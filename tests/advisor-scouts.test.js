'use strict';

// tests/advisor-scouts.test.js — Grok intelligence directive, checkpoint 3.
//
// Mirrors tests/advisor.test.js's structure exactly, for the two new
// flags (EXTERNAL_INTELLIGENCE_ENABLED, INNOVATION_SCOUT_ENABLED):
//   - both flags off (the default) must produce a prompt byte-identical to
//     the pre-existing EXPECTED_PROMPT_FLAG_OFF — no regression to the
//     already-approved C2 memory-context behaviour;
//   - turning a flag on for a disposable tenant with a persisted
//     surfaceable row appends the expected labelled block;
//   - a context-build failure while a flag is on must never throw or
//     block the rest of the prompt (fail-soft, matching MEMORY_CONTEXT_ENABLED).

const assert = require('assert');
const { hasDatabase } = require('./helpers/env');
const { buildPrompt } = require('../api/intelligence/agents/advisor');

const QUESTION = 'What should we prioritise this quarter?';

const SPECIALIST_RESULTS = [
  {
    agent: 'evidence_analyst',
    status: 'ok',
    output: { confidence: 'HIGH', findings: ['f1'], known: ['k1'], not_known: [], interpretation: ['i1'], risks: [], recommendations: ['r1'], sources: [] },
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

const VALID_PROVENANCE = [
  { stage: 'grok_generation', model: 'grok-2-latest', timestamp: '2026-01-01T00:00:00.000Z', prompt_hash: 'abc123' },
  { stage: 'claude_qa', model: 'claude-sonnet-5', version: 'qa-gate-v1', timestamp: '2026-01-01T00:00:01.000Z', qa_status: 'VERIFIED', qa_notes: 'ok' },
  { stage: 'system_ingestion', timestamp: '2026-01-01T00:00:02.000Z', tenant_id: 'zztest', feature_flag_state: true },
];

async function withDisposableTenant(featureFlagsJson, fn) {
  const { getPool } = require('../api/services/db');
  const { _invalidateTenantCacheForTests } = require('../api/memory/util');
  const pool = getPool();
  const slug = `zztest${Date.now()}`.slice(0, 20);
  await pool.query(
    `INSERT INTO master.tenants (slug, name, subdomain, db_schema, is_active, feature_flags)
     VALUES ($1, $2, $3, $1, true, $4::jsonb)`,
    [slug, `Test Tenant ${slug}`, `${slug}.test.auxeira.com`, featureFlagsJson],
  );
  _invalidateTenantCacheForTests();
  try {
    return await fn(slug, pool);
  } finally {
    await pool.query('DELETE FROM master.tenants WHERE slug = $1', [slug]);
    _invalidateTenantCacheForTests();
  }
}

module.exports = {
  'prompt is byte-identical to the pre-Grok-directive prompt when both new flags are off (no meta)': async () => {
    const prompt = await buildPrompt(QUESTION, SPECIALIST_RESULTS, {});
    assert.strictEqual(prompt, EXPECTED_PROMPT_FLAG_OFF);
    assert.ok(!prompt.includes('EXTERNAL INTELLIGENCE'));
    assert.ok(!prompt.includes('INNOVATION CANDIDATES'));
  },

  'prompt is byte-identical for an unknown tenant (both new flags default false, fail closed)': async () => {
    const prompt = await buildPrompt(QUESTION, SPECIALIST_RESULTS, { tenantId: 'no-such-tenant' });
    assert.strictEqual(prompt, EXPECTED_PROMPT_FLAG_OFF);
  },

  'EXTERNAL_INTELLIGENCE_ENABLED on: a surfaceable (VERIFIED) row is appended as a labelled EXTERNAL INTELLIGENCE block': async () => {
    if (!hasDatabase()) return 'SKIP';
    const { insertExternalIntelligence } = require('../api/intelligence/scouts/store');
    await withDisposableTenant('{"EXTERNAL_INTELLIGENCE_ENABLED": true}', async (slug) => {
      await insertExternalIntelligence({
        tenantId: slug, category: 'funding', claim: 'Acme raised a Series B', source_url: 'https://example.com/acme',
        qa_status: 'VERIFIED', qa_notes: 'ok', provenance_chain: VALID_PROVENANCE,
      });
      const prompt = await buildPrompt(QUESTION, SPECIALIST_RESULTS, { tenantId: slug });
      assert.ok(prompt.includes('EXTERNAL INTELLIGENCE'), 'expected the EXTERNAL INTELLIGENCE block header');
      assert.ok(prompt.includes('Acme raised a Series B'));
      assert.ok(prompt.includes('[VERIFIED]'));
      assert.ok(prompt.startsWith(EXPECTED_PROMPT_FLAG_OFF), 'the flag-off prefix must be unchanged when the flag is on');
    });
  },

  'INNOVATION_SCOUT_ENABLED on: a surfaceable (SPECULATIVE) row is appended as a labelled INNOVATION CANDIDATES block': async () => {
    if (!hasDatabase()) return 'SKIP';
    const { insertInnovationCandidate } = require('../api/intelligence/scouts/store');
    await withDisposableTenant('{"INNOVATION_SCOUT_ENABLED": true}', async (slug) => {
      await insertInnovationCandidate({
        tenantId: slug, idea: 'Explore a referral programme', rationale: 'low acquisition efficiency', context_summary: 'ctx',
        qa_status: 'SPECULATIVE', qa_notes: 'ok', provenance_chain: VALID_PROVENANCE, context_hash: 'h',
      });
      const prompt = await buildPrompt(QUESTION, SPECIALIST_RESULTS, { tenantId: slug });
      assert.ok(prompt.includes('INNOVATION CANDIDATES'), 'expected the INNOVATION CANDIDATES block header');
      assert.ok(prompt.includes('Explore a referral programme'));
      assert.ok(prompt.includes('[SPECULATIVE]'));
      assert.ok(prompt.startsWith(EXPECTED_PROMPT_FLAG_OFF));
    });
  },

  'both flags on with no surfaceable rows: neither block is appended (empty-block-skip, matching MEMORY_CONTEXT_ENABLED)': async () => {
    if (!hasDatabase()) return 'SKIP';
    await withDisposableTenant('{"EXTERNAL_INTELLIGENCE_ENABLED": true, "INNOVATION_SCOUT_ENABLED": true}', async (slug) => {
      const prompt = await buildPrompt(QUESTION, SPECIALIST_RESULTS, { tenantId: slug });
      assert.strictEqual(prompt, EXPECTED_PROMPT_FLAG_OFF, 'with no rows to surface, the prompt must equal the flag-off prompt exactly');
    });
  },

  'a context-build failure while a flag is on does not throw or block the prompt (fail-soft)': async () => {
    if (!hasDatabase()) return 'SKIP';
    // A tenant with the flag on but no db_schema column set is enough to
    // exercise an internal failure path without mocking; regardless of
    // what happens internally, buildPrompt must never throw.
    const { getPool } = require('../api/services/db');
    const { _invalidateTenantCacheForTests } = require('../api/memory/util');
    const pool = getPool();
    const slug = `zzfail${Date.now()}`.slice(0, 20);
    await pool.query(
      `INSERT INTO master.tenants (slug, name, subdomain, is_active, feature_flags)
       VALUES ($1, $2, $3, true, '{"EXTERNAL_INTELLIGENCE_ENABLED": true, "INNOVATION_SCOUT_ENABLED": true}'::jsonb)`,
      [slug, `Test Tenant ${slug}`, `${slug}.test.auxeira.com`],
    );
    _invalidateTenantCacheForTests();
    try {
      const prompt = await buildPrompt(QUESTION, SPECIALIST_RESULTS, { tenantId: slug });
      assert.ok(prompt.startsWith(EXPECTED_PROMPT_FLAG_OFF));
    } finally {
      await pool.query('DELETE FROM master.tenants WHERE slug = $1', [slug]);
      _invalidateTenantCacheForTests();
    }
  },

  'cross-tenant mode (meta.tenantScope.mode === "all") skips both scout blocks entirely, even if flags are on': async () => {
    if (!hasDatabase()) return 'SKIP';
    const { insertExternalIntelligence } = require('../api/intelligence/scouts/store');
    await withDisposableTenant('{"EXTERNAL_INTELLIGENCE_ENABLED": true}', async (slug) => {
      await insertExternalIntelligence({
        tenantId: slug, category: 'other', claim: 'should never appear in cross-tenant mode', source_url: 'https://example.com/x',
        qa_status: 'VERIFIED', qa_notes: 'ok', provenance_chain: VALID_PROVENANCE,
      });
      const prompt = await buildPrompt(QUESTION, SPECIALIST_RESULTS, {
        tenantId: slug,
        tenantScope: { mode: 'all' },
        allTenantsData: [{ tenant_id: slug, tenant_name: 'Test', corpus_health: 'healthy', document_count: 1, evaluation_count: 1, programme_count: 1, completeness: 1, evidence_quality: 1, last_ingestion: null, pipeline_status: 'clear', intelligence_signals: 0, relevant_alerts: 0 }],
      });
      assert.ok(!prompt.includes('EXTERNAL INTELLIGENCE'), 'scout context must never inject in cross-tenant mode, per checkpoint 4');
      assert.ok(!prompt.includes('should never appear in cross-tenant mode'));
    });
  },
};
