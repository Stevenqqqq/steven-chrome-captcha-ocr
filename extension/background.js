(function exposeShortcutBackground(root, factory) {
  const api = factory();
  root.ShortcutBackground = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
}(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const SHORTCUT_COMMAND = "recognize-current-page";
  const DEFAULT_POPUP = "popup.html";
  const SHORTCUT_POPUP = "shortcut_popup.html";
  const OFFSCREEN_DOCUMENT = "offscreen.html";

  let creatingOffscreen = null;

  async function openShortcutPopup(chromeApi) {
    await chromeApi.action.setPopup({ popup: SHORTCUT_POPUP });
    try {
      await chromeApi.action.openPopup();
    } finally {
      await chromeApi.action.setPopup({ popup: DEFAULT_POPUP });
    }
  }

  async function ensureOffscreenDocument(chromeApi, path = OFFSCREEN_DOCUMENT) {
    if (!chromeApi?.offscreen?.createDocument) {
      throw new Error("目前瀏覽器版本不支援 Offscreen Document");
    }
    const offscreenUrl = chromeApi.runtime?.getURL ? chromeApi.runtime.getURL(path) : path;
    if (typeof chromeApi.runtime?.getContexts === "function") {
      const existing = await chromeApi.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [offscreenUrl],
      });
      if (existing.length > 0) return true;
    }
    if (!creatingOffscreen) {
      creatingOffscreen = chromeApi.offscreen.createDocument({
        url: path,
        reasons: ["WORKERS"],
        justification: "Run local offline onnxruntime-web WASM inference for user-triggered OCR",
      }).finally(() => {
        creatingOffscreen = null;
      });
    }
    await creatingOffscreen;
    return true;
  }

  async function forwardToOffscreen(chromeApi, payload) {
    await ensureOffscreenDocument(chromeApi);
    return chromeApi.runtime.sendMessage({
      ...payload,
      target: "offscreen",
      requestId: payload.requestId || `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
  }

  function registerShortcut(chromeApi) {
    chromeApi.commands.onCommand.addListener((command) => {
      if (command !== SHORTCUT_COMMAND) return;
      openShortcutPopup(chromeApi).catch((error) => {
        console.error("無法開啟 OCR 快捷鍵彈窗", error);
      });
    });
  }

  function registerOffscreenBridge(chromeApi) {
    if (!chromeApi?.runtime?.onMessage) return;
    chromeApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === "OCR_BG_HEALTH") {
        forwardToOffscreen(chromeApi, { type: "OCR_HEALTH", requestId: message.requestId })
          .then(sendResponse)
          .catch((error) => sendResponse({ ok: false, ready: false, error: error?.message || String(error) }));
        return true;
      }
      if (message?.type === "OCR_BG_RECOGNIZE") {
        forwardToOffscreen(chromeApi, {
          type: "OCR_RECOGNIZE",
          requestId: message.requestId,
          imageDataUrl: message.imageDataUrl,
          expectedLength: message.expectedLength,
          lengthMode: message.lengthMode,
          charsetHint: message.charsetHint,
          caseSensitive: message.caseSensitive,
        })
          .then(sendResponse)
          .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
        return true;
      }
      return false;
    });
  }

  if (typeof chrome !== "undefined" && chrome.commands) registerShortcut(chrome);
  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) registerOffscreenBridge(chrome);

  return {
    DEFAULT_POPUP,
    OFFSCREEN_DOCUMENT,
    SHORTCUT_COMMAND,
    SHORTCUT_POPUP,
    ensureOffscreenDocument,
    forwardToOffscreen,
    openShortcutPopup,
    registerOffscreenBridge,
    registerShortcut,
  };
}));
