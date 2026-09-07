'use strict';

// tests/scouts-shaping.test.js — Grok intelligence directive.
//
// shapeItem() in scouts/external.js and scouts/innovation.js is the first
// line of defence against malformed or hostile raw Grok output, before
// anything reaches the QA gate. These are pure-function tests: no live
// Grok/Anthropic call, no database.

const assert = require('assert');
const { shapeItem: shapeExternalItem } = require('../api/intelligence/scouts/external');
const { shapeItem: shapeInnovationItem, contextHash } = require('../api/intelligence/scouts/innovation');

module.exports = {
  // ── external ──────────────────────────────────────────
  'external shapeItem: a well-formed item passes through with a valid category': async () => {
    const out = shapeExternalItem({ claim: 'X raised funding', source_url: 'https://example.com/a', category: 'funding' });
    assert.deepStrictEqual(out, { claim: 'X raised funding', source_url: 'https://example.com/a', category: 'funding' });
  },
  'external shapeItem: missing claim is dropped (returns null)': async () => {
    assert.strictEqual(shapeExternalItem({ source_url: 'https://example.com/a' }), null);
  },
  'external shapeItem: missing source_url is dropped (returns null)': async () => {
    assert.strictEqual(shapeExternalItem({ claim: 'X raised funding' }), null);
  },
  'external shapeItem: a malformed URL is dropped (returns null)': async () => {
    assert.strictEqual(shapeExternalItem({ claim: 'X', source_url: 'not-a-url' }), null);
  },
  'external shapeItem: a non-http(s) URL scheme (e.g. javascript:) is dropped': async () => {
    assert.strictEqual(shapeExternalItem({ claim: 'X', source_url: 'javascript:alert(1)' }), null);
    assert.strictEqual(shapeExternalItem({ claim: 'X', source_url: 'file:///etc/passwd' }), null);
  },
  'external shapeItem: an invalid/unknown category falls back to "other"': async () => {
    const out = shapeExternalItem({ claim: 'X', source_url: 'https://example.com/a', category: 'not-a-real-category' });
    assert.strictEqual(out.category, 'other');
  },
  'external shapeItem: a non-object or null raw item is dropped': async () => {
    assert.strictEqual(shapeExternalItem(null), null);
    assert.strictEqual(shapeExternalItem('a string'), null);
    assert.strictEqual(shapeExternalItem(42), null);
  },
  'external shapeItem: whitespace-only claim/source_url is dropped': async () => {
    assert.strictEqual(shapeExternalItem({ claim: '   ', source_url: 'https://example.com/a' }), null);
  },

  // ── innovation ────────────────────────────────────────
  'innovation shapeItem: a well-formed item passes through with context_summary attached': async () => {
    const out = shapeInnovationItem({ idea: 'Try a referral programme', rationale: 'low acquisition efficiency' }, 'ctx summary');
    assert.deepStrictEqual(out, { idea: 'Try a referral programme', rationale: 'low acquisition efficiency', context_summary: 'ctx summary' });
  },
  'innovation shapeItem: missing idea is dropped (returns null)': async () => {
    assert.strictEqual(shapeInnovationItem({ rationale: 'x' }, 'ctx'), null);
  },
  'innovation shapeItem: missing rationale is dropped (returns null)': async () => {
    assert.strictEqual(shapeInnovationItem({ idea: 'x' }, 'ctx'), null);
  },
  'innovation shapeItem: a non-object or null raw item is dropped': async () => {
    assert.strictEqual(shapeInnovationItem(null, 'ctx'), null);
    assert.strictEqual(shapeInnovationItem(undefined, 'ctx'), null);
  },
  'innovation contextHash: deterministic for identical input, differs for different input': async () => {
    const h1 = contextHash('some context string');
    const h2 = contextHash('some context string');
    const h3 = contextHash('a different context string');
    assert.strictEqual(h1, h2);
    assert.notStrictEqual(h1, h3);
    assert.strictEqual(h1.length, 64, 'expected a hex sha256 digest');
  },
};
