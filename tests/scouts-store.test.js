'use strict';

// tests/scouts-store.test.js — Grok intelligence directive, checkpoints 2
// and 4. DB-backed; skips cleanly without PostgreSQL, matching the rest of
// this suite. Uses a disposable test tenant registered directly in
// master.tenants for the duration of each test (never zenex/optima),
// deleted again in a finally block.
//
// Covers:
//   - tenant isolation: an unresolvable tenant slug THROWS (checkpoint 4,
//     the user's explicit correction — an empty array would mask
//     misconfiguration silently);
//   - provenance_chain validation (all 3 named stages required);
//   - the qa_status CHECK constraint / allowed-status validation per kind;
//   - the immutability trigger: qa_status/qa_notes/provenance_chain can
//     never be UPDATEd after insert, with the exact required error message;
//   - the two permitted mutations: superseded_by and decision_status/notes;
//   - surfaceable-read hard SQL filtering (VERIFIED/QUALIFIED only for
//     external, SPECULATIVE only for innovation, superseded rows excluded).

const assert = require('assert');
const { hasDatabase } = require('./helpers/env');

const VALID_PROVENANCE = [
  { stage: 'grok_generation', model: 'grok-2-latest', timestamp: '2026-01-01T00:00:00.000Z', prompt_hash: 'abc123' },
  { stage: 'claude_qa', model: 'claude-sonnet-5', version: 'qa-gate-v1', timestamp: '2026-01-01T00:00:01.000Z', qa_status: 'VERIFIED', qa_notes: 'ok' },
  { stage: 'system_ingestion', timestamp: '2026-01-01T00:00:02.000Z', tenant_id: 'zztest', feature_flag_state: true },
];

