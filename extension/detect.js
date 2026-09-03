(() => {
  const visible = (element) => {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none"
      && style.visibility !== "hidden"
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
    element.className || "",
    element.getAttribute("name") || "",
    element.getAttribute("alt") || "",
    element.getAttribute("title") || "",
    element.getAttribute("placeholder") || "",
    element.getAttribute("aria-label") || "",
    element.getAttribute("src") || "",
  ].join(" ").toLowerCase();

  const hintPattern = /captcha|verify|verification|vcode|auth.?code|check.?code|security.?code|驗證碼|验证码|圖形碼|校驗碼/i;
  const inputs = Array.from(document.querySelectorAll("input:not([type]), input[type='text'], input[type='tel'], input[type='search']"))
    .filter(visible);

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
    labelledBy.forEach((id) => fragments.push(document.getElementById(id)?.textContent || ""));
    return fragments.join(" ");
  };

  const localInputContext = (input) => {
    const container = input.closest(
      "tr, td, .form-group, .field, .input-group, .form-row, .control-group, .form-item",
    );
    if (container) return container.textContent || "";
    const parent = input.parentElement;
    if (!parent || ["FORM", "BODY", "HTML"].includes(parent.tagName)) return "";
    const text = parent.textContent || "";
    return text.length <= 300 ? text : "";
  };

  const inputScore = (input, image) => {
    return CaptchaDetect.scoreInputAssociation({
      metadata: textOf(input),
      labelText: associatedLabelText(input),
      localContext: localInputContext(input),
      maxLength: input.maxLength,
      hasValue: Boolean(input.value),
      imageRect: image.getBoundingClientRect(),
      inputRect: input.getBoundingClientRect(),
    });
  };

  const images = Array.from(document.querySelectorAll("img, canvas")).filter(visible);
  const hintedBackgrounds = Array.from(document.querySelectorAll("[id], [class]"))
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

    const rankedInputs = inputs
      .map((input) => ({ input, score: inputScore(input, image) }))
      .sort((a, b) => b.score - a.score);
    if (rankedInputs[0]) score += Math.min(35, rankedInputs[0].score / 2);
    return {
      image,
      input: rankedInputs[0]?.input,
      score,
      inputScore: rankedInputs[0]?.score || 0,
      inputDistance: rankedInputs[0] ? distance(rankedInputs[0].input, image) : Infinity,
    };
  }).filter((item) => item.input);

  const rankedCandidates = CaptchaDetect.rankCandidates(candidates);
  const best = rankedCandidates[0];
  if (!best || best.score < 22 || best.inputScore < 8) {
    return { ok: false, error: "找不到可見的驗證碼圖片與輸入框" };
  }

  const token = `steven-ocr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  document.querySelectorAll("[data-steven-captcha-target]").forEach((item) => {
    item.removeAttribute("data-steven-captcha-target");
  });
  best.input.setAttribute("data-steven-captcha-target", token);

  const rect = best.image.getBoundingClientRect();
  const sourceDataUrl = CaptchaDetect.originalImageDataUrl(best.image, document);
  const captchaIdentity = CaptchaDetect.imageIdentity(
    best.image,
    sourceDataUrl,
    getComputedStyle(best.image).backgroundImage,
  );
  const inputMaxLength = Number(best.input.maxLength);
  const expectedLength = Number.isInteger(inputMaxLength)
    && inputMaxLength >= 3
    && inputMaxLength <= 6
    ? inputMaxLength
    : null;
  return {
    ok: true,
    token,
    score: Math.round(best.score),
    rect: {
      left: Math.max(0, rect.left),
      top: Math.max(0, rect.top),
      width: Math.min(rect.width, innerWidth - Math.max(0, rect.left)),
      height: Math.min(rect.height, innerHeight - Math.max(0, rect.top)),
    },
    viewport: { width: innerWidth, height: innerHeight },
    sourceDataUrl,
    captchaIdentity,
    inputHasValue: Boolean(best.input.value),
    expectedLength,
  };
})();
