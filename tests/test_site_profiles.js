const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeOrigin, validateProfile, buildStableSelector, loadProfile, saveProfile, removeProfile,
} = require("../extension/site_profiles.js");

const example = {
  origin: "https://example.com",
  imageSelector: "#challenge",
  inputSelector: 'input[name="answer"]',
  expectedLength: 4,
  lengthMode: "exact",
  charsetHint: "digits",
  caseSensitive: false,
  updatedAt: 1234,
};

test("normalizes an origin without paths, queries or credentials", () => {
  assert.equal(normalizeOrigin("https://user:pass@EXAMPLE.COM:443/a?b=c#d"), "https://example.com");
  assert.equal(normalizeOrigin("http://example.com:8080/foo"), "http://example.com:8080");
  assert.equal(normalizeOrigin("file:///C:/test.html"), "file://");
  assert.equal(normalizeOrigin("file://server/share/index.html"), "file://server");
  for (const value of ["/relative", "chrome://extensions", "javascript:alert(1)", "", undefined]) {
    assert.equal(normalizeOrigin(value), "");
  }
});

test("validates the profile schema and bounds selector length and syntax", () => {
  assert.deepEqual(validateProfile({ ...example, origin: "https://example.com/page" }), example);
  assert.equal(validateProfile({ ...example, expectedLength: null, lengthMode: "unknown" }).expectedLength, null);
  for (const change of [
    { origin: "data:text/plain,test" }, { imageSelector: " " }, { imageSelector: "a".repeat(301) },
    { imageSelector: "a<script>" }, { imageSelector: '[name="x"' }, { inputSelector: "input\n" },
    { expectedLength: "4" }, { expectedLength: 9 }, { lengthMode: "range" },
    { charsetHint: "hex" }, { caseSensitive: 1 },
  ]) {
    assert.equal(validateProfile({ ...example, ...change }), null);
  }
});

test("prefers a unique stable ID, then name and data-testid", () => {
  const attrs = { name: 'captcha"answer', "data-testid": "captcha-input" };
  const element = { tagName: "INPUT", id: "challenge-answer", getAttribute: (name) => attrs[name] };
  let uniqueSelector = "#challenge-answer";
  element.getRootNode = () => ({
    querySelectorAll: (selector) => selector === uniqueSelector ? [element] : [element, {}],
  });
  assert.equal(buildStableSelector(element), uniqueSelector);
  uniqueSelector = '[name="captcha\\"answer"]';
  assert.equal(buildStableSelector(element), uniqueSelector);
  uniqueSelector = '[data-testid="captcha-input"]';
  element.id = "challenge-550e8400-e29b-41d4-a716-446655440000";
  assert.equal(buildStableSelector(element), uniqueSelector);
  assert.equal(buildStableSelector({ tagName: "IMG", id: "captcha" }), "#captcha");
});

test("uses a scoped nth-of-type when the tag matches multiple elements", () => {
  const first = { tagName: "IMG" };
  const second = { tagName: "IMG" };
  const wrapper = { tagName: "DIV", children: [first, second] };
  second.parentElement = wrapper;
  second.getRootNode = () => ({
    querySelectorAll: (selector) => selector === "img:nth-of-type(2)" ? [second] : [first, second],
  });
  assert.equal(buildStableSelector(second), "img:nth-of-type(2)");
});

test("persists validated profiles under siteProfiles and isolates concurrent origin updates", async () => {
  let stored = {};
  const storage = {
    async get(key) {
      assert.equal(key, "siteProfiles");
      return structuredClone(stored);
    },
    async set(value) {
      stored = structuredClone(value);
    },
  };
  assert.equal(await loadProfile(storage, example.origin), null);
  assert.equal(await saveProfile(storage, { ...example, expectedLength: -1 }), null);
  const second = { ...example, origin: "https://other.example", updatedAt: undefined };
  const [saved, savedSecond] = await Promise.all([saveProfile(storage, example), saveProfile(storage, second)]);
  assert.deepEqual(saved, example);
  assert.ok(Number.isFinite(savedSecond.updatedAt));
  assert.deepEqual(await loadProfile(storage, "https://example.com/page"), example);
  assert.deepEqual(await loadProfile(storage, second.origin), savedSecond);
  assert.equal(await removeProfile(storage, example.origin), true);
  assert.equal(await removeProfile(storage, example.origin), false);
  assert.equal(await loadProfile(storage, example.origin), null);
  assert.deepEqual(stored.siteProfiles, { [second.origin]: savedSecond });
});
