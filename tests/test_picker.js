const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const picker = require("../extension/picker.js");
const siteProfiles = require("../extension/site_profiles.js");
const detect = require("../extension/detect_helpers.js");

function fixture() {
  function eventTarget() {
    const listeners = new Map();
    return {
      listeners,
      addEventListener(type, listener, capture = false) {
        assert.ok(!listeners.has(type), type);
        listeners.set(type, { listener, capture });
      },
      removeEventListener(type, listener, capture = false) {
        assert.deepEqual(listeners.get(type), { listener, capture });
        listeners.delete(type);
      },
      fire(type, target, extra = {}) {
        const event = {
          target,
          preventDefault() { this.prevented = true; },
          stopImmediatePropagation() { this.stopped = true; },
          ...extra,
        };
        listeners.get(type)?.listener(event);
        return event;
      },
    };
  }

  const timers = new Map();
  let timerId = 0;
  const win = {
    ...eventTarget(),
    getComputedStyle: (node) => ({ backgroundImage: node.background || "none" }),
    setTimeout(callback, delay) {
      timers.set(++timerId, { callback, delay });
      return timerId;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  const doc = {
    ...eventTarget(),
    defaultView: win,
    location: { href: "https://example.com/challenge?private=value" },
    getElementById(id) { return this.documentElement.children.find((node) => node.id === id); },
    createElement(tag) {
      return {
        ...eventTarget(),
        ownerDocument: doc,
        tagName: tag.toUpperCase(),
        children: [],
        style: {},
        type: tag === "input" ? "text" : "",
        hidden: false,
        attributes: {},
        append(...nodes) {
          for (const node of nodes) if (typeof node !== "string") node.parentElement = this;
          this.children.push(...nodes);
        },
        remove() {
          this.parentElement.children = this.parentElement.children.filter((node) => node !== this);
        },
        attachShadow({ mode }) {
          this.shadowRoot = doc.createElement("shadow");
          this.shadowRoot.mode = mode;
          return this.shadowRoot;
        },
        closest(selector) {
          assert.equal(selector, "img, canvas, svg");
          for (let node = this; node; node = node.parentElement) {
            if (["IMG", "CANVAS", "SVG"].includes(node.tagName)) return node;
          }
          return null;
        },
        getBoundingClientRect() { return this.rect; },
        matches(selector) { return selector === ":disabled" && Boolean(this.insideDisabledFieldset); },
        setAttribute(key, value) { this.attributes[key] = value; },
        getAttribute(key) { return this.attributes[key] ?? null; },
      };
    },
  };
  doc.documentElement = doc.createElement("html");
  const image = doc.createElement("svg");
  image.id = "challenge";
  image.rect = { left: 112, top: 160, width: 138, height: 48 };
  const path = doc.createElement("path");
  image.append(path);
  const input = doc.createElement("input");
  input.id = "answer";
  input.minLength = 0;
  input.maxLength = 5;
  input.inputMode = "numeric";
  input.setAttribute("aria-label", "區分大小寫");
  input.rect = { left: 112, top: 212, width: 156, height: 32 };
  const host = () => doc.getElementById("steven-ocr-picker-host");
  function ui() {
    const [style, hover, locked, hud] = host().shadowRoot.children;
    const [badge, prompt, controls, cancel] = hud.children;
    const [length, charset, caseSensitive] = controls.children.slice(0, 3)
      .map((label) => label.children[1]);
    const [, , , save, retry] = controls.children;
    return { style, hover, locked, hud, badge, prompt, controls, cancel, length, charset, caseSensitive, save, retry };
  }
  function start(options) {
    return picker.createPickerController({ document: doc, siteProfiles, detect, ...options });
  }
  return { doc, win, timers, image, path, input, host, ui, start };
}

test("exports the picker and resolves images, SVG descendants, and image backgrounds", () => {
  assert.equal(globalThis.StevenOcrPicker, picker);
  const { doc, image, path } = fixture();
  assert.equal(picker.resolvePickTarget(path, 1), image);
  for (const tag of ["img", "canvas", "svg"]) {
    const element = doc.createElement(tag);
    assert.equal(picker.resolvePickTarget(element, 1), element);
  }
  const background = doc.createElement("div");
  assert.equal(picker.resolvePickTarget(background, 1), null);
  background.background = 'url("captcha.png")';
  assert.equal(picker.resolvePickTarget(background, 1), background);
  image.append(background);
  assert.equal(picker.resolvePickTarget(background, 1), image);
  assert.equal(picker.resolvePickTarget(null, 1), null);
});

test("resolves only editable answer inputs in step two", () => {
  const { input, image } = fixture();
  assert.equal(picker.resolvePickTarget(input, 2), input);
  for (const property of ["disabled", "readOnly", "insideDisabledFieldset"]) {
    input[property] = true;
    assert.equal(picker.resolvePickTarget(input, 2), null);
    input[property] = false;
  }
  input.type = "checkbox";
  assert.equal(picker.resolvePickTarget(input, 2), null);
  assert.equal(picker.resolvePickTarget(image, 2), null);
});

test("computes fixed viewport coordinates and rejects empty or invalid rectangles", () => {
  const { image } = fixture();
  image.rect.left = -1.5;
  assert.deepEqual(picker.computeHighlightRect(image), { left: -1.5, top: 160, width: 138, height: 48 });
  for (const invalid of [null, { ...image.rect, height: 0 }, { ...image.rect, top: Infinity }]) {
    image.rect = invalid;
    assert.equal(picker.computeHighlightRect(image), null);
  }
  assert.equal(picker.computeHighlightRect(null), null);
});

test("walks both steps and updates only the relevant outline, including on scroll", () => {
  const { doc, win, start, ui, image, path, input, host } = fixture();
  const controller = start();
  const { style, hover, locked, badge, prompt, controls } = ui();
  assert.equal(host().shadowRoot.mode, "open");
  for (const declaration of [
    "all: initial;", "--ocr-info: #38bdf8;", "--ocr-success: #22c55e;",
    "z-index: 2147483647", "top: 16px;", "left: 50%;", "translateX(-50%)",
    "border: 1px solid rgba(56, 189, 248, 0.45)", "border-radius: 12px;",
    "padding: 10px 14px;", "0 12px 32px rgba(0, 0, 0, 0.45)",
    "border: 2px solid var(--ocr-info)", "width: 20px;", "font: 12px var(--ocr-font-sans)",
  ]) assert.ok(style.textContent.includes(declaration), declaration);
  assert.equal(prompt.textContent, "請點選目標圖片（img / canvas / svg）");
  assert.equal(badge.textContent, "1");
  assert.equal(controls.hidden, true);
  assert.equal(hover.hidden, true);
  doc.fire("pointermove", doc.documentElement, { composedPath: () => [path, image] });
  assert.equal(hover.hidden, false);
  assert.deepEqual(hover.style, { left: "112px", top: "160px", width: "138px", height: "48px" });
  const imageClick = doc.fire("click", doc.documentElement, { composedPath: () => [path, image] });
  assert.equal(imageClick.prevented, true);
  assert.equal(imageClick.stopped, true);
  assert.equal(prompt.textContent, "請點選要填入答案的輸入框");
  assert.equal(badge.textContent, "2");
  assert.equal(locked.hidden, false);
  assert.equal(hover.hidden, true);
  assert.equal(doc.fire("click", image).prevented, undefined);
  doc.fire("pointermove", input);
  assert.equal(hover.style.width, "156px");
  image.rect.top = 120;
  win.fire("scroll");
  assert.equal(locked.style.top, "120px");
  doc.fire("click", input);
  assert.equal(controls.hidden, false);
  assert.equal(hover.hidden, true);
  controller.cancel();
});

test("ignores composed events from the HUD even if their deepest target is eligible", () => {
  const { doc, start, ui, image, input, host } = fixture();
  const controller = start();
  doc.fire("pointermove", host(), { composedPath: () => [image, host()] });
  assert.equal(ui().hover.hidden, true);
  assert.equal(doc.fire("click", host(), { composedPath: () => [image, host()] }).prevented, undefined);
  assert.equal(ui().badge.textContent, "1");
  doc.fire("click", image);
  doc.fire("click", host(), { composedPath: () => [input, host()] });
  assert.equal(ui().controls.hidden, true);
  controller.cancel();
});

test("prefills inferred hints and saves adjusted values using the real profile schema", async () => {
  const { doc, start, ui, timers, image, input, host, win } = fixture();
  let stored = {};
  const storage = {
    async get() { return stored; },
    async set(value) { stored = structuredClone(value); },
  };
  start({ chrome: { storage: { local: storage } } });
  doc.fire("click", image);
  doc.fire("click", input);
  const { length, charset, caseSensitive, controls, prompt, save } = ui();
  assert.deepEqual(length.children.map((item) => item.textContent), ["自動", "3", "4", "5", "6"]);
  assert.deepEqual(charset.children.map((item) => item.textContent), ["英數", "純數字", "純字母"]);
  assert.deepEqual(controls.children.slice(0, 3).map((item) => item.children[0]), ["長度", "字元集", "區分大小寫"]);
  assert.equal(length.value, "5");
  assert.equal(charset.value, "digits");
  assert.equal(caseSensitive.checked, true);
  length.value = "4";
  length.fire("change", length);
  charset.value = "letters";
  caseSensitive.checked = false;
  assert.equal(save.textContent, "儲存此網站規則");
  await save.listeners.get("click").listener();
  const profile = stored.siteProfiles["https://example.com"];
  assert.ok(Number.isFinite(profile.updatedAt));
  assert.deepEqual(profile, {
    origin: "https://example.com", imageSelector: "#challenge", inputSelector: "#answer",
    expectedLength: 4, lengthMode: "exact", charsetHint: "letters", caseSensitive: false,
    updatedAt: profile.updatedAt,
  });
  assert.equal(prompt.textContent, "✓ 已記住此網站規則");
  const [timer] = timers.values();
  assert.equal(timer.delay, 1200);
  timer.callback();
  assert.equal(host(), undefined);
  assert.equal(doc.listeners.size + win.listeners.size + timers.size, 0);
});

test("preserves inferred maximum mode, and falls back to automatic hints without detection", async () => {
  for (const useDetect of [true, false]) {
    const { doc, start, ui, image, input } = fixture();
    let message;
    const controller = start({
      detect: useDetect ? detect : null,
      chrome: { runtime: { sendMessage(value) { message = value; } } },
    });
    doc.fire("click", image);
    doc.fire("click", input);
    await ui().save.listeners.get("click").listener();
    assert.equal(message.type, "STEVEN_OCR_PROFILE_SAVED");
    assert.equal(message.profile.expectedLength, useDetect ? 5 : null);
    assert.equal(message.profile.lengthMode, useDetect ? "max" : "unknown");
    assert.equal(message.profile.charsetHint, useDetect ? "digits" : "alphanumeric");
    controller.cancel();
  }
});

test("reselection clears the binding and Escape or the cancel control removes the session", () => {
  const { doc, win, start, ui, image, input, host } = fixture();
  const controller = start();
  doc.fire("click", image);
  doc.fire("click", input);
  ui().retry.fire("click");
  assert.equal(ui().retry.textContent, "重選");
  assert.equal(ui().badge.textContent, "1");
  assert.equal(ui().locked.hidden, true);
  assert.equal(ui().controls.hidden, true);
  assert.equal(doc.fire("keydown", null, { key: "Enter" }).prevented, undefined);
  assert.equal(doc.fire("keydown", null, { key: "Escape" }).stopped, true);
  assert.equal(host(), undefined);
  controller.cancel();
  start();
  assert.equal(ui().cancel.textContent, "ESC 取消");
  ui().cancel.fire("click");
  assert.equal(host(), undefined);
  assert.equal(doc.listeners.size + win.listeners.size, 0);
});

test("invalid selectors remain unconfirmable and a rejected save can be retried", async () => {
  const { doc, start, ui, image, input } = fixture();
  let attempts = 0;
  const controller = start({
    async onSave() {
      attempts += 1;
      if (attempts === 1) throw new Error("storage unavailable");
    },
  });
  doc.fire("click", image);
  input.getRootNode = () => ({ querySelectorAll: () => [input, {}] });
  doc.fire("click", input);
  assert.equal(ui().controls.hidden, true);
  delete input.getRootNode;
  doc.fire("click", input);
  const { save, prompt } = ui();
  await save.listeners.get("click").listener();
  assert.equal(save.disabled, false);
  assert.equal(prompt.textContent, "請點選要填入答案的輸入框");
  await save.listeners.get("click").listener();
  assert.equal(attempts, 2);
  assert.equal(prompt.textContent, "✓ 已記住此網站規則");
  controller.cancel();
});

test("consumes an exact true injection flag and replaces a prior session during reinjection", async () => {
  const { doc, win, timers, ui, image, input, host } = fixture();
  const source = readFileSync(require.resolve("../extension/picker.js"), "utf8");
  const globals = { document: doc, SiteProfiles: siteProfiles, __STEVEN_OCR_START_PICKER__: "true" };
  runInNewContext(source, globals);
  assert.equal(host(), undefined);
  globals.__STEVEN_OCR_START_PICKER__ = true;
  runInNewContext(source, globals);
  assert.equal(Object.hasOwn(globals, "__STEVEN_OCR_START_PICKER__"), false);
  assert.ok(globals.StevenOcrPicker);
  const first = host();
  globals.__STEVEN_OCR_START_PICKER__ = true;
  runInNewContext(source, globals);
  assert.notEqual(host(), first);
  assert.equal(doc.listeners.size + win.listeners.size, 5);
  doc.fire("keydown", null, { key: "Escape" });

  let resolveSave;
  let calls = 0;
  picker.createPickerController({
    document: doc, siteProfiles,
    onSave() {
      calls += 1;
      return new Promise((resolve) => { resolveSave = resolve; });
    },
  });
  doc.fire("click", image);
  doc.fire("click", input);
  const { save } = ui();
  const pending = save.listeners.get("click").listener();
  await save.listeners.get("click").listener();
  assert.equal(calls, 1);
  doc.fire("keydown", null, { key: "Escape" });
  resolveSave();
  await pending;
  assert.equal(host(), undefined);
  assert.equal(timers.size, 0);
});
