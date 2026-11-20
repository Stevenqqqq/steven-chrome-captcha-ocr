(function exposePicker(root, factory) {
  const api = factory(root);
  root.StevenOcrPicker = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root.__STEVEN_OCR_START_PICKER__ === true) {
    delete root.__STEVEN_OCR_START_PICKER__;
    api.createPickerController();
  }
}(globalThis, (root) => {
  const HOST_ID = "steven-ocr-picker-host";
  const disposeHost = Symbol.for("steven-ocr-picker.dispose");
  const IMAGE_PROMPT = "請點選目標圖片（img / canvas / svg）";
  const INPUT_PROMPT = "請點選要填入答案的輸入框";
  const INPUT_TYPES = ["text", "search", "tel", "number", "email", "url", "password"];
  const CSS = `
    :host {
      all: initial;
      --ocr-bg: #12161d;
      --ocr-popover: #171c25;
      --ocr-secondary: #1b222d;
      --ocr-secondary-hover: #242e3d;
      --ocr-border: #2a3444;
      --ocr-fg: #eef2f7;
      --ocr-muted: #8f9cad;
      --ocr-primary: #3b82f6;
      --ocr-primary-hover: #2563eb;
      --ocr-success: #22c55e;
      --ocr-info: #38bdf8;
      --ocr-warning: #f59e0b;
      --ocr-font-sans: "Segoe UI", "Microsoft JhengHei UI", system-ui, -apple-system, sans-serif;
      --ocr-font-mono: Consolas, "Cascadia Mono", ui-monospace, monospace;
      direction: ltr !important;
      display: block !important;
      position: fixed !important;
      inset: 0 !important;
      pointer-events: none !important;
      z-index: 2147483647 !important;
    }
    .outline {
      position: fixed;
      box-sizing: border-box;
      border: 2px solid var(--ocr-info);
      border-radius: 4px;
      background: rgba(56, 189, 248, 0.08);
      pointer-events: none;
    }
    .locked { border-color: var(--ocr-success); background: rgba(34, 197, 94, 0.08); }
    .hud {
      position: fixed;
      top: 16px;
      left: 50%;
      transform: translateX(-50%);
      box-sizing: border-box;
      width: max-content;
      max-width: calc(100% - 24px);
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 9px;
      background: var(--ocr-popover);
      border: 1px solid rgba(56, 189, 248, 0.45);
      border-radius: 12px;
      padding: 10px 14px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
      color: var(--ocr-fg);
      font: 12px var(--ocr-font-sans);
      pointer-events: auto;
    }
    .badge {
      display: inline-grid;
      place-items: center;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      color: var(--ocr-info);
      background: rgba(56, 189, 248, 0.16);
      border: 1px solid rgba(56, 189, 248, 0.45);
      font-weight: 700;
    }
    .controls, label { display: inline-flex; align-items: center; gap: 6px; }
    .controls { flex-wrap: wrap; }
    button, select {
      background: var(--ocr-secondary);
      color: var(--ocr-fg);
      border: 1px solid var(--ocr-border);
      border-radius: 6px;
      padding: 4px 8px;
      font: inherit;
    }
    button { cursor: pointer; font-weight: 600; transition: background 0.12s ease; }
    button:hover:not(:disabled) { background: var(--ocr-secondary-hover); }
    button:disabled { cursor: default; opacity: 0.55; }
    .primary { background: var(--ocr-primary); border-color: var(--ocr-primary); color: #ffffff; }
    .primary:hover:not(:disabled) { background: var(--ocr-primary-hover); }
    .cancel { background: transparent; border-color: transparent; color: var(--ocr-muted); }
    .cancel:hover:not(:disabled) { background: rgba(255, 255, 255, 0.06); color: var(--ocr-fg); }
    .saved { color: var(--ocr-success); font-weight: 700; }
    [hidden] { display: none; }
  `;

  function resolvePickTarget(element, step) {
    if (step === 1) {
      const image = element?.closest?.("img, canvas, svg");
      if (image) return image;
      if (!element?.tagName) return null;
      const background = element.ownerDocument?.defaultView?.getComputedStyle(element)?.backgroundImage;
      return background && background !== "none" ? element : null;
    }
    if (step === 2 && element?.tagName?.toLowerCase() === "input"
      && !element.disabled && !element.readOnly && !element.matches?.(":disabled")
      && INPUT_TYPES.includes(element.type || "text")) return element;
    return null;
  }

  function computeHighlightRect(element) {
    const rect = element?.getBoundingClientRect?.();
    if (!rect) return null;
    const { left, top, width, height } = rect;
    if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
    return { left, top, width, height };
  }

  function createPickerController({
    document: doc = root.document,
    siteProfiles = root.SiteProfiles,
    detect = root.CaptchaDetect,
    chrome = root.chrome,
    onSave,
  } = {}) {
    if (!doc?.documentElement || !siteProfiles) return null;
    const win = doc.defaultView || root;
    doc.getElementById(HOST_ID)?.[disposeHost]?.();

    const make = (tag, className, text) => {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text) node.textContent = text;
      return node;
    };
    const button = (text, className, action) => {
      const node = make("button", className, text);
      node.type = "button";
      node.addEventListener("click", action);
      return node;
    };
    const select = (choices) => {
      const node = make("select");
      for (const [value, text] of choices) {
        const option = make("option", "", text);
        option.value = value;
        node.append(option);
      }
      return node;
    };
    const label = (text, field) => {
      const node = make("label");
      node.append(text, field);
      return node;
    };

    const host = make("div");
    host.id = HOST_ID;
    const shadow = host.attachShadow({ mode: "open" });
    const hover = make("div", "outline");
    const locked = make("div", "outline locked");
    const hud = make("div", "hud");
    const badge = make("span", "badge");
    const prompt = make("span");
    prompt.setAttribute("role", "status");
    const controls = make("div", "controls");
    const length = select([["", "自動"], ...["3", "4", "5", "6"].map((value) => [value, value])]);
    const charset = select([["alphanumeric", "英數"], ["digits", "純數字"], ["letters", "純字母"]]);
    const caseSensitive = make("input");
    caseSensitive.type = "checkbox";
    const saveButton = button("儲存此網站規則", "primary", save);
    const retryButton = button("重選", "", reset);
    const cancelButton = button("ESC 取消", "cancel", cancel);
    controls.append(label("長度", length), label("字元集", charset),
      label("區分大小寫", caseSensitive), saveButton, retryButton);
    hud.append(badge, prompt, controls, cancelButton);
    shadow.append(make("style", "", CSS), hover, locked, hud);

    let step;
    let image;
    let hovered;
    let profile;
    let closed = false;
    let saved = false;
    let saveTimer;
    let lengthEdited;
    length.addEventListener("change", markLengthEdited);

    function markLengthEdited() {
      lengthEdited = true;
    }

    function paint(box, element) {
      const rect = element?.isConnected === false ? null : computeHighlightRect(element);
      box.hidden = !rect;
      if (rect) {
        for (const [key, value] of Object.entries(rect)) box.style[key] = value + "px";
      }
    }

    function updateOutlines() {
      paint(locked, image);
      paint(hover, hovered);
    }

    function reset() {
      step = 1;
      image = hovered = profile = null;
      badge.textContent = "1";
      prompt.textContent = IMAGE_PROMPT;
      controls.hidden = true;
      updateOutlines();
    }

    function eventTarget(event) {
      const path = event.composedPath?.() || [];
      if (path.includes(host) || event.target === host) return null;
      return path[0] || event.target;
    }

    function onMove(event) {
      hovered = !profile && !saved ? resolvePickTarget(eventTarget(event), step) : null;
      if (hovered === image) hovered = null;
      paint(hover, hovered);
    }

    function onClick(event) {
      if (profile || saved) return;
      const target = resolvePickTarget(eventTarget(event), step);
      if (!target || target === image) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      hovered = null;
      if (step === 1) {
        image = target;
        step = 2;
        badge.textContent = "2";
        prompt.textContent = INPUT_PROMPT;
      } else {
        const hints = detect?.inferInputHints?.({
          type: target.type,
          inputMode: target.inputMode,
          pattern: target.pattern,
          minLength: target.minLength,
          maxLength: target.maxLength,
          metadata: target.getAttribute("placeholder") || "",
          labelText: [...Array.from(target.labels || [], (item) => item.textContent),
            target.getAttribute("aria-label")].filter(Boolean).join(" "),
        });
        profile = siteProfiles.validateProfile({
          origin: siteProfiles.normalizeOrigin(doc.location?.href),
          imageSelector: siteProfiles.buildStableSelector(image),
          inputSelector: siteProfiles.buildStableSelector(target),
          expectedLength: hints?.expectedLength ?? null,
          lengthMode: hints?.lengthMode ?? "unknown",
          charsetHint: hints?.charsetHint ?? "alphanumeric",
          caseSensitive: hints?.caseSensitive ?? false,
        });
        if (profile) {
          length.value = profile.expectedLength?.toString() || "";
          charset.value = profile.charsetHint;
          caseSensitive.checked = profile.caseSensitive;
          lengthEdited = false;
          controls.hidden = false;
        }
      }
      updateOutlines();
    }

    async function save() {
      if (!profile || saveButton.disabled || closed) return;
      const expectedLength = length.value ? Number(length.value) : null;
      const checkedProfile = siteProfiles.validateProfile({
        ...profile,
        expectedLength,
        lengthMode: expectedLength === null ? "unknown"
          : lengthEdited || expectedLength !== profile.expectedLength ? "exact" : profile.lengthMode,
        charsetHint: charset.value,
        caseSensitive: caseSensitive.checked,
        updatedAt: Date.now(),
      });
      if (!checkedProfile) return;
      for (const field of [length, charset, caseSensitive, saveButton, retryButton]) field.disabled = true;
      try {
        if (onSave) {
          if (await onSave(checkedProfile) === false) return;
        } else if (chrome?.storage?.local) {
          if (!await siteProfiles.saveProfile(chrome.storage.local, checkedProfile)) return;
        } else if (chrome?.runtime?.sendMessage) {
          const result = await chrome.runtime.sendMessage({ type: "STEVEN_OCR_PROFILE_SAVED", profile: checkedProfile });
          if (result === false || result?.ok === false) return;
        } else {
          return;
        }
        if (closed) return;
        saved = true;
        image = null;
        updateOutlines();
        badge.hidden = controls.hidden = cancelButton.hidden = true;
        prompt.className = "saved";
        prompt.textContent = "✓ 已記住此網站規則";
        saveTimer = win.setTimeout(cancel, 1200);
      } catch {
        // Keep the selection available so the user can retry a failed save.
      } finally {
        if (!saved && !closed) {
          for (const field of [length, charset, caseSensitive, saveButton, retryButton]) field.disabled = false;
        }
      }
    }

    function onKey(event) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      cancel();
    }

    function cancel() {
      if (closed) return;
      closed = true;
      if (saveTimer !== undefined) win.clearTimeout(saveTimer);
      doc.removeEventListener("pointermove", onMove, true);
      doc.removeEventListener("click", onClick, true);
      doc.removeEventListener("keydown", onKey, true);
      win.removeEventListener("scroll", updateOutlines, true);
      win.removeEventListener("resize", updateOutlines);
      length.removeEventListener("change", markLengthEdited);
      saveButton.removeEventListener("click", save);
      retryButton.removeEventListener("click", reset);
      cancelButton.removeEventListener("click", cancel);
      host.remove();
    }

    reset();
    host[disposeHost] = cancel;
    doc.documentElement.append(host);
    doc.addEventListener("pointermove", onMove, true);
    doc.addEventListener("click", onClick, true);
    doc.addEventListener("keydown", onKey, true);
    win.addEventListener("scroll", updateOutlines, true);
    win.addEventListener("resize", updateOutlines);
    return { cancel };
  }

  return { createPickerController, resolvePickTarget, computeHighlightRect };
}));
