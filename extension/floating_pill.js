(function exposeFloatingPill(root, factory) {
  const api = factory(root);
  root.StevenOcrFloatingPill = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  const data = root.__STEVEN_OCR_PILL_DATA__;
  if (data !== undefined) {
    delete root.__STEVEN_OCR_PILL_DATA__;
    if (data) api.mountFloatingPill(data);
  }
}(globalThis, (root) => {
  const HOST_ID = "steven-ocr-pill-host";
  const disposeHost = Symbol.for("steven-ocr-pill.dispose");
  const TOKEN_ATTRIBUTE = "data-steven-captcha-target";
  const VIEWPORT_MARGIN = 12;
  const FADE_MS = 150;
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
    .pill {
      position: fixed;
      box-sizing: border-box;
      width: max-content;
      max-width: calc(100% - 40px);
      margin-top: 6px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 7px;
      padding: 7px 10px;
      border: 1px solid rgba(59, 130, 246, 0.42);
      border-radius: 10px;
      background: var(--ocr-popover);
      box-shadow: 0 10px 26px rgba(0, 0, 0, 0.45);
      color: var(--ocr-fg);
      font: 12px var(--ocr-font-sans);
      pointer-events: auto;
      transition: opacity ${FADE_MS}ms ease-out;
    }
    .leaving { opacity: 0; pointer-events: none; }
    @media (prefers-reduced-motion: reduce) { .pill { transition: none; } }
    .status {
      background: rgba(34, 197, 94, 0.16);
      border: 1px solid rgba(34, 197, 94, 0.35);
      color: #22c55e;
      border-radius: 999px;
      padding: 2px 7px;
      font-size: 11px;
      font-weight: 700;
    }
    .answer { font: 700 13px var(--ocr-font-mono); letter-spacing: 0.04em; overflow-wrap: anywhere; }
    .swaps { display: flex; flex-wrap: wrap; gap: 6px; }
    .swaps[hidden] { display: none; }
    button {
      cursor: pointer;
      background: var(--ocr-secondary);
      border: 1px solid var(--ocr-border);
      border-radius: 6px;
      padding: 3px 8px;
      color: var(--ocr-fg);
      font: 600 11.5px var(--ocr-font-mono);
      overflow-wrap: anywhere;
      transition: background 0.12s ease, border-color 0.12s ease;
    }
    button:hover {
      background: var(--ocr-secondary-hover);
      border-color: rgba(59, 130, 246, 0.55);
    }
    .close { background: transparent; border-color: transparent; color: var(--ocr-muted); padding: 2px 6px; }
    .close:hover { background: rgba(255, 255, 255, 0.06); border-color: transparent; color: var(--ocr-fg); }
  `;

  function computePillPosition(inputRect, viewport, pillSize) {
    if (!Number.isFinite(inputRect?.left) || !Number.isFinite(inputRect?.bottom)
      || inputRect.width === 0 || inputRect.height === 0) return { right: 20, bottom: 20 };
    const clamp = (value, extent, size) =>
      Math.max(VIEWPORT_MARGIN, Math.min(value, extent - size - VIEWPORT_MARGIN));
    return {
      left: clamp(inputRect.left, viewport.width, pillSize.width),
      top: clamp(inputRect.bottom, viewport.height, pillSize.height),
    };
  }

  function buildSwapCandidates(currentAnswer, candidates) {
    const seen = new Set([currentAnswer]);
    const swaps = [];
    for (const candidate of candidates || []) {
      const answer = candidate?.answer;
      if (typeof answer !== "string" || !answer.trim() || seen.has(answer)) continue;
      seen.add(answer);
      swaps.push(candidate);
      if (swaps.length === 2) break;
    }
    return swaps;
  }

  function editableInput(input) {
    return input?.tagName?.toLowerCase() === "input" && !input.disabled && !input.readOnly
      && !input.matches?.(":disabled") && input.isConnected !== false;
  }

  function findInput(doc, selectorOrToken, detect) {
    if (typeof selectorOrToken !== "string" || !selectorOrToken.trim()) return null;
    const query = (selector) => detect?.queryAllDeep
      ? detect.queryAllDeep(doc, selector)
      : Array.from(doc.querySelectorAll(selector));
    const tokens = query(`input[${TOKEN_ATTRIBUTE}]`)
      .filter((input) => input.getAttribute(TOKEN_ATTRIBUTE) === selectorOrToken);
    if (tokens.length) return tokens.length === 1 && editableInput(tokens[0]) ? tokens[0] : null;
    try {
      const inputs = query(selectorOrToken).filter(editableInput);
      return inputs.length === 1 ? inputs[0] : null;
    } catch {
      return null;
    }
  }

  function mountFloatingPill(data, {
    document: doc = root.document,
    detect = root.CaptchaDetect,
  } = {}) {
    if (!doc?.documentElement || typeof data?.answer !== "string" || !data.answer.trim()) return null;
    const win = doc.defaultView || root;
    const input = findInput(doc, data.inputSelectorOrToken, detect);
    doc.getElementById("steven-ocr-page-button-host")?.[Symbol.for("steven-ocr-page-button.dispose")]?.();
    doc.getElementById(HOST_ID)?.[disposeHost]?.();
    const autoHideMs = Number.isFinite(data.autoHideMs) && data.autoHideMs >= 0 ? data.autoHideMs : 3500;
    const candidates = [{ answer: data.answer, confidence: data.confidence }, ...(data.candidates || [])];
    const nativeSetter = Object.getOwnPropertyDescriptor(win.HTMLInputElement?.prototype || {}, "value")?.set;
    const now = () => win.performance.now();
    let currentAnswer = data.answer;
    let isHovered = false;
    let closed = false;
    let leaving = false;
    let remaining = autoHideMs;
    let deadline;
    let timer;

    const make = (tag, className, text) => {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text) node.textContent = text;
      return node;
    };
    const button = (text, className, onClick) => {
      const node = make("button", className, text);
      node.type = "button";
      node.tabIndex = -1;
      node.addEventListener("mousedown", (event) => event.preventDefault());
      node.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      });
      return node;
    };
    const host = make("div");
    host.id = HOST_ID;
    host.tabIndex = -1;
    host[disposeHost] = close;
    const shadow = host.attachShadow({ mode: "open" });
    const pill = make("div", "pill");
    pill.tabIndex = -1;
    const status = make("span", "status", "✓ 已填入");
    const answer = make("span", "answer");
    answer.setAttribute("role", "status");
    const swaps = make("div", "swaps");
    const closeButton = button("×", "close", close);
    pill.append(status, answer, swaps, closeButton);
    pill.addEventListener("mousedown", preventFocus);
    pill.addEventListener("mouseenter", pause);
    pill.addEventListener("mouseleave", resume);
    shadow.append(make("style", "", CSS), pill);
    doc.documentElement.append(host);
    win.addEventListener("resize", position);
    win.addEventListener("scroll", position, true);
    render();
    startTimer();
    return { close };

    function preventFocus(event) {
      event.preventDefault();
    }

    function canFill(candidate) {
      return editableInput(input) && nativeSetter
        && (input.type !== "number" || /^[0-9]+$/.test(candidate));
    }

    function render() {
      answer.textContent = currentAnswer;
      const available = candidates.filter((candidate) => canFill(candidate?.answer));
      swaps.replaceChildren(...buildSwapCandidates(currentAnswer, available).map((candidate) =>
        button("改填 " + candidate.answer, "", () => swap(candidate.answer))));
      swaps.hidden = swaps.childElementCount === 0;
      position();
    }

    function position() {
      const inputRect = input?.isConnected === false ? null : input?.getBoundingClientRect();
      const viewport = { width: win.innerWidth, height: win.innerHeight };
      const coordinates = computePillPosition(inputRect, viewport, pill.getBoundingClientRect());
      for (const edge of ["left", "top", "right", "bottom"]) {
        pill.style[edge] = coordinates[edge] === undefined ? "" : coordinates[edge] + "px";
      }
    }

    function swap(value) {
      if (closed || leaving || !canFill(value)) return;
      nativeSetter.call(input, value);
      if (input.value !== value) return;
      input.dispatchEvent(new win.Event("input", { bubbles: true, composed: true }));
      input.dispatchEvent(new win.Event("change", { bubbles: true }));
      if (closed || input.value !== value) return;
      currentAnswer = value;
      render();
      clearTimer();
      remaining = autoHideMs;
      if (!isHovered) startTimer();
    }

    function clearTimer() {
      if (timer !== undefined) win.clearTimeout(timer);
      timer = undefined;
    }

    function startTimer() {
      deadline = now() + remaining;
      timer = win.setTimeout(fade, remaining);
    }

    function pause() {
      if (isHovered || leaving || closed) return;
      isHovered = true;
      remaining = Math.max(0, deadline - now());
      clearTimer();
    }

    function resume() {
      if (!isHovered || leaving || closed) return;
      isHovered = false;
      startTimer();
    }

    function fade() {
      leaving = true;
      pill.classList.add("leaving");
      const reducedMotion = win.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      timer = win.setTimeout(close, reducedMotion ? 0 : FADE_MS);
    }

    function close() {
      if (closed) return;
      closed = true;
      clearTimer();
      pill.removeEventListener("mousedown", preventFocus);
      pill.removeEventListener("mouseenter", pause);
      pill.removeEventListener("mouseleave", resume);
      win.removeEventListener("resize", position);
      win.removeEventListener("scroll", position, true);
      host.remove();
    }
  }

  return { computePillPosition, buildSwapCandidates, mountFloatingPill };
}));
