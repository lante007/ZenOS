'use strict';

// api/intelligence/decision-events/orchestrator.js
//
// AUXEIRA V1.2 Decision Intelligence -- Orchestration layer.
//
// This module's ONLY responsibilities, per the approved design (design
// conversation dated 2026-09-08):
//   1. Invoke each of the six deterministic pathways, unmodified, against
//      its own natural candidate pool.
//   2. Validate that a fired result conforms to the shared pathway
//      contract (has a fingerprint and an explanation; priority/confidence
//      are still null).
//   3. Attach authoritative tenant/pathway identity -- identity the
//      pathway itself never sets.
//   4. Deduplicate (within a tick, defensively) and persist via
//      ON CONFLICT (tenant_id, trigger_pathway, fingerprint) DO NOTHING.
//
// This module NEVER:
//   - calls an LLM
//   - reinterprets a pathway's fired/not-fired decision
//   - ranks, scores, or judges the importance/urgency/CEO-relevance of a
//     candidate
//   - generates a recommendation
//   - performs economic/actuarial reasoning
//   - decides what a human should see
//   - modifies a pathway's own semantics (each pathway is called with its
//     existing signature, exactly as approved when it was written)
//   - makes one pathway's invocation depend on another pathway's result
//
// A persisted public.decision_events row means only: "a deterministic rule
// fired." status='new' is a WORKFLOW state -- it marks a row as not yet
// picked up by the (not-yet-built) assessment stage. It does NOT mean
// "important," "urgent," or "the CEO should see this." Those judgements
// belong entirely to later phases (Phase 3 assessment onward), which this
// module does not implement and does not anticipate beyond the read-only
// handoff contract described in the design conversation (Phase 3 will
// SELECT ... WHERE status = 'new'; this module's job ends at INSERT).
//
// No "since last tick" cursor exists (v1, deliberate): every tick
// re-evaluates the full non-terminal candidate pool via each existing
// listX() function, up to orchestrator-config's candidateFetchLimit. This
// is intentionally the simplest correct thing, not a scalability strategy
// -- it relies on each pathway's own fingerprint making repeat evaluation
// of an unchanged fact a cheap no-op. Revisit at real scale.
//
// GAPS: no pathway here consumes an evidence-gaps input. This is not an
// oversight -- per explicit instruction, gaps are treated as future
// assessment context, not a seventh detection trigger, in this increment.
// This module does not claim otherwise.

const { getPool } = require('../../services/db');
const { listTenants } = require('../../services/tenants');
const { listSignals } = require('../../memory/watchtower');
const { listDecisions, getDecision } = require('../../memory/decisions');
const { listOutcomes } = require('../../memory/outcomes');

const { detectSignalTouchesExposure } = require('./pathways/signal-touches-exposure');
const { detectDecisionDeadlineApproaching } = require('./pathways/decision-deadline-approaching');
const { detectOutcomeDivergesFromExpectation } = require('./pathways/outcome-diverges-from-expectation');
const { detectSignalConvergence } = require('./pathways/signal-convergence');
const { detectOpportunityWindowClosing } = require('./pathways/opportunity-window-closing');
const { detectReversibleBecomingIrreversible } = require('./pathways/reversible-becoming-irreversible');

const { candidateFetchLimit } = require('./orchestrator-config');

// Static function -> trigger_pathway mapping. Deliberately not derived from
// each pathway's own trigger_data.pathway string (which exists only for
// that pathway's own explanation text) -- the orchestrator owns identity
// attachment itself, per the approved design, so a future typo inside a
// pathway's trigger_data can never desync from the decision_events CHECK
// constraint.
const SIGNAL_PATHWAYS = [
  { key: 'SIGNAL_TOUCHES_EXPOSURE', call: (tenant, signal) => detectSignalTouchesExposure(tenant, signal) },
  { key: 'SIGNAL_CONVERGENCE', call: (tenant, signal, opts) => detectSignalConvergence(tenant, signal, opts) },
  { key: 'OPPORTUNITY_WINDOW_CLOSING', call: (tenant, signal, opts) => detectOpportunityWindowClosing(tenant, signal, opts) },
  { key: 'REVERSIBLE_BECOMING_IRREVERSIBLE', call: (tenant, signal, opts) => detectReversibleBecomingIrreversible(tenant, signal, opts) },
];

