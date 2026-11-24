const test = require("node:test");
const assert = require("node:assert/strict");

globalThis.__STEVEN_OCR_DISABLE_AUTOSTART__ = true;
const pageButton = require("../extension/page_button.js");
const floatingPill = require("../extension/floating_pill.js");

function createDesktopFixture({ withCaptcha = true } = {}) {
  class Node extends EventTarget {
    constructor(tag) {
      super();
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.style = {};
      this.attributes = new Map();
      this.isConnected = tag.toUpperCase() === "HTML";
      this.textContent = "";
      this.className = "";
      this.classList = {
        add: (name) => { this.className += " " + name; },
        contains: (name) => this.className.split(" ").includes(name),
      };
    }
    get childElementCount() { return this.children.length; }
    append(...nodes) {
      const setConn = (el, s) => {
        el.isConnected = s;
        for (const ch of el.children || []) setConn(ch, s);
      };
      for (const node of nodes) {
        node.parent = this;
        setConn(node, this.isConnected);
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
    getRootNode() { return doc; }
    closest() { return null; }
    matches(selector) {
      if (selector === ":disabled") return Boolean(this.disabled);
      return false;
    }
    getBoundingClientRect() {
      return this.rect || { left: 20, top: 20, right: 180, bottom: 54, width: 160, height: 34 };
    }
    querySelectorAll(selector) {
      const out = [];
      const visit = (node) => {
        for (const child of node.children) {
          const tag = child.tagName.toLowerCase();
          if (
            selector === "*"
            || (selector.includes("img") && (tag === "img" || tag === "canvas" || tag === "svg"))
            || (selector.includes("input") && tag === "input")
            || selector === `#${child.id}`
          ) {
            out.push(child);
          }
          visit(child);
        }
      };
      visit(this);
      return out;
    }
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }
  }

  class Input extends Node {
    constructor() {
      super("input");
      this.type = "text";
      this.nativeValue = "";
      this.nativeWrites = 0;
      this.maxLength = 4;
      this.minLength = 4;
      this.rect = { left: 160, top: 24, right: 280, bottom: 56, width: 120, height: 32 };
    }
    get value() { return this.nativeValue; }
    set value(v) {
      this.nativeWrites += 1;
      this.nativeValue = v;
    }
  }

  const win = Object.assign(new EventTarget(), {
    Event,
    HTMLInputElement: Input,
    innerWidth: 1280,
    innerHeight: 720,
    performance: { now: () => 0 },
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1", backgroundImage: "none" }),
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout: () => {},
  });

  const html = new Node("html");
  const body = new Node("body");
  html.append(body);

  let img = null;
  let input = null;
  if (withCaptcha) {
    img = new Node("img");
    img.id = "captcha_img";
    img.naturalWidth = 120;
    img.naturalHeight = 40;
    img.setAttribute("src", "data:image/png;base64,iVBORw0KGgo=");
    img.rect = { left: 20, top: 20, right: 140, bottom: 60, width: 120, height: 40 };

    input = new Input();
    input.id = "captcha_code";
    input.setAttribute("placeholder", "請輸入驗證碼");
    body.append(img, input);
  }

  const doc = Object.assign(new EventTarget(), {
    defaultView: win,
    documentElement: html,
    body,
    visibilityState: "visible",
    location: { origin: "https://example.com", href: "https://example.com/login" },
    createElement: (tag) => new Node(tag),
    getElementById: (id) => html.querySelector(`#${id}`),
    querySelectorAll: (selector) => html.querySelectorAll(selector),
    querySelector: (selector) => html.querySelector(selector),
  });

  return { doc, win, img, input };
}

test("desktop page button stays completely idle on pages without inputs", async () => {
  const { doc } = createDesktopFixture({ withCaptcha: false });
  let sentCount = 0;
  const ctrl = pageButton.mountDesktopPageButton({
    doc,
    sendMessage: async () => { sentCount += 1; return { ok: true }; },
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(ctrl.getState().mounted, false);
  assert.equal(ctrl.getState().viewportListening, false);
  assert.equal(doc.getElementById(pageButton.HOST_ID), null);
  assert.equal(sentCount, 0);
  ctrl.close();
});

test("desktop page button mounts, recognizes on click, fills natively, swaps, drags, and detaches listeners on dismiss", async () => {
  const { doc, win, input } = createDesktopFixture({ withCaptcha: true });
  const events = [];
  Object.defineProperty(input, "value", {
    get: () => input.nativeValue,
    set: () => assert.fail("Must use native HTMLInputElement setter"),
  });
  input.addEventListener("input", (e) => events.push([e.type, input.value]));
  input.addEventListener("change", (e) => events.push([e.type, input.value]));

  const sent = [];
  const ctrl = pageButton.mountDesktopPageButton({
    doc,
    sendMessage: async (msg) => {
      sent.push(msg);
      return {
        ok: true,
        answer: "A7OK",
        confidence: 0.94,
        length_match: true,
        candidates: [{ answer: "A7OK" }, { answer: "A70K" }, { answer: "47OK" }],
      };
    },
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(ctrl.getState().mounted, true);
  assert.equal(ctrl.getState().viewportListening, true);
  assert.equal(sent.length, 0, "Mounting button must not wake background/WASM before user click");

  const host = doc.getElementById(pageButton.HOST_ID);
  const [, pill] = host.shadowRoot.children;
  const [dragHandle, mainRow, swapsRow] = pill.children;
  assert.equal(mainRow.children[0].textContent, "🔍 辨識");

  // Click recognize directly on page.
  mainRow.children[0].dispatchEvent(new Event("click", { cancelable: true }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "OCR_PAGE_RECOGNIZE");
  assert.equal(sent[0].expectedLength, 4);
  assert.equal(input.value, "A7OK");
  assert.deepEqual(events, [["input", "A7OK"], ["change", "A7OK"]]);
  assert.equal(mainRow.children[0].textContent, "✓ 已填入");
  assert.equal(mainRow.children[1].textContent, "A7OK");
  assert.deepEqual(swapsRow.children.map((b) => b.textContent), ["改填 A70K", "改填 47OK"]);

  // Swap candidate.
  swapsRow.children[0].dispatchEvent(new Event("click", { cancelable: true }));
  assert.equal(input.value, "A70K");

  // Drag pill via pointer events.
  const down = Object.assign(new Event("pointerdown", { cancelable: true }), { pointerId: 1, button: 0, clientX: 25, clientY: 25 });
  const move = Object.assign(new Event("pointermove", { cancelable: true }), { pointerId: 1, clientX: 300, clientY: 200 });
  const up = Object.assign(new Event("pointerup", { cancelable: true }), { pointerId: 1, clientX: 300, clientY: 200 });
  dragHandle.dispatchEvent(down);
  win.dispatchEvent(move);
  win.dispatchEvent(up);
  assert.equal(pill.style.left, "295px");
  assert.equal(pill.style.top, "195px");

  // Shortcut floating pill dismisses the page button cleanly so two pills never overlap.
  const shortcutPill = floatingPill.mountFloatingPill(
    { answer: "A70K", candidates: [{ answer: "A70K" }], inputSelectorOrToken: "#captcha_code", autoHideMs: 5000 },
    { document: doc },
  );
  assert.equal(doc.getElementById(pageButton.HOST_ID), null);
  assert.equal(ctrl.getState().viewportListening, false);
  shortcutPill.close();
  ctrl.close();
});

test("startDesktopPageButton honors pageButtonEnabled storage toggle live", async () => {
  const { doc } = createDesktopFixture({ withCaptcha: true });
  let onChangedListener = null;
  let storedEnabled = false;
  const chromeApi = {
    runtime: { sendMessage: async () => ({ ok: true, answer: "1234" }) },
    storage: {
      local: { get: async () => ({ [pageButton.PAGE_BUTTON_ENABLED_KEY]: storedEnabled }) },
      onChanged: { addListener: (fn) => { onChangedListener = fn; } },
    },
  };

  const handle = pageButton.startDesktopPageButton({ doc, chromeApi });
  await new Promise((r) => setImmediate(r));
  assert.equal(handle.getController(), null);
  assert.equal(doc.getElementById(pageButton.HOST_ID), null);

  storedEnabled = true;
  onChangedListener({ [pageButton.PAGE_BUTTON_ENABLED_KEY]: { newValue: true } }, "local");
  await new Promise((r) => setImmediate(r));
  assert.ok(handle.getController());
  assert.ok(doc.getElementById(pageButton.HOST_ID));

  onChangedListener({ [pageButton.PAGE_BUTTON_ENABLED_KEY]: { newValue: false } }, "local");
  assert.equal(handle.getController(), null);
  assert.equal(doc.getElementById(pageButton.HOST_ID), null);
});

test("focusing the account input on a login form never hijacks the target or fills the account field", async () => {
  const { doc, input: captchaInput, img } = createDesktopFixture({ withCaptcha: true });
  // Reproduce compact login card: account input at top, captcha input + image on bottom row.
  captchaInput.rect = { left: 40, top: 215, right: 215, bottom: 257, width: 175, height: 42 };
  img.rect = { left: 230, top: 215, right: 360, bottom: 257, width: 130, height: 42 };

  const InputCtor = doc.defaultView.HTMLInputElement;
  const accountInput = new InputCtor();
  accountInput.id = "account";
  accountInput.maxLength = 32;
  accountInput.minLength = 0;
  accountInput.setAttribute("autocomplete", "username");
  accountInput.rect = { left: 40, top: 80, right: 360, bottom: 122, width: 320, height: 42 };
  // Place accountInput before captchaInput in DOM order (typical login form).
  doc.body.replaceChildren(accountInput, captchaInput, img);

  const ctrl = pageButton.mountDesktopPageButton({
    doc,
    sendMessage: async () => ({
      ok: true,
      answer: "F4B6",
      confidence: 0.96,
      length_match: true,
      candidates: [{ answer: "F4B6" }],
    }),
  });
  await new Promise((r) => setImmediate(r));

  // Focus the account input (this previously hijacked preferredInput to accountInput).
  const focusEvt = new Event("focusin", { bubbles: true });
  Object.defineProperty(focusEvt, "target", { value: accountInput });
  doc.dispatchEvent(focusEvt);
  await new Promise((r) => setImmediate(r));

  const host = doc.getElementById(pageButton.HOST_ID);
  const [, pill] = host.shadowRoot.children;
  const [, mainRow] = pill.children;
  mainRow.children[0].dispatchEvent(new Event("click", { cancelable: true }));
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(accountInput.value, "", "Account input must never be filled with the CAPTCHA answer");
  assert.equal(captchaInput.value, "F4B6", "Same-row CAPTCHA input must receive the answer");
  ctrl.close();

  // Even if the captcha input is absent, an account input above the image must not match.
  doc.body.replaceChildren(accountInput, img);
  assert.equal(pageButton.detectQuickTarget(doc).ok, false);
});

test("desktop page button resets back to 辨識 after Enter advances to the next image or clears the input", async () => {
  const { doc, img, input } = createDesktopFixture({ withCaptcha: true });
  let focused = 0;
  input.focus = () => { focused += 1; };

  let round = 0;
  const ctrl = pageButton.mountDesktopPageButton({
    doc,
    sendMessage: async () => {
      round += 1;
      return {
        ok: true,
        answer: round === 1 ? "HKEF" : "JSWH",
        confidence: 0.95,
        length_match: true,
        candidates: [{ answer: round === 1 ? "HKEF" : "JSWH" }],
      };
    },
  });
  await new Promise((r) => setImmediate(r));

  const host = doc.getElementById(pageButton.HOST_ID);
  const [, pill] = host.shadowRoot.children;
  const [, mainRow] = pill.children;
  assert.equal(mainRow.children[0].textContent, "🔍 辨識");

  // Round 1: click recognize -> fills HKEF and focuses input so Enter works directly.
  mainRow.children[0].dispatchEvent(new Event("click", { cancelable: true }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ctrl.getState().mode, "result");
  assert.equal(input.value, "HKEF");
  assert.equal(focused, 1);

  // Site clears input and advances on Enter (simulating webbboxx.com).
  input.value = "";
  const enterEvt = Object.assign(new Event("keydown", { bubbles: true }), { key: "Enter" });
  doc.dispatchEvent(enterEvt);
  assert.equal(ctrl.getState().mode, "idle");
  assert.equal(mainRow.children[0].textContent, "🔍 辨識");

  // Round 2: click recognize again -> fills JSWH; then image load event resets button back to 辨識.
  mainRow.children[0].dispatchEvent(new Event("click", { cancelable: true }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ctrl.getState().mode, "result");
  assert.equal(input.value, "JSWH");

  img.setAttribute("src", "data:image/png;base64,BBBB");
  img.dispatchEvent(new Event("load"));
  assert.equal(ctrl.getState().mode, "idle");
  assert.equal(mainRow.children[0].textContent, "🔍 辨識");
  ctrl.close();
});
