const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_CHARSET,
  resizeRgbBilinear,
  rgbToChwFloat32,
  rgbToGrayscaleBytes,
  computeMedianLuminance,
  isBlueBackground,
  alignedCharMatches,
  enhanceDarkPrimaryRgb,
  resizeGrayscaleUnit01,
  cropHorizontalSegment,
  softmaxRows,
  ctcPrefixBeamAscii,
  fuseFixed4Probabilities,
  fuseOfficialAndFixed4,
  ctcGreedyDecode,
  createBrowserOcrRuntime,
} = require("../extension/browser_ocr.js");

test("pixel centers interpolate RGB and disregard alpha", () => {
  const pixels = Uint8Array.of(0, 10, 20, 255, 100, 110, 120, 0);
  assert.deepEqual(
    [...resizeRgbBilinear(pixels, 2, 1, 3, 1)],
    [0, 10, 20, 50, 60, 70, 100, 110, 120],
  );
});

test("RGB bytes map to normalized float32 planes", () => {
  const pixels = Uint8Array.of(255, 0, 0, 0, 0, 255);
  assert.deepEqual([...rgbToChwFloat32(pixels, 2, 1)], [1, 0, 0, 0, 0, 1]);
  const normalized = rgbToChwFloat32(pixels, 2, 1, true);
  assert.ok(Math.abs(normalized[0] - (1 - 0.485) / 0.229) < 1e-6);
  assert.ok(Math.abs(normalized[5] - (1 - 0.406) / 0.225) < 1e-6);
});

test("malformed dimensions and incomplete buffers are rejected", () => {
  assert.throws(() => resizeRgbBilinear(new Uint8Array(4), 1, 1, 0, 1), RangeError);
  assert.throws(() => rgbToChwFloat32(new Uint8Array(2), 1, 1), RangeError);
});

test("horizontal crop matches Fixed4FusionOcr margin bounds", () => {
  const width = 100;
  const height = 10;
  const rgb = new Uint8Array(width * height * 3);
  const seg0 = cropHorizontalSegment(rgb, width, height, 0, 4, 0.32);
  const seg1 = cropHorizontalSegment(rgb, width, height, 1, 4, 0.32);
  assert.equal(seg0.left, 0);
  assert.equal(seg0.right, 33);
  assert.equal(seg1.left, 17);
  assert.equal(seg1.right, 58);
});

test("fuses fixed4 probabilities, respects charsetHint, and emits top-3 candidates", () => {
  const cols = DEFAULT_CHARSET.length;
  const direct = new Float32Array(4 * cols).fill(1e-4);
  const crop = new Float32Array(4 * cols).fill(1e-4);
  const setPos = (pos, ch, p) => {
    const idx = DEFAULT_CHARSET.indexOf(ch);
    direct[pos * cols + idx] = p;
    crop[pos * cols + idx] = p;
  };
  setPos(0, "A", 0.92);
  setPos(1, "7", 0.91);
  setPos(2, "O", 0.52);
  setPos(2, "0", 0.44);
  setPos(3, "K", 0.95);

  const alnum = fuseFixed4Probabilities(direct, crop, DEFAULT_CHARSET, 6, 6);
  assert.equal(alnum.answer, "A7OK");
  assert.equal(alnum.top_candidates.length, 3);
  assert.equal(alnum.top_candidates[1].answer, "A70K");
  assert.equal(alnum.char_confidences[2].alternatives[0], "0");

  const digitsOnly = fuseFixed4Probabilities(direct, crop, DEFAULT_CHARSET, 6, 6, { charsetHint: "digits" });
  assert.match(digitsOnly.answer, /^[0-9]{4}$/);
  assert.equal(digitsOnly.answer[1], "7");
  assert.equal(digitsOnly.answer[2], "0");
});

