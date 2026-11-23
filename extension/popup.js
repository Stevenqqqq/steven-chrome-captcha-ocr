const OCR_URL = "http://127.0.0.1:8765";

const recognizeButton = document.querySelector("#recognizeButton");
const pickerButton = document.querySelector("#pickerButton");
const enginePill = document.querySelector("#enginePill");
const serviceState = document.querySelector("#serviceState");
const engineLabel = document.querySelector("#engineLabel");
const siteStatusText = document.querySelector("#siteStatusText");
const siteRuleBadge = document.querySelector("#siteRuleBadge");
const clearSiteRuleButton = document.querySelector("#clearSiteRuleButton");
const captureRow = document.querySelector("#captureRow");
const captureThumb = document.querySelector("#captureThumb");
const confidenceValue = document.querySelector("#confidenceValue");
const metaDetail = document.querySelector("#metaDetail");
const statusText = document.querySelector("#statusText");
const answerText = document.querySelector("#answerText");
const charTiles = document.querySelector("#charTiles");
const candidatesRow = document.querySelector("#candidatesRow");
const candidatesList = document.querySelector("#candidatesList");
const detailText = document.querySelector("#detailText");
const feedbackStrip = document.querySelector("#feedbackStrip");
const feedbackToggle = document.querySelector("#feedbackToggle");
const feedbackPanel = document.querySelector("#feedbackPanel");
const feedbackThumbWrap = document.querySelector("#feedbackThumbWrap");
const feedbackThumb = document.querySelector("#feedbackThumb");
const feedbackPrediction = document.querySelector("#feedbackPrediction");
const correctAnswerInput = document.querySelector("#correctAnswerInput");
const reportButton = document.querySelector("#reportButton");
const nextButton = document.querySelector("#nextButton");
const exportOfflineButton = document.querySelector("#exportOfflineButton");

const PENDING_FEEDBACK_KEY = "pendingFeedback";
const ENGINE_PREF_KEY = "enginePreference";
const OFFLINE_FEEDBACK_KEY = "offlineFeedbackQueue";
const MAX_OFFLINE_FEEDBACK = 100;
const NEXT_BUTTON_DEFAULT_TEXT = nextButton?.textContent || "答案正確／下一題";

let activeFeedback = null;
let cachedDetection = null;
let lastFillContext = null;
let activeCandidates = [];
let activeTabOrigin = "";
let activeThumbUrl = "";
let activeCapturedBlob = null;
let activeEngineMode = "python";
let engineHealth = {
  browser: { ok: false, models: [], error: null },
  python: { ok: false, solvers: [], error: null },
};

function isShortcutMode() {
  return PopupStartup.isShortcutInvocation(document?.body?.dataset?.invocation);
}

function setStatus(message, detail = "", answer = "") {
  if (statusText) statusText.textContent = message;
  if (detailText) detailText.textContent = detail;
  if (answerText) {
    answerText.textContent = answer;
    answerText.hidden = !answer || Boolean(charTiles && !charTiles.hidden);
  }
}

function setBusy(busy) {
  if (recognizeButton) recognizeButton.disabled = busy;
  if (pickerButton) pickerButton.disabled = busy;
  if (reportButton) reportButton.disabled = busy;
  if (nextButton) nextButton.disabled = busy;
  recognizeButton?.classList?.toggle("busy", busy);
}

function setFeedbackDrawerOpen(open) {
  if (feedbackPanel) feedbackPanel.hidden = !open;
  if (feedbackToggle) {
    feedbackToggle.textContent = open ? "收合糾正 ▴" : "展開糾正 ▾";
    feedbackToggle.setAttribute?.("aria-expanded", String(Boolean(open)));
  }
}

function updateThumbPreview(blobOrUrl) {
  if (activeThumbUrl && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
    try {
      URL.revokeObjectURL(activeThumbUrl);
    } catch {
      // Ignore cleanup errors in headless mocks.
    }
    activeThumbUrl = "";
  }
  let url = "";
  if (typeof blobOrUrl === "string") {
    url = blobOrUrl;
  } else if (blobOrUrl && typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
    try {
      url = URL.createObjectURL(blobOrUrl);
      activeThumbUrl = url;
    } catch {
      url = "";
    }
  }
  if (captureThumb) captureThumb.src = url;
  if (feedbackThumb) feedbackThumb.src = url;
  if (captureRow) captureRow.hidden = !url;
  if (feedbackThumbWrap) feedbackThumbWrap.hidden = !url;
}

