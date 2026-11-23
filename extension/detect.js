(async () => {
  const visible = (element) => {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none"
      && style.visibility !== "hidden"
      && style.visibility !== "collapse"
      && Number(style.opacity || "1") > 0
      && rect.width >= 20
      && rect.height >= 12
      && rect.bottom > 0
      && rect.right > 0
      && rect.top < innerHeight
      && rect.left < innerWidth;
  };

  const textOf = (element) => [
    element.id || "",
    element.getAttribute("class") || "",
    element.getAttribute("name") || "",
    element.getAttribute("alt") || "",
    element.getAttribute("title") || "",
    element.getAttribute("placeholder") || "",
    element.getAttribute("aria-label") || "",
    element.getAttribute("src") || "",
  ].join(" ").toLowerCase();

  const hintPattern = /captcha|verify|verification|vcode|auth.?code|check.?code|security.?code|驗證碼|验证码|圖形碼|校驗碼/i;
  const inputSelector = "input:not([type]), input[type='text'], input[type='tel'], input[type='search'], input[type='number']";
  const findAll = (selector) => CaptchaDetect.queryAllDeep(document, selector);
  const usableInput = (input) => !input.disabled && !input.readOnly
    && !input.matches(":disabled") && visible(input);

  const distance = (first, second) => {
    const a = first.getBoundingClientRect();
    const b = second.getBoundingClientRect();
    const ax = a.left + a.width / 2;
    const ay = a.top + a.height / 2;
    const bx = b.left + b.width / 2;
    const by = b.top + b.height / 2;
    return Math.hypot(ax - bx, ay - by);
  };

  const associatedLabelText = (input) => {
    const fragments = Array.from(input.labels || []).map((label) => label.textContent || "");
    const wrappingLabel = input.closest("label");
    if (wrappingLabel) fragments.push(wrappingLabel.textContent || "");
    const labelledBy = (input.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
    const scope = input.getRootNode();
    labelledBy.forEach((id) => fragments.push(scope.getElementById?.(id)?.textContent || ""));
    return fragments.join(" ");
  };

  const localInputContext = (input) => {
    const container = input.closest(
      "tr, td, .form-group, .field, .input-group, .form-row, .control-group, .form-item",
    );
    if (container) {
      const ownText = (container.textContent || "").trim();
      if (ownText) return ownText;
      const outer = container.parentElement;
      if (outer && !["FORM", "BODY", "HTML"].includes(outer.tagName)) {
        const outerText = (outer.textContent || "").trim();
        if (outerText.length <= 300) return outerText;
      }
    }
    let parent = input.parentElement;
    for (let depth = 0; depth < 2 && parent && !["FORM", "BODY", "HTML"].includes(parent.tagName); depth += 1) {
      const text = (parent.textContent || "").trim();
      if (text && text.length <= 300) return text;
      parent = parent.parentElement;
    }
    return "";
  };

  const inputScore = (candidate, imageRect) => {
    const { input, metadata, labelText, localContext } = candidate;
    return CaptchaDetect.scoreInputAssociation({
      metadata,
      labelText,
      localContext,
      maxLength: input.maxLength,
      hasValue: Boolean(input.value),
      imageRect,
      inputRect: candidate.rect,
    });
  };

  const nearbyCaptchaInput = (image, rect, candidate) => {
    const { input, metadata, labelText, rect: field } = candidate;
    if (!hintPattern.test(metadata + " " + labelText)) return false;
    if (input.parentNode !== image.parentNode) return false;
    const gapX = Math.max(rect.left - field.right, field.left - rect.right, 0);
    const gapY = Math.max(rect.top - field.bottom, field.top - rect.bottom, 0);
    return (gapX <= 40 && gapY === 0) || (gapY <= 24 && gapX === 0);
  };

  function heuristicCandidate() {
    const inputs = findAll(inputSelector).filter(usableInput).map((input) => ({
      input,
      metadata: textOf(input),
      labelText: associatedLabelText(input),
      localContext: localInputContext(input),
      rect: input.getBoundingClientRect(),
    }));
    const images = findAll("img, canvas, svg").filter(visible);
    const hintedBackgrounds = findAll("[id], [class]")
      .filter((element) => {
        if (!visible(element) || !hintPattern.test(textOf(element))) return false;
        return getComputedStyle(element).backgroundImage !== "none";
      });

    const candidates = [...new Set([...images, ...hintedBackgrounds])].map((image) => {
      const rect = image.getBoundingClientRect();
      const metadata = textOf(image);
      const parentText = image.closest("tr, .form-group, .field, .input-group, form")?.textContent || "";
      let score = 0;
      if (hintPattern.test(metadata)) score += 55;
      if (hintPattern.test(parentText)) score += 24;
      if (rect.width >= 45 && rect.width <= 420) score += 10;
      if (rect.height >= 18 && rect.height <= 180) score += 10;
      const ratio = rect.width / Math.max(rect.height, 1);
      if (ratio >= 1.2 && ratio <= 7) score += 8;

      let eligibleInputs = inputs;
      if (image.tagName.toLowerCase() === "svg") {
        if (rect.width < 36 || rect.width > 420 || rect.height < 16 || rect.height > 180) return null;
        if (!hintPattern.test(metadata)) {
          eligibleInputs = inputs.filter((candidate) => nearbyCaptchaInput(image, rect, candidate));
        }
      }
      const rankedInputs = eligibleInputs
        .map((candidate) => ({ input: candidate.input, score: inputScore(candidate, rect) }))
        .sort((a, b) => b.score - a.score);
      if (rankedInputs[0]) score += Math.min(35, rankedInputs[0].score / 2);
      return {
        image,
        input: rankedInputs[0]?.input,
        score,
        inputScore: rankedInputs[0]?.score || 0,
        inputDistance: rankedInputs[0] ? distance(rankedInputs[0].input, image) : Infinity,
      };
    }).filter((item) => item?.input);

    const best = CaptchaDetect.rankCandidates(candidates)[0];
    return best && best.score >= 22 && best.inputScore >= 8 ? best : null;
  }

  function candidateFromProfile(profile) {
    if (!profile) return null;
    try {
      const images = findAll(profile.imageSelector).filter(visible);
      const inputs = findAll(profile.inputSelector)
        .filter((input) => input.matches(inputSelector) && usableInput(input));
      if (images.length === 1 && inputs.length === 1 && images[0] !== inputs[0]) {
        return { image: images[0], input: inputs[0], score: 1000 };
      }
    } catch {
      // A stale or invalid selector must not prevent heuristic detection.
    }
    return null;
  }

  function screenshotGeometry(element) {
    const bounds = element.getBoundingClientRect();
    let { left, top, right, bottom } = bounds;
    let frame = window;
    while (true) {
      left = Math.max(0, left);
      top = Math.max(0, top);
      right = Math.min(frame.innerWidth, right);
      bottom = Math.min(frame.innerHeight, bottom);
      if (right <= left || bottom <= top) return { offscreen: true };
      if (frame === frame.top) {
        return {
          rect: { left, top, width: right - left, height: bottom - top },
          viewport: { width: frame.innerWidth, height: frame.innerHeight },
        };
      }
      const host = frame.frameElement;
      if (!host) return {};
      const frameBounds = host.getBoundingClientRect();
      if (!frameBounds.width || !frameBounds.height) return { offscreen: true };
      const scaleX = frameBounds.width / host.offsetWidth;
      const scaleY = frameBounds.height / host.offsetHeight;
      if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY)) return {};
      const style = frame.parent.getComputedStyle(host);
      if (style.visibility !== "visible" || Number(style.opacity) === 0) return { offscreen: true };
      const originX = frameBounds.left + (host.clientLeft + (parseFloat(style.paddingLeft) || 0)) * scaleX;
      const originY = frameBounds.top + (host.clientTop + (parseFloat(style.paddingTop) || 0)) * scaleY;
      left = originX + left * scaleX;
      right = originX + right * scaleX;
      top = originY + top * scaleY;
      bottom = originY + bottom * scaleY;
      frame = frame.parent;
    }
  }

  const injectedProfile = globalThis.__STEVEN_OCR_SITE_PROFILE__;
  delete globalThis.__STEVEN_OCR_SITE_PROFILE__;
  let profile = injectedProfile;
  if (!profile && globalThis.SiteProfiles && globalThis.chrome?.storage?.local) {
    profile = await SiteProfiles.loadProfile(chrome.storage.local, location.href).catch(() => null);
  }
  const profileCandidate = candidateFromProfile(profile);
  const best = profileCandidate || heuristicCandidate();
  const geometry = best && screenshotGeometry(best.image);
  if (!best || geometry.offscreen) {
    return { ok: false, error: "找不到可見的驗證碼圖片與輸入框" };
  }

  const token = `steven-ocr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  findAll("[data-steven-captcha-target]").forEach((item) => {
    item.removeAttribute("data-steven-captcha-target");
  });
  best.input.setAttribute("data-steven-captcha-target", token);

  const sourceDataUrl = CaptchaDetect.originalImageDataUrl(best.image, document);
  const captchaIdentity = CaptchaDetect.imageIdentity(
    best.image,
    sourceDataUrl,
    getComputedStyle(best.image).backgroundImage,
  );
  const hints = profileCandidate ? profile : CaptchaDetect.inferInputHints({
    type: best.input.type,
    inputMode: best.input.inputMode,
    pattern: best.input.pattern,
    minLength: best.input.minLength,
    maxLength: best.input.maxLength,
    metadata: best.input.getAttribute("placeholder") || "",
    labelText: associatedLabelText(best.input) + " " + (best.input.getAttribute("aria-label") || ""),
    localContext: localInputContext(best.input),
  });
  let svgMarkup;
  let svgSize;
  if (best.image.tagName.toLowerCase() === "svg") {
    try {
      const markup = new XMLSerializer().serializeToString(best.image);
      if (markup.length <= 500_000) {
        svgMarkup = markup;
        const { width, height } = best.image.getBoundingClientRect();
        svgSize = { width, height };
      }
    } catch {
      // A serialization failure can still use the screenshot.
    }
  }
  return {
    ok: true,
    token,
    score: Math.round(best.score),
    rect: geometry.rect,
    viewport: geometry.viewport,
    sourceDataUrl,
    captchaIdentity,
    inputHasValue: Boolean(best.input.value),
    expectedLength: hints.expectedLength,
    lengthMode: hints.lengthMode,
    charsetHint: hints.charsetHint,
    caseSensitive: hints.caseSensitive,
    matchedByProfile: Boolean(profileCandidate),
    ...(svgMarkup && { svgMarkup, svgSize }),
  };
})().catch(() => ({ ok: false, error: "無法在此頁框偵測驗證碼" }));
