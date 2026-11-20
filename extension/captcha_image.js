(function exposeCaptchaImage(root, factory) {
  const api = factory();
  root.CaptchaImage = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
}(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  const MAX_BASE64_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
  const MAX_DATA_URL_LENGTH = MAX_BASE64_LENGTH + 64;
  const DATA_IMAGE_PATTERN = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/i;

  function buildRecognizeUrl(baseUrl, expectedLengthOrOptions) {
    const options = expectedLengthOrOptions && typeof expectedLengthOrOptions === "object"
      ? expectedLengthOrOptions
      : null;
    const expectedLength = options ? options.expectedLength : expectedLengthOrOptions;
    const text = typeof expectedLength === "number" || typeof expectedLength === "string"
      ? String(expectedLength)
      : "";
    const params = new URLSearchParams();
    if (/^[3-6]$/.test(text)) params.set("expectedLength", text);
    if (["exact", "max", "unknown"].includes(options?.lengthMode)) params.set("lengthMode", options.lengthMode);
    if (["alphanumeric", "digits", "letters"].includes(options?.charsetHint)) params.set("charsetHint", options.charsetHint);
    if (options?.caseSensitive === true) params.set("caseSensitive", "1");
    const query = params.toString();
    return baseUrl + "/recognize" + (query ? "?" + query : "");
  }

  async function rasterizeSvgCaptcha(markup, size) {
    const width = Math.round(size?.width);
    const height = Math.round(size?.height);
    if (typeof markup !== "string" || !markup || markup.length > 500_000
      || /<!DOCTYPE/i.test(markup) || !(width >= 10 && height >= 10 && width * height <= 2_000_000)) {
      throw new Error("SVG 驗證碼格式或尺寸無效");
    }
    const svg = new DOMParser().parseFromString(markup, "image/svg+xml").documentElement;
    if (svg.localName !== "svg" || svg.namespaceURI !== "http://www.w3.org/2000/svg") {
      throw new Error("無法讀取 SVG 驗證碼");
    }
    svg.setAttribute("width", width);
    svg.setAttribute("height", height);
    // Use the browser's restricted SVG image context, never insert markup into the popup DOM.
    const objectUrl = URL.createObjectURL(new Blob(
      [new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" },
    ));
    try {
      const image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error("無法讀取 SVG 驗證碼"));
        image.src = objectUrl;
      });
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { alpha: false });
      context.fillStyle = "#fff";
      context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      const png = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!png || png.type !== "image/png" || png.size > MAX_IMAGE_BYTES) {
        throw new Error("無法建立 SVG 驗證碼的 PNG 圖片");
      }
      return png;
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  async function blobIdentity(blob) {
    const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return "png:" + Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
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
    rasterizeSvgCaptcha,
    blobIdentity,
  };
}));