async function blobToDataUrl(blob) {
  if (typeof FileReader !== "undefined") {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("無法轉換圖片資料"));
      reader.readAsDataURL(blob);
    });
  }
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < buffer.length; i += 1) binary += String.fromCharCode(buffer[i]);
  return `data:${blob.type || "image/png"};base64,${btoa(binary)}`;
}

function formatRuleBadge(profile) {
  if (!profile) return "";
  const parts = [];
  if (profile.expectedLength) {
    parts.push(profile.lengthMode === "max" ? `最多${profile.expectedLength}碼` : `${profile.expectedLength}碼`);
  }
  const charsetLabels = { digits: "純數字", letters: "純字母", alphanumeric: "英數" };
  if (charsetLabels[profile.charsetHint]) parts.push(charsetLabels[profile.charsetHint]);
  if (profile.caseSensitive) parts.push("區分大小寫");
  return parts.join(" · ") || "自訂選擇器";
}

async function refreshSiteProfileBar(tab) {
  if (!globalThis.SiteProfiles || !globalThis.chrome?.storage?.local || !tab?.url) return null;
  const origin = SiteProfiles.normalizeOrigin(tab.url);
  activeTabOrigin = origin;
  if (!origin) return null;
  try {
    const profile = await SiteProfiles.loadProfile(chrome.storage.local, origin);
    if (siteStatusText) siteStatusText.textContent = profile ? "已記憶" : "自動偵測";
    if (siteRuleBadge) {
      siteRuleBadge.textContent = profile ? formatRuleBadge(profile) : "";
      siteRuleBadge.hidden = !profile;
    }
    if (clearSiteRuleButton) clearSiteRuleButton.hidden = !profile;
    return profile;
  } catch {
    return null;
  }
}

async function refreshOfflineExportButton() {
  if (!exportOfflineButton || !globalThis.chrome?.storage?.local) return;
  try {
    const stored = await chrome.storage.local.get(OFFLINE_FEEDBACK_KEY);
    const items = Array.isArray(stored?.[OFFLINE_FEEDBACK_KEY]) ? stored[OFFLINE_FEEDBACK_KEY] : [];
    exportOfflineButton.hidden = items.length === 0;
    if (items.length > 0) {
      exportOfflineButton.textContent = `匯出離線錯題 (${items.length} 筆 JSON)`;
    }
  } catch {
    exportOfflineButton.hidden = true;
  }
}

function renderCharacterTiles(answer, charConfidences) {
  if (!charTiles || typeof document?.createElement !== "function") return;
  const chars = String(answer || "").split("");
  if (!chars.length) {
    charTiles.hidden = true;
    charTiles.textContent = "";
    return;
  }
  charTiles.textContent = "";
  chars.forEach((ch, index) => {
    const info = Array.isArray(charConfidences) ? charConfidences[index] : null;
    const conf = typeof info?.confidence === "number" ? info.confidence : 1;
    const alt = Array.isArray(info?.alternatives) && info.alternatives[0] ? info.alternatives[0] : "";
    const tile = document.createElement("div");
    tile.className = conf < 0.85 ? "char-tile warn" : "char-tile";
    if (conf < 0.85 && alt) {
      const hint = document.createElement("span");
      hint.className = "tile-hint";
      hint.textContent = `${ch}/${alt}`;
      tile.appendChild(hint);
    }
    tile.appendChild(document.createTextNode(ch));
    charTiles.appendChild(tile);
  });
  charTiles.hidden = false;
  if (answerText) answerText.hidden = true;
}