// Minimal, mechanical contract check. This is validation, not
// interpretation: it confirms the shape the orchestrator itself depends on
// (fingerprint, explanation, and the priority/confidence-must-stay-null
// invariant every pathway already promises) is actually present. It does
// not evaluate whether the content is "right."
function contractViolation(result) {
  if (!result.fingerprint || typeof result.fingerprint !== 'string') return 'missing or invalid fingerprint';
  if (!result.trigger_explanation || typeof result.trigger_explanation !== 'string') return 'missing or invalid trigger_explanation';
  if (result.priority !== null) return `priority must be null at detection time, got ${JSON.stringify(result.priority)}`;
  if (result.confidence !== null) return `confidence must be null at detection time, got ${JSON.stringify(result.confidence)}`;
  return null;
}

// Persists one fired, contract-valid candidate. Returns 'inserted',
// 'deduped_in_tick', or throws (caller records the error and continues --
// see runOnce). ON CONFLICT DO NOTHING is the entire idempotency
// mechanism: an unchanged fact rediscovered on a later tick is a no-op by
// design (see file header); this function never UPDATEs an existing row.
async function persistCandidate(pool, tenantSlug, trigger_pathway, result, seenThisTick) {
  const dedupeKey = `${tenantSlug}::${trigger_pathway}::${result.fingerprint}`;
  if (seenThisTick.has(dedupeKey)) {
    return 'deduped_in_tick';
  }
  seenThisTick.add(dedupeKey);

  const insertRes = await pool.query(
    `INSERT INTO public.decision_events
       (tenant_id, trigger_pathway, trigger_explanation, trigger_data, fingerprint, inputs, status, priority)
     VALUES ($1, $2, $3, $4, $5, $6, 'new', NULL)
     ON CONFLICT (tenant_id, trigger_pathway, fingerprint) DO NOTHING
     RETURNING id`,
    [
      tenantSlug,
      trigger_pathway,
      result.trigger_explanation,
      JSON.stringify(result.trigger_data || {}),
      result.fingerprint,
      JSON.stringify(result.inputs || {}),
    ],
  );
  return insertRes.rows.length ? 'inserted' : 'conflict_no_op';
}

// Evaluates one (pathway, candidate object) pair: calls the pathway,
// validates the contract if fired, persists if valid. Every failure mode
// (pathway throws, contract violation, DB error) is caught here and
// recorded on stats -- never thrown up to the tick loop, so one bad
// candidate can never abort evaluation of the rest.
async function evaluateAndPersist(pool, trigger_pathway, tenantSlug, callDetect, stats, seenThisTick) {
  stats.candidates_evaluated += 1;

  let result;
  try {
    result = await callDetect();
  } catch (err) {
    stats.errors.push({ scope: 'pathway', trigger_pathway, tenant: tenantSlug, message: err.message });
    return;
  }

  if (!result || result.fired !== true) return;

  const violation = contractViolation(result);
  if (violation) {
    stats.errors.push({ scope: 'contract_violation', trigger_pathway, tenant: tenantSlug, message: violation });
    return;
  }

  stats.events_fired += 1;

  try {
    const outcome = await persistCandidate(pool, tenantSlug, trigger_pathway, result, seenThisTick);
    if (outcome === 'inserted') stats.events_inserted += 1;
    else if (outcome === 'deduped_in_tick') stats.events_deduped_in_tick += 1;
    else stats.events_conflict_no_op += 1; // already existed from a prior tick
  } catch (err) {
    stats.errors.push({ scope: 'persist', trigger_pathway, tenant: tenantSlug, message: err.message });
  }
}

