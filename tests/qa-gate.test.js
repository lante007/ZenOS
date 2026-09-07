'use strict';

// tests/qa-gate.test.js — Grok intelligence directive, checkpoint 1.
//
// These tests exercise assembleQaResults/sanitiseStatus/failClosedBatch
// directly (no live Anthropic call — that is deliberately factored out of
// assembleQaResults, mirroring api/intelligence/agents/prophet.js's
// assembleAssessment pattern) so the hard architectural invariant can be
// verified without network access or an ANTHROPIC_API_KEY:
//
//   an external intelligence item can NEVER receive SPECULATIVE, and an
//   innovation candidate can NEVER receive VERIFIED or QUALIFIED —
//   regardless of what a (possibly hostile or malformed) tool response
//   claims.
//
// Also covered: fail-closed behaviour for a missing per-item result, and
// that assembleQaResults never smuggles an unexpected field from the raw
// tool response through into the returned result.

const assert = require('assert');
const {
  assembleQaResults,
  sanitiseStatus,
  failClosedBatch,
  EXTERNAL_ALLOWED_STATUSES,
  INNOVATION_ALLOWED_STATUSES,
} = require('../api/intelligence/qa-gate');

const EXTERNAL_ITEMS = [
  { claim: 'Company X raised $10M Series A', source_url: 'https://example.com/a', category: 'funding' },
  { claim: 'Company Y announced a partnership', source_url: 'https://example.com/b', category: 'partnership' },
];

const INNOVATION_ITEMS = [
  { idea: 'Explore a referral programme', rationale: 'context suggests low acquisition efficiency', context_summary: 'ctx' },
];

