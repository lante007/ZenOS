'use strict';

// tests/advisor.test.js — C2: buildPrompt(question, specialistResults, meta)
//
// The required regression guard: when MEMORY_CONTEXT_ENABLED is false for
// the tenant (the default), the Advisor's prompt must be byte-identical to
// the pre-C1/C2 prompt. EXPECTED below is constructed independently (the
// same array-join shape as the original inline `combined` construction,
// with values computed by hand from renderAgentBlock's known formatting
// rules) rather than by calling into the module under test, so this test
// actually catches an accidental change to that shape or formatting.
//
// The flag-ON test exercises a real MEMORY CONTEXT append, using a
// disposable tenant registered directly in master.tenants for the duration
// of the test (never the real zenex/optima rows — those must never be
// touched by an automated test against a shared/production database) and
// deleted again in a finally block. It requires PostgreSQL and skips
// cleanly without it, matching the rest of this suite.

const assert = require('assert');
const { hasDatabase } = require('./helpers/env');
const { buildPrompt } = require('../api/intelligence/agents/advisor');

const QUESTION = 'What should we prioritise this quarter?';

const SPECIALIST_RESULTS = [
  {
    agent: 'evidence_analyst',
    status: 'ok',
    output: {
      confidence: 'HIGH',
      findings: ['f1'],
      known: ['k1'],
      not_known: [],
      interpretation: ['i1'],
      risks: [],
      recommendations: ['r1'],
      sources: [],
    },
  },
];

const EXPECTED_BLOCK = [
  'EVIDENCE ANALYST (status ok, confidence HIGH)',
  'Findings:\n- f1',
  'Known:\n- k1',
  'Not known: none stated',
  'Interpretation:\n- i1',
  'Risks: none stated',
  'Recommendations:\n- r1',
  'Sources:\n  * none',
].join('\n');

const EXPECTED_PROMPT_FLAG_OFF = [
  'ORIGINAL QUESTION',
  QUESTION,
  '',
  'SPECIALIST AGENT OUTPUTS',
  '',
  EXPECTED_BLOCK,
  '',
  'Synthesise these into one response by calling submit_synthesis. Keep evidence and interpretation separate. Note explicitly where an agent failed.',
].join('\n');

module.exports = {
  'prompt is byte-identical to pre-C1/C2 when MEMORY_CONTEXT_ENABLED is false (no meta)': async () => {
    const prompt = await buildPrompt(QUESTION, SPECIALIST_RESULTS, {});
    assert.strictEqual(prompt, EXPECTED_PROMPT_FLAG_OFF);
    assert.ok(!prompt.includes('MEMORY CONTEXT'), 'prompt must not mention memory context when the flag is off');
  },

  'prompt is byte-identical to pre-C1/C2 when MEMORY_CONTEXT_ENABLED is false (zenex tenant)': async () => {
    const prompt = await buildPrompt(QUESTION, SPECIALIST_RESULTS, { tenantId: 'zenex' });
    assert.strictEqual(prompt, EXPECTED_PROMPT_FLAG_OFF);
  },

  'prompt is byte-identical for an unknown tenant (flag defaults false, fails closed)': async () => {
    const prompt = await buildPrompt(QUESTION, SPECIALIST_RESULTS, { tenantId: 'no-such-tenant' });
    assert.strictEqual(prompt, EXPECTED_PROMPT_FLAG_OFF);
  },

  'when the flag is ON for a tenant, a MEMORY CONTEXT section is appended': async () => {
    if (!hasDatabase()) return 'SKIP';
    const { getPool } = require('../api/services/db');
    const pool = getPool();
    const slug = `zztest${Date.now()}`.slice(0, 20);
    await pool.query(
      `INSERT INTO master.tenants (slug, name, subdomain, db_schema, is_active, feature_flags)
       VALUES ($1, $2, $3, $1, true, '{"MEMORY_CONTEXT_ENABLED": true}'::jsonb)`,
      [slug, `Test Tenant ${slug}`, `${slug}.test.auxeira.com`],
    );
    try {
      const prompt = await buildPrompt(QUESTION, SPECIALIST_RESULTS, { tenantId: slug });
      assert.ok(prompt.includes('MEMORY CONTEXT (flag-gated)'), 'expected a MEMORY CONTEXT section when the flag is on');
      assert.ok(prompt.startsWith(EXPECTED_PROMPT_FLAG_OFF), 'the flag-off prefix of the prompt must be unchanged when the flag is on');
    } finally {
      await pool.query('DELETE FROM master.tenants WHERE slug = $1', [slug]);
    }
  },

  'a memory context failure while the flag is on does not throw or block the prompt': async () => {
    if (!hasDatabase()) return 'SKIP';
    const { getPool } = require('../api/services/db');
    const pool = getPool();
    // A tenant with the flag on but no db_schema set is enough to make
    // downstream memory/decision/signal queries behave oddly for that
    // schema; regardless of what happens internally, buildPrompt must
    // never throw and must always return at least the base prompt.
    const slug = `zzfail${Date.now()}`.slice(0, 20);
    await pool.query(
      `INSERT INTO master.tenants (slug, name, subdomain, is_active, feature_flags)
       VALUES ($1, $2, $3, true, '{"MEMORY_CONTEXT_ENABLED": true}'::jsonb)`,
      [slug, `Test Tenant ${slug}`, `${slug}.test.auxeira.com`],
    );
    try {
      const prompt = await buildPrompt(QUESTION, SPECIALIST_RESULTS, { tenantId: slug });
      assert.ok(prompt.startsWith(EXPECTED_PROMPT_FLAG_OFF));
    } finally {
      await pool.query('DELETE FROM master.tenants WHERE slug = $1', [slug]);
    }
  },
};
