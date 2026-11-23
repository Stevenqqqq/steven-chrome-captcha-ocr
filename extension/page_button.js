(function exposeDesktopPageButton(root, factory) {
  const api = factory(root);
  root.StevenOcrPageButton = api;
  if (typeof module === "object" && module.exports) module.exports = api;
  if (
    !root.__STEVEN_OCR_DISABLE_AUTOSTART__
    && typeof root.document !== "undefined"
    && root.document?.documentElement
    && typeof chrome !== "undefined"
    && chrome.runtime?.sendMessage
  ) {
    api.startDesktopPageButton();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const HOST_ID = "steven-ocr-page-button-host";
  const SHORTCUT_PILL_HOST_ID = "steven-ocr-pill-host";
  const DISPOSE_SYMBOL = Symbol.for("steven-ocr-page-button.dispose");
  const PAGE_BUTTON_ENABLED_KEY = "pageButtonEnabled";
  const SITE_PROFILES_KEY = "siteProfiles";
  const VIEWPORT_MARGIN = 12;
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  const HINT_PATTERN = /captcha|verify|verification|vcode|auth.?code|check.?code|security.?code|驗證碼|验证码|圖形碼|校驗碼/i;
  const INPUT_SELECTOR = "input:not([type]), input[type='text'], input[type='tel'], input[type='search'], input[type='number']";

  const PILL_CSS = `
    :host {
      all: initial;
      --ocr-popover: #171c25;
      --ocr-secondary: #1b222d;
      --ocr-secondary-hover: #242e3d;
      --ocr-border: #2a3444;
      --ocr-fg: #eef2f7;
      --ocr-muted: #8f9cad;
      --ocr-primary: #3b82f6;
      --ocr-primary-hover: #2563eb;
      --ocr-success: #22c55e;
      --ocr-warning: #f59e0b;
      --ocr-danger: #ef4444;
      --ocr-font-sans: "Segoe UI", "Microsoft JhengHei UI", system-ui, -apple-system, sans-serif;
      --ocr-font-mono: Consolas, "Cascadia Mono", ui-monospace, monospace;
      direction: ltr !important;
      display: block !important;
      position: fixed !important;
      inset: 0 !important;
      pointer-events: none !important;
      z-index: 2147483646 !important;
    }
    .pill {
      position: fixed;
      box-sizing: border-box;
      width: max-content;
      max-width: calc(100vw - 24px);
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      padding: 6px 9px;
      border: 1px solid rgba(59, 130, 246, 0.45);
      border-radius: 10px;
      background: var(--ocr-popover);
      box-shadow: 0 10px 26px rgba(0, 0, 0, 0.45);
      color: var(--ocr-fg);
      font: 12px var(--ocr-font-sans);
      pointer-events: auto;
      user-select: none;
    }
    .drag-handle {
      display: inline-flex;
      align-items: center;
      padding: 2px 3px;
      color: var(--ocr-muted);
      font-size: 13px;
      line-height: 1;
      cursor: grab;
      touch-action: none;
    }
    .drag-handle:active { cursor: grabbing; color: var(--ocr-fg); }
    .row { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
    .row[hidden] { display: none; }
    .badge {
      border-radius: 999px;
      padding: 2px 7px;
      font-size: 11px;
      font-weight: 700;
      white-space: nowrap;
    }
    .badge-ok { background: rgba(34, 197, 94, 0.16); border: 1px solid rgba(34, 197, 94, 0.35); color: var(--ocr-success); }
    .badge-warn { background: rgba(245, 158, 11, 0.16); border: 1px solid rgba(245, 158, 11, 0.35); color: var(--ocr-warning); }
    .badge-err { background: rgba(239, 68, 68, 0.16); border: 1px solid rgba(239, 68, 68, 0.35); color: var(--ocr-danger); }
    .answer { font: 700 13px var(--ocr-font-mono); letter-spacing: 0.04em; overflow-wrap: anywhere; }
    .status-text { font-size: 11.5px; color: var(--ocr-muted); max-width: 240px; overflow-wrap: anywhere; }
    button {
      cursor: pointer;
      border-radius: 6px;
      padding: 3px 8px;
      font: 600 11.5px var(--ocr-font-sans);
      transition: background 0.12s ease, border-color 0.12s ease;
    }
    .primary-btn {
      background: var(--ocr-primary);
      border: 1px solid rgba(96, 165, 250, 0.55);
      color: #ffffff;
    }
    .primary-btn:hover { background: var(--ocr-primary-hover); }
    .swap-btn {
      background: var(--ocr-secondary);
      border: 1px solid var(--ocr-border);
      color: var(--ocr-fg);
      font-family: var(--ocr-font-mono);
    }
    .swap-btn:hover { background: var(--ocr-secondary-hover); border-color: rgba(59, 130, 246, 0.55); }
    .icon-btn {
      background: transparent;
      border: 1px solid transparent;
      color: var(--ocr-muted);
      padding: 2px 6px;
      font-size: 13px;
      line-height: 1.1;
    }
    .icon-btn:hover { background: rgba(255, 255, 255, 0.08); color: var(--ocr-fg); }
  `;

  function clamp(value, extent, size) {
    return Math.max(VIEWPORT_MARGIN, Math.min(value, extent - size - VIEWPORT_MARGIN));
  }

  function rectsOverlap(a, b) {
    if (!a || !b) return false;
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  function computePillPosition(inputRect, viewport, pillSize, imageRect = null) {
    if (
      !Number.isFinite(inputRect?.left)
      || !Number.isFinite(inputRect?.bottom)
      || inputRect.width === 0
      || inputRect.height === 0
    ) {
      return { right: 20, bottom: 20 };
    }
    const vw = Number.isFinite(viewport?.width) && viewport.width > 0 ? viewport.width : 1280;
    const vh = Number.isFinite(viewport?.height) && viewport.height > 0 ? viewport.height : 720;
    const pw = Number.isFinite(pillSize?.width) && pillSize.width > 0 ? pillSize.width : 160;
    const ph = Number.isFinite(pillSize?.height) && pillSize.height > 0 ? pillSize.height : 34;

    const belowLeft = clamp(inputRect.left, vw, pw);
    const belowTop = clamp(inputRect.bottom + 6, vh, ph);
    const hasImage = Boolean(
      imageRect
      && Number.isFinite(imageRect.left)
      && Number.isFinite(imageRect.top)
      && imageRect.width > 0
      && imageRect.height > 0,
    );
    if (!hasImage) return { left: belowLeft, top: belowTop };

    const imageBox = {
      left: imageRect.left - 4,
      top: imageRect.top - 4,
      right: (imageRect.right ?? imageRect.left + imageRect.width) + 4,
      bottom: (imageRect.bottom ?? imageRect.top + imageRect.height) + 4,
    };
    const inputTop = Number.isFinite(inputRect.top) ? inputRect.top : inputRect.bottom - inputRect.height;
    const inputRight = Number.isFinite(inputRect.right) ? inputRect.right : inputRect.left + inputRect.width;
    const placements = [
      { left: belowLeft, top: belowTop },
      { left: clamp(inputRight + 8, vw, pw), top: clamp(inputTop, vh, ph) },
      { left: clamp(inputRight - pw, vw, pw), top: clamp(inputTop - ph - 8, vh, ph) },
      { left: clamp(inputRect.left, vw, pw), top: clamp(inputTop - ph - 8, vh, ph) },
      { left: clamp(imageBox.right + 6, vw, pw), top: clamp(inputTop, vh, ph) },
    ];
    for (const pos of placements) {
      const pillBox = { left: pos.left, top: pos.top, right: pos.left + pw, bottom: pos.top + ph };
      if (!rectsOverlap(pillBox, imageBox)) return pos;
    }
    return { left: belowLeft, top: belowTop };
  }

  function buildSwapCandidates(currentAnswer, candidates) {
    const seen = new Set([currentAnswer]);
    const isPureDigits = typeof currentAnswer === "string" && /^[0-9]+$/.test(currentAnswer);
    const swaps = [];
    for (const candidate of candidates || []) {
      const answer = candidate?.answer;
      if (typeof answer !== "string" || !answer.trim() || seen.has(answer)) continue;
      if (isPureDigits && answer.length === currentAnswer.length && !/^[0-9]+$/.test(answer)) {
        const folded = answer.replace(/[OoQq]/g, "0").replace(/[Il|]/g, "1").replace(/[Zz]/g, "2").replace(/[Ss]/g, "5").replace(/[Bb]/g, "8");
        if (folded === currentAnswer) continue;
      }
      seen.add(answer);
      swaps.push(candidate);
      if (swaps.length === 2) break;
    }
    return swaps;
  }

  function isVisible(element, win) {
    if (!element || element.isConnected === false) return false;
    const style = win.getComputedStyle?.(element);
    if (style && (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity || "1") <= 0)) {
      return false;
    }
    const rect = element.getBoundingClientRect?.();
    if (!rect) return false;
    return rect.width >= 20
      && rect.height >= 12
      && rect.bottom > 0
      && rect.right > 0
      && rect.top < (win.innerHeight || 10000)
      && rect.left < (win.innerWidth || 10000);
  }

  function editableInput(input) {
    if (!input || input.tagName?.toLowerCase() !== "input") return false;
    const type = String(input.type || "text").toLowerCase();
    if (!["", "text", "tel", "search", "number"].includes(type)) return false;
    return !input.disabled && !input.readOnly && !input.matches?.(":disabled") && input.isConnected !== false;
  }

  function textOf(el) {
    if (!el) return "";
    return [
      el.id || "",
      el.getAttribute?.("class") || "",
      el.getAttribute?.("name") || "",
      el.getAttribute?.("alt") || "",
      el.getAttribute?.("title") || "",
      el.getAttribute?.("placeholder") || "",
      el.getAttribute?.("aria-label") || "",
      el.getAttribute?.("src") || "",
    ].join(" ").toLowerCase();
  }

  function associatedLabelText(input) {
    const parts = Array.from(input.labels || []).map((l) => l.textContent || "");
    const wrap = input.closest?.("label");
    if (wrap) parts.push(wrap.textContent || "");
    const ids = (input.getAttribute?.("aria-labelledby") || "").split(/\s+/).filter(Boolean);
    const scope = input.getRootNode?.();
    ids.forEach((id) => parts.push(scope?.getElementById?.(id)?.textContent || ""));
    return parts.join(" ");
  }

  function localInputContext(input) {
    const container = input.closest?.("tr, td, .form-group, .field, .input-group, .form-row, .control-group, .form-item");
    if (container) {
      const text = (container.textContent || "").trim();
      if (text && text.length <= 300) return text;
    }
    const parent = input.parentElement;
    if (parent && !["FORM", "BODY", "HTML"].includes(parent.tagName)) {
      const text = (parent.textContent || "").trim();
      if (text && text.length <= 300) return text;
    }
    return "";
  }

  function inferQuickHints(input) {
    const type = String(input.type || "").toLowerCase();
    const inputMode = String(input.inputMode || "").toLowerCase();
    const pattern = String(input.getAttribute?.("pattern") || "");
    const text = `${input.getAttribute?.("placeholder") || ""} ${associatedLabelText(input)} ${localInputContext(input)}`;
    const maxLen = Number(input.maxLength);
    const minLen = Number(input.minLength);
    let expectedLength = null;
    let lengthMode = "unknown";
    if (Number.isInteger(maxLen) && maxLen >= 1 && maxLen <= 12) {
      expectedLength = maxLen;
      lengthMode = minLen === maxLen ? "exact" : "max";
    } else {
      const m = /(\d)\s*(?:位|碼|個?字)/.exec(text);
      if (m) {
        expectedLength = Number(m[1]);
        lengthMode = "exact";
      }
    }
    let charsetHint = "alphanumeric";
    if (type === "number" || inputMode === "numeric" || /^\^?(?:\\d|\[0-9\])/.test(pattern) || /純數字|數字驗證碼/.test(text)) {
      charsetHint = "digits";
    } else if (/純英文|純字母|英文字母/.test(text)) {
      charsetHint = "letters";
    }
    const caseSensitive = /區分大小寫|区分大小写|case[- ]?sensitive/i.test(text);
    return { expectedLength, lengthMode, charsetHint, caseSensitive };
  }

  function scorePair(image, input, win) {
    const imgRect = image.getBoundingClientRect();
    const inpRect = input.getBoundingClientRect();
    const imgMeta = textOf(image);
    const inpMeta = textOf(input);
    const inpLabel = associatedLabelText(input);
    const inpContext = localInputContext(input);
    const parentText = image.closest?.("tr, .form-group, .field, .input-group, form")?.textContent || "";

    let imgScore = 0;
    if (HINT_PATTERN.test(imgMeta)) imgScore += 55;
    if (HINT_PATTERN.test(parentText)) imgScore += 24;
    if (imgRect.width >= 45 && imgRect.width <= 420) imgScore += 10;
    if (imgRect.height >= 18 && imgRect.height <= 180) imgScore += 10;
    const ratio = imgRect.width / Math.max(imgRect.height, 1);
    if (ratio >= 1.2 && ratio <= 7) imgScore += 8;

    let inpScore = 0;
    if (HINT_PATTERN.test(inpMeta)) inpScore += 42;
    if (HINT_PATTERN.test(inpLabel)) inpScore += 36;
    if (HINT_PATTERN.test(inpContext)) inpScore += 22;
    if (input.maxLength >= 3 && input.maxLength <= 8) inpScore += 12;

    const dx = (imgRect.left + imgRect.width / 2) - (inpRect.left + inpRect.width / 2);
    const dy = (imgRect.top + imgRect.height / 2) - (inpRect.top + inpRect.height / 2);
    const dist = Math.hypot(dx, dy);
    if (dist <= 260) inpScore += 16;
    else if (dist <= 480) inpScore += 8;

    if (image.tagName?.toLowerCase() === "svg") {
      if (imgRect.width < 36 || imgRect.width > 420 || imgRect.height < 16 || imgRect.height > 180) return null;
      if (!HINT_PATTERN.test(imgMeta) && !HINT_PATTERN.test(`${inpMeta} ${inpLabel}`)) return null;
    }

    const total = imgScore + Math.min(35, inpScore / 2);
    const hasHint = HINT_PATTERN.test(imgMeta) || HINT_PATTERN.test(inpMeta) || HINT_PATTERN.test(inpLabel) || HINT_PATTERN.test(inpContext);
    if (!hasHint || total < 34 || inpScore < 16 || dist > 620) return null;
    return { image, input, score: total, distance: dist };
  }

  function detectQuickTarget(doc, { preferredInput = null, profile = null } = {}) {
    const win = doc?.defaultView || root;
    if (!doc) return { ok: false };

    if (profile?.imageSelector && profile?.inputSelector) {
      try {
        const imgs = Array.from(doc.querySelectorAll(profile.imageSelector)).filter((el) => isVisible(el, win));
        const inps = Array.from(doc.querySelectorAll(profile.inputSelector)).filter((el) => editableInput(el) && isVisible(el, win));
        if (imgs.length === 1 && inps.length === 1 && imgs[0] !== inps[0]) {
          return {
            ok: true,
            image: imgs[0],
            input: inps[0],
            hints: {
              expectedLength: profile.expectedLength ?? null,
              lengthMode: profile.lengthMode || "exact",
              charsetHint: profile.charsetHint || "alphanumeric",
              caseSensitive: Boolean(profile.caseSensitive),
            },
            matchedByProfile: true,
          };
        }
      } catch {
        // Ignore stale profile selectors and continue with heuristic scan.
      }
    }

    let inputs;
    if (preferredInput && editableInput(preferredInput) && isVisible(preferredInput, win)) {
      inputs = [preferredInput];
    } else {
      inputs = Array.from(doc.querySelectorAll(INPUT_SELECTOR)).filter((el) => editableInput(el) && isVisible(el, win)).slice(0, 24);
    }
    if (!inputs.length) return { ok: false };

    const images = Array.from(doc.querySelectorAll("img, canvas, svg")).filter((el) => isVisible(el, win)).slice(0, 48);
    let best = null;
    for (const input of inputs) {
      for (const image of images) {
        const pair = scorePair(image, input, win);
        if (!pair) continue;
        if (!best || pair.score > best.score || (pair.score === best.score && pair.distance < best.distance)) {
          best = pair;
        }
      }
    }
    if (!best) return { ok: false };
    return {
      ok: true,
      image: best.image,
      input: best.input,
      hints: inferQuickHints(best.input),
      matchedByProfile: false,
    };
  }

  function extractCssBackgroundUrl(value) {
    const match = /url\((['"]?)(.*?)\1\)/i.exec(String(value || ""));
    return match ? match[2].trim() : "";
  }

  function blobToDataUrl(blob, win = root) {
    if (typeof win.FileReader === "function") {
      return new Promise((resolve, reject) => {
        const reader = new win.FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("無法讀取圖片內容"));
        reader.readAsDataURL(blob);
      });
    }
    return blob.arrayBuffer().then((buf) => {
      const bytes = new Uint8Array(buf);
      let bin = "";
      for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
      return `data:${blob.type || "image/png"};base64,${btoa(bin)}`;
    });
  }

  function drawToPngDataUrl(source, width, height, doc) {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (w < 10 || h < 10 || w * h > 2_000_000) throw new Error("圖片尺寸無效");
    const canvas = doc.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(source, 0, 0, w, h);
    return canvas.toDataURL("image/png");
  }

  async function extractImageDataUrl(image, { doc = root.document, fetchImpl = root.fetch } = {}) {
    if (!image) throw new Error("找不到目標圖片");
    const win = doc?.defaultView || root;
    const tag = image.tagName?.toUpperCase();

    if (tag === "CANVAS") {
      return drawToPngDataUrl(image, Number(image.width), Number(image.height), doc);
    }

    if (tag === "SVG") {
      const Serializer = win.XMLSerializer || root.XMLSerializer;
      const markup = new Serializer().serializeToString(image);
      if (markup.length > 500_000 || /<!doctype|<script|<foreignObject|javascript:/i.test(markup)) {
        throw new Error("不支援此 SVG 圖片，請按 Ctrl+Shift+Y");
      }
      const rect = image.getBoundingClientRect();
      const urlApi = win.URL || root.URL;
      const blobUrl = urlApi.createObjectURL(new Blob([markup], { type: "image/svg+xml;charset=utf-8" }));
      try {
        const ImageCtor = win.Image || root.Image;
        const img = new ImageCtor();
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = () => reject(new Error("無法轉繪 SVG 圖片，請按 Ctrl+Shift+Y"));
          img.src = blobUrl;
        });
        return drawToPngDataUrl(img, rect.width || img.naturalWidth, rect.height || img.naturalHeight, doc);
      } finally {
        urlApi.revokeObjectURL(blobUrl);
      }
    }

    let sourceUrl = "";
    if (tag === "IMG") {
      sourceUrl = image.currentSrc || image.getAttribute?.("src") || "";
      if (/^data:image\/(?:png|jpeg|webp);base64,/i.test(sourceUrl)) {
        return sourceUrl;
      }
      const w = Number(image.naturalWidth || image.width);
      const h = Number(image.naturalHeight || image.height);
      if (w >= 10 && h >= 10 && w * h <= 2_000_000) {
        try {
          return drawToPngDataUrl(image, w, h, doc);
        } catch {
          // Cross-origin image tainted canvas; attempt credentialed fetch below.
        }
      }
    } else {
      sourceUrl = extractCssBackgroundUrl(win.getComputedStyle?.(image)?.backgroundImage);
    }

    if (!sourceUrl) throw new Error("無法讀取圖片，請按 Ctrl+Shift+Y");
    if (/^data:image\/(?:png|jpeg|webp);base64,/i.test(sourceUrl)) return sourceUrl;

    try {
      const resolved = new URL(sourceUrl, doc.location?.href || win.location?.href || "https://localhost/").href;
      const response = await fetchImpl(resolved, { credentials: "include" });
      if (!response.ok) throw new Error("fetch failed");
      const blob = await response.blob();
      if (blob.size > MAX_IMAGE_BYTES) throw new Error("圖片超過 5 MB");
      return await blobToDataUrl(blob, win);
    } catch {
      throw new Error("跨網域圖片，請按 Ctrl+Shift+Y");
    }
  }

  function elementIdentity(image, win) {
    if (!image) return "";
    const tag = image.tagName?.toUpperCase() || "";
    if (tag === "IMG") return image.currentSrc || image.getAttribute?.("src") || image.id || "img";
    return image.id || extractCssBackgroundUrl(win.getComputedStyle?.(image)?.backgroundImage) || tag;
  }

  function mountDesktopPageButton({
    doc = root.document,
    sendMessage,
    loadProfile = async () => null,
    extractImage = (img) => extractImageDataUrl(img, { doc }),
  } = {}) {
    if (!doc?.documentElement || typeof sendMessage !== "function") return null;
    const win = doc.defaultView || root;
    doc.getElementById(HOST_ID)?.[DISPOSE_SYMBOL]?.();

    const nativeSetter = Object.getOwnPropertyDescriptor(win.HTMLInputElement?.prototype || {}, "value")?.set;

    const make = (tag, className, text) => {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text) node.textContent = text;
      return node;
    };

    const preventSteal = (event) => event.preventDefault?.();

    const makeButton = (text, className, onClick) => {
      const btn = make("button", className, text);
      btn.type = "button";
      btn.tabIndex = -1;
      btn.addEventListener("mousedown", preventSteal);
      btn.addEventListener("click", (event) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        onClick();
      });
      return btn;
    };

    const host = make("div");
    host.id = HOST_ID;
    host.tabIndex = -1;
    const shadow = host.attachShadow({ mode: "open" });
    const pill = make("div", "pill");
    pill.tabIndex = -1;
    pill.addEventListener("mousedown", preventSteal);

    const dragHandle = make("span", "drag-handle", "⋮⋮");
    dragHandle.title = "拖曳以移動";
    const mainRow = make("div", "row");
    const swapsRow = make("div", "row");
    pill.append(dragHandle, mainRow, swapsRow);
    shadow.append(make("style", "", PILL_CSS), pill);

    let mode = "idle"; // idle | busy | result | error
    let errorText = "";
    let currentTarget = null;
    let currentIdentity = "";
    let currentAnswer = "";
    let lastResult = null;
    let dismissedKey = "";
    let closed = false;
    let viewportListening = false;
    let positionRaf = null;
    let userDragPos = null;
    let drag = null;
    let cachedProfile = undefined;
    let idleHandle = null;
    let idleUsesRic = false;

    function startDrag(event) {
      if (drag || event.button !== 0 || event.isPrimary === false) return;
      event.preventDefault();
      const rect = pill.getBoundingClientRect();
      drag = { id: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
      dragHandle.setPointerCapture?.(event.pointerId);
      win.addEventListener("pointermove", moveDrag, { passive: false });
      win.addEventListener("pointerup", endDrag);
      win.addEventListener("pointercancel", endDrag);
    }

    function moveDrag(event) {
      if (!drag || event.pointerId !== drag.id) return;
      event.preventDefault();
      userDragPos = { left: event.clientX - drag.offsetX, top: event.clientY - drag.offsetY };
      positionPill();
    }

    function endDrag(event) {
      if (drag && event.pointerId === drag.id) stopDrag();
    }

    function stopDrag() {
      drag = null;
      win.removeEventListener("pointermove", moveDrag);
      win.removeEventListener("pointerup", endDrag);
      win.removeEventListener("pointercancel", endDrag);
    }

    dragHandle.addEventListener("pointerdown", startDrag, { passive: false });

    function attachViewportListeners() {
      if (viewportListening) return;
      viewportListening = true;
      win.addEventListener("resize", schedulePosition, { passive: true });
      win.addEventListener("scroll", schedulePosition, { capture: true, passive: true });
    }

    function detachViewportListeners() {
      if (!viewportListening) return;
      viewportListening = false;
      if (positionRaf !== null) {
        win.cancelAnimationFrame?.(positionRaf);
        positionRaf = null;
      }
      win.removeEventListener("resize", schedulePosition);
      win.removeEventListener("scroll", schedulePosition, true);
    }

    function schedulePosition() {
      if (closed || !viewportListening) return;
      if (typeof win.requestAnimationFrame === "function") {
        if (positionRaf !== null) return;
        positionRaf = win.requestAnimationFrame(() => {
          positionRaf = null;
          positionPill();
        });
      } else {
        positionPill();
      }
    }

    function positionPill() {
      if (!host.isConnected && !host.parent) return;
      const input = currentTarget?.input;
      const image = currentTarget?.image;
      const inputRect = input?.isConnected === false ? null : input?.getBoundingClientRect?.();
      const imageRect = image?.isConnected === false ? null : image?.getBoundingClientRect?.();
      const viewport = { width: win.innerWidth, height: win.innerHeight };
      const rect = pill.getBoundingClientRect();
      if (userDragPos) {
        userDragPos.left = clamp(userDragPos.left, viewport.width, rect.width);
        userDragPos.top = clamp(userDragPos.top, viewport.height, rect.height);
      }
      const coords = userDragPos || computePillPosition(inputRect, viewport, rect, imageRect);
      for (const edge of ["left", "top", "right", "bottom"]) {
        pill.style[edge] = coords[edge] === undefined ? "" : `${coords[edge]}px`;
      }
    }

    function canFill(input, value) {
      return editableInput(input) && typeof value === "string" && value.length > 0
        && (input.type !== "number" || /^[0-9]+$/.test(value));
    }

    function applyValue(input, value) {
      if (!canFill(input, value)) return false;
      if (nativeSetter) nativeSetter.call(input, value);
      else input.value = value;
      if (input.value !== value) return false;
      input.dispatchEvent(new win.Event("input", { bubbles: true, composed: true }));
      input.dispatchEvent(new win.Event("change", { bubbles: true }));
      return input.value === value;
    }

    function targetKey(target) {
      if (!target?.image || !target?.input) return "";
      return `${elementIdentity(target.image, win)}|${target.input.id || target.input.name || "input"}`;
    }

    function detachHost() {
      stopDrag();
      userDragPos = null;
      detachViewportListeners();
      host.remove();
    }

    function dismiss() {
      dismissedKey = targetKey(currentTarget);
      mode = "idle";
      lastResult = null;
      currentAnswer = "";
      detachHost();
    }

    function render() {
      if (closed || !currentTarget) return;
      if (doc.getElementById(SHORTCUT_PILL_HOST_ID)) {
        detachHost();
        return;
      }
      if (!host.parent && !host.isConnected) {
        doc.documentElement.append(host);
        attachViewportListeners();
      }
      swapsRow.replaceChildren();
      swapsRow.hidden = true;

      const closeBtn = makeButton("×", "icon-btn", dismiss);
      closeBtn.setAttribute("aria-label", "關閉");

      if (mode === "busy") {
        mainRow.replaceChildren(make("span", "status-text", "⏳ 辨識中..."), closeBtn);
      } else if (mode === "error") {
        const badge = make("span", "badge badge-err", "⚠️ 失敗");
        const msg = make("span", "status-text", errorText);
        const retryBtn = makeButton("🔄 重試", "primary-btn", () => recognizeCurrent());
        mainRow.replaceChildren(badge, msg, retryBtn, closeBtn);
      } else if (mode === "result" && lastResult) {
        const input = currentTarget.input;
        const mismatch = lastResult.length_match === false;
        const candidates = [
          { answer: lastResult.answer, confidence: lastResult.confidence },
          ...(lastResult.top_candidates || lastResult.candidates || []),
        ];
        const retryBtn = makeButton("🔄", "icon-btn", () => recognizeCurrent());
        retryBtn.setAttribute("aria-label", "重新辨識");

        if (mismatch) {
          const badge = make("span", "badge badge-warn", "⚠️ 長度不符");
          const fillBtn = makeButton(`仍填入 ${lastResult.answer}`, "swap-btn", () => {
            if (applyValue(input, lastResult.answer)) {
              currentAnswer = lastResult.answer;
              lastResult = { ...lastResult, length_match: true };
              render();
            }
          });
          mainRow.replaceChildren(badge, fillBtn, retryBtn, closeBtn);
        } else {
          const badge = make("span", "badge badge-ok", "✓ 已填入");
          const answerSpan = make("span", "answer", currentAnswer);
          answerSpan.setAttribute("role", "status");
          mainRow.replaceChildren(badge, answerSpan, retryBtn, closeBtn);
        }

        const swapBtns = buildSwapCandidates(mismatch ? lastResult.answer : currentAnswer, candidates)
          .filter((c) => canFill(input, c.answer))
          .map((c) => makeButton(`改填 ${c.answer}`, "swap-btn", () => {
            if (applyValue(input, c.answer)) {
              currentAnswer = c.answer;
              lastResult = { ...lastResult, length_match: true };
              render();
            }
          }));
        if (swapBtns.length) {
          swapsRow.replaceChildren(...swapBtns);
          swapsRow.hidden = false;
        }
      } else {
        const triggerBtn = makeButton("🔍 辨識", "primary-btn", () => recognizeCurrent());
        triggerBtn.title = "辨識並填入驗證碼（快捷鍵 Ctrl+Shift+Y）";
        mainRow.replaceChildren(triggerBtn, closeBtn);
      }

      positionPill();
    }

    async function ensureProfile() {
      if (cachedProfile !== undefined) return cachedProfile;
      try {
        cachedProfile = await loadProfile();
      } catch {
        cachedProfile = null;
      }
      return cachedProfile;
    }

    async function scan({ preferredInput = null, force = false } = {}) {
      if (closed || mode === "busy" || doc.visibilityState === "hidden") return false;
      if (!preferredInput && typeof doc.querySelector === "function" && !doc.querySelector("input")) {
        if (host.parent || host.isConnected) detachHost();
        return false;
      }
      const profile = await ensureProfile();
      if (closed) return false;
      const found = detectQuickTarget(doc, { preferredInput, profile });
      if (!found.ok) {
        if (!preferredInput && !currentTarget) return false;
        if (!preferredInput && currentTarget && (currentTarget.input.isConnected === false || currentTarget.image.isConnected === false)) {
          currentTarget = null;
          currentIdentity = "";
          detachHost();
        }
        return false;
      }

      const key = targetKey(found);
      if (!force && dismissedKey && dismissedKey === key) return false;
      if (force) dismissedKey = "";

      const identity = elementIdentity(found.image, win);
      if (found.input !== currentTarget?.input || found.image !== currentTarget?.image || identity !== currentIdentity) {
        stopDrag();
        userDragPos = null;
        mode = "idle";
        lastResult = null;
        currentAnswer = "";
        currentIdentity = identity;
      }
      currentTarget = found;
      render();
      return true;
    }

    async function recognizeCurrent() {
      if (closed || mode === "busy") return;
      const profile = await ensureProfile();
      const fresh = detectQuickTarget(doc, { preferredInput: currentTarget?.input || null, profile });
      if (fresh.ok) currentTarget = fresh;
      if (!currentTarget?.image || !currentTarget?.input) return;

      mode = "busy";
      errorText = "";
      render();

      try {
        const imageDataUrl = await extractImage(currentTarget.image);
        const result = await sendMessage({
          type: "OCR_PAGE_RECOGNIZE",
          imageDataUrl,
          expectedLength: currentTarget.hints?.expectedLength ?? null,
          lengthMode: currentTarget.hints?.lengthMode || "exact",
          charsetHint: currentTarget.hints?.charsetHint || "alphanumeric",
          caseSensitive: Boolean(currentTarget.hints?.caseSensitive),
        });
        if (closed) return;
        if (!result?.ok || !result.answer) {
          throw new Error(result?.error || "辨識失敗，請重試");
        }
        lastResult = result;
        currentAnswer = result.answer;
        if (result.length_match !== false) {
          applyValue(currentTarget.input, result.answer);
        }
        mode = "result";
        render();
      } catch (error) {
        if (closed) return;
        mode = "error";
        errorText = error?.message || String(error);
        render();
      }
    }

    function onFocusIn(event) {
      const target = event?.target;
      if (!editableInput(target)) return;
      scan({ preferredInput: target }).catch(() => {});
    }

    function invalidateProfileCache() {
      cachedProfile = undefined;
    }

    function close() {
      if (closed) return;
      closed = true;
      if (idleHandle !== null) {
        if (idleUsesRic) win.cancelIdleCallback?.(idleHandle);
        else win.clearTimeout?.(idleHandle);
        idleHandle = null;
      }
      doc.removeEventListener?.("focusin", onFocusIn, true);
      dragHandle.removeEventListener("pointerdown", startDrag);
      detachHost();
    }

    host[DISPOSE_SYMBOL] = dismiss;
    doc.addEventListener?.("focusin", onFocusIn, true);

    // One lightweight idle check ONLY if the page has at least one <input>.
    if (typeof doc.querySelector !== "function" || doc.querySelector("input")) {
      if (typeof win.requestIdleCallback === "function") {
        idleUsesRic = true;
        idleHandle = win.requestIdleCallback(() => {
          idleHandle = null;
          scan().catch(() => {});
        }, { timeout: 1200 });
      } else {
        idleUsesRic = false;
        idleHandle = win.setTimeout(() => {
          idleHandle = null;
          scan().catch(() => {});
        }, 300);
      }
    }

    return {
      scan,
      recognizeCurrent,
      dismiss,
      close,
      invalidateProfileCache,
      getState: () => ({
        mode,
        mounted: Boolean(host.isConnected || host.parent),
        viewportListening,
        currentAnswer,
        errorText,
      }),
    };
  }

  function startDesktopPageButton({
    doc = root.document,
    chromeApi = typeof chrome !== "undefined" ? chrome : null,
  } = {}) {
    if (!doc?.documentElement || !chromeApi?.runtime?.sendMessage) return null;
    let controller = null;

    const loadProfile = async () => {
      if (!chromeApi.storage?.local?.get || !doc.location?.origin) return null;
      const stored = await chromeApi.storage.local.get(SITE_PROFILES_KEY);
      const map = stored?.[SITE_PROFILES_KEY];
      return (map && typeof map === "object") ? (map[doc.location.origin] || null) : null;
    };

    const mount = () => {
      if (controller) return controller;
      controller = mountDesktopPageButton({
        doc,
        sendMessage: (msg) => chromeApi.runtime.sendMessage(msg),
        loadProfile,
      });
      return controller;
    };

    const unmount = () => {
      if (!controller) return;
      controller.close();
      controller = null;
    };

    const checkEnabled = async () => {
      try {
        const stored = await chromeApi.storage?.local?.get?.(PAGE_BUTTON_ENABLED_KEY);
        const enabled = stored?.[PAGE_BUTTON_ENABLED_KEY] !== false;
        if (enabled) mount();
        else unmount();
      } catch {
        mount();
      }
    };

    if (chromeApi.storage?.onChanged?.addListener) {
      chromeApi.storage.onChanged.addListener((changes, areaName) => {
        if (areaName && areaName !== "local") return;
        if (changes[PAGE_BUTTON_ENABLED_KEY]) {
          const enabled = changes[PAGE_BUTTON_ENABLED_KEY].newValue !== false;
          if (enabled) mount();
          else unmount();
        }
        if (changes[SITE_PROFILES_KEY] && controller) {
          controller.invalidateProfileCache();
          controller.scan({ force: true }).catch(() => {});
        }
      });
    }

    checkEnabled();
    return { mount, unmount, getController: () => controller };
  }

  return {
    HOST_ID,
    SHORTCUT_PILL_HOST_ID,
    DISPOSE_SYMBOL,
    PAGE_BUTTON_ENABLED_KEY,
    computePillPosition,
    buildSwapCandidates,
    detectQuickTarget,
    extractImageDataUrl,
    mountDesktopPageButton,
    startDesktopPageButton,
  };
});
