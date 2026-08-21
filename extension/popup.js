const OCR_URL = "http://127.0.0.1:8765";

const recognizeButton = document.querySelector("#recognizeButton");
const serviceState = document.querySelector("#serviceState");
const statusText = document.querySelector("#statusText");
const answerText = document.querySelector("#answerText");
const detailText = document.querySelector("#detailText");
const feedbackPanel = document.querySelector("#feedbackPanel");
const feedbackPrediction = document.querySelector("#feedbackPrediction");
const correctAnswerInput = document.querySelector("#correctAnswerInput");
const reportButton = document.querySelector("#reportButton");
const nextButton = document.querySelector("#nextButton");

const PENDING_FEEDBACK_KEY = "pendingFeedback";
const NEXT_BUTTON_DEFAULT_TEXT = nextButton.textContent;
let activeFeedback = null;
let cachedDetection = null;

function setStatus(message, detail = "", answer = "") {
  statusText.textContent = message;
  detailText.textContent = detail;
  answerText.textContent = answer;
  answerText.hidden = !answer;
}

function setBusy(busy) {
  recognizeButton.disabled = busy;
  reportButton.disabled = busy;
  nextButton.disabled = busy;
  recognizeButton.classList.toggle("busy", busy);
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
  feedbackPanel.hidden = true;
  correctAnswerInput.value = "";
  nextButton.textContent = NEXT_BUTTON_DEFAULT_TEXT;
  await chrome.storage.session.remove(PENDING_FEEDBACK_KEY);
}

function showPendingFeedback(pending, restoreStatus = true) {
  activeFeedback = pending;
  feedbackPrediction.textContent = pending.answer;
  feedbackPanel.hidden = false;
  nextButton.textContent = pending.blockedReason === "length_mismatch"
    ? "略過並關閉"
    : NEXT_BUTTON_DEFAULT_TEXT;
  if (restoreStatus) {
    if (pending.blockedReason === "length_mismatch") {
      setStatus(
        "答案長度不符，未自動填入",
        `頁面要求 ${pending.expectedLength} 字元；請輸入正解保存，或略過這題。`,
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

async function checkService() {
  try {
    const response = await fetch(`${OCR_URL}/health`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "OCR 服務無法使用");
    if (!FeedbackHelpers.isSupportedApiVersion(data.version)) {
      throw new Error("請關閉舊的 OCR 視窗，再重新開啟「啟動OCR服務.bat」");
    }
    serviceState.classList.add("online");
    recognizeButton.disabled = false;
    setStatus("OCR 服務已就緒", `${data.solvers.length} 組模型：${data.solvers.join(" / ")}`);
    return true;
  } catch (error) {
    serviceState.classList.remove("online");
    recognizeButton.disabled = true;
    setStatus("OCR 服務尚未就緒", error.message || "請先開啟專案內的「啟動OCR服務.bat」");
    return false;
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
  const padding = 2;
  const sourceX = Math.max(0, Math.floor((detection.rect.left - padding) * scaleX));
  const sourceY = Math.max(0, Math.floor((detection.rect.top - padding) * scaleY));
  const sourceWidth = Math.min(
    image.naturalWidth - sourceX,
    Math.ceil((detection.rect.width + padding * 2) * scaleX),
  );
  const sourceHeight = Math.min(
    image.naturalHeight - sourceY,
    Math.ceil((detection.rect.height + padding * 2) * scaleY),
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

async function fillAnswer(tabId, token, answer) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (targetToken, value) => {
      const input = document.querySelector(`[data-steven-captcha-target="${CSS.escape(targetToken)}"]`);
      if (!input) return { ok: false, error: "驗證碼輸入框已消失" };
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      descriptor.set.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.focus();
      input.select();
      input.removeAttribute("data-steven-captcha-target");
      return { ok: input.value === value, value: input.value };
    },
    args: [token, answer],
  });
  if (!result?.ok) throw new Error(result?.error || "網站拒絕填入驗證碼");
}

async function detectCaptcha(tab) {
  const injection = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["detect_helpers.js", "detect.js"],
  });
  return injection[0]?.result;
}

async function detectNewCaptcha(pendingFeedback) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return false;
    const detection = await detectCaptcha(tab);
    if (!PopupStartup.isNewCaptcha(pendingFeedback, detection)) return false;
    cachedDetection = { tabId: tab.id, detection };
    return true;
  } catch {
    cachedDetection = null;
    return false;
  }
}