function buildTopCandidates(data) {
  const seen = new Set();
  const list = [];
  const rawList = Array.isArray(data?.top_candidates) && data.top_candidates.length
    ? data.top_candidates
    : Array.isArray(data?.candidates) ? data.candidates : [];
  if (data?.answer) {
    seen.add(data.answer);
    list.push({ answer: data.answer, confidence: data.confidence ?? null });
  }
  for (const item of rawList) {
    const val = String(item?.answer || "");
    if (!val || seen.has(val)) continue;
    seen.add(val);
    list.push({ answer: val, confidence: item.confidence ?? null });
    if (list.length >= 3) break;
  }
  return list;
}

function renderCandidateChips(candidates, selectedAnswer) {
  activeCandidates = candidates;
  if (!candidatesRow || !candidatesList || typeof document?.createElement !== "function") return;
  if (candidates.length <= 1) {
    candidatesRow.hidden = true;
    candidatesList.textContent = "";
    return;
  }
  candidatesList.textContent = "";
  candidates.forEach((item, index) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = item.answer === selectedAnswer ? "cand-chip active" : "cand-chip";
    btn.dataset.candidate = item.answer;
    const key = document.createElement("span");
    key.className = "cand-key";
    key.textContent = String(index + 1);
    btn.appendChild(key);
    btn.appendChild(document.createTextNode(item.answer));
    btn.addEventListener("click", () => {
      applyCandidateChoice(item.answer).catch(() => {});
    });
    candidatesList.appendChild(btn);
  });
  candidatesRow.hidden = false;
}

function renderMetrics(data, sourceLabel) {
  if (confidenceValue) {
    if (typeof data?.confidence === "number" && Number.isFinite(data.confidence)) {
      const pct = Math.round(data.confidence * 1000) / 10;
      confidenceValue.textContent = `${pct.toFixed(1)}%`;
      confidenceValue.classList?.toggle?.("warn", data.confidence < 0.85);
    } else {
      confidenceValue.textContent = "--";
      confidenceValue.classList?.toggle?.("warn", false);
    }
  }
  if (metaDetail) {
    const parts = [];
    if (sourceLabel) parts.push(sourceLabel);
    if (typeof data?.latency_ms === "number" && Number.isFinite(data.latency_ms)) {
      parts.push(`${Math.round(data.latency_ms)} ms`);
    }
    metaDetail.textContent = parts.join(" · ");
  }
}

async function applyCandidateChoice(candidateAnswer) {
  if (!candidateAnswer || !lastFillContext) return;
  await fillAnswer(lastFillContext.tabId, lastFillContext.frameId, lastFillContext.token, candidateAnswer);
  if (activeFeedback) {
    activeFeedback.answer = candidateAnswer;
    await savePendingFeedback(activeFeedback);
    if (feedbackPrediction) feedbackPrediction.textContent = candidateAnswer;
  }
  renderCharacterTiles(candidateAnswer, null);
  renderCandidateChips(activeCandidates, candidateAnswer);
  setStatus("已切換並填入候選答案", `目前答案：${candidateAnswer}`, candidateAnswer);
}

async function loadPendingFeedback() {
  const stored = await chrome.storage.session.get(PENDING_FEEDBACK_KEY);
  const pending = stored[PENDING_FEEDBACK_KEY];
  if (FeedbackHelpers.isPendingFeedback(pending)) return pending;
  if (pending) await chrome.storage.session.remove(PENDING_FEEDBACK_KEY);
  return null;
}

async function savePendingFeedback(pending) {
  await chrome.storage.session.set({ [PENDING_FEEDBACK_KEY]: pending });
}

async function clearPendingFeedback() {
  activeFeedback = null;
  if (feedbackStrip) feedbackStrip.hidden = true;
  setFeedbackDrawerOpen(false);
  if (correctAnswerInput) correctAnswerInput.value = "";
  if (nextButton) nextButton.textContent = NEXT_BUTTON_DEFAULT_TEXT;
  await chrome.storage.session.remove(PENDING_FEEDBACK_KEY);
}