test("CTC greedy decode collapses repeats and blanks and respects hints", () => {
  const charset = ["", "0", "1", "a", "B"];
  const decoded = ctcGreedyDecode([0, 3, 3, 0, 1, 4, 4], [1, 7], charset);
  assert.equal(decoded, "A0B");
  const sensitive = ctcGreedyDecode([0, 3, 0, 4], [1, 4], charset, { caseSensitive: true });
  assert.equal(sensitive, "aB");
  const digits = ctcGreedyDecode([0, 3, 1, 2, 4], [1, 5], charset, { charsetHint: "digits" });
  assert.equal(digits, "01");
});

test("runtime deduplicates warmup and runs mock fixed4 ONNX sessions offline without overlapping WASM calls", async () => {
  let createCalls = 0;
  let activeOrtCalls = 0;
  const cols = DEFAULT_CHARSET.length;
  const target = "A70K";
  const makeLogits = () => {
    const arr = new Float32Array(4 * cols).fill(-4);
    target.split("").forEach((ch, pos) => {
      arr[pos * cols + DEFAULT_CHARSET.indexOf(ch)] = 6;
    });
    return arr;
  };
  const fakeOrt = {
    Tensor: class Tensor {
      constructor(type, data, dims) {
        this.type = type;
        this.data = data;
        this.dims = dims;
      }
    },
    InferenceSession: {
      async create() {
        if (activeOrtCalls > 0) throw new Error("Session already started");
        activeOrtCalls += 1;
        await new Promise((r) => setTimeout(r, 2));
        activeOrtCalls -= 1;
        createCalls += 1;
        return {
          inputNames: ["image"],
          outputNames: ["logits"],
          async run() {
            if (activeOrtCalls > 0) throw new Error("Session already started");
            activeOrtCalls += 1;
            await new Promise((r) => setTimeout(r, 2));
            activeOrtCalls -= 1;
            return { logits: { data: makeLogits(), dims: [1, 4, cols] } };
          },
        };
      },
    },
  };
  const fakeFetch = async (url) => {
    if (url.endsWith("bundle_manifest.json")) {
      return { ok: true, json: async () => ({ bundles: { fusion_v7: { kind: "fixed4_dual_cnn" } } }) };
    }
    if (url.endsWith("config.json")) {
      return {
        ok: true,
        json: async () => ({
          charset: DEFAULT_CHARSET,
          alpha: 6,
          beta: 6,
          direct_image_size: [12, 20],
          crop_image_size: [12, 8],
          crop_margin: 0.32,
        }),
      };
    }
    return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  };

  const runtime = createBrowserOcrRuntime({ ort: fakeOrt, modelBaseUrl: "mem://models", fetchImpl: fakeFetch });
  const [s1, s2] = await Promise.all([runtime.warmUp(), runtime.warmUp()]);
  assert.equal(createCalls, 2);
  assert.equal(s1.ready, true);
  assert.deepEqual(s2.models, ["fusion_v7"]);

  const rgba = new Uint8Array(40 * 16 * 4).fill(240);
  const [res1, res2] = await Promise.all([
    runtime.recognizeRgba({ rgba, width: 40, height: 16, expectedLength: 4 }),
    runtime.recognizeRgba({ rgba, width: 40, height: 16, expectedLength: 4 }),
  ]);
  assert.equal(res1.ok, true);
  assert.equal(res1.answer, "A70K");
  assert.equal(res2.ok, true);
  assert.equal(res2.answer, "A70K");
  assert.equal(res1.engine, "browser_onnx");
  assert.equal(res1.top_candidates[0].answer, "A70K");
  assert.ok(res1.confidence > 0.99);
});

test("softmaxRows produces valid probability rows", () => {
  const probs = softmaxRows(Float32Array.of(1, 2, 3, 0, 0, 0), 2, 3);
  assert.ok(Math.abs(probs[0] + probs[1] + probs[2] - 1) < 1e-6);
  assert.ok(Math.abs(probs[3] - 1 / 3) < 1e-6);
});

