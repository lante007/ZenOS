'use strict';

// tests/geography.test.js -- expandNationalScope(), the write-time
// defensive backstop that expands the literal "National" value into the
// nine real South African provinces at the point of persistence.

const assert = require('assert');
const { expandNationalScope, NINE_PROVINCES } = require('../api/services/geography');

module.exports = {
  '["National"] expands to the nine provinces': async () => {
    const result = expandNationalScope(['National']);
    assert.deepStrictEqual(result, NINE_PROVINCES);
    assert.strictEqual(result.length, 9);
  },

  '["Gauteng"] is returned unchanged': async () => {
    const result = expandNationalScope(['Gauteng']);
    assert.deepStrictEqual(result, ['Gauteng']);
  },

  '["National", "Gauteng"] expands to the nine provinces with no duplicate': async () => {
    const result = expandNationalScope(['National', 'Gauteng']);
    assert.deepStrictEqual(result, NINE_PROVINCES);
    assert.strictEqual(result.length, 9);
    assert.strictEqual(result.filter(p => p === 'Gauteng').length, 1);
  },

  '[] is returned unchanged': async () => {
    const result = expandNationalScope([]);
    assert.deepStrictEqual(result, []);
  },

  'null is returned unchanged': async () => {
    const result = expandNationalScope(null);
    assert.strictEqual(result, null);
  },

  'case-insensitive match: ["national"] (lowercase) also expands': async () => {
    const result = expandNationalScope(['national']);
    assert.deepStrictEqual(result, NINE_PROVINCES);
  },
};
