const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, existsSync } = require("node:fs");
const path = require("node:path");

globalThis.__STEVEN_OCR_DISABLE_AUTOSTART__ = true;
const detect = require("../extension/detect_helpers.js");
const captchaImage = require("../extension/captcha_image.js");
const browserOcr = require("../extension/browser_ocr.js");
const mobile = require("../mobile/mobile_runtime.js");

function makeMemoryIndexedDb() {
  const stores = new Map();
  return {
    open(name) {
      const request = { result: null, onupgradeneeded: null, onsuccess: null, onerror: null };
      if (!stores.has(name)) stores.set(name, new Map());
      const db = {
        objectStoreNames: { contains: (s) => stores.has(`${name}:${s}`) },
        createObjectStore: (s) => { stores.set(`${name}:${s}`, new Map()); },
        transaction(storeName) {
          const map = stores.get(`${name}:${storeName}`) || new Map();
          return {
            objectStore() {
              return {
                get(key) {
                  const req = { result: map.get(key) ?? null, onsuccess: null, onerror: null };
                  queueMicrotask(() => req.onsuccess?.());
                  return req;
                },
                put(value, key) {
                  map.set(key, value);
                  const req = { onsuccess: null, onerror: null };
                  queueMicrotask(() => req.onsuccess?.());
                  return req;
                },
              };
            },
          };
        },
      };
      request.result = db;
      queueMicrotask(() => {
        if (!stores.has(`${name}:assets`)) {
          request.onupgradeneeded?.();
        }
        request.onsuccess?.();
      });
      return request;
    },
  };
}

test("createAssetLoader caches binary assets in memory and IndexedDB and prefers GM_xmlhttpRequest", async () => {
  const idb = makeMemoryIndexedDb();
  let gmCalls = 0;
  let fetchCalls = 0;
  const sampleBytes = new Uint8Array(2048).fill(7);

  const gmRequest = ({ url, onload }) => {
    gmCalls += 1;
    if (url.includes("mirror1")) {
      onload({ status: 500, response: new ArrayBuffer(0) });
      return;
    }
    onload({ status: 200, response: sampleBytes.buffer.slice(0) });
  };
  const fetchImpl = async () => {
    fetchCalls += 1;
    return { ok: true, arrayBuffer: async () => sampleBytes.buffer.slice(0) };
  };

  const loader1 = mobile.createAssetLoader({ gmRequest, fetchImpl, indexedDB: idb });
  const loaded = await loader1.getBinary("test/model.onnx", [
    "https://example.com/mirror1.onnx",
    "https://example.com/mirror2.onnx",
  ]);
  assert.equal(loaded.byteLength, 2048);
  assert.equal(gmCalls, 2);
  assert.equal(fetchCalls, 0);
  assert.equal(loader1.hasMemoryAsset("test/model.onnx"), true);

  // Second read from same loader uses memory cache.
  const cachedMem = await loader1.getBinary("test/model.onnx", ["https://example.com/mirror2.onnx"]);
  assert.equal(cachedMem.byteLength, 2048);
  assert.equal(gmCalls, 2);

  // New loader instance with same IndexedDB hits persistent IDB cache without network calls.
  const loader2 = mobile.createAssetLoader({ gmRequest, fetchImpl, indexedDB: idb });
  const cachedIdb = await loader2.getBinary("test/model.onnx", ["https://example.com/mirror2.onnx"]);
  assert.equal(cachedIdb.byteLength, 2048);
  assert.equal(gmCalls, 2);
  assert.equal(fetchCalls, 0);

  // Fallback to fetch when GM_xmlhttpRequest is unavailable.
  const fetchOnlyLoader = mobile.createAssetLoader({
    gmRequest: null,
    fetchImpl,
    indexedDB: null,
  });
  const fromFetch = await fetchOnlyLoader.getBinary("test/fallback.onnx", ["https://example.com/fallback.onnx"]);
  assert.equal(fromFetch.byteLength, 2048);
  assert.equal(fetchCalls, 1);
});

