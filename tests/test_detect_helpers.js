const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { runInNewContext } = require("node:vm");

const {
  compareCandidates,
  imageIdentity,
  inferInputHints,
  originalImageDataUrl,
  queryAllDeep,
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

test("queries nested open shadow roots without duplicating light DOM matches", () => {
  const match = { tagName: "INPUT" };
  const inner = { querySelectorAll: (selector) => selector === "*" || selector === "input" ? [match] : [] };
  const nestedHost = { shadowRoot: inner };
  const outer = { querySelectorAll: (selector) => selector === "*" ? [nestedHost] : [] };
  const root = { querySelectorAll: (selector) => selector === "*" ? [{ shadowRoot: outer }, {}] : [] };
  assert.deepEqual(queryAllDeep(root, "input"), [match]);
});

test("excludes disabled and read-only candidates from input ranking", () => {
  assert.equal(scoreInputAssociation({ metadata: "captcha", disabled: true }), -Infinity);
  assert.equal(scoreInputAssociation({ metadata: "captcha", readOnly: true }), -Infinity);
});

test("infers exact length from equal field limits, fixed patterns, and explicit text", () => {
  assert.deepEqual(inferInputHints({ minLength: 5, maxLength: 5 }), {
    expectedLength: 5, lengthMode: "exact", charsetHint: "alphanumeric", caseSensitive: false,
  });
  assert.deepEqual(inferInputHints({ pattern: "^[0-9]{4}$", maxLength: 6 }), {
    expectedLength: 4, lengthMode: "exact", charsetHint: "digits", caseSensitive: false,
  });
  for (const labelText of ["4碼", "4位", "4 digits", "4 characters"]) {
    assert.equal(inferInputHints({ labelText }).expectedLength, 4);
    assert.equal(inferInputHints({ labelText }).lengthMode, "exact");
  }
});

test("distinguishes max length, numeric fields, letters, mixed hints and case", () => {
  assert.deepEqual(inferInputHints({ maxLength: 6, metadata: "最多 6 碼，純英文，區分大小寫" }), {
    expectedLength: 6, lengthMode: "max", charsetHint: "letters", caseSensitive: true,
  });
  for (const hints of [{ type: "number" }, { inputMode: "numeric" }, { pattern: "\\d{4}" }, { labelText: "純數字" }]) {
    assert.equal(inferInputHints(hints).charsetHint, "digits");
  }
  assert.equal(inferInputHints({ pattern: "[A-Za-z]" }).charsetHint, "letters");
  assert.equal(inferInputHints({ localContext: "※驗證碼請輸入英文 ※輸入完畢請按Enter下一題" }).charsetHint, "letters");
  assert.equal(inferInputHints({ localContext: "請勿輸入英文" }).charsetHint, "alphanumeric");
  assert.equal(inferInputHints({ pattern: "[A-Za-z0-9]{4}", labelText: "Enter letters as shown" }).charsetHint, "alphanumeric");
  assert.equal(inferInputHints({ localContext: "數字驗證碼 or letters" }).charsetHint, "alphanumeric");
  assert.equal(inferInputHints({ labelText: "not case sensitive" }).caseSensitive, false);
  assert.deepEqual(inferInputHints({ pattern: "[A-Za-z0-9]{3,6}", maxLength: 99 }), {
    expectedLength: null, lengthMode: "unknown", charsetHint: "alphanumeric", caseSensitive: false,
  });
});

test("identifies changed pixels at the same URL and ignores URL changes for identical pixels", () => {
  const image = { tagName: "IMG", currentSrc: "https://example.com/captcha.png", naturalWidth: 80, naturalHeight: 30 };
  const first = imageIdentity(image, "data:image/png;base64,YQ==");
  assert.notEqual(first, imageIdentity(image, "data:image/png;base64,Yg=="));
  assert.equal(first, imageIdentity({ ...image, currentSrc: "https://example.com/new.png" }, "data:image/png;base64,YQ=="));
});

test("captures valid canvas data and identifies changes after a redraw", () => {
  let data = "data:image/png;base64,YQ==";
  const canvas = {
    tagName: "CANVAS", width: 80, height: 30,
    toDataURL(type) {
      assert.equal(type, "image/png");
      return data;
    },
  };
  assert.equal(originalImageDataUrl(canvas), data);
  const first = imageIdentity(canvas, originalImageDataUrl(canvas));
  data = "data:image/png;base64,Yg==";
  assert.notEqual(first, imageIdentity(canvas, originalImageDataUrl(canvas)));
  assert.equal(originalImageDataUrl({ ...canvas, width: 9 }), "");
  assert.equal(originalImageDataUrl({ ...canvas, height: 100_000 }), "");
  data = "data:,";
  assert.equal(originalImageDataUrl(canvas), "");
  assert.equal(originalImageDataUrl({ tagName: "svg" }), "");
});

const detector = readFileSync(resolve(__dirname, "../extension/detect.js"), "utf8");

function detectionFixture() {
  const inputSelector = "input:not([type]), input[type='text'], input[type='tel'], input[type='search'], input[type='number']";
  const rect = (left, top, width, height) => ({
    left, top, width, height, right: left + width, bottom: top + height,
  });
  const group = {};
  const element = (tagName, attrs, bounds, details = {}) => ({
    id: attrs.id,
    tagName,
    parentNode: group,
    getAttribute: (name) => attrs[name] ?? null,
    setAttribute: (name, value) => { attrs[name] = value; },
    removeAttribute: (name) => { delete attrs[name]; },
    closest: () => null,
    getBoundingClientRect: () => bounds,
    matches: (selector) => selector === inputSelector && tagName === "INPUT",
    ...details,
  });
  const input = element("INPUT", { id: "captcha", placeholder: "4位數字驗證碼" }, rect(10, 20, 80, 25), {
    type: "number", value: "", getRootNode: () => shadow,
  });
  const disabled = { ...input, disabled: true, setAttribute: () => assert.fail("disabled input tagged") };
  const readonly = { ...input, readOnly: true, setAttribute: () => assert.fail("read-only input tagged") };
  const svg = element("svg", { id: "challenge" }, rect(100, 20, 80, 30));
  const icon = element("svg", { id: "captcha-icon" }, rect(100, 20, 20, 20));
  const shadow = {
    querySelectorAll(selector) {
      if (selector === "*") return [input, disabled, readonly, svg, icon];
      if (selector === inputSelector) return [disabled, readonly, input];
      if (selector === "img, canvas, svg") return [icon, svg];
      if (selector === "#challenge") return [svg];
      if (selector === "#captcha") return [input];
      return [];
    },
  };
  const viewport = { innerWidth: 800, innerHeight: 600 };
  const getComputedStyle = () => ({ opacity: "1", visibility: "visible", backgroundImage: "none" });
  const parent = { ...viewport, getComputedStyle };
  parent.top = parent;
  const window = {
    innerWidth: 240, innerHeight: 180, top: parent, parent,
    frameElement: { getBoundingClientRect: () => rect(30, 40, 244, 184), clientLeft: 2, clientTop: 2, offsetWidth: 244, offsetHeight: 184 },
  };
  const document = { querySelectorAll: (selector) => selector === "*" ? [{ shadowRoot: shadow }] : [] };
  return {
    input,
    context: {
      document, window, innerWidth: window.innerWidth, innerHeight: window.innerHeight, getComputedStyle,
      CaptchaDetect: require("../extension/detect_helpers.js"),
      XMLSerializer: class {
        serializeToString(node) {
          assert.equal(node, svg);
          return '<svg xmlns="http://www.w3.org/2000/svg"><text>1234</text></svg>';
        }
      },
    },
  };
}

test("detects an adjacent SVG and editable number input in a shadow root inside an iframe", async () => {
  const { input, context } = detectionFixture();
  const result = await runInNewContext(detector, context);
  assert.equal(result.ok, true);
  assert.equal(result.matchedByProfile, false);
  assert.equal(result.expectedLength, 4);
  assert.equal(result.lengthMode, "exact");
  assert.equal(result.charsetHint, "digits");
  assert.match(result.svgMarkup, /1234/);
  assert.equal(result.sourceDataUrl, "");
  assert.equal(result.rect.left, 132);
  assert.equal(result.rect.top, 62);
  assert.equal(result.viewport.width, 800);
  assert.equal(input.getAttribute("data-steven-captcha-target"), result.token);
});

test("uses and clears the supplied profile and falls back when its selectors are stale", async () => {
  const { context } = detectionFixture();
  context.__STEVEN_OCR_SITE_PROFILE__ = {
    imageSelector: "#challenge", inputSelector: "#captcha",
    expectedLength: 5, lengthMode: "max", charsetHint: "digits", caseSensitive: true,
  };
  const result = await runInNewContext(detector, context);
  assert.equal(result.matchedByProfile, true);
  assert.equal(result.expectedLength, 5);
  assert.equal(result.lengthMode, "max");
  assert.equal(result.caseSensitive, true);
  assert.equal(Object.hasOwn(context, "__STEVEN_OCR_SITE_PROFILE__"), false);
  context.__STEVEN_OCR_SITE_PROFILE__ = { imageSelector: "#missing", inputSelector: "#captcha" };
  assert.equal((await runInNewContext(detector, context)).matchedByProfile, false);
});

test("reads a profile for the current frame origin from extension local storage", async () => {
  const { context } = detectionFixture();
  const profile = {
    origin: "https://example.com", imageSelector: "#challenge", inputSelector: "#captcha",
    expectedLength: 6, lengthMode: "max", charsetHint: "digits", caseSensitive: false,
  };
  context.SiteProfiles = require("../extension/site_profiles.js");
  context.location = { href: "https://example.com/frame" };
  context.chrome = { storage: { local: {
    get: async (key) => ({ [key]: { [profile.origin]: profile } }),
  } } };
  const result = await runInNewContext(detector, context);
  assert.equal(result.matchedByProfile, true);
  assert.equal(result.expectedLength, 6);
});
