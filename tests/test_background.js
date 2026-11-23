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