function showPendingFeedback(pending, restoreStatus = true) {
  activeFeedback = pending;
  if (feedbackPrediction) feedbackPrediction.textContent = pending.answer;
  if (feedbackStrip) feedbackStrip.hidden = false;
  const forceOpen = pending.blockedReason === "length_mismatch" || restoreStatus;
  setFeedbackDrawerOpen(forceOpen);
  if (nextButton) {
    nextButton.textContent = pending.blockedReason === "length_mismatch"
      ? "略過並關閉"
      : NEXT_BUTTON_DEFAULT_TEXT;
  }
  if (restoreStatus) {
    renderCharacterTiles(pending.answer, null);
    if (pending.blockedReason === "length_mismatch") {
      const length = pending.lengthMode === "max" ? "最多 " + pending.expectedLength : pending.expectedLength;
      setStatus(
        "答案長度不符，未自動填入",
        `頁面要求 ${length} 字元；請輸入正解保存，或略過這題。`,
        pending.answer,
      );
    } else {
      setStatus(
        "上一題等待確認",
        "若答案有誤，輸入正解保存；若正確，按「下一題」。",
        pending.answer,
      );
    }
  }
}

async function probePythonService() {
  try {
    const response = await fetch(`${OCR_URL}/health`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "OCR 服務無法使用");
    if (!FeedbackHelpers.isSupportedApiVersion(data.version)) {
      throw new Error("請關閉舊的 OCR 視窗，再重新開啟「啟動OCR服務.bat」");
    }
    return { ok: true, solvers: data.solvers || [], error: null };
  } catch (error) {
    return { ok: false, solvers: [], error: error?.message || "未偵測到本機 Python 服務" };
  }
}

async function probeBrowserEngine() {
  if (typeof chrome === "undefined" || typeof chrome.runtime?.sendMessage !== "function") {
    return { ok: false, models: [], error: "目前環境未啟用離線 ONNX" };
  }
  try {
    const res = await chrome.runtime.sendMessage({ type: "OCR_BG_HEALTH" });
    if (res?.ok && res?.ready) {
      return { ok: true, models: res.models || [], backend: res.backend || "wasm", error: null };
    }
    return { ok: false, models: [], error: res?.error || "未找到離線瀏覽器模型" };
  } catch (error) {
    return { ok: false, models: [], error: error?.message || "離線 ONNX 尚未就緒" };
  }
}

async function loadEnginePreference() {
  if (!globalThis.chrome?.storage?.local) return "auto";
  try {
    const stored = await chrome.storage.local.get(ENGINE_PREF_KEY);
    const pref = stored?.[ENGINE_PREF_KEY];
    return ["auto", "browser", "python"].includes(pref) ? pref : "auto";
  } catch {
    return "auto";
  }
}

function applyActiveEngineUi() {
  const ready = (activeEngineMode === "browser" && engineHealth.browser.ok)
    || (activeEngineMode === "python" && engineHealth.python.ok);

  serviceState?.classList?.toggle?.("online", ready);
  if (recognizeButton) recognizeButton.disabled = !ready;

  if (activeEngineMode === "browser" && engineHealth.browser.ok) {
    if (engineLabel) engineLabel.textContent = "離線 ONNX";
    const models = engineHealth.browser.models.join(" / ");
    const switchHint = engineHealth.python.ok ? "（點右上膠囊可切本機 Python）" : "";
    setStatus("離線 ONNX 引擎已就緒", `免開 Python · ${models}${switchHint}`);
    return true;
  }

  if (activeEngineMode === "python" && engineHealth.python.ok) {
    if (engineLabel) engineLabel.textContent = "本機 Python";
    const solvers = engineHealth.python.solvers;
    const switchHint = engineHealth.browser.ok ? "（點右上膠囊可切離線 ONNX）" : "";
    setStatus("OCR 服務已就緒", `${solvers.length} 組模型：${solvers.join(" / ")}${switchHint}`);
    return true;
  }

  if (engineLabel) engineLabel.textContent = "未連線";
  setStatus(
    "OCR 引擎尚未就緒",
    engineHealth.python.error || engineHealth.browser.error || "請啟動本機服務或先執行 prepare_browser_bundle.py",
  );
  return false;
}

async function disposeBrowserEngine() {
  if (typeof chrome === "undefined" || typeof chrome.runtime?.sendMessage !== "function") return;
  try {
    await chrome.runtime.sendMessage({ type: "OCR_BG_DISPOSE" });
  } catch {
    // Ignore errors when offscreen document is already closed.
  }
}