async function recognizeCurrentPage() {
  setBusy(true);
  setStatus("正在尋找驗證碼...");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("找不到目前分頁");

    const detection = cachedDetection?.tabId === tab.id
      ? cachedDetection.detection
      : await detectCaptcha(tab);
    cachedDetection = null;
    if (!detection?.ok) throw new Error(detection?.error || "找不到驗證碼");

    setStatus(detection.sourceDataUrl ? "正在讀取驗證碼原圖..." : "正在截取驗證碼...");
    const selectedImage = await CaptchaImage.preferredCaptchaBlob(
      detection.sourceDataUrl,
      async () => {
        const screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
        return cropCaptcha(screenshot, detection);
      },
    );
    const captchaBlob = selectedImage.blob;

    setStatus("三組 OCR 正在辨識...");
    const recognizeUrl = CaptchaImage.buildRecognizeUrl(OCR_URL, detection.expectedLength);
    const response = await fetch(recognizeUrl, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: captchaBlob,
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "OCR 辨識失敗");

    const pendingFeedback = {
      reportId: data.report_id,
      answer: data.answer,
      createdAt: Date.now(),
      captchaIdentity: detection.captchaIdentity || "",
      expectedLength: detection.expectedLength || null,
    };
    const shouldAutoFill = FeedbackHelpers.shouldAutoFill(
      data.answer,
      detection.expectedLength,
      data.length_match,
    );
    if (!shouldAutoFill) {
      pendingFeedback.blockedReason = "length_mismatch";
      await savePendingFeedback(pendingFeedback);
      showPendingFeedback(pendingFeedback, false);
      setStatus(
        "答案長度不符，未自動填入",
        `頁面要求 ${detection.expectedLength} 字元，OCR 回傳 ${data.answer.length} 字元；請人工確認後保存錯題。`,
        data.answer,
      );
      correctAnswerInput.focus();
      return;
    }

    await fillAnswer(tab.id, detection.token, data.answer);
    await savePendingFeedback(pendingFeedback);
    const imageSource = selectedImage.source === "original" ? "使用原始圖片" : "使用畫面裁切";
    const voteText = `${imageSource}；${data.solver_votes}/${data.solver_count} 組模型一致；共 ${data.total_votes} 票`;
    setStatus("已填入驗證碼", voteText, data.answer);
    showPendingFeedback(pendingFeedback, false);
    PopupStartup.closeAfterSuccessfulFill(window);
  } catch (error) {
    setStatus("無法完成辨識", error.message || String(error));
  } finally {
    setBusy(false);
  }
}

async function reportWrongAnswer() {
  if (!activeFeedback) {
    setStatus("沒有可回報的錯題", "請先辨識一題驗證碼。");
    return;
  }
  setBusy(true);
  try {
    const payload = FeedbackHelpers.buildFeedbackPayload(
      activeFeedback.reportId,
      correctAnswerInput.value,
    );
    if (payload.correctAnswer === activeFeedback.answer) {
      throw new Error("輸入的答案與 OCR 相同；若辨識正確，請按「下一題」。");
    }
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

recognizeButton.addEventListener("click", recognizeNextQuestion);
reportButton.addEventListener("click", reportWrongAnswer);
nextButton.addEventListener("click", recognizeNextQuestion);
correctAnswerInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") reportWrongAnswer();
});
PopupStartup.startPopup({
  checkService,
  consumeShortcutTrigger: () => PopupStartup.isShortcutInvocation(document.body.dataset.invocation),
  clearPendingFeedback,
  loadPendingFeedback,
  detectNewCaptcha,
  showPendingFeedback,
  recognizeCurrentPage,
});