// runOnce(opts)
//   opts.now: injectable clock for tests; defaults to the real current time.
//   opts.pool: injectable pg pool for tests; defaults to getPool().
//
// Returns a stats object describing the tick. Never throws -- every
// failure mode is caught and recorded in stats.errors so a single bad
// tenant, pathway, or candidate can never abort the whole run.
async function runOnce({ now = new Date(), pool: injectedPool } = {}) {
  const stats = {
    started_at: now.toISOString(),
    tenants_processed: 0,
    candidates_evaluated: 0,
    events_fired: 0,
    events_inserted: 0,
    events_deduped_in_tick: 0,
    events_conflict_no_op: 0,
    outcomes_skipped_no_decision: 0,
    errors: [],
  };

  const pool = injectedPool || getPool();
  if (!pool) {
    stats.errors.push({ scope: 'startup', message: 'Database is not configured' });
    stats.completed_at = new Date().toISOString();
    return stats;
  }

  let tenants;
  try {
    tenants = (await listTenants()).filter(t => t.is_active !== false);
  } catch (err) {
    stats.errors.push({ scope: 'listTenants', message: err.message });
    stats.completed_at = new Date().toISOString();
    return stats;
  }

  // Signals are global (public.wt_signals has no tenant_id), fetched once
  // per tick, then correctly re-evaluated once per active tenant below --
  // tenant-scoped relevance/dismissal state genuinely differs per tenant,
  // so this is required for correctness, not redundant work.
  let signals = [];
  try {
    signals = await listSignals({ limit: candidateFetchLimit });
  } catch (err) {
    stats.errors.push({ scope: 'listSignals', message: err.message });
  }

  const seenThisTick = new Set();

  for (const tenant of tenants) {
    const tenantSlug = tenant.slug;
    stats.tenants_processed += 1;

    // --- Signal-driven pathways: 1, 4, 5, 6 ---
    for (const signal of signals) {
      for (const pathway of SIGNAL_PATHWAYS) {
        await evaluateAndPersist(
          pool, pathway.key, tenantSlug,
          () => pathway.call(tenantSlug, signal, { now }),
          stats, seenThisTick,
        );
      }
    }

    // --- Decision-driven pathway: 2 ---
    let decisions = [];
    try {
      decisions = await listDecisions(tenantSlug, {
        statuses: ['ACTIVE', 'REVIEW_RECOMMENDED'],
        limit: candidateFetchLimit,
      });
    } catch (err) {
      stats.errors.push({ scope: 'listDecisions', tenant: tenantSlug, message: err.message });
    }
    for (const decision of decisions) {
      await evaluateAndPersist(
        pool, 'DECISION_DEADLINE_APPROACHING', tenantSlug,
        () => detectDecisionDeadlineApproaching(tenantSlug, decision, { now }),
        stats, seenThisTick,
      );
    }

    // --- Outcome-driven pathway: 3 (decision looked up per-outcome, not
    // by the pathway itself -- matches its existing (tenant, outcome,
    // decision) signature exactly) ---
    let outcomes = [];
    try {
      outcomes = await listOutcomes(tenantSlug, { limit: candidateFetchLimit });
    } catch (err) {
      stats.errors.push({ scope: 'listOutcomes', tenant: tenantSlug, message: err.message });
    }
    for (const outcome of outcomes) {
      if (!outcome.decision_id) continue;

      let decision;
      try {
        decision = await getDecision(tenantSlug, outcome.decision_id);
      } catch (err) {
        stats.errors.push({ scope: 'getDecision', tenant: tenantSlug, outcome_id: outcome.id, message: err.message });
        continue;
      }
      if (!decision) {
        stats.outcomes_skipped_no_decision += 1;
        continue;
      }

      await evaluateAndPersist(
        pool, 'OUTCOME_DIVERGES_FROM_EXPECTATION', tenantSlug,
        () => detectOutcomeDivergesFromExpectation(tenantSlug, outcome, decision),
        stats, seenThisTick,
      );
    }
  }

  stats.completed_at = new Date().toISOString();
  return stats;
}

module.exports = { runOnce };