test("ctcPrefixBeamAscii decodes ASCII-only classes, folds case, and extracts top-3 & char confidences", () => {
  const asciiEntries = [
    { index: 1, char: "A" },
    { index: 2, char: "a" },
    { index: 3, char: "7" },
    { index: 4, char: "0" },
    { index: 5, char: "O" },
    { index: 6, char: "K" },
  ];
  // 8 timesteps x 10 classes (index 0 = blank, index 9 = irrelevant non-ASCII class with huge logit)
  const T = 8;
  const C = 10;
  const logits = new Float32Array(T * C).fill(-8);
  const put = (t, idx, val) => { logits[t * C + idx] = val; };
  // Emit a, blank, 7, blank, 0 (close to O), blank, K, blank; also put noise in non-ASCII index 9
  put(0, 2, 6); put(0, 9, 20);
  put(1, 0, 6);
  put(2, 3, 6);
  put(3, 0, 6);
  put(4, 4, 5.2); put(4, 5, 4.7);
  put(5, 0, 6);
  put(6, 6, 6);
  put(7, 0, 6);

  const res = ctcPrefixBeamAscii(logits, [T, 1, C], asciiEntries, { expectedLength: 4, lengthMode: "exact" });
  assert.equal(res.answer, "A70K");
  assert.equal(res.top_candidates[0].answer, "A70K");
  assert.equal(res.top_candidates[1].answer, "A7OK");
  assert.equal(res.char_confidences[2].alternatives[0], "O");

  const digits = ctcPrefixBeamAscii(logits, [T, 1, C], asciiEntries, { charsetHint: "digits", expectedLength: null });
  assert.match(digits.answer, /^[0-9]{3,6}$/);
  assert.ok(digits.answer.includes("70"));
});

test("median luminance and dark_primary enhancement classify dark vs light correctly", () => {
  const darkRgb = new Uint8Array(4 * 4 * 3).fill(40);
  const lightRgb = new Uint8Array(4 * 4 * 3).fill(230);
  assert.ok(computeMedianLuminance(rgbToGrayscaleBytes(darkRgb, 4, 4)) < 170);
  assert.ok(computeMedianLuminance(rgbToGrayscaleBytes(lightRgb, 4, 4)) >= 170);
  const enhanced = enhanceDarkPrimaryRgb(rgbToGrayscaleBytes(darkRgb, 4, 4), 4, 4);
  assert.equal(enhanced.length, 4 * 4 * 3);
  const unit = resizeGrayscaleUnit01(lightRgb, 4, 4, 64);
  assert.equal(unit.height, 64);
  assert.ok(unit.tensor[0] > 0.8 && unit.tensor[0] <= 1.0);
});

test("offscreen controller releases sessions and closes after idle timeout without interrupting in-flight work", async () => {
  const { createOffscreenController } = require("../extension/offscreen.js");
  let disposed = 0;
  let closed = 0;
  let scheduledFn = null;
  let scheduledMs = null;
  let cleared = 0;
  let releasePending;

  const controller = createOffscreenController({
    runtime: {
      async warmUp() { return { ok: true, ready: true, models: ["official"] }; },
      async recognizeRgba() {
        await new Promise((resolve) => { releasePending = resolve; });
        return { ok: true, answer: "A7KP" };
      },
      async dispose() { disposed += 1; },
    },
    decodeDataUrl: async () => ({ rgba: new Uint8Array(16), width: 2, height: 2 }),
    idleMs: 600_000,
    onClose: () => { closed += 1; },
    setTimer: (fn, ms) => { scheduledFn = fn; scheduledMs = ms; return 42; },
    clearTimer: () => { cleared += 1; scheduledFn = null; },
  });

  const health = await controller.handleMessage({ type: "OCR_HEALTH", requestId: "r1" });
  assert.equal(health.ok, true);
  assert.equal(scheduledMs, 600_000);
  assert.equal(controller.getState().hasIdleTimer, true);

  // Start in-flight recognition: timer must be cancelled while busy.
  const recogPromise = controller.handleMessage({ type: "OCR_RECOGNIZE", imageDataUrl: "data:image/png;base64,", requestId: "r2" });
  await new Promise((r) => setImmediate(r));
  assert.equal(controller.getState().inFlight, 1);
  assert.equal(controller.getState().hasIdleTimer, false);
  assert.ok(cleared >= 1);

  releasePending();
  const recog = await recogPromise;
  assert.equal(recog.answer, "A7KP");
  assert.equal(controller.getState().inFlight, 0);
  assert.equal(controller.getState().hasIdleTimer, true);

  // Fire the 10-minute idle timer: disposes ONNX runtime and closes offscreen document.
  await scheduledFn();
  await new Promise((r) => setImmediate(r));
  assert.equal(disposed, 1);
  assert.equal(closed, 1);
  assert.equal(controller.getState().closing, true);
});