test("createMobileOcrEngine warms up via virtual fetch, falls back to official-only, and auto-releases after idle", async () => {
  const charset = ["", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "A", "K", "P"];
  const officialCharset = {
    schema_version: 1,
    blank_index: 0,
    num_classes: charset.length,
    target_height: 64,
    ascii_entries: charset.slice(1).map((char, i) => ({ index: i + 1, char })),
  };
  const fusionConfig = {
    schema_version: 1,
    alpha: 6.0,
    beta: 6.0,
    charset: browserOcr.DEFAULT_CHARSET,
    direct_image_size: [12, 20],
    crop_image_size: [12, 8],
    crop_margin: 0.32,
  };

  let createdSessions = 0;
  let disposedSessions = 0;
  let releasePendingInference = null;
  let scheduledFn = null;
  let scheduledMs = null;
  let clearedTimers = 0;

  const target = "A7KP";
  const makeCtcLogits = () => {
    const T = 8;
    const C = charset.length;
    const logits = new Float32Array(T * C).fill(-8);
    target.split("").forEach((ch, idx) => {
      logits[(idx * 2) * C + charset.indexOf(ch)] = 6;
      logits[(idx * 2 + 1) * C + 0] = 6;
    });
    return { data: logits, dims: [T, 1, C] };
  };

  const fakeOrt = {
    env: { wasm: {} },
    Tensor: class Tensor {
      constructor(type, data, dims) {
        this.type = type;
        this.data = data;
        this.dims = dims;
      }
    },
    InferenceSession: {
      async create() {
        createdSessions += 1;
        return {
          inputNames: ["input1"],
          outputNames: ["output"],
          async run() {
            if (releasePendingInference) {
              await new Promise((resolve) => {
                const fn = releasePendingInference;
                releasePendingInference = null;
                fn(resolve);
              });
            }
            return { output: makeCtcLogits() };
          },
          async release() {
            disposedSessions += 1;
          },
        };
      },
    },
  };

  // Fail fusion_v7 downloads to verify graceful fallback to official-only.
  const fakeAssetLoader = {
    async getBinary(key) {
      if (key.startsWith("fusion_v7/")) {
        throw new Error("fusion_v7 unreachable");
      }
      return new Uint8Array(2048).fill(1);
    },
  };

  const engine = mobile.createMobileOcrEngine({
    getOrt: () => fakeOrt,
    assetLoader: fakeAssetLoader,
    browserOcr,
    officialCharset,
    fusionConfig,
    idleMs: 180_000,
    setTimer: (fn, ms) => {
      scheduledFn = fn;
      scheduledMs = ms;
      return 101;
    },
    clearTimer: () => {
      clearedTimers += 1;
      scheduledFn = null;
    },
  });

  // Pause inside inference so we can assert idle timer never runs during in-flight work.
  let resolveGate;
  releasePendingInference = (resolve) => {
    resolveGate = resolve;
  };

  const rgba = new Uint8Array(40 * 16 * 4).fill(235);
  const recogPromise = engine.recognizeRgba({ rgba, width: 40, height: 16, expectedLength: 4 });
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(engine.getState().inFlight, 1);
  assert.equal(engine.getState().hasIdleTimer, false);
  assert.equal(fakeOrt.env.wasm.numThreads, 1);
  assert.equal(fakeOrt.env.wasm.proxy, false);
  assert.ok(fakeOrt.env.wasm.wasmBinary instanceof Uint8Array);

  resolveGate();
  const res = await recogPromise;
  assert.equal(res.ok, true);
  assert.equal(res.answer, "A7KP");
  assert.equal(res.model, "official");
  // 1st attempt created official before fusion_v7 threw & disposed it; 2nd attempt created official cleanly.
  assert.equal(createdSessions, 2);
  assert.equal(disposedSessions, 1);
  assert.equal(engine.getState().inFlight, 0);
  assert.equal(engine.getState().hasIdleTimer, true);
  assert.equal(scheduledMs, 180_000);

  // Trigger idle timeout and verify session is released.
  await scheduledFn();
  assert.equal(disposedSessions, 2);
  assert.equal(engine.getState().hasRuntime, false);
  assert.ok(clearedTimers >= 0);
});

