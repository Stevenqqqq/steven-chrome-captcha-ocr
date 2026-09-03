const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  closeAfterSuccessfulFill,
  isNewCaptcha,
  isShortcutInvocation,
  startPopup,
} = require("../extension/popup_startup.js");


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


test("manifest grants storage for feedback that survives popup closure", () => {
  const manifestPath = path.join(__dirname, "..", "extension", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  assert.ok(manifest.permissions.includes("storage"));
  assert.equal(manifest.version, "1.8.2");
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