async function checkService() {
  const pref = await loadEnginePreference();
  let browserStatus = { ok: false, models: [], error: null };
  let pythonStatus = { ok: false, solvers: [], error: null };

  if (pref === "python") {
    pythonStatus = await probePythonService();
    if (!pythonStatus.ok) {
      browserStatus = await probeBrowserEngine();
    }
  } else {
    [browserStatus, pythonStatus] = await Promise.all([
      probeBrowserEngine(),
      probePythonService(),
    ]);
  }
  engineHealth = { browser: browserStatus, python: pythonStatus };

  if (pref === "browser" && browserStatus.ok) {
    activeEngineMode = "browser";
  } else if (pref === "python" && pythonStatus.ok) {
    activeEngineMode = "python";
  } else if (browserStatus.ok) {
    activeEngineMode = "browser";
  } else if (pythonStatus.ok) {
    activeEngineMode = "python";
  } else {
    activeEngineMode = pref === "browser" ? "browser" : "python";
  }

  await refreshOfflineExportButton();
  return applyActiveEngineUi();
}

async function toggleEngineMode() {
  const next = activeEngineMode === "browser" ? "python" : "browser";
  if (next === "browser" && !engineHealth.browser.ok) {
    engineHealth.browser = await probeBrowserEngine();
  }
  if (next === "python" && !engineHealth.python.ok) {
    engineHealth.python = await probePythonService();
  }
  if ((next === "browser" && engineHealth.browser.ok) || (next === "python" && engineHealth.python.ok)) {
    activeEngineMode = next;
    if (globalThis.chrome?.storage?.local) {
      await chrome.storage.local.set({ [ENGINE_PREF_KEY]: next }).catch(() => {});
    }
    if (next === "python") {
      await disposeBrowserEngine();
      engineHealth.browser = { ok: false, models: [], error: null };
    }
    applyActiveEngineUi();
  } else {
    const targetName = next === "browser" ? "離線 ONNX" : "本機 Python";
    setStatus(`無法切換至${targetName}`, next === "browser" ? engineHealth.browser.error : engineHealth.python.error);
  }
}

async function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("無法讀取目前分頁截圖"));
    image.src = dataUrl;
  });
}

async function canvasBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("無法建立驗證碼圖片")), "image/png");
  });
}

async function cropCaptcha(dataUrl, detection) {
  const image = await loadImage(dataUrl);
  const scaleX = image.naturalWidth / detection.viewport.width;
  const scaleY = image.naturalHeight / detection.viewport.height;
  const sourceX = Math.max(0, Math.floor(detection.rect.left * scaleX));
  const sourceY = Math.max(0, Math.floor(detection.rect.top * scaleY));
  const sourceWidth = Math.min(
    image.naturalWidth - sourceX,
    Math.ceil((detection.rect.left + detection.rect.width) * scaleX) - sourceX,
  );
  const sourceHeight = Math.min(
    image.naturalHeight - sourceY,
    Math.ceil((detection.rect.top + detection.rect.height) * scaleY) - sourceY,
  );
  if (sourceWidth < 10 || sourceHeight < 10) throw new Error("驗證碼截圖範圍無效");

  const canvas = document.createElement("canvas");
  canvas.width = sourceWidth;
  canvas.height = sourceHeight;
  canvas.getContext("2d", { alpha: false }).drawImage(
    image,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    sourceWidth,
    sourceHeight,
  );
  return canvasBlob(canvas);
}

async function fillAnswer(tabId, frameId, token, answer) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: (targetToken, value) => {
      const selector = `input[data-steven-captcha-target="${CSS.escape(targetToken)}"]`;
      const [input] = globalThis.CaptchaDetect?.queryAllDeep(document, selector) || [];
      if (!input || input.disabled || input.readOnly || input.matches(":disabled")) {
        return { ok: false, error: "驗證碼輸入框已消失或無法編輯" };
      }
      if (input.type === "number" && !/^[0-9]+$/.test(value)) {
        return { ok: false, error: "數字輸入框需要純數字驗證碼" };
      }
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      descriptor.set.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.focus();
      if (input.type !== "number") input.select();
      return { ok: input.value === value, value: input.value };
    },
    args: [token, answer],
  });
  const result = injection?.result;
  if (!result?.ok) throw new Error(result?.error || "網站拒絕填入驗證碼");
}