function createMobileDomFixture({ imageTag = "img", inputType = "text" } = {}) {
  class Node extends EventTarget {
    constructor(tag) {
      super();
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.style = {};
      this.attributes = new Map();
      this.isConnected = tag.toUpperCase() === "HTML";
      this.textContent = "";
    }
    get childElementCount() { return this.children.length; }
    append(...nodes) {
      const setConnected = (el, state) => {
        el.isConnected = state;
        for (const ch of el.children || []) setConnected(ch, state);
      };
      for (const node of nodes) {
        node.parent = this;
        setConnected(node, this.isConnected);
      }
      this.children.push(...nodes);
    }
    replaceChildren(...nodes) {
      for (const node of this.children) node.parent = null;
      this.children = [];
      this.append(...nodes);
    }
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter((n) => n !== this);
      this.parent = null;
      this.isConnected = false;
    }
    attachShadow({ mode }) {
      this.shadowRoot = new Node("shadow");
      this.shadowRoot.mode = mode;
      this.shadowRoot.host = this;
      return this.shadowRoot;
    }
    setAttribute(k, v) { this.attributes.set(k, String(v)); }
    getAttribute(k) { return this.attributes.get(k) ?? null; }
    getRootNode() { return this.rootNode || doc; }
    closest() { return null; }
    matches(selector) {
      if (selector === ":disabled") return Boolean(this.disabled);
      return false;
    }
    getBoundingClientRect() {
      return this.rect || { left: 10, top: 10, right: 130, bottom: 50, width: 120, height: 40 };
    }
    querySelectorAll(selector) {
      const matches = [];
      const visit = (node) => {
        for (const child of node.children) {
          const tag = child.tagName.toLowerCase();
          if (
            selector === "*"
            || (selector.includes("img") && (tag === "img" || tag === "canvas" || tag === "svg"))
            || (selector.includes("input") && tag === "input")
            || (selector === `#${child.id}`)
          ) {
            matches.push(child);
          }
          visit(child);
        }
      };
      visit(this);
      return matches;
    }
  }

  class Input extends Node {
    constructor() {
      super("input");
      this.type = inputType;
      this.nativeValue = "";
      this.nativeWrites = 0;
      this.maxLength = 4;
      this.minLength = 4;
      this.rect = { left: 140, top: 16, right: 240, bottom: 48, width: 100, height: 32 };
    }
    get value() { return this.nativeValue; }
    set value(v) {
      this.nativeWrites += 1;
      this.nativeValue = v;
    }
  }

  const win = {
    Event,
    HTMLInputElement: Input,
    innerWidth: 390,
    innerHeight: 844,
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1", backgroundImage: "none" }),
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  };

  const html = new Node("html");
  const body = new Node("body");
  html.append(body);

  const img = new Node(imageTag);
  img.id = "captcha_img";
  img.naturalWidth = 120;
  img.naturalHeight = 40;
  img.setAttribute("src", "data:image/png;base64,iVBORw0KGgo=");
  img.rect = { left: 12, top: 12, right: 132, bottom: 52, width: 120, height: 40 };

  const input = new Input();
  input.id = "captcha_code";
  input.setAttribute("placeholder", "請輸入驗證碼");
  body.append(img, input);

  const doc = {
    defaultView: win,
    documentElement: html,
    body,
    location: { href: "https://example.com/login" },
    createElement: (tag) => {
      if (tag === "canvas") {
        const canvas = new Node("canvas");
        canvas.getContext = () => ({
          fillStyle: "#ffffff",
          fillRect() {},
          drawImage() {},
          getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(255) }),
        });
        return canvas;
      }
      return new Node(tag);
    },
    getElementById: (id) => html.querySelectorAll(`#${id}`)[0] || null,
    querySelectorAll: (selector) => html.querySelectorAll(selector),
    addEventListener() {},
    removeEventListener() {},
  };

  return { doc, win, img, input };
}

