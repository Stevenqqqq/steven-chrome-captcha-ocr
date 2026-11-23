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
    const source = sourceDataUrl
      || image?.currentSrc
      || image?.getAttribute?.("src")
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
    const tag = image?.tagName;
    if (tag !== "IMG" && tag !== "CANVAS") return "";
    const currentSource = tag === "IMG" ? image.currentSrc || image.getAttribute?.("src") : "";
    if (safeDataImage(currentSource)) return currentSource;

    const width = Number(tag === "IMG" ? image.naturalWidth : image.width);
    const height = Number(tag === "IMG" ? image.naturalHeight : image.height);
    if (!Number.isInteger(width)
      || !Number.isInteger(height)
      || width < 10
      || height < 10
      || width * height > MAX_IMAGE_PIXELS) {
      return "";
    }

    try {
      if (tag === "CANVAS") {
        const serialized = image.toDataURL("image/png");
        return safeDataImage(serialized) ? serialized : "";
      }
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

  function queryAllDeep(root, selector) {
    const matches = [];
    const roots = [root];
    while (roots.length) {
      const scope = roots.pop();
      if (!scope?.querySelectorAll) continue;
      for (const element of scope.querySelectorAll(selector)) matches.push(element);
      const hosts = Array.from(scope.querySelectorAll("*"));
      if (scope.shadowRoot) hosts.unshift(scope);
      for (const host of hosts.reverse()) {
        if (host.shadowRoot) roots.push(host.shadowRoot);
      }
    }
    return matches;
  }

  function inferInputHints({
    type, inputMode, pattern, minLength, maxLength, metadata, labelText, localContext,
  } = {}) {
    const min = Number(minLength);
    const max = Number(maxLength);
    const validLength = (length) => Number.isInteger(length) && length >= 3 && length <= 6;
    const regex = String(pattern || "").trim();
    const atom = String.raw`(?:\\[dws]|\[\S+\]|[A-Za-z0-9.])`;
    const fixedPattern = new RegExp(String.raw`^\^?(?:\((?:\?:)?${atom}\)|${atom})\{([3-6])\}\$?$`);
    const patternLength = Number(fixedPattern.exec(regex)?.[1]);
    const exactLengthText = /(^|[^\d])([3-6])\s*(?:[碼码位]|digits?\b|characters?\b)/i;
    let statedLength = null;
    for (const source of [labelText, metadata, localContext]) {
      const text = String(source || "")
        .replace(/(?:最多|至多|最少|至少|上限|up to|at most|at least|max(?:imum)?)\s*[:：]?\s*[3-6]/gi, "")
        .replace(/\d+\s*[-–~～至到]\s*[3-6]/g, "");
      const match = exactLengthText.exec(text);
      if (match) {
        statedLength = Number(match[2]);
        break;
      }
    }
    const exactLength = (min === max && validLength(min) ? min : null)
      || patternLength || statedLength;
    const expectedLength = exactLength || (validLength(max) ? max : null);

    const digitsAtom = String.raw`(?:\\d|\[[0-9-]+\]|[0-9])`;
    const lettersAtom = String.raw`(?:\[[A-Za-z-]+\]|[A-Za-z])`;
    const alnumAtom = String.raw`(?:\\w|\[(?:0-9A-Za-z|A-Za-z0-9|a-zA-Z0-9|0-9a-zA-Z|A-Z0-9|0-9A-Z|a-z0-9|0-9a-z-)+\])`;
    const isPatternFor = (characterAtom) => new RegExp(
      String.raw`^\^?(?:\((?:\?:)?${characterAtom}\)|${characterAtom})(?:[+*?]|\{\d+(?:,\d*)?\})?\$?$`,
    ).test(regex);
    const text = [labelText, metadata, localContext].filter(Boolean).join(" ");
    const positiveLetterText = text.replace(
      /(?:請勿|不要|不可|勿)\s*(?:輸入)?\s*英文|\b(?:no|not|without)\s+letters?\b/gi,
      "",
    );
    const mixedText = isPatternFor(alnumAtom)
      || /英數|英数|字母與數字|字母和數字|字母与数字|alphanumeric/i.test(text)
      || (/(?:[a-z]*letters?|alphabetic|字母|英文)/i.test(positiveLetterText) && /數字|数字|digits?|numeric/i.test(text));
    const digitsText = /純[數数]字|[數数]字[驗验][證证][碼码]|\bdigits? only\b|\b\d+\s+digits?\b|\bnumeric\b/i.test(text);
    const explicitDigits = /^(?:number)$/i.test(type || "") || /^(?:numeric)$/i.test(inputMode || "");
    let charsetHint = "alphanumeric";
    if (explicitDigits || isPatternFor(digitsAtom) || (!mixedText && digitsText)) {
      charsetHint = "digits";
    } else if (
      isPatternFor(lettersAtom)
      || (!mixedText && /純英文|英文字母|(?:請輸入|輸入|為)英文|英文\s*(?:驗證碼|验证码)|letters? only|\b(?:enter|input)\s+letters\b/i.test(positiveLetterText))
    ) {
      charsetHint = "letters";
    }
    const caseSensitive = /(?:區分大小寫|区分大小写|\bcase[- ]sensitive\b)/i.test(
      text.replace(/不\s*(?:區分大小寫|区分大小写)|\bnot\s+case[- ]sensitive\b/gi, ""),
    );
    return {
      expectedLength,
      lengthMode: exactLength ? "exact" : expectedLength ? "max" : "unknown",
      charsetHint,
      caseSensitive,
    };
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
    if (candidate?.disabled || candidate?.readOnly) return Number.NEGATIVE_INFINITY;
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
    queryAllDeep,
    inferInputHints,
    compareCandidates,
    rankCandidates,
    scoreInputAssociation,
  };
}));
