'use strict';

// api/intelligence/decision-events/pathways/outcome-diverges-from-expectation.js
//
// AUXEIRA V1.2 Decision Intelligence -- Pathway 3: "Outcome materially
// diverges from expectation."
//
// Deterministic detection only. No LLM call, no database write -- a pure
// read that returns a description of what fired (or { fired: false }).
// Persisting the resulting Decision Event is the caller's (the engine's)
// responsibility, not this function's.
//
// Convergence condition (both clauses required -- this is an AND, not a
// three-way OR like Pathway 1):
//
//   outcome_status IN ('failed', 'partial')
//     -- 'significantly_different' does not exist in OUTCOME_STATUS
//     -- (api/memory/outcomes.js). 'failed' and 'partial' are the two
//     -- negative-result states; 'succeeded'/'acted_on' are positive,
//     -- 'pending' has no result yet, 'dismissed' means a human already
//     -- made the call -- none of those warrant escalation here.
//   AND
//   ( decision.confidence === 'HIGH'  OR  decision touches a programme
//     investment >= INVESTMENT_THRESHOLD_RAND )
//     -- A diverging outcome on a low-confidence, low-investment decision
//     -- is operationally interesting but not CEO-level. Escalation to a
//     -- Decision Event requires either that the original call was made
//     -- with high confidence (and was still wrong) or that real money is
//     -- at stake. This is what separates governance-relevant noise from
//     -- signal.
//
// Outcomes without a linked decision are excluded -- no expected_outcome
// basis for divergence assessment. This is deliberate, not a gap to be
// filled with a fallback: an outcome with no decision_id is a data-quality
// issue to be surfaced separately, not a Decision Event trigger.
//
// priority and confidence are ALWAYS null in this function's return value.
// Only the assessment layer (Phase 3) may set them.

const crypto = require('crypto');
const { getTenantBySlug } = require('../../../services/tenants');
const { getPool } = require('../../../services/db');

const DIVERGENT_OUTCOME_STATUSES = ['failed', 'partial'];

// Duplicated from api/intelligence/decision-events/pathways/signal-touches-exposure.js
// deliberately, not imported: that file is already-approved code and this
// pathway needs the same threshold applied against decision text rather
// than signal text. FUTURE CLEANUP: generalise both into a single shared
// matcher (e.g. api/intelligence/decision-events/programme-match.js) that
// takes an arbitrary token/entity set rather than a signal- or
// decision-shaped object, and have both pathways call it. Tracked here so
// a future developer sees it in the code, not just in design history.
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

// Local analogue of Pathway 1's matchProgrammesForSignal, matched against a
// decision's text instead of a signal's. Pure read.
async function matchProgrammesForDecision(tenantSlug, decision) {
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

  const decisionTokens = new Set(tokenise(`${decision.decision} ${decision.rationale} ${decision.expected_outcome}`));

  const matches = [];
  for (const r of res.rows) {
    const name = r.canonical_programme_name || r.programme_name || '';
    const nameTokens = new Set(tokenise(name));
    const tokenOverlap = [...decisionTokens].filter(t => nameTokens.has(t)).length;

    if (tokenOverlap >= 2) {
      matches.push({ record: r, token_overlap: tokenOverlap });
    }
  }
  matches.sort((a, b) => b.token_overlap - a.token_overlap);
  return matches;
}

function buildFingerprint(tenantSlug, outcomeId) {
  const parts = [tenantSlug, 'OUTCOME_DIVERGES_FROM_EXPECTATION', outcomeId];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

// detectOutcomeDivergesFromExpectation(tenantSlug, outcome, decision)
//   outcome: a public.intelligence_outcomes row (as returned by listOutcomes/getOutcomeById).
//   decision: the linked public.decisions row (null/undefined if outcome.decision_id is null).
//
// Returns { fired: false } or the standard fired shape (see Pathway 1).
async function detectOutcomeDivergesFromExpectation(tenantSlug, outcome, decision) {
  if (!outcome || !outcome.id) {
    throw new Error('detectOutcomeDivergesFromExpectation requires an outcome with an id');
  }

  if (!DIVERGENT_OUTCOME_STATUSES.includes(outcome.outcome_status)) {
    return { fired: false };
  }

  // No linked decision -- no expected_outcome basis for divergence
  // assessment. Deliberately excluded, not a fallback case.
  if (!decision || !decision.id) {
    return { fired: false };
  }

  const escalatedByConfidence = decision.confidence === 'HIGH';
  const programmeMatches = await matchProgrammesForDecision(tenantSlug, decision);
  const escalatedByInvestment = programmeMatches.length > 0;

  if (!escalatedByConfidence && !escalatedByInvestment) {
    return { fired: false };
  }

  const lines = [];
  lines.push(`TRIGGERED BECAUSE: outcome recorded for decision "${decision.decision}" (owner: ${decision.owner || 'unassigned'}) diverged materially from expectation.`);
  lines.push(`  Outcome status: ${outcome.outcome_status} (expected: "${decision.expected_outcome || 'not recorded'}").`);

  const escalationReasons = [];
  if (escalatedByConfidence) {
    escalationReasons.push('original decision confidence was HIGH');
  }
  if (escalatedByInvestment) {
    for (const m of programmeMatches) {
      const name = m.record.canonical_programme_name || m.record.programme_name;
      escalationReasons.push(`decision touches programme "${name}" with investment R${Number(m.record.total_cost_rand).toLocaleString('en-ZA')}, exceeds R${INVESTMENT_THRESHOLD_RAND.toLocaleString('en-ZA')} threshold`);
    }
  }
  lines.push(`  Escalated because: ${escalationReasons.join('; ')}.`);

  return {
    fired: true,
    trigger_explanation: lines.join('\n'),
    trigger_data: {
      pathway: 'OUTCOME_DIVERGES_FROM_EXPECTATION',
      outcome_id: outcome.id,
      decision_id: decision.id,
      outcome_status: outcome.outcome_status,
      decision_confidence: decision.confidence,
      escalated_by_confidence: escalatedByConfidence,
      escalated_by_investment: escalatedByInvestment,
      programme_matches: programmeMatches.map(m => ({
        record_id: m.record.id,
        programme_name: m.record.canonical_programme_name || m.record.programme_name,
        total_cost_rand: m.record.total_cost_rand,
        token_overlap: m.token_overlap,
      })),
      investment_threshold_rand: INVESTMENT_THRESHOLD_RAND,
    },
    inputs: {
      outcome_ids: [outcome.id],
      decision_ids: [decision.id],
    },
    fingerprint: buildFingerprint(tenantSlug, outcome.id),
    priority: null,
    confidence: null,
  };
}

module.exports = {
  detectOutcomeDivergesFromExpectation,
  DIVERGENT_OUTCOME_STATUSES,
  INVESTMENT_THRESHOLD_RAND,
  // exported for tests only
  matchProgrammesForDecision,
};