test("mountMobileCaptchaUi detects CAPTCHA pair, recognizes on tap, fills native value, swaps candidates, and retries", async () => {
  const { doc, img, input } = createMobileDomFixture();
  const events = [];
  Object.defineProperty(input, "value", {
    get: () => input.nativeValue,
    set: () => assert.fail("Must use native HTMLInputElement value setter"),
  });
  input.addEventListener("input", (e) => events.push([e.type, input.value]));
  input.addEventListener("change", (e) => events.push([e.type, input.value]));

  let recognizeCalls = 0;
  const mockEngine = {
    async recognizeRgba(opts) {
      recognizeCalls += 1;
      assert.equal(opts.expectedLength, 4);
      if (recognizeCalls === 1) {
        return {
          ok: true,
          answer: "A7OK",
          confidence: 0.91,
          length_match: true,
          candidates: [
            { answer: "A7OK", confidence: 0.91 },
            { answer: "A70K", confidence: 0.85 },
            { answer: "47OK", confidence: 0.42 },
          ],
        };
      }
      return {
        ok: true,
        answer: "B8MN",
        confidence: 0.97,
        length_match: true,
        candidates: [{ answer: "B8MN", confidence: 0.97 }],
      };
    },
  };

  const ui = mobile.mountMobileCaptchaUi({
    doc,
    engine: mockEngine,
    detect,
    captchaImage,
    decodeBlob: async () => ({ rgba: new Uint8Array(120 * 40 * 4).fill(240), width: 120, height: 40 }),
    observeMutations: false,
  });

  const host = doc.getElementById(mobile.HOST_ID);
  assert.ok(host, "Mobile floating pill host should mount");
  assert.equal(ui.getUiState().mode, "idle");

  const [, pill] = host.shadowRoot.children;
  const [mainRow, swapsRow] = pill.children;
  assert.equal(mainRow.children[0].textContent, "🔍 辨識驗證碼");

  // Tap recognize button.
  mainRow.children[0].dispatchEvent(new Event("click", { cancelable: true }));
  await new Promise((r) => setTimeout(r, 15));

  assert.equal(ui.getUiState().mode, "result");
  assert.equal(input.value, "A7OK");
  assert.equal(input.nativeWrites, 1);
  assert.deepEqual(events, [["input", "A7OK"], ["change", "A7OK"]]);
  assert.equal(mainRow.children[0].textContent, "✓ 已填入");
  assert.equal(mainRow.children[1].textContent, "A7OK");
  assert.deepEqual(swapsRow.children.map((b) => b.textContent), ["改填 A70K", "改填 47OK"]);

  // Even if scan() runs after filling the input, the result pill stays mounted.
  ui.scan();
  assert.equal(ui.getUiState().mode, "result");

  // Tap swap candidate button.
  swapsRow.children[0].dispatchEvent(new Event("click", { cancelable: true }));
  assert.equal(input.value, "A70K");
  assert.deepEqual(swapsRow.children.map((b) => b.textContent), ["改填 A7OK", "改填 47OK"]);

  // Simulate CAPTCHA image refresh & tap retry button (🔄).
  img.setAttribute("src", "data:image/png;base64,AAAA");
  mainRow.children[2].dispatchEvent(new Event("click", { cancelable: true }));
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(recognizeCalls, 2);
  assert.equal(input.value, "B8MN");

  ui.close();
  assert.equal(doc.getElementById(mobile.HOST_ID), null);
});

test("computePillPosition avoids overlapping the CAPTCHA image and filters digit homoglyph swaps", () => {
  const viewport = { width: 390, height: 844 };
  const pillSize = { width: 220, height: 36 };
  const inputRect = { left: 24, top: 360, right: 366, bottom: 404, width: 342, height: 44 };

  // When image is beside/unrelated, places below input as usual.
  const nonOverlappingImage = { left: 24, top: 300, right: 140, bottom: 340, width: 116, height: 40 };
  assert.deepEqual(
    mobile.computePillPosition(inputRect, viewport, pillSize, nonOverlappingImage),
    { left: 24, top: 410 },
  );

  // When image sits directly beneath the input (like has.nlma.gov.tw), moves above-right of input.
  const imageBelowInput = { left: 24, top: 412, right: 174, bottom: 462, width: 150, height: 50 };
  const pos = mobile.computePillPosition(inputRect, viewport, pillSize, imageBelowInput);
  assert.ok(pos.top < inputRect.top, `Expected pill above input (top=${pos.top} < ${inputRect.top})`);
  assert.equal(pos.left, inputRect.right - pillSize.width);

  // Homoglyph filtering for pure-digit answers: drops 7O7694 when 707694 is active, keeps 107694.
  const swaps = mobile.buildSwapCandidates("707694", [
    { answer: "707694" },
    { answer: "7O7694" },
    { answer: "107694" },
    { answer: "1O7694" },
    { answer: "707699" },
  ]);
  assert.deepEqual(swaps.map((s) => s.answer), ["107694", "707699"]);
});

test("built mobile/steven_captcha_ocr.user.js contains valid userscript metadata and embedded assets", () => {
  const builtPath = path.resolve(__dirname, "..", "mobile", "steven_captcha_ocr.user.js");
  assert.equal(existsSync(builtPath), true, "mobile/steven_captcha_ocr.user.js should exist");
  const content = readFileSync(builtPath, "utf8");
  assert.match(content, /^\/\/ ==UserScript==/m);
  assert.match(content, /^\/\/ @grant\s+GM_xmlhttpRequest$/m);
  assert.match(content, /^\/\/ @require\s+https:\/\/cdn\.jsdelivr\.net\/npm\/onnxruntime-web@1\.23\.2\/dist\/ort\.wasm\.min\.js$/m);
  assert.match(content, /__STEVEN_OCR_EMBEDDED_ASSETS__/);
  assert.match(content, /officialCharset/);
  assert.match(content, /fusionConfig/);
});
