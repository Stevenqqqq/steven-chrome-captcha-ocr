const test = require("node:test");
const assert = require("node:assert/strict");

const FeedbackHelpers = require("../extension/feedback_helpers.js");


test("normalizes a correct answer to uppercase ASCII letters and digits", () => {
  assert.equal(FeedbackHelpers.normalizeCorrectAnswer(" a7k2 "), "A7K2");
});


test("rejects malformed labels before sending feedback", () => {
  for (const value of ["", "AB", "A/B2", "ABCDEFG"]) {
    assert.throws(() => FeedbackHelpers.validateCorrectAnswer(value), /3 至 6/);
  }
});


test("builds a bounded JSON feedback request", () => {
  assert.deepEqual(
    FeedbackHelpers.buildFeedbackPayload("f".repeat(32), " b8m3 "),
    { reportId: "f".repeat(32), correctAnswer: "B8M3" },
  );
  assert.throws(
    () => FeedbackHelpers.buildFeedbackPayload("../ticket", "B8M3"),
    /回報代碼/,
  );
});


test("requires the feedback-capable OCR API version", () => {
  assert.equal(FeedbackHelpers.isSupportedApiVersion(4), true);
  assert.equal(FeedbackHelpers.isSupportedApiVersion(3), false);
  assert.equal(FeedbackHelpers.isSupportedApiVersion("4"), false);
});


test("blocks answers that do not match the detected captcha length", () => {
  assert.equal(FeedbackHelpers.shouldAutoFill("WNE", 4, false), false);
  assert.equal(FeedbackHelpers.shouldAutoFill("WNE", 4, undefined), false);
  assert.equal(FeedbackHelpers.shouldAutoFill("WUTA", 4, true), true);
  assert.equal(FeedbackHelpers.shouldAutoFill("WUTA", null, null), true);
});


test("describes stored error types in Traditional Chinese", () => {
  assert.equal(FeedbackHelpers.describeErrorType("missing_character"), "漏字");
  assert.equal(FeedbackHelpers.describeErrorType("substitution"), "字元誤判");
  assert.equal(FeedbackHelpers.describeErrorType("unknown"), "未分類錯誤");
});
