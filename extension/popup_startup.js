(function exposePopupStartup(root, factory) {
  const api = factory();
  root.PopupStartup = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
}(typeof globalThis !== "undefined" ? globalThis : this, () => {
  function isShortcutInvocation(invocation) {
    return invocation === "shortcut";
  }

  function isNewCaptcha(pendingFeedback, detection) {
    if (!detection?.ok) return false;
    if (pendingFeedback?.captchaIdentity && detection.captchaIdentity) {
      return pendingFeedback.captchaIdentity !== detection.captchaIdentity;
    }
    return detection.inputHasValue === false;
  }

  function closeAfterSuccessfulFill(windowRef) {
    if (typeof windowRef?.close === "function") windowRef.close();
  }

  async function startPopup({
    checkService,
    consumeShortcutTrigger,
    clearPendingFeedback,
    loadPendingFeedback,
    detectNewCaptcha,
    showPendingFeedback,
    recognizeCurrentPage,
  }) {
    const shortcutTriggered = consumeShortcutTrigger
      ? await consumeShortcutTrigger()
      : false;
    const serviceReady = await checkService();
    if (!serviceReady) return false;
    if (shortcutTriggered) {
      if (clearPendingFeedback) await clearPendingFeedback();
      await recognizeCurrentPage();
      return "recognized";
    }
    const pendingFeedback = await loadPendingFeedback();
    if (pendingFeedback) {
      const newCaptcha = detectNewCaptcha
        ? await detectNewCaptcha(pendingFeedback)
        : false;
      if (newCaptcha) {
        if (clearPendingFeedback) await clearPendingFeedback();
        await recognizeCurrentPage();
        return "recognized";
      }
      showPendingFeedback(pendingFeedback);
      return "feedback";
    }
    await recognizeCurrentPage();
    return "recognized";
  }

  return {
    closeAfterSuccessfulFill,
    isNewCaptcha,
    isShortcutInvocation,
    startPopup,
  };
}));
