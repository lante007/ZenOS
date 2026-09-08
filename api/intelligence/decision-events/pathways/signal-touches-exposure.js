'use strict';

// api/intelligence/decision-events/pathways/signal-touches-exposure.js
//
// AUXEIRA V1.2 Decision Intelligence -- Pathway 1: "External signal touches
// active exposure."
//
// Deterministic detection only. This function NEVER calls an LLM and NEVER
// writes to the database -- it is a pure read that returns a description of
// what fired (or { fired: false }). Persisting the resulting Decision Event
// is the caller's (the engine's) responsibility, not this function's.
//
// Convergence condition (either half firing is sufficient):
//   Half A: the signal domain-matches an outstanding decision
//           (status ACTIVE or REVIEW_RECOMMENDED -- DORMANT decisions are
//           explicitly parked and must not trigger).
//   Half B: the signal domain-matches an active programme investment
//           (an intelligence_records row whose total_cost_rand meets or
//           exceeds INVESTMENT_THRESHOLD_RAND).
//
// "Domain" has no formal taxonomy anywhere in this system. Half A reuses
// the existing, shared matchDecisionsForSignal() entity/keyword-overlap
// matcher unmodified. Half B is a small, analogous overlap matcher against
// programme names, since no equivalent existed for programme investments.
//
// priority and confidence are ALWAYS null in this function's return value.
// Only the assessment layer (Phase 3) may set them. This is enforced by
// shape, not just convention, so a future edit cannot quietly bypass
// assessment by setting either field here.

const crypto = require('crypto');
const { matchDecisionsForSignal } = require('../../../memory/decisions');
const { getTenantBySlug } = require('../../../services/tenants');
const { getPool } = require('../../../services/db');

// Same convention as api/services/priority-score.js's INVESTMENT_CAP_RAND --
// reused deliberately rather than inventing a second, competing number.
const INVESTMENT_THRESHOLD_RAND = 25_000_000;

function tokenise(s) {
  return String(s || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];
}

function assertSchema(schema) {
  if (!/^[a-z][a-z0-9_]*$/.test(schema || '')) {
    throw new Error(`Unsafe tenant schema: ${schema}`);
  }
  return schema;
}

// Half B. Not exported -- an internal analogue of matchDecisionsForSignal,
// scoped to this pathway only. Pure read.
async function matchProgrammesForSignal(tenantSlug, signal) {
  const pool = getPool();
  if (!pool) return [];

  const tenant = await getTenantBySlug(tenantSlug);
  const schema = assertSchema((tenant && tenant.db_schema) || tenantSlug);

  const res = await pool.query(
    `SELECT id, programme_name, canonical_programme_name, total_cost_rand, programme_area, year
     FROM ${schema}.intelligence_records
     WHERE total_cost_rand >= $1`,
    [INVESTMENT_THRESHOLD_RAND],
  );

  const signalTokens = new Set([
    ...tokenise(signal.title), ...tokenise(signal.summary), ...tokenise(signal.change_description),
  ]);
  const signalEntities = new Set((signal.entities || []).map(e => String(e.name || e).toLowerCase()));

  const matches = [];
  for (const r of res.rows) {
    const name = r.canonical_programme_name || r.programme_name || '';
    const nameTokens = new Set(tokenise(name));
    const nameLower = name.toLowerCase();

    const entityHit = signalEntities.has(nameLower);
    const tokenOverlap = [...signalTokens].filter(t => nameTokens.has(t)).length;

    if (entityHit || tokenOverlap >= 2) {
      matches.push({
        record: r,
        entity_hit: entityHit,
        token_overlap: tokenOverlap,
        strength: entityHit ? 'ENTITY_MATCH' : 'TEXTUAL_OVERLAP',
      });
    }
  }
  matches.sort((a, b) => (b.entity_hit - a.entity_hit) || (b.token_overlap - a.token_overlap));
  return matches;
}

