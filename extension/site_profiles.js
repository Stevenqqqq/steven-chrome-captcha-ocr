(function exposeSiteProfiles(root, factory) {
  const api = factory();
  root.SiteProfiles = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
}(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const STORAGE_KEY = "siteProfiles";
  const MAX_SELECTOR_LENGTH = 300;
  const pendingWrites = new WeakMap();

  function normalizeOrigin(urlOrOrigin) {
    try {
      const url = new URL(urlOrOrigin);
      return ["http:", "https:", "file:"].includes(url.protocol) ? url.protocol + "//" + url.host : "";
    } catch {
      return "";
    }
  }

  function safeSelector(value) {
    if (typeof value !== "string" || value.length > MAX_SELECTOR_LENGTH || !value.trim()
      || /[\u0000-\u001f\u007f<{};]/.test(value)) return false;
    const pairs = { "[": "]", "(": ")" };
    const closing = [];
    let quote = "";
    for (let index = 0; index < value.length; index += 1) {
      const char = value[index];
      if (char === "\\") {
        index += 1;
        if (index === value.length) return false;
      } else if (quote) {
        if (char === quote) quote = "";
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (pairs[char]) {
        closing.push(pairs[char]);
      } else if ((char === "]" || char === ")") && closing.pop() !== char) {
        return false;
      }
    }
    if (quote || closing.length) return false;
    try {
      globalThis.document?.createDocumentFragment?.().querySelector(value);
      return true;
    } catch {
      return false;
    }
  }

  function validateProfile(raw) {
    const origin = normalizeOrigin(raw?.origin);
    if (!origin || !safeSelector(raw.imageSelector) || !safeSelector(raw.inputSelector)) return null;
    const { expectedLength, lengthMode, charsetHint, caseSensitive, updatedAt } = raw;
    if (expectedLength !== null
      && (!Number.isInteger(expectedLength) || expectedLength < 3 || expectedLength > 6)) return null;
    if (!["exact", "max", "unknown"].includes(lengthMode)
      || !["alphanumeric", "digits", "letters"].includes(charsetHint)
      || typeof caseSensitive !== "boolean") return null;
    return {
      origin,
      imageSelector: raw.imageSelector.trim(),
      inputSelector: raw.inputSelector.trim(),
      expectedLength,
      lengthMode,
      charsetHint,
      caseSensitive,
      updatedAt: Number.isFinite(updatedAt) && updatedAt >= 0 ? updatedAt : null,
    };
  }

  function stableId(id) {
    return /^[A-Za-z_][\w-]*$/.test(id)
      && !/(?:^|[-_])(?:[a-f0-9]{8,}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$|\d{5,}$/i.test(id);
  }

  function attributeSelector(element, attribute) {
    const value = element.getAttribute?.(attribute) || (attribute === "name" ? element.name : "");
    if (typeof value !== "string" || !value || /[\u0000-\u001f\u007f<{};]/.test(value)) return "";
    return "[" + attribute + '="' + value.replace(/["\\]/g, "\\$&") + '"]';
  }

  function buildStableSelector(element) {
    if (!element?.tagName) return "";
    const tree = element.getRootNode?.() || element.ownerDocument;
    const documentRef = element.ownerDocument;
    const unique = (selector) => {
      if (!safeSelector(selector)) return false;
      try {
        const deepQuery = globalThis.CaptchaDetect?.queryAllDeep;
        const matches = deepQuery && documentRef?.querySelectorAll
          ? deepQuery(documentRef, selector)
          : tree?.querySelectorAll?.(selector);
        return matches ? matches.length === 1 && matches[0] === element : true;
      } catch {
        return false;
      }
    };

    const parts = [];
    for (let current = element; current?.tagName; current = current.parentElement) {
      const tag = current.tagName.toLowerCase();
      const id = current.id || current.getAttribute?.("id") || "";
      const name = attributeSelector(current, "name");
      const testId = attributeSelector(current, "data-testid");
      for (const candidate of [stableId(id) ? "#" + id : "", name, testId]) {
        if (!candidate) continue;
        const selector = [candidate, ...parts].join(" > ");
        if (unique(selector)) return selector;
      }
      const attribute = name || testId || attributeSelector(current, "type") || attributeSelector(current, "alt");
      const siblings = Array.from((current.parentElement || tree)?.children || [])
        .filter((sibling) => sibling.tagName === current.tagName);
      const index = siblings.indexOf(current);
      const position = siblings.length > 1 && index >= 0 ? ":nth-of-type(" + (index + 1) + ")" : "";
      const simple = [tag + attribute, ...parts].join(" > ");
      if (unique(simple)) return simple;
      parts.unshift(tag + attribute + position);
      const path = parts.join(" > ");
      if (unique(path)) return path;
      if (path.length > MAX_SELECTOR_LENGTH) return "";
    }
    return "";
  }

  async function readProfiles(storageArea) {
    const value = (await storageArea.get(STORAGE_KEY))?.[STORAGE_KEY];
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function updateProfiles(storageArea, update) {
    const previous = pendingWrites.get(storageArea) || Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      const profiles = { ...await readProfiles(storageArea) };
      if (!update(profiles)) return false;
      await storageArea.set({ [STORAGE_KEY]: profiles });
      return true;
    });
    pendingWrites.set(storageArea, pending);
    return pending;
  }

  async function loadProfile(storageArea, urlOrOrigin) {
    const origin = normalizeOrigin(urlOrOrigin);
    if (!origin) return null;
    const profiles = await readProfiles(storageArea);
    const profile = validateProfile(profiles[origin]);
    return profile?.origin === origin ? profile : null;
  }

  async function saveProfile(storageArea, raw) {
    const profile = validateProfile(raw);
    if (!profile) return null;
    profile.updatedAt ??= Date.now();
    await updateProfiles(storageArea, (profiles) => {
      profiles[profile.origin] = profile;
      return true;
    });
    return profile;
  }

  async function removeProfile(storageArea, urlOrOrigin) {
    const origin = normalizeOrigin(urlOrOrigin);
    if (!origin) return false;
    return updateProfiles(storageArea, (profiles) => {
      if (!Object.hasOwn(profiles, origin)) return false;
      delete profiles[origin];
      return true;
    });
  }

  return { normalizeOrigin, validateProfile, buildStableSelector, loadProfile, saveProfile, removeProfile };
}));