test("isBlueBackground, alignedCharMatches, and fuseOfficialAndFixed4 rescue 3-letter drops and balance official+CNN", () => {
  const blueRgb = new Uint8Array(4 * 4 * 3);
  const grayRgb = new Uint8Array(4 * 4 * 3);
  for (let i = 0; i < 16; i++) {
    blueRgb[i * 3] = 2; blueRgb[i * 3 + 1] = 108; blueRgb[i * 3 + 2] = 223;
    grayRgb[i * 3] = 50; grayRgb[i * 3 + 1] = 50; grayRgb[i * 3 + 2] = 50;
  }
  assert.equal(isBlueBackground(blueRgb, 4, 4), true);
  assert.equal(isBlueBackground(grayRgb, 4, 4), false);

  assert.equal(alignedCharMatches("BUE", "BUTE"), 3);
  assert.equal(alignedCharMatches("YEG", "YEGL"), 3);
  assert.equal(alignedCharMatches("LMR", "TLMR"), 3);
  assert.equal(alignedCharMatches("ABCD", "ABXD"), 3);
  assert.equal(alignedCharMatches("AB", "ABCD"), 0);

  const cols = DEFAULT_CHARSET.length;
  const direct = new Float32Array(4 * cols).fill(1e-4);
  const crop = new Float32Array(4 * cols).fill(1e-4);
  const setP = (arr, pos, ch, p) => { arr[pos * cols + DEFAULT_CHARSET.indexOf(ch)] = p; };
  // Suppose direct+crop slightly favors JMYJ over JMXJ, while official is strongly confident in JMXJ.
  for (const arr of [direct, crop]) {
    setP(arr, 0, "J", 0.98);
    setP(arr, 1, "M", 0.98);
    setP(arr, 2, "Y", 0.55);
    setP(arr, 2, "X", 0.42);
    setP(arr, 3, "J", 0.98);
  }
  const joint = fuseOfficialAndFixed4(
    [{ text: "JMXJ", logProb: -0.03 }, { text: "JMYJ", logProb: -5.9 }],
    direct,
    crop,
    DEFAULT_CHARSET,
    { charsetHint: "letters" },
  );
  assert.equal(joint.answer, "JMXJ");
  assert.equal(joint.top_candidates[0].answer, "JMXJ");
  assert.equal(joint.top_candidates[1].answer, "JMYJ");
  assert.ok(joint.confidence > 0.9);

  // Missing word must never outrank a retained official beam whose logProb is below -12.
  const direct2 = new Float32Array(4 * cols).fill(1e-4);
  const crop2 = new Float32Array(4 * cols).fill(1e-4);
  for (const arr of [direct2, crop2]) {
    setP(arr, 0, "A", 0.95);
    setP(arr, 1, "B", 0.95);
    setP(arr, 2, "C", 0.95);
    setP(arr, 3, "D", 0.60);
    setP(arr, 3, "Z", 0.35);
  }
  const jointLowBeam = fuseOfficialAndFixed4(
    [{ text: "ABCD", logProb: -20.0 }],
    direct2,
    crop2,
    DEFAULT_CHARSET,
    { charsetHint: "letters" },
  );
  assert.equal(jointLowBeam.answer, "ABCD");
});

