const test = require("node:test");
const assert = require("node:assert/strict");

const { imageIdentity, originalImageDataUrl } = require("../extension/detect_helpers.js");


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
