const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_POPUP,
  OFFSCREEN_DOCUMENT,
  SHORTCUT_COMMAND,
  SHORTCUT_POPUP,
  disposeOffscreenDocument,
  ensureOffscreenDocument,
  openShortcutPopup,
  recognizeFromPage,
  registerShortcut,
} = require("../extension/background.js");


test("shortcut popup URL is selected before opening and restored afterward", async () => {
  const calls = [];
  const chromeApi = {
    action: {
      setPopup: async (value) => calls.push(["set-popup", value]),
      openPopup: async () => calls.push(["open"]),
    },
  };

  await openShortcutPopup(chromeApi);

  assert.deepEqual(calls, [
    ["set-popup", { popup: SHORTCUT_POPUP }],
    ["open"],
    ["set-popup", { popup: DEFAULT_POPUP }],
  ]);
});


test("failed popup opening still restores the toolbar popup", async () => {
  const calls = [];
  const failure = new Error("popup failed");
  const chromeApi = {
    action: {
      setPopup: async (value) => calls.push(["set-popup", value]),
      openPopup: async () => { throw failure; },
    },
  };

  await assert.rejects(openShortcutPopup(chromeApi), failure);
  assert.deepEqual(calls, [
    ["set-popup", { popup: SHORTCUT_POPUP }],
    ["set-popup", { popup: DEFAULT_POPUP }],
  ]);
});


test("only the recognition command opens the popup", async () => {
  let listener;
  const calls = [];
  const chromeApi = {
    commands: {
      onCommand: {
        addListener: (callback) => { listener = callback; },
      },
    },
    action: {
      setPopup: async ({ popup }) => calls.push(`set:${popup}`),
      openPopup: async () => calls.push("open"),
    },
  };

  registerShortcut(chromeApi);
  listener("another-command");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, []);

  listener(SHORTCUT_COMMAND);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [
    `set:${SHORTCUT_POPUP}`,
    "open",
    `set:${DEFAULT_POPUP}`,
  ]);
});


test("ensureOffscreenDocument creates once and skips when context already exists", async () => {
  let created = 0;
  let existing = [];
  const chromeApi = {
    runtime: {
      getURL: (p) => `chrome-extension://test/${p}`,
      getContexts: async () => existing,
    },
    offscreen: {
      createDocument: async (opts) => {
        created += 1;
        assert.equal(opts.url, OFFSCREEN_DOCUMENT);
        existing = [{ documentUrl: `chrome-extension://test/${opts.url}` }];
      },
    },
  };

  await Promise.all([ensureOffscreenDocument(chromeApi), ensureOffscreenDocument(chromeApi)]);
  assert.equal(created, 1);
  await ensureOffscreenDocument(chromeApi);
  assert.equal(created, 1);
});

test("disposeOffscreenDocument skips creating when closed and forwards OCR_DISPOSE when open", async () => {
  let existing = [];
  const sent = [];
  const chromeApi = {
    runtime: {
      getURL: (p) => `chrome-extension://test/${p}`,
      getContexts: async () => existing,
      sendMessage: async (msg) => {
        sent.push(msg);
        return { ok: true, disposed: true };
      },
    },
    offscreen: {
      createDocument: async () => { throw new Error("must not create during dispose"); },
    },
  };

  const closedRes = await disposeOffscreenDocument(chromeApi);
  assert.equal(closedRes.alreadyClosed, true);
  assert.equal(sent.length, 0);

  existing = [{ documentUrl: `chrome-extension://test/${OFFSCREEN_DOCUMENT}` }];
  const openRes = await disposeOffscreenDocument(chromeApi);
  assert.equal(openRes.disposed, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "OCR_DISPOSE");
  assert.equal(sent[0].target, "offscreen");
});

test("recognizeFromPage honors enginePreference and falls back cleanly between offscreen and Python", async () => {
  let pref = "browser";
  let browserShouldFail = false;
  let pythonShouldFail = false;
  const calls = [];
  const chromeApi = {
    storage: { local: { get: async () => ({ enginePreference: pref }) } },
    runtime: {
      getURL: (p) => `chrome-extension://test/${p}`,
      getContexts: async () => [{ documentUrl: `chrome-extension://test/${OFFSCREEN_DOCUMENT}` }],
      sendMessage: async (msg) => {
        calls.push(["browser", msg.type]);
        if (browserShouldFail) return { ok: false, error: "no models" };
        return { ok: true, answer: "ABCD", engine: "browser_onnx" };
      },
    },
    offscreen: { createDocument: async () => {} },
  };
  const fakeFetch = async (url) => {
    calls.push(["python", url]);
    if (pythonShouldFail) throw new Error("ECONNREFUSED");
    return { ok: true, json: async () => ({ ok: true, answer: "1234", engine: "python" }) };
  };
  const sampleDataUrl = "data:image/png;base64,iVBORw0KGgo=";

  const r1 = await recognizeFromPage(chromeApi, { imageDataUrl: sampleDataUrl, expectedLength: 4 }, fakeFetch);
  assert.equal(r1.answer, "ABCD");
  assert.deepEqual(calls, [["browser", "OCR_RECOGNIZE"]]);

  calls.length = 0;
  browserShouldFail = true;
  const r2 = await recognizeFromPage(chromeApi, { imageDataUrl: sampleDataUrl, expectedLength: 4, charsetHint: "digits" }, fakeFetch);
  assert.equal(r2.answer, "1234");
  assert.equal(calls[0][0], "browser");
  assert.equal(calls[1][0], "python");
  assert.match(calls[1][1], /expectedLength=4&charsetHint=digits/);

  calls.length = 0;
  pref = "python";
  browserShouldFail = false;
  pythonShouldFail = true;
  const r3 = await recognizeFromPage(chromeApi, { imageDataUrl: sampleDataUrl }, fakeFetch);
  assert.equal(r3.answer, "ABCD");
  assert.equal(calls[0][0], "python");
  assert.equal(calls[1][0], "browser");
});
