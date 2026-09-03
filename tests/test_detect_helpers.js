const test = require("node:test");
const assert = require("node:assert/strict");

const {
  compareCandidates,
  imageIdentity,
  originalImageDataUrl,
  rankCandidates,
  scoreInputAssociation,
} = require("../extension/detect_helpers.js");


test("uses input association to break equal image-score ties", () => {
  const logo = { id: "logo", score: 87, inputScore: 79.06, inputDistance: 90 };
  const captcha = { id: "captcha", score: 87, inputScore: 106.9, inputDistance: 30 };

  const candidates = [logo, captcha];
  const ranked = rankCandidates(candidates);

  assert.deepEqual(ranked.map((candidate) => candidate.id), ["captcha", "logo"]);
  assert.deepEqual(candidates.map((candidate) => candidate.id), ["logo", "captcha"]);
});


test("keeps the higher total score ahead of input tie-breakers", () => {
  const ranked = rankCandidates([
    { id: "strong-input", score: 86, inputScore: 130 },
    { id: "strong-image", score: 87, inputScore: 8 },
  ]);

  assert.deepEqual(ranked.map((candidate) => candidate.id), ["strong-image", "strong-input"]);
});


test("uses proximity only when image and input scores are equal", () => {
  const farther = { id: "farther", score: 87, inputScore: 100, inputDistance: 60 };
  const nearer = { id: "nearer", score: 87, inputScore: 100, inputDistance: 20 };

  assert.equal(compareCandidates(nearer, farther), -1);
  assert.deepEqual(rankCandidates([farther, nearer]).map((candidate) => candidate.id), ["nearer", "farther"]);
});


test("selects the same-row CAPTCHA field instead of the populated account field", () => {
  const imageRect = { left: 260, top: 205, width: 90, height: 40 };
  const accountScore = scoreInputAssociation({
    metadata: "userid account student number",
    labelText: "帳號 Employee number or Student number",
    localContext: "",
    maxLength: 0,
    hasValue: true,
    imageRect,
    inputRect: { left: 22, top: 42, width: 513, height: 37 },
  });
  const captchaScore = scoreInputAssociation({
    metadata: "4碼英數字",
    labelText: "驗證碼 Captcha",
    localContext: "驗證碼 Captcha 4碼英數字",
    maxLength: 4,
    hasValue: false,
    imageRect,
    inputRect: { left: 25, top: 205, width: 235, height: 40 },
  });

  assert.ok(captchaScore > accountScore + 150);
});


test("same-row empty field wins even when the CAPTCHA label is not associated", () => {
  const imageRect = { left: 260, top: 205, width: 90, height: 40 };
  const accountScore = scoreInputAssociation({
    metadata: "login username",
    hasValue: true,
    imageRect,
    inputRect: { left: 22, top: 42, width: 513, height: 37 },
  });
  const genericSameRowScore = scoreInputAssociation({
    metadata: "4碼英數字",
    maxLength: 4,
    hasValue: false,
    imageRect,
    inputRect: { left: 25, top: 205, width: 235, height: 40 },
  });

  assert.ok(genericSameRowScore > accountScore);
});


test("image identity changes when the CAPTCHA image URL changes", () => {
  const first = imageIdentity({
    tagName: "IMG",
    currentSrc: "https://example.com/captcha_1.png",
    naturalWidth: 160,
    naturalHeight: 60,
  });
  const repeated = imageIdentity({
    tagName: "IMG",
    currentSrc: "https://example.com/captcha_1.png",
    naturalWidth: 160,
    naturalHeight: 60,
  });
  const second = imageIdentity({
    tagName: "IMG",
    currentSrc: "https://example.com/captcha_2.png",
    naturalWidth: 160,
    naturalHeight: 60,
  });

  assert.equal(first, repeated);
  assert.notEqual(first, second);
});


test("keeps an already safe Base64 image without redrawing it", () => {
  const source = "data:image/png;base64,iVBORw0KGgo=";
  const image = { tagName: "IMG", currentSrc: source };

  const result = originalImageDataUrl(image, {
    createElement() {
      throw new Error("canvas should not be created");
    },
  });

  assert.equal(result, source);
});


test("serializes a loaded page image to exact PNG pixels", () => {
  const serialized = "data:image/png;base64,aW1hZ2UtcGl4ZWxz";
  let drawnImage = null;
  const canvas = {
    getContext: () => ({
      drawImage(image) {
        drawnImage = image;
      },
    }),
    toDataURL: () => serialized,
  };
  const image = {
    tagName: "IMG",
    currentSrc: "https://example.com/captcha.png",
    naturalWidth: 260,
    naturalHeight: 80,
  };

  const result = originalImageDataUrl(image, {
    createElement: () => canvas,
  });

  assert.equal(result, serialized);
  assert.equal(canvas.width, 260);
  assert.equal(canvas.height, 80);
  assert.equal(drawnImage, image);
});


test("falls back safely when browser canvas security blocks pixel access", () => {
  const image = {
    tagName: "IMG",
    currentSrc: "https://cross-origin.example/captcha.png",
    naturalWidth: 260,
    naturalHeight: 80,
  };

  const result = originalImageDataUrl(image, {
    createElement: () => ({
      getContext: () => ({ drawImage() {} }),
      toDataURL() {
        throw new DOMException("Tainted canvas", "SecurityError");
      },
    }),
  });

  assert.equal(result, "");
});


test("does not allocate a canvas for oversized page images", () => {
  const image = {
    tagName: "IMG",
    currentSrc: "https://example.com/huge.png",
    naturalWidth: 2001,
    naturalHeight: 1000,
  };

  const result = originalImageDataUrl(image, {
    createElement() {
      throw new Error("oversized images must be rejected first");
    },
  });

  assert.equal(result, "");
});
