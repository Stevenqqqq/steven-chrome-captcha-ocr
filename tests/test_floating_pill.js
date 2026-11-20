const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const pillApi = require("../extension/floating_pill.js");
const detect = require("../extension/detect_helpers.js");

function fixture() {
  class Node extends EventTarget {
    constructor(tag) {
      super();
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.style = {};
      this.attributes = new Map();
      this.classList = {
        add: (name) => { this.className += " " + name; },
        contains: (name) => this.className?.split(" ").includes(name),
      };
    }
    get childElementCount() { return this.children.length; }
    append(...nodes) {
      for (const node of nodes) node.parent = this;
      this.children.push(...nodes);
    }
    replaceChildren(...nodes) {
      for (const node of this.children) node.parent = null;
      this.children = [];
      this.append(...nodes);
    }
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this);
      this.parent = null;
    }
    attachShadow({ mode }) {
      this.shadowRoot = new Node("shadow");
      this.shadowRoot.mode = mode;
      return this.shadowRoot;
    }
    setAttribute(key, value) { this.attributes.set(key, value); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    getBoundingClientRect() { return this.rect || { width: 180, height: 32 }; }
    querySelectorAll(selector) {
      const nodes = [];
      const visit = (node) => {
        for (const child of node.children) {
          if (selector === "*" || (selector === "input" && child.tagName === "INPUT")
            || selector === "#" + child.id
            || (selector === "input[data-steven-captcha-target]" && child.tagName === "INPUT"
              && child.attributes.has("data-steven-captcha-target"))) nodes.push(child);
          visit(child);
        }
      };
      if (selector === "[") throw new SyntaxError("Invalid selector");
      visit(this);
      return nodes;
    }
  }
  class Input extends Node {
    constructor() {
      super("input");
      this.type = "text";
      this.nativeValue = "A1";
      this.nativeWrites = 0;
      this.isConnected = true;
      this.rect = { left: 30, bottom: 72, width: 90, height: 22 };
    }
    get value() { return this.nativeValue; }
    set value(value) {
      this.nativeWrites += 1;
      this.nativeValue = value;
    }
    matches(selector) { return selector === ":disabled" && Boolean(this.insideDisabledFieldset); }
  }

  let time = 0;
  let timerId = 0;
  const timers = new Map();
  const listeners = new Map();
  const win = {
    Event,
    HTMLInputElement: Input,
    innerWidth: 500,
    innerHeight: 300,
    performance: { now: () => time },
    addEventListener(type, action, capture = false) {
      assert.ok(!listeners.has(type), type);
      listeners.set(type, { action, capture });
    },
    removeEventListener(type, action, capture = false) {
      assert.deepEqual(listeners.get(type), { action, capture });
      listeners.delete(type);
    },
    setTimeout(action, delay) {
      timers.set(++timerId, { action, due: time + delay });
      return timerId;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  function advance(duration) {
    const end = time + duration;
    while (timers.size) {
      const [id, timer] = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
      if (timer.due > end) break;
      time = timer.due;
      timers.delete(id);
      timer.action();
    }
    time = end;
  }
  const html = new Node("html");
  const input = new Input();
  input.id = "answer";
  html.append(input);
  const doc = {
    activeElement: input,
    defaultView: win,
    documentElement: html,
    createElement: (tag) => new Node(tag),
    getElementById: (id) => html.querySelectorAll("#" + id)[0],
    querySelectorAll: (selector) => html.querySelectorAll(selector),
  };
  const payload = {
    answer: "A1", candidates: [{ answer: "A1" }, { answer: "B2" }, { answer: "C3" }, { answer: "D4" }],
    inputSelectorOrToken: "#answer", confidence: 0.96, latencyMs: 86, sourceLabel: "OCR",
  };
  const host = () => doc.getElementById("steven-ocr-pill-host");
  function ui() {
    const [style, pill] = host().shadowRoot.children;
    const [status, answer, swaps, close] = pill.children;
    return { style, pill, status, answer, swaps, close };
  }
  function mount(data, options) {
    return pillApi.mountFloatingPill({ ...payload, ...data }, { document: doc, ...options });
  }
  function fire(node, type) {
    const event = new Event(type, { cancelable: true });
    node.dispatchEvent(event);
    return event;
  }
  return { doc, win, html, input, Input, timers, listeners, advance, payload, mount, host, ui, fire };
}

test("exports the pill and anchors it at the input's lower-left corner", () => {
  assert.equal(globalThis.StevenOcrFloatingPill, pillApi);
  const viewport = { width: 400, height: 300 };
  const size = { width: 180, height: 32 };
  assert.deepEqual(pillApi.computePillPosition({ left: 30, bottom: 72 }, viewport, size), { left: 30, top: 72 });
  assert.deepEqual(pillApi.computePillPosition({ left: 370, bottom: 296 }, viewport, size), { left: 208, top: 256 });
  assert.deepEqual(pillApi.computePillPosition({ left: -15, bottom: 2 }, viewport, size), { left: 12, top: 12 });
  for (const invalid of [null, {}, { left: 5, bottom: NaN }, { left: 0, bottom: 0, width: 0, height: 0 }]) {
    assert.deepEqual(pillApi.computePillPosition(invalid, viewport, size), { right: 20, bottom: 20 });
  }
});

test("returns up to two ordered distinct swaps without mutating the candidate data", () => {
  const next = { answer: "A1", confidence: 0.7 };
  const alternative = { answer: "B2" };
  const candidates = Object.freeze([
    null, {}, { answer: " " }, { answer: 12 }, { answer: "a1" }, next,
    { answer: "A1" }, alternative, { answer: "C3" },
  ]);
  assert.deepEqual(pillApi.buildSwapCandidates("a1", candidates), [next, alternative]);
  assert.deepEqual(pillApi.buildSwapCandidates("A1", undefined), []);
});

test("mounts the locked Shadow DOM UI and closes without changing the active input", () => {
  const { doc, input, mount, host, ui, fire, timers, listeners } = fixture();
  mount();
  assert.equal(host().shadowRoot.mode, "open");
  assert.equal(host().tabIndex, -1);
  const { style, pill, status, answer, swaps, close } = ui();
  for (const declaration of [
    "all: initial;", "--ocr-bg: #12161d;", "--ocr-popover: #171c25;", "--ocr-secondary: #1b222d;",
    "--ocr-border: #2a3444;", "--ocr-fg: #eef2f7;", "--ocr-muted: #8f9cad;", "--ocr-primary: #3b82f6;",
    "--ocr-success: #22c55e;", "--ocr-info: #38bdf8;", "--ocr-warning: #f59e0b;",
    '"Segoe UI", "Microsoft JhengHei UI", system-ui, -apple-system, sans-serif',
    'Consolas, "Cascadia Mono", ui-monospace, monospace', "z-index: 2147483647",
    "rgba(34, 197, 94, 0.16)", "rgba(34, 197, 94, 0.35)", "color: #22c55e;",
    "border-radius: 999px;", "font-size: 11px;", "font-weight: 700;", "font: 700 13px var(--ocr-font-mono)",
    "border-radius: 6px;", "background: var(--ocr-secondary)", "border: 1px solid var(--ocr-border)",
  ]) assert.ok(style.textContent.includes(declaration), declaration);
  assert.equal(pill.tabIndex, -1);
  assert.deepEqual(pill.style, { left: "30px", top: "72px", right: "", bottom: "" });
  assert.equal(status.textContent, "✓ 已填入");
  assert.equal(answer.textContent, "A1");
  assert.deepEqual(swaps.children.map((node) => node.textContent), ["改填 B2", "改填 C3"]);
  assert.equal(close.textContent, "×");
  for (const button of [...swaps.children, close]) {
    assert.equal(button.tabIndex, -1);
    assert.equal(button.type, "button");
    assert.equal(fire(button, "mousedown").defaultPrevented, true);
  }
  assert.equal(fire(pill, "mousedown").defaultPrevented, true);
  fire(close, "click");
  assert.equal(doc.activeElement, input);
  assert.equal(input.value, "A1");
  assert.equal(host(), undefined);
  assert.equal(timers.size + listeners.size, 0);
});

test("swaps using the native setter, dispatches input then change, and offers the previous answer", () => {
  const { doc, input, mount, ui, fire } = fixture();
  const events = [];
  Object.defineProperty(input, "value", {
    get: () => input.nativeValue,
    set: () => assert.fail("The input's own setter must be bypassed"),
  });
  for (const type of ["input", "change", "submit"]) {
    input.addEventListener(type, (event) => events.push([event.type, event.bubbles, event.composed, input.value]));
  }
  const controller = mount();
  const { answer, swaps } = ui();
  fire(swaps.children[0], "click");
  assert.equal(input.nativeWrites, 1);
  assert.equal(doc.activeElement, input);
  assert.deepEqual(events, [["input", true, true, "B2"], ["change", true, false, "B2"]]);
  assert.equal(answer.textContent, "B2");
  assert.deepEqual(swaps.children.map((node) => node.textContent), ["改填 A1", "改填 C3"]);
  fire(swaps.children[0], "click");
  assert.equal(input.value, "A1");
  assert.equal(answer.textContent, "A1");
  controller.close();
});

test("filters swaps for numeric inputs before limiting them and rechecks editability on click", () => {
  const { input, mount, ui, fire } = fixture();
  input.type = "number";
  input.nativeValue = "0123";
  const controller = mount({
    answer: "0123",
    candidates: ["1e3", "A1", " 23", "0042", "96", "23.1"].map((answer) => ({ answer })),
  });
  const { swaps, answer } = ui();
  assert.deepEqual(swaps.children.map((node) => node.textContent), ["改填 0042", "改填 96"]);
  for (const property of ["disabled", "readOnly", "insideDisabledFieldset"]) {
    input[property] = true;
    fire(swaps.children[0], "click");
    assert.equal(input.nativeWrites, 0);
    input[property] = false;
  }
  input.isConnected = false;
  fire(swaps.children[0], "click");
  assert.equal(input.nativeWrites, 0);
  input.isConnected = true;
  fire(swaps.children[0], "click");
  assert.equal(answer.textContent, "0042");
  assert.equal(input.value, "0042");
  controller.close();
});

test("resolves the exact detection token through an open shadow root", () => {
  const { html, input, doc, mount, ui, fire } = fixture();
  const pageHost = doc.createElement("div");
  html.append(pageHost);
  const shadow = pageHost.attachShadow({ mode: "open" });
  input.remove();
  shadow.append(input);
  const token = 'steven-ocr-123-quote"and\\';
  input.setAttribute("data-steven-captcha-target", token);
  const controller = mount({ inputSelectorOrToken: token }, { detect });
  assert.equal(ui().pill.style.left, "30px");
  fire(ui().swaps.children[0], "click");
  assert.equal(input.value, "B2");
  controller.close();
});

test("falls back without swaps for missing, invalid, ambiguous, or unavailable targets", () => {
  const { html, Input, input, mount, ui } = fixture();
  html.append(new Input());
  for (const selector of ["#missing", "[", "input", undefined]) {
    const controller = mount({ inputSelectorOrToken: selector });
    assert.deepEqual(ui().pill.style, { left: "", top: "", right: "20px", bottom: "20px" });
    assert.equal(ui().swaps.hidden, true);
    controller.close();
  }
  input.readOnly = true;
  const controller = mount();
  assert.equal(ui().pill.style.right, "20px");
  assert.equal(ui().swaps.hidden, true);
  controller.close();
});

test("repositions on resize and scroll and falls back when the matched input detaches", () => {
  const { input, win, listeners, mount, ui } = fixture();
  const controller = mount();
  const { pill } = ui();
  win.innerHeight = 100;
  win.innerWidth = 220;
  listeners.get("resize").action();
  assert.equal(pill.style.left, "28px");
  assert.equal(pill.style.top, "56px");
  input.rect = { left: 10, bottom: 50, width: 80, height: 20 };
  listeners.get("scroll").action();
  assert.equal(pill.style.left, "12px");
  assert.equal(pill.style.top, "50px");
  input.isConnected = false;
  listeners.get("scroll").action();
  assert.equal(pill.style.left, "");
  assert.equal(pill.style.right, "20px");
  controller.close();
});

test("defaults to a 3500ms countdown, preserves time across hover, and fades before removing", () => {
  const { mount, ui, fire, advance, host, timers, listeners } = fixture();
  mount();
  const { pill } = ui();
  advance(1000);
  fire(pill, "mouseenter");
  advance(5000);
  assert.equal(timers.size, 0);
  assert.ok(host());
  fire(pill, "mouseleave");
  advance(2499);
  assert.equal(Boolean(pill.classList.contains("leaving")), false);
  advance(1);
  assert.equal(pill.classList.contains("leaving"), true);
  assert.ok(host());
  advance(150);
  assert.equal(host(), undefined);
  assert.equal(timers.size + listeners.size, 0);
});

test("starts a full custom countdown after swapping while hovered", () => {
  const { mount, ui, fire, advance, host } = fixture();
  mount({ autoHideMs: 400 });
  const { pill, swaps } = ui();
  advance(350);
  fire(pill, "mouseenter");
  fire(swaps.children[0], "click");
  advance(1000);
  assert.ok(host());
  fire(pill, "mouseleave");
  advance(399);
  assert.equal(Boolean(pill.classList.contains("leaving")), false);
  advance(1);
  assert.equal(pill.classList.contains("leaving"), true);
  advance(150);
  assert.equal(host(), undefined);
});

test("resets the countdown for a swap without hover and honors reduced motion", () => {
  const { win, mount, ui, fire, advance, host } = fixture();
  win.matchMedia = () => ({ matches: true });
  mount({ autoHideMs: 400 });
  advance(350);
  fire(ui().swaps.children[0], "click");
  advance(399);
  assert.ok(host());
  advance(1);
  assert.equal(host(), undefined);
});

test("autoinjection consumes the payload and disposes the previous mount and its timer", () => {
  const { doc, payload, mount, host, ui, timers, listeners, advance } = fixture();
  const source = readFileSync(require.resolve("../extension/floating_pill.js"), "utf8");
  const original = mount({ autoHideMs: 500 });
  const first = host();
  advance(300);
  const globals = { document: doc, __STEVEN_OCR_PILL_DATA__: { ...payload, answer: "B2", autoHideMs: 800 } };
  runInNewContext(source, globals);
  assert.equal(Object.hasOwn(globals, "__STEVEN_OCR_PILL_DATA__"), false);
  assert.ok(globals.StevenOcrFloatingPill);
  assert.notEqual(host(), first);
  assert.equal(ui().answer.textContent, "B2");
  assert.equal(timers.size, 1);
  assert.equal(listeners.size, 2);
  original.close();
  advance(200);
  assert.ok(host());
  advance(750);
  assert.equal(host(), undefined);
  assert.equal(timers.size + listeners.size, 0);
});