async function injectFloatingPill(tabId, frameId, payload) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: (pillData) => {
        globalThis.__STEVEN_OCR_PILL_DATA__ = pillData;
      },
      args: [payload],
    });
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      files: ["floating_pill.js"],
    });
  } catch {
    // Floating pill is progressive enhancement; ignore injection restrictions.
  }
}

async function startElementPicker() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("找不到目前分頁");
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        globalThis.__STEVEN_OCR_START_PICKER__ = true;
      },
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["site_profiles.js", "detect_helpers.js", "picker.js"],
    });
    PopupStartup.closeAfterSuccessfulFill(window);
  } catch (error) {
    setStatus("無法啟動手動點選模式", error.message || "此頁面不支援擴充功能注入");
  }
}

async function detectCaptcha(tab) {
  const files = ["site_profiles.js", "detect_helpers.js", "detect.js"];
  let injections;
  try {
    injections = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files });
  } catch {
    injections = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files });
  }
  return PopupStartup.selectFrameDetection(injections);
}

async function captureCaptcha(tab, detection) {
  let rasterizedSvg = false;
  const selected = await CaptchaImage.preferredCaptchaBlob(detection.sourceDataUrl, async () => {
    if (detection.svgMarkup) {
      try {
        const blob = await CaptchaImage.rasterizeSvgCaptcha(detection.svgMarkup, detection.svgSize);
        rasterizedSvg = true;
        return blob;
      } catch {
        // SVG that cannot be rasterized still has the screenshot path.
      }
    }
    if (!detection.rect || !detection.viewport) throw new Error("無法定位此頁框的驗證碼截圖");
    const screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    return cropCaptcha(screenshot, detection);
  });
  if (selected.source !== "original") {
    detection.captchaIdentity = await CaptchaImage.blobIdentity(selected.blob);
  }
  return rasterizedSvg ? { blob: selected.blob, source: "svg" } : selected;
}

async function detectNewCaptcha(pendingFeedback) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return false;
    const detection = await detectCaptcha(tab);
    if (!detection.ok) return false;
    const selectedImage = detection.sourceDataUrl ? null : await captureCaptcha(tab, detection);
    if (!PopupStartup.isNewCaptcha(pendingFeedback, detection)) return false;
    cachedDetection = { tabId: tab.id, detection, selectedImage };
    return true;
  } catch {
    cachedDetection = null;
    return false;
  }
}

