(function exposeCaptchaDetect(root, factory) {
  const api = factory();
  root.CaptchaDetect = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
}(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const MAX_IMAGE_PIXELS = 2_000_000;
  const MAX_DATA_URL_LENGTH = 7_000_000;
  const SAFE_DATA_IMAGE_PATTERN = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]*={0,2}$/i;
  const CAPTCHA_HINT_PATTERN = /captcha|verify|verification|vcode|auth.?code|check.?code|security.?code|驗證碼|验证码|圖形碼|校驗碼/i;
  const NON_CAPTCHA_INPUT_PATTERN = /user|username|account|login|employee|student|email|phone|mobile|password|帳號|帐号|學號|学号|工號|工号|密碼|密码|電子郵件|手機/i;

  function safeDataImage(dataUrl) {
    return typeof dataUrl === "string"
      && dataUrl.length > 0
      && dataUrl.length <= MAX_DATA_URL_LENGTH
      && SAFE_DATA_IMAGE_PATTERN.test(dataUrl);
  }

  function imageIdentity(image, sourceDataUrl = "", backgroundImage = "") {
    const source = image?.currentSrc
      || image?.getAttribute?.("src")
      || sourceDataUrl
      || (backgroundImage !== "none" ? backgroundImage : "")
      || "";
    if (!source) return "";

    let hash = 2166136261;
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    const width = Number(image?.naturalWidth || image?.width || 0);
    const height = Number(image?.naturalHeight || image?.height || 0);
    return `${image?.tagName || "ELEMENT"}:${width}x${height}:${source.length}:${(hash >>> 0).toString(16)}`;
  }

  function originalImageDataUrl(image, documentRef) {
    if (!image || image.tagName !== "IMG") return "";
    const currentSource = image.currentSrc || image.getAttribute?.("src") || "";
    if (safeDataImage(currentSource)) return currentSource;

    const width = Number(image.naturalWidth);
    const height = Number(image.naturalHeight);
    if (!Number.isInteger(width)
      || !Number.isInteger(height)
      || width < 10
      || height < 10
      || width * height > MAX_IMAGE_PIXELS) {
      return "";
    }

    try {
      const canvas = documentRef.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) return "";
      context.drawImage(image, 0, 0, width, height);
      const serialized = canvas.toDataURL("image/png");
      return safeDataImage(serialized) ? serialized : "";
    } catch {
      // Cross-origin images taint canvas; the caller must use screenshot fallback.
      return "";
    }
  }

  function finiteCandidateValue(candidate, key, fallback) {
    const value = Number(candidate?.[key]);
    return Number.isFinite(value) ? value : fallback;
  }

  function rectCenter(rect) {
    return {
      x: Number(rect?.left || 0) + Number(rect?.width || 0) / 2,
      y: Number(rect?.top || 0) + Number(rect?.height || 0) / 2,
    };
  }

  function scoreInputAssociation(candidate) {
    const metadata = String(candidate?.metadata || "");
    const labelText = String(candidate?.labelText || "");
    const localContext = String(candidate?.localContext || "");
    const semanticText = `${metadata} ${labelText}`;
    let score = 0;

    if (CAPTCHA_HINT_PATTERN.test(metadata)) score += 55;
    if (CAPTCHA_HINT_PATTERN.test(labelText)) score += 70;
    if (CAPTCHA_HINT_PATTERN.test(localContext)) score += 30;
    if (NON_CAPTCHA_INPUT_PATTERN.test(semanticText)) score -= 90;
    if (candidate?.hasValue) score -= 35;

    const maxLength = Number(candidate?.maxLength || 0);
    if (maxLength >= 3 && maxLength <= 8) score += 20;

    const imageRect = candidate?.imageRect || {};
    const inputRect = candidate?.inputRect || {};
    const imageCenter = rectCenter(imageRect);
    const inputCenter = rectCenter(inputRect);
    const horizontal = imageCenter.x - inputCenter.x;
    const vertical = Math.abs(imageCenter.y - inputCenter.y);
    const distance = Math.hypot(horizontal, vertical);
    score += Math.max(0, 30 - distance / 12);

    const rowTolerance = Math.max(
      24,
      Math.min(Number(imageRect.height || 0), Number(inputRect.height || 0)) * 1.25,
    );
    const sameRow = vertical <= rowTolerance;
    if (sameRow) {
      score += 60;
      const gap = Number(imageRect.left || 0)
        - (Number(inputRect.left || 0) + Number(inputRect.width || 0));
      if (gap >= -24 && gap <= 180) score += 35;
      if (horizontal >= -20) score += 10;
    } else {
      score -= Math.min(45, vertical / 5);
    }
    return score;
  }

  function compareCandidates(first, second) {
    const firstScore = finiteCandidateValue(first, "score", Number.NEGATIVE_INFINITY);
    const secondScore = finiteCandidateValue(second, "score", Number.NEGATIVE_INFINITY);
    if (firstScore !== secondScore) return secondScore > firstScore ? 1 : -1;

    const firstInputScore = finiteCandidateValue(first, "inputScore", Number.NEGATIVE_INFINITY);
    const secondInputScore = finiteCandidateValue(second, "inputScore", Number.NEGATIVE_INFINITY);
    if (firstInputScore !== secondInputScore) return secondInputScore > firstInputScore ? 1 : -1;

    const firstInputDistance = finiteCandidateValue(first, "inputDistance", Number.POSITIVE_INFINITY);
    const secondInputDistance = finiteCandidateValue(second, "inputDistance", Number.POSITIVE_INFINITY);
    if (firstInputDistance !== secondInputDistance) return firstInputDistance > secondInputDistance ? 1 : -1;

    return 0;
  }

  function rankCandidates(candidates) {
    return [...candidates].sort(compareCandidates);
  }

  return {
    imageIdentity,
    originalImageDataUrl,
    compareCandidates,
    rankCandidates,
    scoreInputAssociation,
  };
}));
