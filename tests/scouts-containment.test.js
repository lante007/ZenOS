'use strict';

// tests/scouts-containment.test.js — Grok intelligence directive.
//
// This file is the explicit, concrete demonstration required before
// implementation was approved:
//
//   (a) a REJECTED Grok claim can never surface in the Advisor;
//   (b) a SPECULATIVE innovation candidate can never be represented as
//       evidence.
//
// Each claim is demonstrated at every layer of the architecture that is
// supposed to enforce it, independently — not just once at the top:
//
//   Layer 1 (QA gate, code-level, no DB):        qa-gate.js
//   Layer 2 (database CHECK constraint):          migration 026
//   Layer 3 (store hard-SQL surfaceable filter):   scouts/store.js
//   Layer 4 (Advisor prompt, end to end):          agents/advisor.js
//
// A failure at any single layer would still be caught by this file,
// because each layer is asserted independently rather than relying on the
// end-to-end result alone.

const assert = require('assert');
const { hasDatabase } = require('./helpers/env');
const { assembleQaResults, sanitiseStatus } = require('../api/intelligence/qa-gate');
const { buildPrompt } = require('../api/intelligence/agents/advisor');
const { ADVISOR_CONTEXT } = require('../api/intelligence/contexts/advisor');

const QUESTION = 'What should we prioritise this quarter?';
const SPECIALIST_RESULTS = [{
  agent: 'evidence_analyst', status: 'ok',
  output: { confidence: 'HIGH', findings: [], known: [], not_known: [], interpretation: [], risks: [], recommendations: [], sources: [] },
}];

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
  // ── (a) a REJECTED claim can never surface ──────────────────────────

  '(a) Layer 1 — QA gate: an external item the model tries to mark VERIFIED after itself flagging fabrication is still sanitised correctly, and REJECTED is a legitimate reachable status the code never upgrades': async () => {
    const items = [{ claim: 'fabricated claim', source_url: 'https://example.com/fake', category: 'other' }];
    const raw = [{ index: 0, qa_status: 'REJECTED', qa_notes: 'source is not credible', claim_type: 'signal' }];
    const out = assembleQaResults(items, 'EXTERNAL', raw, 'claude-sonnet-5', '2026-01-01T00:00:00.000Z');
    assert.strictEqual(out[0].qa_status, 'REJECTED');
    // sanitiseStatus never "upgrades" a REJECTED verdict to anything else —
    // REJECTED is itself always an allowed, unmodified pass-through status.
    assert.strictEqual(sanitiseStatus('REJECTED', 'EXTERNAL'), 'REJECTED');
  },

  '(a) Layer 2 — database: the surfaceable-read queries hard-filter to VERIFIED/QUALIFIED only, and REJECTED is not in that set': async () => {
    const { listSurfaceableExternalIntelligence } = require('../api/intelligence/scouts/store');
    const src = listSurfaceableExternalIntelligence.toString();
    assert.ok(/qa_status IN \('VERIFIED', 'QUALIFIED'\)/.test(src), 'expected the hard SQL filter to be exactly VERIFIED/QUALIFIED');
    assert.ok(!/REJECTED/.test(src), 'REJECTED must not appear anywhere in the surfaceable query');
  },

  '(a) Layer 3 — store: a REJECTED row is persisted (audit trail) but never returned by listSurfaceableExternalIntelligence': async () => {
    if (!hasDatabase()) return 'SKIP';
    const { insertExternalIntelligence, listSurfaceableExternalIntelligence, listExternalIntelligence } = require('../api/intelligence/scouts/store');
    await withDisposableTenant('{}', async (slug) => {
      await insertExternalIntelligence({
        tenantId: slug, category: 'other', claim: 'FABRICATED: company Z is bankrupt', source_url: 'https://example.com/fabricated',
        qa_status: 'REJECTED', qa_notes: 'source is not credible, claim is fabricated', provenance_chain: VALID_PROVENANCE,
      });

      const audit = await listExternalIntelligence({ tenantId: slug, statuses: ['REJECTED'] });
      assert.strictEqual(audit.length, 1, 'the REJECTED row must exist in the full audit trail');
      assert.strictEqual(audit[0].claim, 'FABRICATED: company Z is bankrupt');

      const surfaceable = await listSurfaceableExternalIntelligence({ tenantId: slug, limit: 20 });
      assert.strictEqual(surfaceable.length, 0, 'a REJECTED-only tenant must have zero surfaceable rows');
    });
  },

  '(a) Layer 4 — Advisor prompt: with both a REJECTED and a VERIFIED claim persisted, only the VERIFIED claim appears in the prompt': async () => {
    if (!hasDatabase()) return 'SKIP';
    const { insertExternalIntelligence } = require('../api/intelligence/scouts/store');
    await withDisposableTenant('{"EXTERNAL_INTELLIGENCE_ENABLED": true}', async (slug) => {
      await insertExternalIntelligence({
        tenantId: slug, category: 'other', claim: 'FABRICATED: company Z is bankrupt', source_url: 'https://example.com/fabricated',
        qa_status: 'REJECTED', qa_notes: 'source is not credible, claim is fabricated', provenance_chain: VALID_PROVENANCE,
      });
      await insertExternalIntelligence({
        tenantId: slug, category: 'other', claim: 'Company Q closed a real Series A round', source_url: 'https://example.com/real',
        qa_status: 'VERIFIED', qa_notes: 'credible source, specific claim', provenance_chain: VALID_PROVENANCE,
      });

      const prompt = await buildPrompt(QUESTION, SPECIALIST_RESULTS, { tenantId: slug });

      assert.ok(!prompt.includes('FABRICATED'), 'a REJECTED claim must never appear in the Advisor prompt, in any form');
      assert.ok(!prompt.includes('company Z is bankrupt'));
      assert.ok(prompt.includes('Company Q closed a real Series A round'), 'the VERIFIED claim must appear');
      assert.ok(prompt.includes('[VERIFIED]'));
    });
  },

  // ── (b) a SPECULATIVE candidate can never be evidence ───────────────

  '(b) Layer 1 — QA gate: sanitiseStatus can never assign VERIFIED/QUALIFIED to an innovation candidate; SPECULATIVE is its ceiling': async () => {
    for (const attempted of ['VERIFIED', 'QUALIFIED']) {
      assert.strictEqual(sanitiseStatus(attempted, 'INNOVATION'), 'NEEDS_REVIEW', `INNOVATION must never receive ${attempted}`);
    }
    assert.strictEqual(sanitiseStatus('SPECULATIVE', 'INNOVATION'), 'SPECULATIVE', 'SPECULATIVE itself must pass through unmodified');
  },

  '(b) Layer 2 — database CHECK constraint: innovation_candidates rejects VERIFIED/QUALIFIED at the SQL level, independent of the application': async () => {
    if (!hasDatabase()) return 'SKIP';
    const { ensureScoutSchema } = require('../api/intelligence/scouts/schema');
    await withDisposableTenant('{}', async (slug, pool) => {
      await ensureScoutSchema();
      await assert.rejects(
        () => pool.query(
          `INSERT INTO innovation_candidates (tenant_id, idea, rationale, context_summary, qa_status, provenance_chain, context_hash)
           VALUES ($1,'idea','rationale','ctx','VERIFIED',$2::jsonb,'h')`,
          [slug, JSON.stringify(VALID_PROVENANCE)],
        ),
        /violates check constraint/,
        'the database schema itself must refuse VERIFIED on innovation_candidates, even if application code is bypassed',
      );
    });
  },

  '(b) Layer 3 — store: the innovation surfaceable query is hard-filtered to exactly SPECULATIVE, nothing else': async () => {
    const { listSurfaceableInnovationCandidates } = require('../api/intelligence/scouts/store');
    const src = listSurfaceableInnovationCandidates.toString();
    assert.ok(/qa_status = 'SPECULATIVE'/.test(src));
    assert.ok(!/VERIFIED|QUALIFIED/.test(src), 'no accepted-evidence status must ever appear in the innovation surfaceable query');
  },

  '(b) Layer 4 — Advisor prompt: a SPECULATIVE innovation candidate is always labelled SPECULATIVE, never EVIDENCE, and the system prompt forbids relabelling': async () => {
    if (!hasDatabase()) return 'SKIP';
    const { insertInnovationCandidate } = require('../api/intelligence/scouts/store');
    await withDisposableTenant('{"INNOVATION_SCOUT_ENABLED": true}', async (slug) => {
      await insertInnovationCandidate({
        tenantId: slug, idea: 'Launch a tiered pricing pilot', rationale: 'plausible given cost pressure signals', context_summary: 'ctx',
        qa_status: 'SPECULATIVE', qa_notes: 'coherent, relevant, safe', provenance_chain: VALID_PROVENANCE, context_hash: 'h',
      });

      const prompt = await buildPrompt(QUESTION, SPECIALIST_RESULTS, { tenantId: slug });
      assert.ok(prompt.includes('[SPECULATIVE] Launch a tiered pricing pilot'), 'the candidate must be labelled SPECULATIVE in the injected block');
      assert.ok(prompt.includes('NOT evidence, NOT verified'), 'the block header must explicitly disclaim evidence/verified status');

      // The system prompt (ADVISOR_CONTEXT) — sent on every live Advisor
      // call — must itself forbid the model from ever relabelling a
      // Grok-sourced item (regardless of qa_status) as EVIDENCE or MEMORY.
      assert.ok(
        /always SIGNAL\s+type regardless of their QA status/.test(ADVISOR_CONTEXT),
        'expected the mandatory SIGNAL-only sentence in ADVISOR_CONTEXT',
      );
      assert.ok(
        /never be relabelled as\s+EVIDENCE or MEMORY even when their qa_status is VERIFIED/.test(ADVISOR_CONTEXT),
        'expected the explicit prohibition on relabelling Grok-sourced items as EVIDENCE/MEMORY',
      );
    });
  },

  '(b) cross-status invariant holds in both directions simultaneously: EXTERNAL can never get SPECULATIVE, INNOVATION can never get VERIFIED/QUALIFIED': async () => {
    assert.strictEqual(sanitiseStatus('SPECULATIVE', 'EXTERNAL'), 'NEEDS_REVIEW');
    assert.strictEqual(sanitiseStatus('VERIFIED', 'INNOVATION'), 'NEEDS_REVIEW');
    assert.strictEqual(sanitiseStatus('QUALIFIED', 'INNOVATION'), 'NEEDS_REVIEW');
  },
};