async function runOcrInference(captchaBlob, detection) {
  const { expectedLength, lengthMode, charsetHint, caseSensitive } = detection;
  if (activeEngineMode === "browser" && engineHealth.browser.ok) {
    setStatus("離線 ONNX 正在辨識...");
    const imageDataUrl = await blobToDataUrl(captchaBlob);
    const data = await chrome.runtime.sendMessage({
      type: "OCR_BG_RECOGNIZE",
      imageDataUrl,
      expectedLength,
      lengthMode,
      charsetHint,
      caseSensitive,
    });
    if (!data?.ok) throw new Error(data?.error || "離線 ONNX 辨識失敗");
    return data;
  }

  setStatus("正在辨識圖片文字...");
  const recognizeUrl = CaptchaImage.buildRecognizeUrl(OCR_URL, {
    expectedLength, lengthMode, charsetHint, caseSensitive,
  });
  const response = await fetch(recognizeUrl, {
    method: "POST",
    headers: { "Content-Type": "image/png" },
    body: captchaBlob,
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || "OCR 辨識失敗");
  return data;
}

async function recognizeCurrentPage() {
  setBusy(true);
  setStatus("正在尋找目標圖片...");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("找不到目前分頁");
    await refreshSiteProfileBar(tab);

    const cached = cachedDetection?.tabId === tab.id ? cachedDetection : null;
    cachedDetection = null;
    const detection = cached?.detection || await detectCaptcha(tab);
    if (!detection?.ok) throw new Error(detection?.error || "找不到目標圖片與輸入框");

    setStatus(detection.sourceDataUrl ? "正在讀取原圖..." : "正在截取圖片...");
    const selectedImage = cached?.selectedImage || await captureCaptcha(tab, detection);
    const captchaBlob = selectedImage.blob;
    activeCapturedBlob = captchaBlob;
    updateThumbPreview(captchaBlob);

    const data = await runOcrInference(captchaBlob, detection);
    const { expectedLength, lengthMode, caseSensitive } = detection;
    const sourceLabel = selectedImage.source === "screenshot"
      ? "裁圖"
      : selectedImage.source === "svg" ? "SVG" : "原圖";
    const topCandidates = buildTopCandidates(data);
    renderMetrics(data, sourceLabel);
    renderCharacterTiles(data.answer, data.char_confidences);
    renderCandidateChips(topCandidates, data.answer);

    const pendingFeedback = {
      reportId: data.report_id || "0".repeat(32),
      offline: data.engine === "browser_onnx",
      answer: data.answer,
      createdAt: Date.now(),
      captchaIdentity: detection.captchaIdentity || "",
      expectedLength,
      lengthMode,
      caseSensitive,
    };
    const shouldAutoFill = FeedbackHelpers.shouldAutoFill(
      data.answer,
      expectedLength,
      data.length_match,
      lengthMode,
      caseSensitive,
    );
    if (!shouldAutoFill) {
      pendingFeedback.blockedReason = "length_mismatch";
      await savePendingFeedback(pendingFeedback);
      showPendingFeedback(pendingFeedback, false);
      setFeedbackDrawerOpen(true);
      setStatus(
        "答案長度不符，未自動填入",
        `頁面要求 ${lengthMode === "max" ? "最多 " : ""}${expectedLength} 字元，OCR 回傳 ${data.answer.length} 字元；請人工確認後保存錯題。`,
        data.answer,
      );
      correctAnswerInput?.focus?.();
      return;
    }

    await fillAnswer(tab.id, detection.frameId, detection.token, data.answer);
    lastFillContext = { tabId: tab.id, frameId: detection.frameId, token: detection.token };
    await savePendingFeedback(pendingFeedback);

    const imageSource = selectedImage.source === "screenshot" ? "使用畫面裁切" : "使用原始圖片";
    const voteText = data.engine === "browser_onnx"
      ? `${imageSource}；離線 ONNX (${data.model || "wasm"})`
      : `${imageSource}；${data.solver_votes}/${data.solver_count} 組模型一致；共 ${data.total_votes} 票`;
    setStatus("已填入驗證碼", voteText, data.answer);
    showPendingFeedback(pendingFeedback, false);
    setFeedbackDrawerOpen(false);

    if (isShortcutMode()) {
      await injectFloatingPill(tab.id, detection.frameId, {
        answer: data.answer,
        candidates: topCandidates,
        inputSelectorOrToken: detection.token,
        confidence: data.confidence ?? null,
        latencyMs: data.latency_ms ?? null,
        sourceLabel,
      });
      PopupStartup.closeAfterSuccessfulFill(window);
    }
  } catch (error) {
    setStatus("無法完成辨識", error.message || String(error));
  } finally {
    setBusy(false);
  }
}

async function saveOfflineFeedback(correctAnswer) {
  const imageDataUrl = activeCapturedBlob ? await blobToDataUrl(activeCapturedBlob) : "";
  const stored = await chrome.storage.local.get(OFFLINE_FEEDBACK_KEY);
  const queue = Array.isArray(stored?.[OFFLINE_FEEDBACK_KEY]) ? stored[OFFLINE_FEEDBACK_KEY] : [];
  queue.push({
    reported_at: new Date().toISOString(),
    predicted_answer: activeFeedback.answer,
    correct_answer: correctAnswer,
    expected_length: activeFeedback.expectedLength ?? null,
    image_data_url: imageDataUrl,
  });
  const trimmed = queue.slice(-MAX_OFFLINE_FEEDBACK);
  await chrome.storage.local.set({ [OFFLINE_FEEDBACK_KEY]: trimmed });
  await refreshOfflineExportButton();
  return trimmed.length;
}

