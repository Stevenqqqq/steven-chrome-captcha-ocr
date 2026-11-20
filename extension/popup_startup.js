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

  function selectFrameDetection(injections) {
    let best = null;
    for (const { result, frameId } of injections) {
      if (!result?.ok || !Number.isFinite(result.score) || !Number.isInteger(frameId)) continue;
      if (!best || result.score > best.score
        || (result.score === best.score && frameId < best.frameId)) {
        best = { ...result, frameId };
      }
    }
    return best || { ok: false, error: "找不到可見的驗證碼圖片與輸入框" };
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
    selectFrameDetection,
    startPopup,
  };
}));
