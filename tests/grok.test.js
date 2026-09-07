'use strict';

// tests/grok.test.js — pure-function tests for api/intelligence/grok.js.
// No live API call, no AWS Secrets Manager call: parseJsonArray and
// promptHash are exercised directly. grokChat/grokWebSearch/grokIdeation
// (which require a live Grok API key from Secrets Manager) are exercised
// only indirectly, end-to-end, and are out of scope for automated tests
// per the same house convention as watchtower/fetcher.js.

const assert = require('assert');
const { parseJsonArray, promptHash, EXTERNAL_CATEGORIES } = require('../api/intelligence/grok');

module.exports = {
  'parseJsonArray: parses a clean JSON array': async () => {
    const out = parseJsonArray('[{"a":1},{"a":2}]');
    assert.deepStrictEqual(out, [{ a: 1 }, { a: 2 }]);
  },
  'parseJsonArray: strips ```json ... ``` markdown fences': async () => {
    const out = parseJsonArray('```json\n[{"a":1}]\n```');
    assert.deepStrictEqual(out, [{ a: 1 }]);
  },
  'parseJsonArray: strips bare ``` ... ``` fences (no json tag)': async () => {
    const out = parseJsonArray('```\n[{"a":1}]\n```');
    assert.deepStrictEqual(out, [{ a: 1 }]);
  },
  'parseJsonArray: extracts a JSON array embedded in surrounding prose': async () => {
    const out = parseJsonArray('Sure, here is the array: [{"a":1}] hope that helps');
    assert.deepStrictEqual(out, [{ a: 1 }]);
  },
  'parseJsonArray: returns [] for non-string input': async () => {
    assert.deepStrictEqual(parseJsonArray(null), []);
    assert.deepStrictEqual(parseJsonArray(undefined), []);
    assert.deepStrictEqual(parseJsonArray(42), []);
  },
  'parseJsonArray: returns [] for an empty string': async () => {
    assert.deepStrictEqual(parseJsonArray(''), []);
  },
  'parseJsonArray: returns [] for text with no array at all': async () => {
    assert.deepStrictEqual(parseJsonArray('I could not find any results.'), []);
  },
  'parseJsonArray: returns [] for malformed JSON inside brackets': async () => {
    assert.deepStrictEqual(parseJsonArray('[{"a":1,}]'), []);
  },
  'parseJsonArray: returns [] when the top-level value is an object, not an array': async () => {
    assert.deepStrictEqual(parseJsonArray('{"a":1}'), []);
  },
  'parseJsonArray: handles an explicit empty array': async () => {
    assert.deepStrictEqual(parseJsonArray('[]'), []);
  },

  'promptHash: deterministic for identical input': async () => {
    assert.strictEqual(promptHash('same text'), promptHash('same text'));
  },
  'promptHash: differs for different input': async () => {
    assert.notStrictEqual(promptHash('text a'), promptHash('text b'));
  },
  'promptHash: returns a 64-char hex sha256 digest, even for empty/undefined input': async () => {
    assert.strictEqual(promptHash('').length, 64);
    assert.strictEqual(promptHash(undefined).length, 64);
  },

  'EXTERNAL_CATEGORIES: fixed known set, includes "other" as the fallback category': async () => {
    assert.ok(Array.isArray(EXTERNAL_CATEGORIES));
    assert.ok(EXTERNAL_CATEGORIES.includes('other'));
    assert.deepStrictEqual(EXTERNAL_CATEGORIES, ['funding', 'competitor', 'regulatory', 'market', 'partnership', 'other']);
  },
};