async function withDisposableTenant(fn) {
  const { getPool } = require('../api/services/db');
  const { _invalidateTenantCacheForTests } = require('../api/memory/util');
  const pool = getPool();
  const slug = `zztest${Date.now()}`.slice(0, 20);
  await pool.query(
    `INSERT INTO master.tenants (slug, name, subdomain, db_schema, is_active, feature_flags)
     VALUES ($1, $2, $3, $1, true, '{}'::jsonb)`,
    [slug, `Test Tenant ${slug}`, `${slug}.test.auxeira.com`],
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
  'tenant isolation: resolveTenant THROWS for an unresolvable tenant slug (never returns an empty result)': async () => {
    if (!hasDatabase()) return 'SKIP';
    const { listSurfaceableExternalIntelligence } = require('../api/intelligence/scouts/store');
    await assert.rejects(
      () => listSurfaceableExternalIntelligence({ tenantId: 'notarealtenantxyzzzz' }),
      /Unknown tenant/,
      'expected a throw, not a silently empty array, for an unresolvable tenant slug',
    );
  },

  'tenant isolation: a malformed tenant slug (fails the slug regex) THROWS, never reaches a query': async () => {
    if (!hasDatabase()) return 'SKIP';
    const { listExternalIntelligence } = require('../api/intelligence/scouts/store');
    await assert.rejects(
      () => listExternalIntelligence({ tenantId: "'; DROP TABLE external_intelligence; --" }),
      /Invalid tenant slug/,
    );
  },

  'provenance_chain validation: rejects a chain missing a required stage': async () => {
    if (!hasDatabase()) return 'SKIP';
    const { insertExternalIntelligence } = require('../api/intelligence/scouts/store');
    await withDisposableTenant(async (slug) => {
      const badChain = VALID_PROVENANCE.map(e => (e.stage === 'claude_qa' ? { ...e, stage: 'not_claude_qa' } : e));
      await assert.rejects(
        () => insertExternalIntelligence({
          tenantId: slug, category: 'other', claim: 'x', source_url: 'https://example.com/a',
          qa_status: 'VERIFIED', qa_notes: 'ok', provenance_chain: badChain,
        }),
        /missing required stage "claude_qa"/,
      );
    });
  },

  'provenance_chain validation: rejects fewer than 3 entries': async () => {
    if (!hasDatabase()) return 'SKIP';
    const { insertInnovationCandidate } = require('../api/intelligence/scouts/store');
    await withDisposableTenant(async (slug) => {
      await assert.rejects(
        () => insertInnovationCandidate({
          tenantId: slug, idea: 'x', rationale: 'y', context_summary: 'z',
          qa_status: 'SPECULATIVE', qa_notes: 'ok', provenance_chain: [VALID_PROVENANCE[0]], context_hash: 'h',
        }),
        /at least 3 entries/,
      );
    });
  },

  'qa_status validation: insertExternalIntelligence rejects SPECULATIVE (architectural invariant, application layer)': async () => {
    if (!hasDatabase()) return 'SKIP';
    const { insertExternalIntelligence } = require('../api/intelligence/scouts/store');
    await withDisposableTenant(async (slug) => {
      await assert.rejects(
        () => insertExternalIntelligence({
          tenantId: slug, category: 'other', claim: 'x', source_url: 'https://example.com/a',
          qa_status: 'SPECULATIVE', qa_notes: 'nope', provenance_chain: VALID_PROVENANCE,
        }),
        /Invalid qa_status for external intelligence: SPECULATIVE/,
      );
    });
  },

  'qa_status validation: insertInnovationCandidate rejects VERIFIED (architectural invariant, application layer)': async () => {
    if (!hasDatabase()) return 'SKIP';
    const { insertInnovationCandidate } = require('../api/intelligence/scouts/store');
    await withDisposableTenant(async (slug) => {
      await assert.rejects(
        () => insertInnovationCandidate({
          tenantId: slug, idea: 'x', rationale: 'y', context_summary: 'z',
          qa_status: 'VERIFIED', qa_notes: 'nope', provenance_chain: VALID_PROVENANCE, context_hash: 'h',
        }),
        /Invalid qa_status for innovation candidate: VERIFIED/,
      );
    });
  },

  'qa_status CHECK constraint: the database itself rejects SPECULATIVE on external_intelligence, independent of the application layer': async () => {
    if (!hasDatabase()) return 'SKIP';
    const { ensureScoutSchema } = require('../api/intelligence/scouts/schema');
    await withDisposableTenant(async (slug, pool) => {
      await ensureScoutSchema();
      await assert.rejects(
        () => pool.query(
          `INSERT INTO external_intelligence (tenant_id, category, claim, source_url, qa_status, provenance_chain)
           VALUES ($1,'other','x','https://example.com/a','SPECULATIVE',$2::jsonb)`,
          [slug, JSON.stringify(VALID_PROVENANCE)],
        ),
        /violates check constraint/,
      );
    });
  },

  'immutability trigger: attempting to UPDATE qa_status after insert throws the exact required error': async () => {
    if (!hasDatabase()) return 'SKIP';
    const { insertExternalIntelligence } = require('../api/intelligence/scouts/store');
    const { getPool } = require('../api/services/db');
    await withDisposableTenant(async (slug) => {
      const row = await insertExternalIntelligence({
        tenantId: slug, category: 'other', claim: 'x', source_url: 'https://example.com/a',
        qa_status: 'VERIFIED', qa_notes: 'ok', provenance_chain: VALID_PROVENANCE,
      });
      const pool = getPool();
      await assert.rejects(
        () => pool.query('UPDATE external_intelligence SET qa_status = $1 WHERE id = $2', ['REJECTED', row.id]),
        /QA fields are immutable after insertion\. Record a new item rather than modifying an existing one\./,
      );
    });
  },

  'immutability trigger: attempting to UPDATE qa_notes or provenance_chain after insert also throws': async () => {
    if (!hasDatabase()) return 'SKIP';
    const { insertInnovationCandidate } = require('../api/intelligence/scouts/store');
    const { getPool } = require('../api/services/db');
    await withDisposableTenant(async (slug) => {
      const row = await insertInnovationCandidate({
        tenantId: slug, idea: 'x', rationale: 'y', context_summary: 'z',
        qa_status: 'SPECULATIVE', qa_notes: 'ok', provenance_chain: VALID_PROVENANCE, context_hash: 'h',
      });
      const pool = getPool();
      await assert.rejects(
        () => pool.query('UPDATE innovation_candidates SET qa_notes = $1 WHERE id = $2', ['tampered', row.id]),
        /QA fields are immutable after insertion/,
      );
      const tamperedChain = [...VALID_PROVENANCE, { stage: 'tampered_extra_entry', timestamp: '2026-01-01T00:00:03.000Z' }];
      await assert.rejects(
        () => pool.query('UPDATE innovation_candidates SET provenance_chain = $1::jsonb WHERE id = $2', [JSON.stringify(tamperedChain), row.id]),
        /QA fields are immutable after insertion/,
      );
    });
  },

  'immutability trigger: superseded_by and decision_status/decision_notes remain freely updatable': async () => {
    if (!hasDatabase()) return 'SKIP';
    const { insertInnovationCandidate, setInnovationDecisionStatus, markSuperseded } = require('../api/intelligence/scouts/store');
    await withDisposableTenant(async (slug) => {
      const original = await insertInnovationCandidate({
        tenantId: slug, idea: 'x', rationale: 'y', context_summary: 'z',
        qa_status: 'SPECULATIVE', qa_notes: 'ok', provenance_chain: VALID_PROVENANCE, context_hash: 'h',
      });
      const correction = await insertInnovationCandidate({
        tenantId: slug, idea: 'x, corrected', rationale: 'y', context_summary: 'z',
        qa_status: 'SPECULATIVE', qa_notes: 'ok', provenance_chain: VALID_PROVENANCE, context_hash: 'h',
        original_item_id: original.id,
      });
      assert.strictEqual(correction.original_item_id, original.id);

      const superseded = await markSuperseded({ tenantId: slug, kind: 'INNOVATION', originalId: original.id, newId: correction.id });
      assert.strictEqual(superseded.superseded_by, correction.id);
      assert.strictEqual(superseded.qa_status, 'SPECULATIVE', 'qa_status must remain untouched by the supersession update');

      const decided = await setInnovationDecisionStatus({
        tenantId: slug, id: correction.id, decisionStatus: 'accepted', decisionNotes: 'looks promising', decisionBy: 'test@auxeira.com',
      });
      assert.strictEqual(decided.decision_status, 'accepted');
      assert.strictEqual(decided.qa_status, 'SPECULATIVE', 'qa_status must remain untouched by a decision update');
    });
  },

  'setInnovationDecisionStatus rejects an invalid decision_status value': async () => {
    if (!hasDatabase()) return 'SKIP';
    const { insertInnovationCandidate, setInnovationDecisionStatus } = require('../api/intelligence/scouts/store');
    await withDisposableTenant(async (slug) => {
      const row = await insertInnovationCandidate({
        tenantId: slug, idea: 'x', rationale: 'y', context_summary: 'z',
        qa_status: 'SPECULATIVE', qa_notes: 'ok', provenance_chain: VALID_PROVENANCE, context_hash: 'h',
      });
      await assert.rejects(
        () => setInnovationDecisionStatus({ tenantId: slug, id: row.id, decisionStatus: 'not-a-real-status' }),
        /Invalid decision_status/,
      );
    });
  },

  'surfaceable reads: external intelligence excludes REJECTED/NEEDS_REVIEW at the SQL level, includes VERIFIED/QUALIFIED': async () => {
    if (!hasDatabase()) return 'SKIP';
    const { insertExternalIntelligence, listSurfaceableExternalIntelligence } = require('../api/intelligence/scouts/store');
    await withDisposableTenant(async (slug) => {
      await insertExternalIntelligence({ tenantId: slug, category: 'other', claim: 'verified claim', source_url: 'https://example.com/v', qa_status: 'VERIFIED', qa_notes: 'ok', provenance_chain: VALID_PROVENANCE });
      await insertExternalIntelligence({ tenantId: slug, category: 'other', claim: 'qualified claim', source_url: 'https://example.com/q', qa_status: 'QUALIFIED', qa_notes: 'ok', provenance_chain: VALID_PROVENANCE });
      await insertExternalIntelligence({ tenantId: slug, category: 'other', claim: 'rejected claim', source_url: 'https://example.com/r', qa_status: 'REJECTED', qa_notes: 'bad', provenance_chain: VALID_PROVENANCE });
      await insertExternalIntelligence({ tenantId: slug, category: 'other', claim: 'needs review claim', source_url: 'https://example.com/n', qa_status: 'NEEDS_REVIEW', qa_notes: 'unsure', provenance_chain: VALID_PROVENANCE });

      const rows = await listSurfaceableExternalIntelligence({ tenantId: slug, limit: 20 });
      const claims = rows.map(r => r.claim);
      assert.ok(claims.includes('verified claim'));
      assert.ok(claims.includes('qualified claim'));
      assert.ok(!claims.includes('rejected claim'), 'REJECTED must never be surfaceable');
      assert.ok(!claims.includes('needs review claim'), 'NEEDS_REVIEW must never be surfaceable');
    });
  },

  'surfaceable reads: innovation candidates include only SPECULATIVE, exclude REJECTED/NEEDS_REVIEW': async () => {
    if (!hasDatabase()) return 'SKIP';
    const { insertInnovationCandidate, listSurfaceableInnovationCandidates } = require('../api/intelligence/scouts/store');
    await withDisposableTenant(async (slug) => {
      await insertInnovationCandidate({ tenantId: slug, idea: 'speculative idea', rationale: 'r', context_summary: 'c', qa_status: 'SPECULATIVE', qa_notes: 'ok', provenance_chain: VALID_PROVENANCE, context_hash: 'h' });
      await insertInnovationCandidate({ tenantId: slug, idea: 'rejected idea', rationale: 'r', context_summary: 'c', qa_status: 'REJECTED', qa_notes: 'bad', provenance_chain: VALID_PROVENANCE, context_hash: 'h' });
      await insertInnovationCandidate({ tenantId: slug, idea: 'needs review idea', rationale: 'r', context_summary: 'c', qa_status: 'NEEDS_REVIEW', qa_notes: 'unsure', provenance_chain: VALID_PROVENANCE, context_hash: 'h' });

      const rows = await listSurfaceableInnovationCandidates({ tenantId: slug, limit: 20 });
      const ideas = rows.map(r => r.idea);
      assert.ok(ideas.includes('speculative idea'));
      assert.ok(!ideas.includes('rejected idea'));
      assert.ok(!ideas.includes('needs review idea'));
    });
  },

  'surfaceable reads: a superseded row is excluded even if its qa_status would otherwise qualify': async () => {
    if (!hasDatabase()) return 'SKIP';
    const { insertExternalIntelligence, listSurfaceableExternalIntelligence, markSuperseded } = require('../api/intelligence/scouts/store');
    await withDisposableTenant(async (slug) => {
      const original = await insertExternalIntelligence({ tenantId: slug, category: 'other', claim: 'original claim', source_url: 'https://example.com/o', qa_status: 'VERIFIED', qa_notes: 'ok', provenance_chain: VALID_PROVENANCE });
      const correction = await insertExternalIntelligence({ tenantId: slug, category: 'other', claim: 'corrected claim', source_url: 'https://example.com/o2', qa_status: 'VERIFIED', qa_notes: 'ok', provenance_chain: VALID_PROVENANCE, original_item_id: original.id });
      await markSuperseded({ tenantId: slug, kind: 'EXTERNAL', originalId: original.id, newId: correction.id });

      const rows = await listSurfaceableExternalIntelligence({ tenantId: slug, limit: 20 });
      const claims = rows.map(r => r.claim);
      assert.ok(!claims.includes('original claim'), 'a superseded row must never surface, even though its own qa_status is VERIFIED');
      assert.ok(claims.includes('corrected claim'));
    });
  },

  'tenant isolation: rows inserted for tenant A are never visible to tenant B': async () => {
    if (!hasDatabase()) return 'SKIP';
    const { insertExternalIntelligence, listSurfaceableExternalIntelligence } = require('../api/intelligence/scouts/store');
    await withDisposableTenant(async (slugA) => {
      await withDisposableTenant(async (slugB) => {
        await insertExternalIntelligence({ tenantId: slugA, category: 'other', claim: 'tenant A claim', source_url: 'https://example.com/a-only', qa_status: 'VERIFIED', qa_notes: 'ok', provenance_chain: VALID_PROVENANCE });
        const rowsB = await listSurfaceableExternalIntelligence({ tenantId: slugB, limit: 20 });
        assert.ok(!rowsB.some(r => r.claim === 'tenant A claim'), "tenant B must never see tenant A's rows");
      });
    });
  },
};