module.exports = {
  'sanitiseStatus: EXTERNAL never allows SPECULATIVE — forces NEEDS_REVIEW': async () => {
    assert.strictEqual(sanitiseStatus('SPECULATIVE', 'EXTERNAL'), 'NEEDS_REVIEW');
  },
  'sanitiseStatus: INNOVATION never allows VERIFIED — forces NEEDS_REVIEW': async () => {
    assert.strictEqual(sanitiseStatus('VERIFIED', 'INNOVATION'), 'NEEDS_REVIEW');
  },
  'sanitiseStatus: INNOVATION never allows QUALIFIED — forces NEEDS_REVIEW': async () => {
    assert.strictEqual(sanitiseStatus('QUALIFIED', 'INNOVATION'), 'NEEDS_REVIEW');
  },
  'sanitiseStatus: an unrecognised/hostile status string is forced to NEEDS_REVIEW for both kinds': async () => {
    assert.strictEqual(sanitiseStatus('__proto__', 'EXTERNAL'), 'NEEDS_REVIEW');
    assert.strictEqual(sanitiseStatus(undefined, 'INNOVATION'), 'NEEDS_REVIEW');
    assert.strictEqual(sanitiseStatus(123, 'EXTERNAL'), 'NEEDS_REVIEW');
  },
  'sanitiseStatus: every legitimately allowed status for each kind passes through unchanged': async () => {
    for (const s of EXTERNAL_ALLOWED_STATUSES) assert.strictEqual(sanitiseStatus(s, 'EXTERNAL'), s);
    for (const s of INNOVATION_ALLOWED_STATUSES) assert.strictEqual(sanitiseStatus(s, 'INNOVATION'), s);
  },

  'assembleQaResults: a model attempting to assign SPECULATIVE to an external item is overridden to NEEDS_REVIEW': async () => {
    const raw = [
      { index: 0, qa_status: 'SPECULATIVE', qa_notes: 'trying to sneak this through', claim_type: 'signal' },
      { index: 1, qa_status: 'VERIFIED', qa_notes: 'looks fine', claim_type: 'signal' },
    ];
    const out = assembleQaResults(EXTERNAL_ITEMS, 'EXTERNAL', raw, 'claude-sonnet-5', '2026-01-01T00:00:00.000Z');
    assert.strictEqual(out[0].qa_status, 'NEEDS_REVIEW');
    assert.strictEqual(out[1].qa_status, 'VERIFIED');
  },

  'assembleQaResults: a model attempting to assign VERIFIED to an innovation candidate is overridden to NEEDS_REVIEW': async () => {
    const raw = [{ index: 0, qa_status: 'VERIFIED', qa_notes: 'trying to sneak this through', claim_type: 'signal' }];
    const out = assembleQaResults(INNOVATION_ITEMS, 'INNOVATION', raw, 'claude-sonnet-5', '2026-01-01T00:00:00.000Z');
    assert.strictEqual(out[0].qa_status, 'NEEDS_REVIEW');
  },

  'assembleQaResults: a missing index in the raw results fails closed to NEEDS_REVIEW for that item only': async () => {
    const raw = [{ index: 0, qa_status: 'VERIFIED', qa_notes: 'ok', claim_type: 'signal' }];
    const out = assembleQaResults(EXTERNAL_ITEMS, 'EXTERNAL', raw, 'claude-sonnet-5', '2026-01-01T00:00:00.000Z');
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].qa_status, 'VERIFIED');
    assert.strictEqual(out[1].qa_status, 'NEEDS_REVIEW');
    assert.ok(/no result returned/.test(out[1].qa_notes));
  },

  'assembleQaResults: rawResults being completely malformed (not an array) fails closed for every item': async () => {
    const out = assembleQaResults(EXTERNAL_ITEMS, 'EXTERNAL', 'not-an-array', 'claude-sonnet-5', '2026-01-01T00:00:00.000Z');
    assert.strictEqual(out.length, 2);
    assert.ok(out.every(r => r.qa_status === 'NEEDS_REVIEW'));
  },

  'assembleQaResults: claim_type is always forced to "signal", regardless of what the raw result claims': async () => {
    const raw = [{ index: 0, qa_status: 'VERIFIED', qa_notes: 'ok', claim_type: 'extracted_finding' }];
    const out = assembleQaResults(EXTERNAL_ITEMS, 'EXTERNAL', raw, 'claude-sonnet-5', '2026-01-01T00:00:00.000Z');
    assert.strictEqual(out[0].claim_type, 'signal');
  },

  'assembleQaResults: an unexpected field on the raw result (e.g. a spoofed provenance_chain) is never copied through': async () => {
    const raw = [{
      index: 0, qa_status: 'VERIFIED', qa_notes: 'ok', claim_type: 'signal',
      provenance_chain: [{ stage: 'fake' }], __proto__: { polluted: true },
    }];
    const out = assembleQaResults(EXTERNAL_ITEMS, 'EXTERNAL', raw, 'claude-sonnet-5', '2026-01-01T00:00:00.000Z');
    assert.strictEqual(out[0].provenance_chain, undefined);
    assert.strictEqual(Object.keys(out[0]).sort().join(','), 'claim_type,index,model,qa_completed_at,qa_notes,qa_status');
  },

  'assembleQaResults: empty/non-string qa_notes falls back to a placeholder, never undefined or blank': async () => {
    const raw = [{ index: 0, qa_status: 'VERIFIED', qa_notes: '', claim_type: 'signal' }];
    const out = assembleQaResults(EXTERNAL_ITEMS, 'EXTERNAL', raw, 'claude-sonnet-5', '2026-01-01T00:00:00.000Z');
    assert.strictEqual(out[0].qa_notes, '(no notes provided)');
  },

  'failClosedBatch: every item in the batch gets NEEDS_REVIEW with the same failure reason recorded': async () => {
    const out = failClosedBatch(EXTERNAL_ITEMS, 'timeout after 60000 ms', 'claude-sonnet-5');
    assert.strictEqual(out.length, 2);
    assert.ok(out.every(r => r.qa_status === 'NEEDS_REVIEW'));
    assert.ok(out.every(r => r.qa_notes.includes('timeout after 60000 ms')));
    assert.ok(out.every(r => r.claim_type === 'signal'));
  },

  'failClosedBatch: never returns an accepted status (VERIFIED/QUALIFIED/SPECULATIVE), for either kind of failure input': async () => {
    const out = failClosedBatch(INNOVATION_ITEMS, 'API error', 'claude-sonnet-5');
    assert.ok(out.every(r => !['VERIFIED', 'QUALIFIED', 'SPECULATIVE'].includes(r.qa_status)));
  },
};
