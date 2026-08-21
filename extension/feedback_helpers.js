(function exposeFeedbackHelpers(root, factory) {
  const api = factory();
  root.FeedbackHelpers = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
}(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const REPORT_ID_PATTERN = /^[0-9a-f]{32}$/;
  const ANSWER_PATTERN = /^[0-9A-Z]{3,6}$/;
  const ERROR_TYPE_LABELS = {
    repeated_character_missing: "重複字元漏字",
    missing_character: "漏字",
    missing_characters: "多字元漏字",
    repeated_character_extra: "重複字元多字",
    extra_character: "多字",
    extra_characters: "多個額外字元",
    substitution: "字元誤判",
    multiple_substitutions: "多字元誤判",
    transposition: "相鄰字元調換",
  };

  function normalizeCorrectAnswer(value) {
    return String(value ?? "").trim().toUpperCase();
  }

  function validateCorrectAnswer(value) {
    const answer = normalizeCorrectAnswer(value);
    if (!ANSWER_PATTERN.test(answer)) {
      throw new Error("正確答案必須是 3 至 6 位英文字母或數字");
    }
    return answer;
  }

  function buildFeedbackPayload(reportId, correctAnswer) {
    if (!REPORT_ID_PATTERN.test(String(reportId ?? ""))) {
      throw new Error("錯題回報代碼無效，請重新辨識");
    }
    return {
      reportId,
      correctAnswer: validateCorrectAnswer(correctAnswer),
    };
  }

  function isPendingFeedback(value) {
    return Boolean(
      value
      && REPORT_ID_PATTERN.test(String(value.reportId ?? ""))
      && ANSWER_PATTERN.test(String(value.answer ?? "")),
    );
  }

  function isSupportedApiVersion(value) {
    return Number.isInteger(value) && value >= 4;
  }

  function shouldAutoFill(answerValue, expectedLength, lengthMatch) {
    const answer = normalizeCorrectAnswer(answerValue);
    if (!ANSWER_PATTERN.test(answer)) return false;
    if (lengthMatch === false) return false;
    if (Number.isInteger(expectedLength) && expectedLength >= 3 && expectedLength <= 6) {
      return answer.length === expectedLength;
    }
    return true;
  }

  function describeErrorType(value) {
    return ERROR_TYPE_LABELS[String(value ?? "")] || "未分類錯誤";
  }

  return {
    buildFeedbackPayload,
    describeErrorType,
    isPendingFeedback,
    isSupportedApiVersion,
    normalizeCorrectAnswer,
    shouldAutoFill,
    validateCorrectAnswer,
  };
}));