function buildFingerprint(tenantSlug, signalId, decisionIds, programmeIds) {
  const parts = [
    tenantSlug,
    'SIGNAL_TOUCHES_EXPOSURE',
    signalId,
    ...decisionIds.slice().sort(),
    ...programmeIds.slice().sort(),
  ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

// detectSignalTouchesExposure(tenantSlug, signal)
//   signal: a public.wt_signals row shaped { id, title, summary,
//     change_description, entities, observed_at, ... } (as returned by
//     getSignalById / listTenantSignals).
//
// Returns { fired: false } or:
//   {
//     fired: true,
//     trigger_explanation: string,   // human-readable "TRIGGERED BECAUSE:" text
//     trigger_data: object,          // machine-readable: which halves fired, what matched
//     inputs: { signal_ids, decision_ids, programme_record_ids },
//     fingerprint: string,
//     priority: null,                // set by assessment only, never here
//     confidence: null,              // set by assessment only, never here
//   }
async function detectSignalTouchesExposure(tenantSlug, signal) {
  if (!signal || !signal.id) {
    throw new Error('detectSignalTouchesExposure requires a signal with an id');
  }

  const decisionMatches = (await matchDecisionsForSignal(tenantSlug, signal))
    .filter(m => m.decision.status === 'ACTIVE' || m.decision.status === 'REVIEW_RECOMMENDED');

  const programmeMatches = await matchProgrammesForSignal(tenantSlug, signal);

  if (!decisionMatches.length && !programmeMatches.length) {
    return { fired: false };
  }

  const decisionIds = decisionMatches.map(m => m.decision.id);
  const programmeIds = programmeMatches.map(m => String(m.record.id));

  const lines = [];
  lines.push(`TRIGGERED BECAUSE: signal "${signal.title || signal.id}" (observed ${signal.observed_at || signal.created_at || 'unknown date'})`);

  for (const m of decisionMatches) {
    const basis = m.strength === 'CONDITION_MATCH'
      ? `matched revisit condition(s): ${m.matched_conditions.map(c => c.condition || 'unnamed condition').join(', ')}`
      : `shares ${m.loose_overlap} keyword(s) with the decision text`;
    lines.push(`  - touches outstanding decision "${m.decision.decision}" (status: ${m.decision.status}, owner: ${m.decision.owner || 'unassigned'}) -- ${basis}.`);
  }

  for (const m of programmeMatches) {
    const name = m.record.canonical_programme_name || m.record.programme_name;
    const basis = m.strength === 'ENTITY_MATCH'
      ? 'named directly in the signal'
      : `shares ${m.token_overlap} keyword(s) with the signal`;
    lines.push(`  - touches active programme "${name}" (investment: R${Number(m.record.total_cost_rand).toLocaleString('en-ZA')}, exceeds R${INVESTMENT_THRESHOLD_RAND.toLocaleString('en-ZA')} threshold) -- ${basis}.`);
  }

  if (programmeMatches.length) {
    lines.push('  Note: active programme status is inferred from investment above threshold. No explicit active/inactive flag exists in the corpus.');
  }

  return {
    fired: true,
    trigger_explanation: lines.join('\n'),
    trigger_data: {
      pathway: 'SIGNAL_TOUCHES_EXPOSURE',
      signal_id: signal.id,
      decision_matches: decisionMatches.map(m => ({
        decision_id: m.decision.id,
        strength: m.strength,
        matched_conditions: m.matched_conditions,
        loose_overlap: m.loose_overlap,
      })),
      programme_matches: programmeMatches.map(m => ({
        record_id: m.record.id,
        programme_name: m.record.canonical_programme_name || m.record.programme_name,
        total_cost_rand: m.record.total_cost_rand,
        strength: m.strength,
        token_overlap: m.token_overlap,
      })),
      investment_threshold_rand: INVESTMENT_THRESHOLD_RAND,
    },
    inputs: {
      signal_ids: [signal.id],
      decision_ids: decisionIds,
      programme_record_ids: programmeIds,
    },
    fingerprint: buildFingerprint(tenantSlug, signal.id, decisionIds, programmeIds),
    priority: null,
    confidence: null,
  };
}

module.exports = {
  detectSignalTouchesExposure,
  INVESTMENT_THRESHOLD_RAND,
  // exported for tests only
  matchProgrammesForSignal,
};
