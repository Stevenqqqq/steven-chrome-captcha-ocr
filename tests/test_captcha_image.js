const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MAX_IMAGE_BYTES,
  buildRecognizeUrl,
  decodeSafeDataImage,
  preferredCaptchaBlob,
} = require("../extension/captcha_image.js");


test("adds only a bounded integer CAPTCHA length hint", () => {
  assert.equal(
    buildRecognizeUrl("http://127.0.0.1:8765", 4),
    "http://127.0.0.1:8765/recognize?expectedLength=4",
  );
  assert.equal(
    buildRecognizeUrl("http://127.0.0.1:8765", "4.0"),
    "http://127.0.0.1:8765/recognize",
  );
  assert.equal(
    buildRecognizeUrl("http://127.0.0.1:8765", 99),
    "http://127.0.0.1:8765/recognize",
  );
});


test("decodes an allowed base64 PNG without changing its bytes", () => {
  const expected = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const result = decodeSafeDataImage(`data:image/png;base64,${expected.toString("base64")}`);

  assert.equal(result.type, "image/png");
  assert.deepEqual(Buffer.from(result.bytes), expected);
});


test("rejects active or unsupported data URL content", () => {
  assert.throws(
    () => decodeSafeDataImage("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="),
    /不支援的原始圖片格式/,
  );
  assert.throws(
    () => decodeSafeDataImage("data:text/html;base64,PGgxPm5vPC9oMT4="),
    /不支援的原始圖片格式/,
  );
  assert.throws(
    () => decodeSafeDataImage("data:image/png,not-base64"),
    /不支援的原始圖片格式/,
  );
});


test("rejects decoded images above the same five megabyte API limit", () => {
  const oversizedPayload = Buffer.alloc(MAX_IMAGE_BYTES + 1).toString("base64");

  assert.throws(
    () => decodeSafeDataImage(`data:image/png;base64,${oversizedPayload}`),
    /原始圖片超過 5 MB/,
  );
});


test("prefers an exact page image and does not call the screenshot fallback", async () => {
  let fallbackCalls = 0;
  const expected = Buffer.from("captcha-pixels");
  const dataUrl = `data:image/png;base64,${expected.toString("base64")}`;

  const result = await preferredCaptchaBlob(dataUrl, async () => {
    fallbackCalls += 1;
    return new Blob(["screenshot"], { type: "image/png" });
  });

  assert.equal(result.source, "original");
  assert.equal(fallbackCalls, 0);
  assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), expected);
});


test("falls back to a screenshot when the page image is absent or unsafe", async () => {
  let fallbackCalls = 0;
  const screenshot = new Blob(["screenshot"], { type: "image/png" });
  const fallback = async () => {
    fallbackCalls += 1;
    return screenshot;
  };

  const absent = await preferredCaptchaBlob("", fallback);
  const unsafe = await preferredCaptchaBlob("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", fallback);

  assert.equal(absent.source, "screenshot");
  assert.equal(unsafe.source, "screenshot");
  assert.equal(absent.blob, screenshot);
  assert.equal(unsafe.blob, screenshot);
  assert.equal(fallbackCalls, 2);
});