test("runtime fuses official+fusion_v7 on blue 4-letter CAPTCHA when official drops a letter, while protecting dark digits", async () => {
  const cols = DEFAULT_CHARSET.length;
  const asciiEntries = DEFAULT_CHARSET.split("").map((char, i) => ({ index: i + 1, char }));
  const makeOfficialLogits = (word) => {
    const T = word.length * 2;
    const C = cols + 2;
    const arr = new Float32Array(T * C).fill(-8);
    word.split("").forEach((ch, idx) => {
      arr[(idx * 2) * C + (DEFAULT_CHARSET.indexOf(ch) + 1)] = 6;
      arr[(idx * 2 + 1) * C + 0] = 6;
    });
    return { data: arr, dims: [T, 1, C] };
  };
  const makeFixed4Logits = (word) => {
    const arr = new Float32Array(4 * cols).fill(-4);
    word.split("").forEach((ch, pos) => {
      arr[pos * cols + DEFAULT_CHARSET.indexOf(ch)] = 6;
    });
    return { data: arr, dims: [1, 4, cols] };
  };

  let officialWord = "LMR"; // dropped 'T' from TLMR
  let fusionWord = "TLMR";
  let sessionCount = 0;
  const fakeOrt = {
    Tensor: class Tensor {
      constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; }
    },
    InferenceSession: {
      async create() {
        const id = sessionCount++;
        if (id === 0) {
          return {
            inputNames: ["input1"], outputNames: ["output"],
            async run() { return { output: makeOfficialLogits(officialWord) }; },
          };
        }
        return {
          inputNames: ["image"], outputNames: ["logits"],
          async run() { return { logits: makeFixed4Logits(fusionWord) }; },
        };
      },
    },
  };
  const fakeFetch = async (url) => {
    if (url.endsWith("bundle_manifest.json")) {
      return { ok: true, json: async () => ({ bundles: { official: {}, fusion_v7: {} } }) };
    }
    if (url.endsWith("charset.json")) {
      return { ok: true, json: async () => ({ blank_index: 0, target_height: 64, ascii_entries: asciiEntries }) };
    }
    if (url.endsWith("config.json")) {
      return { ok: true, json: async () => ({ charset: DEFAULT_CHARSET, alpha: 6, beta: 6, direct_image_size: [12, 20], crop_image_size: [12, 8], crop_margin: 0.32 }) };
    }
    return { ok: true, arrayBuffer: async () => new Uint8Array(8).buffer };
  };

  const runtime = createBrowserOcrRuntime({ ort: fakeOrt, modelBaseUrl: "mem://models", fetchImpl: fakeFetch });
  const blueRgba = new Uint8Array(40 * 20 * 4);
  for (let i = 0; i < 40 * 20; i++) {
    blueRgba[i * 4] = 2; blueRgba[i * 4 + 1] = 108; blueRgba[i * 4 + 2] = 223; blueRgba[i * 4 + 3] = 255;
  }

  // Case 1: Blue 4-letter captcha where official drops a letter ("LMR") under lengthMode="max".
  const resBlue = await runtime.recognizeRgba({
    rgba: blueRgba, width: 40, height: 20, expectedLength: 4, lengthMode: "max", charsetHint: "alphanumeric",
  });
  assert.equal(resBlue.answer, "TLMR");
  assert.equal(resBlue.model, "official+fusion_v7");

  // Case 2: Dark/blue digit captcha (even 3 digits / lower confidence) under alphanumeric hint -> must NOT be overridden with letters.
  officialWord = "482";
  fusionWord = "ABCD";
  const resDigits = await runtime.recognizeRgba({
    rgba: blueRgba, width: 40, height: 20, expectedLength: 4, lengthMode: "max", charsetHint: "alphanumeric",
  });
  assert.equal(resDigits.answer, "482");
  assert.equal(resDigits.model, "official");
});
