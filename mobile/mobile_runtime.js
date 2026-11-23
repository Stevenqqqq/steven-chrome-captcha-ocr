(function exposeStevenOcrMobile(root, factory) {
  const api = factory(root);
  root.StevenOcrMobile = api;
  if (typeof module === "object" && module.exports) module.exports = api;
  if (
    typeof root.document !== "undefined"
    && !root.__STEVEN_OCR_DISABLE_AUTOSTART__
    && !root.__STEVEN_OCR_MOBILE_STARTED__
  ) {
    root.__STEVEN_OCR_MOBILE_STARTED__ = true;
    api.startMobileUserscript();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const IDLE_TIMEOUT_MS = 3 * 60 * 1000;
  const VIRTUAL_MODEL_BASE_URL = "steven-userscript://models";
  const HOST_ID = "steven-ocr-mobile-host";
  const disposeHostSymbol = Symbol.for("steven-ocr-mobile.dispose");
  const TOKEN_ATTRIBUTE = "data-steven-captcha-target";
  const VIEWPORT_MARGIN = 12;
  const IDB_NAME = "steven_ocr_mobile_v1";
  const IDB_STORE = "assets";
  const MIN_ASSET_BYTES = 1024;
  const MAX_CAPTCHA_IMAGE_BYTES = 5 * 1024 * 1024;

  const DEFAULT_ASSETS = Object.freeze({
    IDLE_TIMEOUT_MS,
    ORT_SCRIPT_URLS: Object.freeze([
      "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.2/dist/ort.wasm.min.js",
      "https://unpkg.com/onnxruntime-web@1.23.2/dist/ort.wasm.min.js",
    ]),
    ORT_WASM_DIR: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.2/dist/",
    ORT_WASM_URLS: Object.freeze([
      "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.2/dist/ort-wasm-simd-threaded.wasm",
      "https://unpkg.com/onnxruntime-web@1.23.2/dist/ort-wasm-simd-threaded.wasm",
    ]),
    MODEL_URLS: Object.freeze({
      "official/common_old.onnx": Object.freeze([
        "https://cdn.jsdelivr.net/gh/sml2h3/ddddocr@master/ddddocr/common_old.onnx",
        "https://raw.githubusercontent.com/sml2h3/ddddocr/master/ddddocr/common_old.onnx",
      ]),
      "fusion_v7/direct.onnx": Object.freeze([
        "https://cdn.jsdelivr.net/gh/Stevenqqqq/steven-chrome-captcha-ocr@main/models/fusion_v7/direct.onnx",
        "https://raw.githubusercontent.com/Stevenqqqq/steven-chrome-captcha-ocr/main/models/fusion_v7/direct.onnx",
      ]),
      "fusion_v7/crop.onnx": Object.freeze([
        "https://cdn.jsdelivr.net/gh/Stevenqqqq/steven-chrome-captcha-ocr@main/models/fusion_v7/crop.onnx",
        "https://raw.githubusercontent.com/Stevenqqqq/steven-chrome-captcha-ocr/main/models/fusion_v7/crop.onnx",
      ]),
    }),
  });

  const HINT_PATTERN = /captcha|verify|verification|vcode|auth.?code|check.?code|security.?code|驗證碼|验证码|圖形碼|校驗碼/i;
  const INPUT_SELECTOR = "input:not([type]), input[type='text'], input[type='tel'], input[type='search'], input[type='number']";

  function resolveGmRequest() {
    if (typeof root.GM_xmlhttpRequest === "function") return root.GM_xmlhttpRequest;
    if (typeof GM_xmlhttpRequest === "function") return GM_xmlhttpRequest;
    if (typeof root.GM?.xmlHttpRequest === "function") return root.GM.xmlHttpRequest.bind(root.GM);
    if (typeof GM !== "undefined" && typeof GM?.xmlHttpRequest === "function") {
      return GM.xmlHttpRequest.bind(GM);
    }
    return null;
  }

  function resolveGmRegisterMenu() {
    if (typeof root.GM_registerMenuCommand === "function") return root.GM_registerMenuCommand;
    if (typeof GM_registerMenuCommand === "function") return GM_registerMenuCommand;
    return null;
  }

  function resolveDefaultOrt() {
    if (root.ort) return root.ort;
    try {
      if (typeof ort !== "undefined" && ort) return ort;
    } catch {
      // Ignore ReferenceError when ort has not been loaded.
    }
    return null;
  }

  function toUint8Array(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    return null;
  }

  function slicedArrayBuffer(bytes) {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  function jsonResponse(payload) {
    return {
      ok: true,
      status: 200,
      json: async () => payload,
    };
  }

  function binaryResponse(bytes) {
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => slicedArrayBuffer(bytes),
    };
  }

  /**
   * Opens IndexedDB for persistent binary asset caching, returning null if unavailable.
   */
  function openAssetDb(idbFactory) {
    if (!idbFactory || typeof idbFactory.open !== "function") return Promise.resolve(null);
    return new Promise((resolve) => {
      try {
        const request = idbFactory.open(IDB_NAME, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) {
            db.createObjectStore(IDB_STORE);
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  async function readIdbAsset(dbPromise, key) {
    const db = await dbPromise;
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE, "readonly");
        const store = tx.objectStore(IDB_STORE);
        const req = store.get(key);
        req.onsuccess = () => resolve(toUint8Array(req.result));
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  async function writeIdbAsset(dbPromise, key, bytes) {
    const db = await dbPromise;
    if (!db) return;
    await new Promise((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE, "readwrite");
        const store = tx.objectStore(IDB_STORE);
        const req = store.put(slicedArrayBuffer(bytes), key);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  /**
   * Creates a binary asset loader with memory + IndexedDB cache and GM_xmlhttpRequest priority.
   */
  function createAssetLoader({
    gmRequest = resolveGmRequest(),
    fetchImpl = typeof root.fetch === "function" ? root.fetch.bind(root) : null,
    indexedDB = root.indexedDB,
    onProgress,
    minBytes = MIN_ASSET_BYTES,
  } = {}) {
    const memoryCache = new Map();
    const pendingLoads = new Map();
    const dbPromise = openAssetDb(indexedDB);

    async function fetchViaGm(url) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (ok, value) => {
          if (settled) return;
          settled = true;
          if (ok) resolve(value);
          else reject(value);
        };
        try {
          const maybePromise = gmRequest({
            method: "GET",
            url,
            responseType: "arraybuffer",
            timeout: 45000,
            onload: (resp) => {
              if (resp && resp.status >= 200 && resp.status < 300) {
                const bytes = toUint8Array(resp.response);
                if (bytes) {
                  finish(true, bytes);
                  return;
                }
              }
              finish(false, new Error(`下載失敗 (${resp?.status ?? "unknown"}): ${url}`));
            },
            onerror: (err) => finish(false, new Error(`連線失敗: ${err?.error || url}`)),
            ontimeout: () => finish(false, new Error(`下載逾時: ${url}`)),
          });
          if (maybePromise && typeof maybePromise.then === "function") {
            maybePromise.then(
              (resp) => {
                if (resp && resp.status >= 200 && resp.status < 300) {
                  const bytes = toUint8Array(resp.response);
                  if (bytes) {
                    finish(true, bytes);
                    return;
                  }
                }
                finish(false, new Error(`下載失敗 (${resp?.status ?? "unknown"}): ${url}`));
              },
              (err) => finish(false, err instanceof Error ? err : new Error(String(err))),
            );
          }
        } catch (error) {
          finish(false, error instanceof Error ? error : new Error(String(error)));
        }
      });
    }

    async function fetchSingleUrl(url, requiredMinBytes) {
      let bytes = null;
      if (typeof gmRequest === "function") {
        bytes = await fetchViaGm(url);
      } else if (typeof fetchImpl === "function") {
        const resp = await fetchImpl(url, { cache: "force-cache" });
        if (!resp?.ok) throw new Error(`下載失敗 (${resp?.status ?? "unknown"}): ${url}`);
        bytes = new Uint8Array(await resp.arrayBuffer());
      } else {
        throw new Error("沒有可用的網路請求介面");
      }
      if (!bytes || bytes.byteLength < requiredMinBytes) {
        throw new Error(`下載檔案過小 (${bytes?.byteLength ?? 0} bytes): ${url}`);
      }
      return bytes;
    }

    async function fetchRawBytes(urlOrUrls, { minByteLength = 16 } = {}) {
      const urls = Array.isArray(urlOrUrls) ? urlOrUrls : [urlOrUrls];
      let lastError = null;
      for (const url of urls) {
        if (!url) continue;
        try {
          return await fetchSingleUrl(url, minByteLength);
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError || new Error("找不到可用的資源網址");
    }

    async function getBinary(key, urls) {
      if (memoryCache.has(key)) return memoryCache.get(key);
      if (pendingLoads.has(key)) return pendingLoads.get(key);

      const loadPromise = (async () => {
        const cached = await readIdbAsset(dbPromise, key);
        if (cached && cached.byteLength >= minBytes) {
          memoryCache.set(key, cached);
          return cached;
        }
        onProgress?.({ stage: "download", key });
        const downloaded = await fetchRawBytes(urls, { minByteLength: minBytes });
        memoryCache.set(key, downloaded);
        await writeIdbAsset(dbPromise, key, downloaded);
        return downloaded;
      })();

      pendingLoads.set(key, loadPromise);
      try {
        return await loadPromise;
      } finally {
        pendingLoads.delete(key);
      }
    }

    return {
      getBinary,
      fetchRawBytes,
      hasMemoryAsset: (key) => memoryCache.has(key),
    };
  }

  /**
   * Adapts BrowserOcr's fetch-based model loading to virtual in-memory / cached URLs.
   */
  function createVirtualModelFetch({
    assetLoader,
    officialCharset,
    fusionConfig,
    modelUrls = DEFAULT_ASSETS.MODEL_URLS,
    includeFusion = true,
  }) {
    const manifest = {
      schema_version: 2,
      bundles: {
        ...(officialCharset ? { official: { kind: "ddddocr_ctc" } } : {}),
        ...(includeFusion && fusionConfig ? { fusion_v7: { kind: "fixed4_dual_cnn" } } : {}),
      },
    };

    const jsonRoutes = {
      [`${VIRTUAL_MODEL_BASE_URL}/bundle_manifest.json`]: manifest,
      ...(officialCharset ? { [`${VIRTUAL_MODEL_BASE_URL}/official/charset.json`]: officialCharset } : {}),
      ...(includeFusion && fusionConfig ? { [`${VIRTUAL_MODEL_BASE_URL}/fusion_v7/config.json`]: fusionConfig } : {}),
    };

    const binaryRoutes = {
      [`${VIRTUAL_MODEL_BASE_URL}/official/common_old.onnx`]: {
        key: "official/common_old.onnx",
        urls: modelUrls["official/common_old.onnx"],
      },
      [`${VIRTUAL_MODEL_BASE_URL}/fusion_v7/direct.onnx`]: {
        key: "fusion_v7/direct.onnx",
        urls: modelUrls["fusion_v7/direct.onnx"],
      },
      [`${VIRTUAL_MODEL_BASE_URL}/fusion_v7/crop.onnx`]: {
        key: "fusion_v7/crop.onnx",
        urls: modelUrls["fusion_v7/crop.onnx"],
      },
    };

    return async function virtualFetch(url) {
      if (Object.hasOwn(jsonRoutes, url)) {
        return jsonResponse(jsonRoutes[url]);
      }
      const binaryRoute = binaryRoutes[url];
      if (binaryRoute) {
        const bytes = await assetLoader.getBinary(binaryRoute.key, binaryRoute.urls);
        return binaryResponse(bytes);
      }
      return { ok: false, status: 404 };
    };
  }

  function isInsideMobileHost(element) {
    if (!element) return false;
    if (element.id === HOST_ID || element.closest?.(`#${HOST_ID}`)) return true;
    const rootNode = element.getRootNode?.();
    return Boolean(rootNode && rootNode !== element && rootNode.host?.id === HOST_ID);
  }

  function isElementVisible(element, win) {
    if (!element || isInsideMobileHost(element)) return false;
    const style = win.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none"
      && style.visibility !== "hidden"
      && style.visibility !== "collapse"
      && Number(style.opacity || "1") > 0
      && rect.width >= 20
      && rect.height >= 12
      && rect.bottom > 0
      && rect.right > 0
      && rect.top < win.innerHeight
      && rect.left < win.innerWidth;
  }

  function elementText(element) {
    return [
      element.id || "",
      element.getAttribute?.("class") || "",
      element.getAttribute?.("name") || "",
      element.getAttribute?.("alt") || "",
      element.getAttribute?.("title") || "",
      element.getAttribute?.("placeholder") || "",
      element.getAttribute?.("aria-label") || "",
      element.getAttribute?.("src") || "",
    ].join(" ").toLowerCase();
  }

  function associatedLabelText(input) {
    const fragments = Array.from(input.labels || []).map((label) => label.textContent || "");
    const wrappingLabel = input.closest?.("label");
    if (wrappingLabel) fragments.push(wrappingLabel.textContent || "");
    const labelledBy = (input.getAttribute?.("aria-labelledby") || "").split(/\s+/).filter(Boolean);
    const scope = input.getRootNode?.();
    labelledBy.forEach((id) => fragments.push(scope?.getElementById?.(id)?.textContent || ""));
    return fragments.join(" ");
  }

  function localInputContext(input) {
    const container = input.closest?.(
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
  }

  function rectDistance(first, second) {
    const a = first.getBoundingClientRect();
    const b = second.getBoundingClientRect();
    return Math.hypot(
      a.left + a.width / 2 - (b.left + b.width / 2),
      a.top + a.height / 2 - (b.top + b.height / 2),
    );
  }

  function isNearbyCaptchaInput(image, imageRect, candidate) {
    const { input, metadata, labelText, rect: field } = candidate;
    if (!HINT_PATTERN.test(`${metadata} ${labelText}`)) return false;
    if (input.parentNode !== image.parentNode) return false;
    const gapX = Math.max(imageRect.left - field.right, field.left - imageRect.right, 0);
    const gapY = Math.max(imageRect.top - field.bottom, field.top - imageRect.bottom, 0);
    return (gapX <= 40 && gapY === 0) || (gapY <= 24 && gapX === 0);
  }

  /**
   * Detects the highest-scoring visible CAPTCHA image and editable input pair on the page.
   */
  function detectCaptchaTarget(doc = root.document, detect = root.CaptchaDetect) {
    if (!doc || !detect) return { ok: false };
    const win = doc.defaultView || root;
    const findAll = (selector) => detect.queryAllDeep(doc, selector);
    const usableInput = (input) => !input.disabled
      && !input.readOnly
      && !input.matches?.(":disabled")
      && isElementVisible(input, win);

    const inputs = findAll(INPUT_SELECTOR).filter(usableInput).map((input) => ({
      input,
      metadata: elementText(input),
      labelText: associatedLabelText(input),
      localContext: localInputContext(input),
      rect: input.getBoundingClientRect(),
    }));
    if (!inputs.length) return { ok: false };

    const images = findAll("img, canvas, svg").filter((el) => isElementVisible(el, win));
    const hintedBackgrounds = findAll("[id], [class]").filter((element) => {
      if (!isElementVisible(element, win) || !HINT_PATTERN.test(elementText(element))) return false;
      return win.getComputedStyle(element).backgroundImage !== "none";
    });

    const candidates = [...new Set([...images, ...hintedBackgrounds])].map((image) => {
      const rect = image.getBoundingClientRect();
      const metadata = elementText(image);
      const parentText = image.closest?.("tr, .form-group, .field, .input-group, form")?.textContent || "";
      let score = 0;
      if (HINT_PATTERN.test(metadata)) score += 55;
      if (HINT_PATTERN.test(parentText)) score += 24;
      if (rect.width >= 45 && rect.width <= 420) score += 10;
      if (rect.height >= 18 && rect.height <= 180) score += 10;
      const ratio = rect.width / Math.max(rect.height, 1);
      if (ratio >= 1.2 && ratio <= 7) score += 8;

      let eligibleInputs = inputs;
      if (image.tagName?.toLowerCase() === "svg") {
        if (rect.width < 36 || rect.width > 420 || rect.height < 16 || rect.height > 180) return null;
        if (!HINT_PATTERN.test(metadata)) {
          eligibleInputs = inputs.filter((candidate) => isNearbyCaptchaInput(image, rect, candidate));
        }
      }

      const rankedInputs = eligibleInputs
        .map((candidate) => ({
          input: candidate.input,
          score: detect.scoreInputAssociation({
            metadata: candidate.metadata,
            labelText: candidate.labelText,
            localContext: candidate.localContext,
            maxLength: candidate.input.maxLength,
            hasValue: Boolean(candidate.input.value),
            imageRect: rect,
            inputRect: candidate.rect,
          }),
        }))
        .sort((a, b) => b.score - a.score);

      if (!rankedInputs[0]) return null;
      score += Math.min(35, rankedInputs[0].score / 2);
      return {
        image,
        input: rankedInputs[0].input,
        score,
        inputScore: rankedInputs[0].score,
        inputDistance: rectDistance(rankedInputs[0].input, image),
      };
    }).filter((item) => item?.input);

    const best = detect.rankCandidates(candidates)[0];
    if (!best || best.score < 22 || best.inputScore < 8) return { ok: false };

    const hints = detect.inferInputHints({
      type: best.input.type,
      inputMode: best.input.inputMode,
      pattern: best.input.pattern,
      minLength: best.input.minLength,
      maxLength: best.input.maxLength,
      metadata: best.input.getAttribute?.("placeholder") || "",
      labelText: `${associatedLabelText(best.input)} ${best.input.getAttribute?.("aria-label") || ""}`,
      localContext: localInputContext(best.input),
    });

    return {
      ok: true,
      image: best.image,
      input: best.input,
      hints,
      score: Math.round(best.score),
    };
  }

  function extractCssBackgroundUrl(backgroundImage) {
    if (!backgroundImage || backgroundImage === "none") return "";
    const match = /url\(\s*(['"]?)(.*?)\1\s*\)/i.exec(backgroundImage);
    return match?.[2] || "";
  }

  function drawOnWhiteCanvas(drawable, width, height, doc) {
    const canvas = doc.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("瀏覽器不支援 Canvas 2D 讀取");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(drawable, 0, 0, width, height);
    const imageData = ctx.getImageData(0, 0, width, height);
    return {
      rgba: new Uint8Array(imageData.data.buffer, imageData.data.byteOffset, imageData.data.byteLength),
      width,
      height,
    };
  }

  async function decodeBlobToRgba(blob, doc) {
    const win = doc.defaultView || root;
    if (typeof win.createImageBitmap === "function") {
      const bitmap = await win.createImageBitmap(blob);
      try {
        return drawOnWhiteCanvas(bitmap, bitmap.width, bitmap.height, doc);
      } finally {
        bitmap.close?.();
      }
    }
    const urlApi = win.URL || root.URL;
    const objectUrl = urlApi.createObjectURL(blob);
    try {
      const ImageCtor = win.Image || root.Image;
      const img = new ImageCtor();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error("無法解碼驗證碼圖片"));
        img.src = objectUrl;
      });
      return drawOnWhiteCanvas(img, img.naturalWidth || img.width, img.naturalHeight || img.height, doc);
    } finally {
      urlApi.revokeObjectURL(objectUrl);
    }
  }

  /**
   * Extracts RGBA pixels from an IMG, CANVAS, SVG, or CSS-background CAPTCHA element.
   */
  async function extractImageRgba(image, {
    doc = root.document,
    detect = root.CaptchaDetect,
    captchaImage = root.CaptchaImage,
    assetLoader,
    decodeBlob = (blob) => decodeBlobToRgba(blob, doc),
  } = {}) {
    if (!image) throw new Error("找不到驗證碼圖片");
    const win = doc.defaultView || root;
    const tag = image.tagName?.toUpperCase();

    if (tag === "SVG") {
      const Serializer = win.XMLSerializer || root.XMLSerializer;
      const markup = new Serializer().serializeToString(image);
      const rect = image.getBoundingClientRect();
      const pngBlob = await captchaImage.rasterizeSvgCaptcha(markup, {
        width: rect.width,
        height: rect.height,
      });
      return decodeBlob(pngBlob);
    }

    if (tag === "CANVAS") {
      const width = Number(image.width);
      const height = Number(image.height);
      if (!(width >= 10 && height >= 10 && width * height <= 2_000_000)) {
        throw new Error("Canvas 驗證碼尺寸無效");
      }
      return drawOnWhiteCanvas(image, width, height, doc);
    }

    let sourceUrl = "";
    if (tag === "IMG") {
      sourceUrl = image.currentSrc || image.getAttribute?.("src") || "";
      const width = Number(image.naturalWidth || image.width);
      const height = Number(image.naturalHeight || image.height);
      if (width >= 10 && height >= 10 && width * height <= 2_000_000) {
        try {
          if (
            sourceUrl
            && /^data:image\/(?:png|jpeg|webp);base64,/i.test(sourceUrl)
            && captchaImage?.decodeSafeDataImage
          ) {
            const decoded = captchaImage.decodeSafeDataImage(sourceUrl);
            return await decodeBlob(new Blob([decoded.bytes], { type: decoded.type }));
          }
          return drawOnWhiteCanvas(image, width, height, doc);
        } catch {
          // Cross-origin <img> taints canvas; fall back to GM_xmlhttpRequest fetch below.
        }
      }
    } else {
      sourceUrl = extractCssBackgroundUrl(win.getComputedStyle(image).backgroundImage);
    }

    if (!sourceUrl) throw new Error("無法讀取驗證碼圖片來源");
    if (/^data:image\//i.test(sourceUrl)) {
      if (!captchaImage?.decodeSafeDataImage) throw new Error("不支援的圖片格式");
      const decoded = captchaImage.decodeSafeDataImage(sourceUrl);
      return decodeBlob(new Blob([decoded.bytes], { type: decoded.type }));
    }

    const resolvedUrl = new URL(sourceUrl, doc.location?.href || win.location?.href || "https://localhost/").href;
    if (!assetLoader) throw new Error("跨網域圖片需要 GM_xmlhttpRequest 載入器");
    const rawBytes = await assetLoader.fetchRawBytes(resolvedUrl, { minByteLength: 16 });
    if (rawBytes.byteLength > MAX_CAPTCHA_IMAGE_BYTES) {
      throw new Error("驗證碼圖片超過 5 MB");
    }
    return decodeBlob(new Blob([rawBytes]));
  }

  /**
   * Creates an idle-managed mobile OCR engine backed by BrowserOcr + virtual model fetch.
   */
  function createMobileOcrEngine({
    getOrt = resolveDefaultOrt,
    assetLoader,
    browserOcr = root.BrowserOcr,
    officialCharset = root.__STEVEN_OCR_EMBEDDED_ASSETS__?.officialCharset,
    fusionConfig = root.__STEVEN_OCR_EMBEDDED_ASSETS__?.fusionConfig,
    assets = DEFAULT_ASSETS,
    idleMs = IDLE_TIMEOUT_MS,
    setTimer = (fn, ms) => root.setTimeout(fn, ms),
    clearTimer = (id) => root.clearTimeout(id),
    onStatus,
  }) {
    let runtime = null;
    let initPromise = null;
    let disposePromise = Promise.resolve();
    let inFlight = 0;
    let idleTimer = null;

    function cancelIdleTimer() {
      if (idleTimer !== null) {
        clearTimer(idleTimer);
        idleTimer = null;
      }
    }

    async function releaseForIdle() {
      idleTimer = null;
      if (inFlight > 0 || !runtime) return;
      const active = runtime;
      runtime = null;
      disposePromise = Promise.resolve(active.dispose?.()).catch(() => {});
      await disposePromise;
    }

    function scheduleIdleTimer() {
      cancelIdleTimer();
      if (inFlight > 0 || !runtime || !(idleMs > 0)) return;
      idleTimer = setTimer(() => {
        releaseForIdle().catch(() => {});
      }, idleMs);
    }

    async function configureOrtWasm(ortInstance) {
      const wasmEnv = ortInstance?.env?.wasm;
      if (!wasmEnv) return;
      wasmEnv.wasmPaths = assets.ORT_WASM_DIR;
      wasmEnv.numThreads = 1;
      wasmEnv.proxy = false;
      if (!wasmEnv.wasmBinary && assetLoader) {
        onStatus?.("載入推論引擎...");
        const wasmBytes = await assetLoader.getBinary(
          "ort/ort-wasm-simd-threaded.wasm",
          assets.ORT_WASM_URLS,
        );
        wasmEnv.wasmBinary = wasmBytes;
      }
    }

    async function ensureRuntime() {
      await disposePromise;
      if (runtime) return runtime;
      if (initPromise) return initPromise;

      initPromise = (async () => {
        const ortInstance = getOrt();
        if (!ortInstance || typeof ortInstance.InferenceSession?.create !== "function") {
          throw new Error("onnxruntime-web 尚未載入，請確認網路或 Safari 權限");
        }
        await configureOrtWasm(ortInstance);

        const buildAndWarm = async (includeFusion) => {
          onStatus?.("載入離線模型...");
          const fetchImpl = createVirtualModelFetch({
            assetLoader,
            officialCharset,
            fusionConfig,
            modelUrls: assets.MODEL_URLS,
            includeFusion,
          });
          const candidate = browserOcr.createBrowserOcrRuntime({
            ort: ortInstance,
            modelBaseUrl: VIRTUAL_MODEL_BASE_URL,
            fetchImpl,
          });
          try {
            await candidate.warmUp();
            return candidate;
          } catch (error) {
            await candidate.dispose?.().catch(() => {});
            throw error;
          }
        };

        try {
          runtime = await buildAndWarm(Boolean(fusionConfig));
        } catch (error) {
          if (!fusionConfig || !officialCharset) throw error;
          // Retry with official-only bundle if fusion_v7 download/init fails.
          runtime = await buildAndWarm(false);
        }
        return runtime;
      })();

      try {
        return await initPromise;
      } finally {
        initPromise = null;
      }
    }

    async function recognizeRgba(params) {
      cancelIdleTimer();
      inFlight += 1;
      try {
        const activeRuntime = await ensureRuntime();
        onStatus?.("辨識中...");
        return await activeRuntime.recognizeRgba(params);
      } finally {
        inFlight -= 1;
        if (inFlight === 0 && runtime) scheduleIdleTimer();
      }
    }

    async function dispose() {
      cancelIdleTimer();
      const active = runtime;
      runtime = null;
      if (active) {
        disposePromise = Promise.resolve(active.dispose?.()).catch(() => {});
        await disposePromise;
      }
    }

    return {
      IDLE_TIMEOUT_MS: idleMs,
      ensureRuntime,
      recognizeRgba,
      dispose,
      releaseForIdle,
      getState: () => ({
        hasRuntime: Boolean(runtime),
        inFlight,
        hasIdleTimer: idleTimer !== null,
      }),
    };
  }

  function expandRect(rect, pad) {
    return {
      left: rect.left - pad,
      top: rect.top - pad,
      right: (rect.right ?? rect.left + rect.width) + pad,
      bottom: (rect.bottom ?? rect.top + rect.height) + pad,
    };
  }

  function intersectionArea(a, b) {
    const overlapW = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const overlapH = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return overlapW * overlapH;
  }

  function hasValidRect(rect) {
    return (
      Number.isFinite(rect?.left)
      && Number.isFinite(rect?.top)
      && Number.isFinite(rect?.width)
      && Number.isFinite(rect?.height)
      && rect.width > 0
      && rect.height > 0
    );
  }

  function computePillPosition(inputRect, viewport, pillSize, imageRect = null) {
    if (
      !Number.isFinite(inputRect?.left)
      || !Number.isFinite(inputRect?.bottom)
      || inputRect.width === 0
      || inputRect.height === 0
    ) {
      return { right: 16, bottom: 16 };
    }
    const pillW = pillSize?.width || 160;
    const pillH = pillSize?.height || 44;
    const clamp = (value, extent, size) => Math.max(
      VIEWPORT_MARGIN,
      Math.min(value, extent - size - VIEWPORT_MARGIN),
    );
    const defaultPos = {
      left: clamp(inputRect.left, viewport.width, pillW),
      top: clamp(inputRect.bottom + 6, viewport.height, pillH),
    };
    if (!hasValidRect(imageRect)) {
      return defaultPos;
    }

    const inputTop = Number.isFinite(inputRect.top) ? inputRect.top : inputRect.bottom - inputRect.height;
    const inputRight = Number.isFinite(inputRect.right) ? inputRect.right : inputRect.left + inputRect.width;
    const imageRight = Number.isFinite(imageRect.right) ? imageRect.right : imageRect.left + imageRect.width;
    const imageBottom = Number.isFinite(imageRect.bottom) ? imageRect.bottom : imageRect.top + imageRect.height;

    const rawCandidates = [
      { left: inputRect.left, top: inputRect.bottom + 6 },
      { left: inputRight - pillW, top: inputTop - pillH - 6 },
      { left: imageRight + 8, top: inputRect.bottom + 6 },
      { left: inputRect.left, top: Math.min(inputTop, imageRect.top) - pillH - 6 },
      { left: inputRect.left, top: Math.max(inputRect.bottom, imageBottom) + 6 },
    ];

    const blockedImage = expandRect(imageRect, 4);
    const blockedInput = expandRect({
      left: inputRect.left,
      top: inputTop,
      right: inputRight,
      bottom: inputRect.bottom,
    }, 2);

    let bestPos = defaultPos;
    let bestOverlap = Infinity;
    for (const candidate of rawCandidates) {
      const left = clamp(candidate.left, viewport.width, pillW);
      const top = clamp(candidate.top, viewport.height, pillH);
      const pillBox = { left, top, right: left + pillW, bottom: top + pillH };
      const overlap = intersectionArea(pillBox, blockedImage) + intersectionArea(pillBox, blockedInput);
      if (overlap === 0) {
        return { left, top };
      }
      if (overlap < bestOverlap) {
        bestOverlap = overlap;
        bestPos = { left, top };
      }
    }
    return bestPos;
  }

  function normalizeDigitHomoglyphs(text) {
    return String(text || "").replace(/[OoIlZzSsB]/g, (ch) => {
      if (ch === "O" || ch === "o") return "0";
      if (ch === "I" || ch === "l") return "1";
      if (ch === "Z" || ch === "z") return "2";
      if (ch === "S" || ch === "s") return "5";
      if (ch === "B") return "8";
      return ch;
    });
  }

  function buildSwapCandidates(currentAnswer, candidates) {
    const seen = new Set([currentAnswer]);
    const digitsOnlyMode = /^[0-9]{4,8}$/.test(currentAnswer);
    const seenDigits = new Set(digitsOnlyMode ? [currentAnswer] : []);
    const swaps = [];
    for (const candidate of candidates || []) {
      const answer = candidate?.answer;
      if (typeof answer !== "string" || !answer.trim() || seen.has(answer)) continue;
      if (digitsOnlyMode) {
        if (/^[0-9]+$/.test(answer)) {
          seenDigits.add(answer);
        } else if (seenDigits.has(normalizeDigitHomoglyphs(answer))) {
          continue;
        }
      }
      seen.add(answer);
      swaps.push(candidate);
      if (swaps.length === 2) break;
    }
    return swaps;
  }

  function editableInput(input) {
    return input?.tagName?.toLowerCase() === "input"
      && !input.disabled
      && !input.readOnly
      && !input.matches?.(":disabled")
      && input.isConnected !== false;
  }

  const MOBILE_PILL_CSS = `
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
      --ocr-warning: #f59e0b;
      --ocr-danger: #ef4444;
      --ocr-font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
      --ocr-font-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
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
      max-width: calc(100vw - 24px);
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 5px;
      padding: 5px 8px;
      min-height: 34px;
      border: 1px solid rgba(59, 130, 246, 0.45);
      border-radius: 10px;
      background: var(--ocr-popover);
      box-shadow: 0 10px 26px rgba(0, 0, 0, 0.45);
      color: var(--ocr-fg);
      font: 12.5px var(--ocr-font-sans);
      pointer-events: auto;
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
      user-select: none;
    }
    .badge {
      border-radius: 999px;
      padding: 2px 7px;
      font-size: 11px;
      font-weight: 700;
    }
    .badge-ok {
      background: rgba(34, 197, 94, 0.16);
      border: 1px solid rgba(34, 197, 94, 0.35);
      color: var(--ocr-success);
    }
    .badge-warn {
      background: rgba(245, 158, 11, 0.16);
      border: 1px solid rgba(245, 158, 11, 0.35);
      color: var(--ocr-warning);
    }
    .badge-err {
      background: rgba(239, 68, 68, 0.16);
      border: 1px solid rgba(239, 68, 68, 0.35);
      color: var(--ocr-danger);
    }
    .answer {
      font: 700 13.5px var(--ocr-font-mono);
      letter-spacing: 0.04em;
      overflow-wrap: anywhere;
    }
    .status-text {
      color: var(--ocr-fg);
      font-size: 12px;
      font-weight: 600;
    }
    button {
      cursor: pointer;
      min-height: 26px;
      padding: 3px 8px;
      border-radius: 7px;
      border: 1px solid var(--ocr-border);
      background: var(--ocr-secondary);
      color: var(--ocr-fg);
      font: 600 12px var(--ocr-font-sans);
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
    }
    button:disabled {
      opacity: 0.6;
      cursor: default;
    }
    .primary-btn {
      background: var(--ocr-primary);
      border-color: rgba(59, 130, 246, 0.8);
      color: #ffffff;
    }
    .swap-btn {
      font-family: var(--ocr-font-mono);
    }
    .icon-btn {
      padding: 3px 6px;
      background: transparent;
      border-color: transparent;
      color: var(--ocr-muted);
    }
    .row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 5px;
    }
    .row[hidden] {
      display: none;
    }
  `;

  /**
   * Mounts and maintains a touch-friendly Shadow DOM floating control for mobile Safari.
   */
  function mountMobileCaptchaUi({
    doc = root.document,
    engine,
    detect = root.CaptchaDetect,
    captchaImage = root.CaptchaImage,
    assetLoader,
    decodeBlob,
    observeMutations = true,
  }) {
    if (!doc?.documentElement || !engine || !detect) return null;
    const win = doc.defaultView || root;
    doc.getElementById(HOST_ID)?.[disposeHostSymbol]?.();

    const nativeSetter = Object.getOwnPropertyDescriptor(win.HTMLInputElement?.prototype || {}, "value")?.set;

    const make = (tag, className, text) => {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text) node.textContent = text;
      return node;
    };

    const preventSteal = (event) => {
      event.preventDefault?.();
    };

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

    const mainRow = make("div", "row");
    const swapsRow = make("div", "row");
    pill.append(mainRow, swapsRow);
    shadow.append(make("style", "", MOBILE_PILL_CSS), pill);

    let mode = "idle"; // idle | busy | result | error
    let busyText = "⏳ 辨識中...";
    let errorText = "";
    let currentTarget = null;
    let currentIdentity = "";
    let lastResult = null;
    let currentAnswer = "";
    let dismissedKey = "";
    let closed = false;
    let scanTimer = null;
    let observer = null;

    function targetKey(target) {
      if (!target?.image || !target?.input) return "";
      const id = detect.imageIdentity(
        target.image,
        "",
        win.getComputedStyle(target.image).backgroundImage,
      );
      return `${id}|${target.input.id || target.input.name || "input"}`;
    }

    function canFillCandidate(input, answer) {
      if (!editableInput(input) || typeof answer !== "string" || !answer) return false;
      return input.type !== "number" || /^[0-9]+$/.test(answer);
    }

    function applyAnswerToInput(input, value) {
      if (!canFillCandidate(input, value)) return false;
      if (nativeSetter) nativeSetter.call(input, value);
      else input.value = value;
      if (input.value !== value) return false;
      input.dispatchEvent(new win.Event("input", { bubbles: true, composed: true }));
      input.dispatchEvent(new win.Event("change", { bubbles: true }));
      return input.value === value;
    }

    function positionPill() {
      if (!host.isConnected && !host.parent) return;
      const input = currentTarget?.input;
      const image = currentTarget?.image;
      const inputRect = input?.isConnected === false ? null : input?.getBoundingClientRect?.();
      const imageRect = image?.isConnected === false ? null : image?.getBoundingClientRect?.();
      const viewport = {
        width: win.visualViewport?.width || win.innerWidth,
        height: win.visualViewport?.height || win.innerHeight,
      };
      const coords = computePillPosition(inputRect, viewport, pill.getBoundingClientRect(), imageRect);
      for (const edge of ["left", "top", "right", "bottom"]) {
        pill.style[edge] = coords[edge] === undefined ? "" : `${coords[edge]}px`;
      }
    }

    function render() {
      if (closed || !currentTarget) return;
      if (!host.parent && !host.isConnected) {
        doc.documentElement.append(host);
      }
      swapsRow.replaceChildren();
      swapsRow.hidden = true;

      const closeBtn = makeButton("×", "icon-btn", dismiss);
      closeBtn.setAttribute("aria-label", "關閉");

      if (mode === "busy") {
        const label = make("span", "status-text", busyText);
        mainRow.replaceChildren(label, closeBtn);
      } else if (mode === "error") {
        const badge = make("span", "badge badge-err", "⚠️ 失敗");
        const msg = make("span", "status-text", errorText);
        const retryBtn = makeButton("🔄 重試", "primary-btn", () => recognizeCurrent());
        mainRow.replaceChildren(badge, msg, retryBtn, closeBtn);
      } else if (mode === "result" && lastResult) {
        const input = currentTarget.input;
        const mismatch = lastResult.length_match === false;
        const candidates = [{ answer: lastResult.answer, confidence: lastResult.confidence }, ...(lastResult.candidates || [])];
        const retryBtn = makeButton("🔄", "icon-btn", () => recognizeCurrent());
        retryBtn.setAttribute("aria-label", "重新辨識");

        if (mismatch) {
          const badge = make("span", "badge badge-warn", "⚠️ 長度不符");
          const fillBtn = makeButton(`仍填入 ${lastResult.answer}`, "swap-btn", () => {
            if (applyAnswerToInput(input, lastResult.answer)) {
              currentAnswer = lastResult.answer;
              lastResult = { ...lastResult, length_match: true };
              render();
            }
          });
          mainRow.replaceChildren(badge, fillBtn, retryBtn, closeBtn);
          const swapButtons = buildSwapCandidates(lastResult.answer, candidates)
            .filter((c) => canFillCandidate(input, c.answer))
            .map((c) => makeButton(`改填 ${c.answer}`, "swap-btn", () => {
              if (applyAnswerToInput(input, c.answer)) {
                currentAnswer = c.answer;
                lastResult = { ...lastResult, length_match: true };
                render();
              }
            }));
          if (swapButtons.length) {
            swapsRow.replaceChildren(...swapButtons);
            swapsRow.hidden = false;
          }
        } else {
          const badge = make("span", "badge badge-ok", "✓ 已填入");
          const answerSpan = make("span", "answer", currentAnswer);
          answerSpan.setAttribute("role", "status");
          mainRow.replaceChildren(badge, answerSpan, retryBtn, closeBtn);
          const swapButtons = buildSwapCandidates(currentAnswer, candidates)
            .filter((c) => canFillCandidate(input, c.answer))
            .map((c) => makeButton(`改填 ${c.answer}`, "swap-btn", () => {
              if (applyAnswerToInput(input, c.answer)) {
                currentAnswer = c.answer;
                render();
              }
            }));
          if (swapButtons.length) {
            swapsRow.replaceChildren(...swapButtons);
            swapsRow.hidden = false;
          }
        }
      } else {
        const triggerBtn = makeButton("🔍 辨識驗證碼", "primary-btn", () => recognizeCurrent());
        mainRow.replaceChildren(triggerBtn, closeBtn);
      }

      positionPill();
    }

    async function recognizeCurrent() {
      if (closed || mode === "busy") return;
      const freshTarget = detectCaptchaTarget(doc, detect);
      if (freshTarget.ok) {
        currentTarget = freshTarget;
      }
      if (!currentTarget?.image || !currentTarget?.input) return;

      mode = "busy";
      busyText = "⏳ 讀取圖片...";
      render();

      try {
        const { rgba, width, height } = await extractImageRgba(currentTarget.image, {
          doc,
          detect,
          captchaImage,
          assetLoader,
          decodeBlob,
        });
        const result = await engine.recognizeRgba({
          rgba,
          width,
          height,
          expectedLength: currentTarget.hints?.expectedLength ?? null,
          lengthMode: currentTarget.hints?.lengthMode || "exact",
          charsetHint: currentTarget.hints?.charsetHint || "alphanumeric",
          caseSensitive: Boolean(currentTarget.hints?.caseSensitive),
        });
        if (closed) return;

        lastResult = result;
        currentAnswer = result.answer;
        if (result.length_match !== false) {
          applyAnswerToInput(currentTarget.input, result.answer);
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

    function detachHost() {
      host.remove();
    }

    function dismiss() {
      dismissedKey = targetKey(currentTarget);
      mode = "idle";
      lastResult = null;
      currentAnswer = "";
      detachHost();
    }

    function canPreserveCurrentTarget() {
      return (
        (mode === "result" || mode === "error")
        && currentTarget?.image?.isConnected !== false
        && currentTarget?.input?.isConnected !== false
        && isElementVisible(currentTarget.image, win)
        && editableInput(currentTarget.input)
        && isElementVisible(currentTarget.input, win)
      );
    }

    function scan({ force = false } = {}) {
      if (closed || mode === "busy") return;
      const found = detectCaptchaTarget(doc, detect);
      if (!found.ok) {
        if (!force && canPreserveCurrentTarget()) {
          positionPill();
          return;
        }
        currentTarget = null;
        currentIdentity = "";
        lastResult = null;
        currentAnswer = "";
        mode = "idle";
        detachHost();
        return;
      }

      const key = targetKey(found);
      if (!force && dismissedKey && dismissedKey === key) {
        return;
      }
      if (force) dismissedKey = "";

      const identity = detect.imageIdentity(
        found.image,
        "",
        win.getComputedStyle(found.image).backgroundImage,
      );
      if (identity !== currentIdentity || found.input !== currentTarget?.input) {
        mode = "idle";
        lastResult = null;
        currentAnswer = "";
        currentIdentity = identity;
      }
      currentTarget = found;
      render();
    }

    function scheduleScan() {
      if (closed || scanTimer !== null) return;
      scanTimer = win.setTimeout(() => {
        scanTimer = null;
        scan();
      }, 250);
    }

    function setEngineStatus(text) {
      if (mode !== "busy" || closed) return;
      busyText = `⏳ ${text}`;
      render();
    }

    function close() {
      if (closed) return;
      closed = true;
      if (scanTimer !== null) {
        win.clearTimeout(scanTimer);
        scanTimer = null;
      }
      observer?.disconnect();
      observer = null;
      win.removeEventListener("resize", positionPill);
      win.removeEventListener("scroll", positionPill, true);
      win.visualViewport?.removeEventListener("resize", positionPill);
      doc.removeEventListener?.("focusin", scheduleScan, true);
      detachHost();
    }

    host[disposeHostSymbol] = close;
    win.addEventListener("resize", positionPill);
    win.addEventListener("scroll", positionPill, true);
    win.visualViewport?.addEventListener("resize", positionPill);
    doc.addEventListener?.("focusin", scheduleScan, true);

    if (observeMutations && typeof win.MutationObserver === "function" && doc.body) {
      observer = new win.MutationObserver((mutations) => {
        const relevant = mutations.some((m) => m.target !== host && !isInsideMobileHost(m.target));
        if (relevant) scheduleScan();
      });
      observer.observe(doc.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "style", "class"],
      });
    }

    scan();

    return {
      scan,
      recognizeCurrent,
      setEngineStatus,
      dismiss,
      close,
      getUiState: () => ({
        mode,
        mounted: Boolean(host.isConnected || host.parent),
        currentAnswer,
        busyText,
        errorText,
      }),
    };
  }

  /**
   * Boots the complete mobile Userscript controller on the current page.
   */
  function startMobileUserscript({
    doc = root.document,
    detect = root.CaptchaDetect,
    captchaImage = root.CaptchaImage,
    browserOcr = root.BrowserOcr,
    assets = DEFAULT_ASSETS,
  } = {}) {
    const assetLoader = createAssetLoader();
    let uiController = null;
    const engine = createMobileOcrEngine({
      assetLoader,
      browserOcr,
      assets,
      onStatus: (text) => uiController?.setEngineStatus(text),
    });
    uiController = mountMobileCaptchaUi({
      doc,
      engine,
      detect,
      captchaImage,
      assetLoader,
    });
    const registerMenu = resolveGmRegisterMenu();
    if (registerMenu && uiController) {
      try {
        registerMenu("🔍 重新偵測並辨識驗證碼", () => {
          uiController.scan({ force: true });
          uiController.recognizeCurrent();
        });
      } catch {
        // Ignore menu registration failures in managers without menu support.
      }
    }
    return { assetLoader, engine, uiController };
  }

  return {
    IDLE_TIMEOUT_MS,
    VIRTUAL_MODEL_BASE_URL,
    HOST_ID,
    TOKEN_ATTRIBUTE,
    DEFAULT_ASSETS,
    createAssetLoader,
    createVirtualModelFetch,
    detectCaptchaTarget,
    extractImageRgba,
    createMobileOcrEngine,
    computePillPosition,
    buildSwapCandidates,
    mountMobileCaptchaUi,
    startMobileUserscript,
  };
});
