const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { runInNewContext } = require("node:vm");

const {
  closeAfterSuccessfulFill,
  isNewCaptcha,
  isShortcutInvocation,
  selectFrameDetection,
  startPopup,
} = require("../extension/popup_startup.js");

test("chooses the highest-scoring successful frame and retains its fill token and frame ID", () => {
  const result = selectFrameDetection([
    { frameId: 0, result: { ok: true, score: 70, token: "main" } },
    { frameId: 2, result: { ok: false, score: 900 } },
    { frameId: 3 },
    { frameId: 5, result: { ok: true, score: 100, token: "iframe" } },
  ]);
  assert.deepEqual(result, { ok: true, score: 100, token: "iframe", frameId: 5 });
  assert.equal(selectFrameDetection([{ frameId: 0 }]).ok, false);
});

test("resolves frame-score ties independently of injection result ordering", () => {
  const result = { ok: true, score: 100 };
  assert.equal(selectFrameDetection([{ frameId: 3, result }, { frameId: 0, result }]).frameId, 0);
});

test("popup requests rasterized PNG with hints and fills the chosen shadow iframe without selecting a number input", async () => {
  const popup = fs.readFileSync(path.join(__dirname, "../extension/popup.js"), "utf8");
  const png = new Blob(["rasterized"], { type: "image/png" });
  const page = new Map();
  const inputEvents = [];
  class Input {
    type = "number";
    set value(value) { this.currentValue = value; }
    get value() { return this.currentValue; }
    matches() { return false; }
    dispatchEvent(event) { inputEvents.push(event.type); }
    focus() {}
    select() { assert.fail("number input cannot be selected"); }
    removeAttribute() {}
  }
  const input = new Input();
  let saved;
  const context = {
    document: { querySelector(selector) {
      if (!page.has(selector)) page.set(selector, {
        textContent: "", addEventListener() {}, classList: { toggle() {} },
      });
      return page.get(selector);
    } },
    window: { close() {}, },
    CSS: { escape: (text) => text },
    Event,
    HTMLInputElement: Input,
    CaptchaDetect: { queryAllDeep(_document, selector) {
      assert.equal(selector, 'input[data-steven-captcha-target="frame-token"]');
      return [input];
    } },
    CaptchaImage: {
      ...require("../extension/captcha_image.js"),
      async rasterizeSvgCaptcha(markup) {
        assert.equal(markup, "<svg/>");
        return png;
      },
    },
    FeedbackHelpers: require("../extension/feedback_helpers.js"),
    PopupStartup: { ...require("../extension/popup_startup.js"), startPopup() {} },
    chrome: {
      tabs: { query: async () => [{ id: 11 }] },
      storage: { session: { async set(value) { saved = value.pendingFeedback; } } },
      scripting: {
        async executeScript({ target, files, func, args }) {
          assert.equal(target.tabId, 11);
          if (files) {
            assert.equal(target.allFrames, true);
            assert.equal(files.join(","), "site_profiles.js,detect_helpers.js,detect.js");
            return [
              { frameId: 0, result: { ok: true, score: 30 } },
              { frameId: 4, result: {
                ok: true, score: 50, token: "frame-token", svgMarkup: "<svg/>",
                expectedLength: 5, lengthMode: "max", charsetHint: "digits", caseSensitive: true,
              } },
            ];
          }
          assert.equal(target.frameIds.join(","), "4");
          return [{ result: func(...args) }];
        },
      },
    },
    fetch: async (url, request) => {
      assert.equal(url, "http://127.0.0.1:8765/recognize?expectedLength=5&lengthMode=max&charsetHint=digits&caseSensitive=1");
      assert.equal(request.body, png);
      return { ok: true, json: async () => ({ ok: true, answer: "012", length_match: false }) };
    },
  };
  await runInNewContext(popup + "\nrecognizeCurrentPage();", context);
  assert.equal(input.value, "012");
  assert.deepEqual(inputEvents, ["input", "change"]);
  assert.match(saved.captchaIdentity, /^png:[a-f0-9]{64}$/);
  assert.equal(page.get("#statusText").textContent, "已填入驗證碼");
});


test("successful filling closes the popup so Enter returns to the page", () => {
  let closeCalls = 0;

  closeAfterSuccessfulFill({
    close() {
      closeCalls += 1;
    },
  });

  assert.equal(closeCalls, 1);
});


test("recognizes only the explicit shortcut popup mode", () => {
  assert.equal(isShortcutInvocation("shortcut"), true);
  assert.equal(isShortcutInvocation("toolbar"), false);
  assert.equal(isShortcutInvocation(undefined), false);
});


