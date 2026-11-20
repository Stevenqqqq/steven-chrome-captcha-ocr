(() => {
  "use strict";

  const ort = globalThis.ort;
  if (ort?.env?.wasm && typeof chrome !== "undefined" && chrome.runtime?.getURL) {
    ort.env.wasm.wasmPaths = chrome.runtime.getURL("vendor/ort/");
    ort.env.wasm.numThreads = globalThis.crossOriginIsolated && typeof SharedArrayBuffer !== "undefined" ? 2 : 1;
    ort.env.wasm.proxy = false;
  }

  const modelBaseUrl = typeof chrome !== "undefined" && chrome.runtime?.getURL
    ? chrome.runtime.getURL("models")
    : "./models";

  const runtime = BrowserOcr.createBrowserOcrRuntime({
    ort,
    modelBaseUrl,
    fetchImpl: globalThis.fetch.bind(globalThis),
  });

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

  async function handleMessage(message) {
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
        const { rgba, width, height } = await decodeDataUrlToRgba(message.imageDataUrl);
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

    return { ok: false, error: "Unsupported offscreen message", requestId: message.requestId };
  }

  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.target !== "offscreen") return false;
      handleMessage(message).then(sendResponse);
      return true;
    });
  }
})();
