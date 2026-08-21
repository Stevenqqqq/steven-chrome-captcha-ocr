(function exposeCaptchaImage(root, factory) {
  const api = factory();
  root.CaptchaImage = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
}(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  const MAX_BASE64_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
  const MAX_DATA_URL_LENGTH = MAX_BASE64_LENGTH + 64;
  const DATA_IMAGE_PATTERN = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/i;

  function buildRecognizeUrl(baseUrl, expectedLength) {
    const text = typeof expectedLength === "number" || typeof expectedLength === "string"
      ? String(expectedLength)
      : "";
    if (!/^[3-6]$/.test(text)) return `${baseUrl}/recognize`;
    return `${baseUrl}/recognize?expectedLength=${text}`;
  }

  function decodeSafeDataImage(dataUrl) {
    if (typeof dataUrl !== "string" || dataUrl.length === 0 || dataUrl.length > MAX_DATA_URL_LENGTH) {
      throw new Error(dataUrl?.length > MAX_DATA_URL_LENGTH
        ? "原始圖片超過 5 MB"
        : "不支援的原始圖片格式");
    }

    const match = DATA_IMAGE_PATTERN.exec(dataUrl);
    if (!match || !match[2]) throw new Error("不支援的原始圖片格式");

    const payload = match[2];
    const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
    const decodedSize = Math.floor(payload.length * 3 / 4) - padding;
    if (decodedSize > MAX_IMAGE_BYTES) throw new Error("原始圖片超過 5 MB");

    let binary;
    try {
      binary = atob(payload);
    } catch {
      throw new Error("不支援的原始圖片格式");
    }
    if (binary.length > MAX_IMAGE_BYTES) throw new Error("原始圖片超過 5 MB");

    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return { type: match[1].toLowerCase(), bytes };
  }

  async function preferredCaptchaBlob(dataUrl, screenshotFallback) {
    if (dataUrl) {
      try {
        const decoded = decodeSafeDataImage(dataUrl);
        return {
          source: "original",
          blob: new Blob([decoded.bytes], { type: decoded.type }),
        };
      } catch {
        // Untrusted or unsupported page data must use the existing screenshot path.
      }
    }

    return {
      source: "screenshot",
      blob: await screenshotFallback(),
    };
  }

  return {
    MAX_IMAGE_BYTES,
    buildRecognizeUrl,
    decodeSafeDataImage,
    preferredCaptchaBlob,
  };
}));