test("detects a new CAPTCHA by its image identity", () => {
  const pending = { captchaIdentity: "old-image" };

  assert.equal(isNewCaptcha(pending, {
    ok: true,
    captchaIdentity: "new-image",
    inputHasValue: false,
  }), true);
  assert.equal(isNewCaptcha(pending, {
    ok: true,
    captchaIdentity: "old-image",
    inputHasValue: false,
  }), false);
});


test("an empty input upgrades legacy pending feedback without an image identity", () => {
  assert.equal(isNewCaptcha({}, { ok: true, inputHasValue: false }), true);
  assert.equal(isNewCaptcha({}, { ok: true, inputHasValue: true }), false);
  assert.equal(isNewCaptcha({}, { ok: false, inputHasValue: false }), false);
});


test("automatically recognizes once when the OCR service is ready", async () => {
  const calls = [];

  await startPopup({
    checkService: async () => {
      calls.push("check");
      return true;
    },
    recognizeCurrentPage: async () => {
      calls.push("recognize");
    },
    loadPendingFeedback: async () => null,
    showPendingFeedback: () => calls.push("show-feedback"),
  });

  assert.deepEqual(calls, ["check", "recognize"]);
});


test("shortcut clears pending feedback and recognizes the current captcha", async () => {
  const calls = [];

  const result = await startPopup({
    consumeShortcutTrigger: async () => true,
    checkService: async () => {
      calls.push("check");
      return true;
    },
    clearPendingFeedback: async () => calls.push("clear-feedback"),
    loadPendingFeedback: async () => {
      calls.push("load-feedback");
      return { reportId: "a".repeat(32), answer: "LUXO" };
    },
    showPendingFeedback: () => calls.push("show-feedback"),
    recognizeCurrentPage: async () => calls.push("recognize"),
  });

  assert.equal(result, "recognized");
  assert.deepEqual(calls, ["check", "clear-feedback", "recognize"]);
});


test("shows pending feedback instead of overwriting it with a new recognition", async () => {
  const calls = [];
  const pending = { reportId: "a".repeat(32), answer: "3L06" };

  const result = await startPopup({
    checkService: async () => true,
    loadPendingFeedback: async () => pending,
    showPendingFeedback: (value) => calls.push(["show-feedback", value]),
    recognizeCurrentPage: async () => calls.push(["recognize"]),
  });

  assert.deepEqual(calls, [["show-feedback", pending]]);
  assert.equal(result, "feedback");
});


test("a changed CAPTCHA clears prior feedback and recognizes automatically", async () => {
  const calls = [];
  const pending = {
    reportId: "a".repeat(32),
    answer: "LUXO",
    captchaIdentity: "old-image",
  };

  const result = await startPopup({
    checkService: async () => true,
    consumeShortcutTrigger: async () => false,
    loadPendingFeedback: async () => pending,
    detectNewCaptcha: async (value) => {
      calls.push(["detect", value]);
      return true;
    },
    clearPendingFeedback: async () => calls.push(["clear"]),
    showPendingFeedback: () => calls.push(["show"]),
    recognizeCurrentPage: async () => calls.push(["recognize"]),
  });

  assert.equal(result, "recognized");
  assert.deepEqual(calls, [
    ["detect", pending],
    ["clear"],
    ["recognize"],
  ]);
});


test("does not recognize when the OCR service is offline", async () => {
  let recognizeCalls = 0;

  await startPopup({
    checkService: async () => false,
    recognizeCurrentPage: async () => {
      recognizeCalls += 1;
    },
    loadPendingFeedback: async () => null,
    showPendingFeedback: () => {},
  });

  assert.equal(recognizeCalls, 0);
});


test("manifest grants storage and offscreen with wasm-unsafe-eval CSP", () => {
  const manifestPath = path.join(__dirname, "..", "extension", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  assert.ok(manifest.permissions.includes("storage"));
  assert.ok(manifest.permissions.includes("offscreen"));
  assert.match(manifest.content_security_policy?.extension_pages || "", /wasm-unsafe-eval/);
  assert.equal(manifest.version, "2.0.2");
});


test("manifest assigns Ctrl+Shift+Y to the recognition command", () => {
  const manifestPath = path.join(__dirname, "..", "extension", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  assert.equal(
    manifest.commands?.["recognize-current-page"]?.suggested_key?.default,
    "Ctrl+Shift+Y",
  );
  assert.equal(manifest.background?.service_worker, "background.js");
  assert.equal(manifest.minimum_chrome_version, "127");
});


test("shortcut popup has an explicit invocation mode and the shared scripts", () => {
  const shortcutPopupPath = path.join(__dirname, "..", "extension", "shortcut_popup.html");
  const html = fs.readFileSync(shortcutPopupPath, "utf8");

  assert.match(html, /<body data-invocation="shortcut">/);
  assert.match(html, /<script src="popup_startup\.js"><\/script>/);
  assert.match(html, /<script src="popup\.js"><\/script>/);
});