async function exportOfflineFeedback() {
  if (!globalThis.chrome?.storage?.local) return;
  const stored = await chrome.storage.local.get(OFFLINE_FEEDBACK_KEY);
  const items = Array.isArray(stored?.[OFFLINE_FEEDBACK_KEY]) ? stored[OFFLINE_FEEDBACK_KEY] : [];
  if (!items.length) return;
  const blob = new Blob([JSON.stringify({ schema_version: 1, items }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `steven_ocr_offline_feedback_${Date.now()}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function reportWrongAnswer() {
  if (!activeFeedback) {
    setStatus("沒有可回報的錯題", "請先辨識一題。");
    return;
  }
  setBusy(true);
  try {
    const validatedAnswer = FeedbackHelpers.validateCorrectAnswer(correctAnswerInput.value);
    if (validatedAnswer === activeFeedback.answer) {
      throw new Error("輸入的答案與 OCR 相同；若辨識正確，請按「下一題」。");
    }

    if (activeFeedback.offline || activeEngineMode === "browser") {
      const total = await saveOfflineFeedback(validatedAnswer);
      await clearPendingFeedback();
      setStatus("離線錯題已暫存", `正解 ${validatedAnswer}；已本機累積 ${total} 筆，可隨時匯出 JSON。`);
      return;
    }

    const payload = FeedbackHelpers.buildFeedbackPayload(
      activeFeedback.reportId,
      correctAnswerInput.value,
    );
    const response = await fetch(`${OCR_URL}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "錯題保存失敗");

    await clearPendingFeedback();
    const duplicateText = data.duplicate
      ? `正解 ${payload.correctAnswer}；這張圖已存在，已累計為 ${data.occurrences} 次。`
      : `正解 ${payload.correctAnswer}；${FeedbackHelpers.describeErrorType(data.error_type)}。`;
    setStatus(data.duplicate ? "重複錯題已合併" : "錯題已保存", duplicateText);
  } catch (error) {
    setStatus("無法保存錯題", error.message || String(error), activeFeedback?.answer || "");
  } finally {
    setBusy(false);
  }
}

async function recognizeNextQuestion() {
  const shouldClose = activeFeedback?.blockedReason === "length_mismatch";
  await clearPendingFeedback();
  if (shouldClose) {
    window.close();
    return;
  }
  await recognizeCurrentPage();
}

recognizeButton?.addEventListener("click", recognizeNextQuestion);
pickerButton?.addEventListener("click", startElementPicker);
enginePill?.addEventListener("click", () => {
  toggleEngineMode().catch(() => {});
});
clearSiteRuleButton?.addEventListener("click", async () => {
  if (!activeTabOrigin || !globalThis.SiteProfiles || !globalThis.chrome?.storage?.local) return;
  await SiteProfiles.removeProfile(chrome.storage.local, activeTabOrigin);
  if (siteStatusText) siteStatusText.textContent = "自動偵測";
  if (siteRuleBadge) siteRuleBadge.hidden = true;
  if (clearSiteRuleButton) clearSiteRuleButton.hidden = true;
  setStatus("已清除此網站規則", "下次辨識將恢復自動偵測。");
});
feedbackToggle?.addEventListener("click", () => {
  setFeedbackDrawerOpen(Boolean(feedbackPanel?.hidden));
});
exportOfflineButton?.addEventListener("click", () => {
  exportOfflineFeedback().catch(() => {});
});
reportButton?.addEventListener("click", reportWrongAnswer);
nextButton?.addEventListener("click", recognizeNextQuestion);
correctAnswerInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") reportWrongAnswer();
});
document?.addEventListener?.("keydown", (event) => {
  if (event.target === correctAnswerInput) return;
  const index = Number(event.key) - 1;
  if (index >= 0 && index < activeCandidates.length) {
    applyCandidateChoice(activeCandidates[index].answer).catch(() => {});
  }
});

window?.addEventListener?.("pagehide", () => {
  updateThumbPreview("");
  activeCapturedBlob = null;
});

PopupStartup.startPopup({
  checkService,
  consumeShortcutTrigger: () => isShortcutMode(),
  clearPendingFeedback,
  loadPendingFeedback,
  detectNewCaptcha,
  showPendingFeedback,
  recognizeCurrentPage,
});
