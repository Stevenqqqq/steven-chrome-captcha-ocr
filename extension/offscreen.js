(function exposeOffscreenController(root, factory) {
  const api = factory(root);
  root.OffscreenController = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

  function createOffscreenController({
    runtime,
    decodeDataUrl,
    idleMs = IDLE_TIMEOUT_MS,
    onClose = () => root.close?.(),
    setTimer = (fn, ms) => root.setTimeout(fn, ms),
    clearTimer = (id) => root.clearTimeout(id),
  }) {
    let inFlight = 0;
    let idleTimer = null;
    let closing = false;

    function cancelIdleTimer() {
      if (idleTimer !== null) {
        clearTimer(idleTimer);
        idleTimer = null;
      }
    }

    async function shutdownForIdle() {
      idleTimer = null;
      if (inFlight > 0 || closing) return;
      closing = true;
      try {
        await runtime?.dispose?.();
      } finally {
        onClose();
      }
    }

    function scheduleIdleTimer() {
      cancelIdleTimer();
      if (closing || inFlight > 0 || !(idleMs > 0)) return;
      idleTimer = setTimer(() => {
        shutdownForIdle().catch(() => {});
      }, idleMs);
    }

    async function handleMessage(message) {
      if (closing) {
        return { ok: false, error: "Offscreen runtime is closing", requestId: message?.requestId };
      }
      cancelIdleTimer();
      inFlight += 1;
      try {
        if (message.type === "OCR_HEALTH") {
          try {
            const status = await runtime.warmUp();
            return { ...status, requestId: message.requestId };
          } catch (error) {
            return {
              ok: false,
              ready: false,
              backend: "wasm",
              models: [],
              error: error?.message || String(error),
              requestId: message.requestId,
            };
          }
        }

        if (message.type === "OCR_RECOGNIZE") {
          try {
            const { rgba, width, height } = await decodeDataUrl(message.imageDataUrl);
            const result = await runtime.recognizeRgba({
              rgba,
              width,
              height,
              expectedLength: message.expectedLength ?? null,
              lengthMode: message.lengthMode || "exact",
              charsetHint: message.charsetHint || "alphanumeric",
              caseSensitive: Boolean(message.caseSensitive),
            });
            return { ...result, requestId: message.requestId };
          } catch (error) {
            return {
              ok: false,
              error: error?.message || String(error),
              engine: "browser_onnx",
              requestId: message.requestId,
            };
          }
        }

        if (message.type === "OCR_DISPOSE") {
          if (inFlight > 1) {
            return { ok: false, busy: true, error: "OCR inference in flight", requestId: message.requestId };
          }
          closing = true;
          try {
            await runtime?.dispose?.();
          } finally {
            setTimer(() => onClose(), 0);
          }
          return { ok: true, disposed: true, requestId: message.requestId };
        }

        return { ok: false, error: "Unsupported offscreen message", requestId: message.requestId };
      } finally {
        inFlight -= 1;
        if (inFlight === 0) scheduleIdleTimer();
      }
    }

    return {
      IDLE_TIMEOUT_MS,
      handleMessage,
      scheduleIdleTimer,
      cancelIdleTimer,
      shutdownForIdle,
      getState: () => ({ inFlight, hasIdleTimer: idleTimer !== null, closing }),
    };
  }

  async function decodeDataUrlToRgba(dataUrl) {
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, bitmap.width, bitmap.height);
      ctx.drawImage(bitmap, 0, 0);
      const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      return { rgba: imageData.data, width: bitmap.width, height: bitmap.height };
    } finally {
      bitmap.close?.();
    }
  }

  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage && root.BrowserOcr) {
    const ort = root.ort;
    if (ort?.env?.wasm && chrome.runtime?.getURL) {
      ort.env.wasm.wasmPaths = chrome.runtime.getURL("vendor/ort/");
      ort.env.wasm.numThreads = root.crossOriginIsolated && typeof SharedArrayBuffer !== "undefined" ? 2 : 1;
      ort.env.wasm.proxy = false;
    }
    const modelBaseUrl = chrome.runtime?.getURL ? chrome.runtime.getURL("models") : "./models";
    const runtime = root.BrowserOcr.createBrowserOcrRuntime({
      ort,
      modelBaseUrl,
      fetchImpl: root.fetch.bind(root),
    });
    const controller = createOffscreenController({
      runtime,
      decodeDataUrl: decodeDataUrlToRgba,
      idleMs: IDLE_TIMEOUT_MS,
    });
    controller.scheduleIdleTimer();

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.target !== "offscreen") return false;
      controller.handleMessage(message).then(sendResponse);
      return true;
    });
  }

  return { IDLE_TIMEOUT_MS, createOffscreenController };
});
