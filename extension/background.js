(function exposeShortcutBackground(root, factory) {
  const api = factory();
  root.ShortcutBackground = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
}(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const SHORTCUT_COMMAND = "recognize-current-page";
  const DEFAULT_POPUP = "popup.html";
  const SHORTCUT_POPUP = "shortcut_popup.html";

  async function openShortcutPopup(chromeApi) {
    await chromeApi.action.setPopup({ popup: SHORTCUT_POPUP });
    try {
      await chromeApi.action.openPopup();
    } finally {
      await chromeApi.action.setPopup({ popup: DEFAULT_POPUP });
    }
  }

  function registerShortcut(chromeApi) {
    chromeApi.commands.onCommand.addListener((command) => {
      if (command !== SHORTCUT_COMMAND) return;
      openShortcutPopup(chromeApi).catch((error) => {
        console.error("無法開啟 OCR 快捷鍵彈窗", error);
      });
    });
  }

  if (typeof chrome !== "undefined" && chrome.commands) registerShortcut(chrome);

  return {
    DEFAULT_POPUP,
    SHORTCUT_COMMAND,
    SHORTCUT_POPUP,
    openShortcutPopup,
    registerShortcut,
  };
}));
