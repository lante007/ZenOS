'use strict';

// api/intelligence/decision-events/pathways/signal-convergence.js
//
// AUXEIRA V1.2 Decision Intelligence -- Pathway 4: "Convergence of two
// previously separate signals."
//
// Deterministic detection only. No LLM call, no database write -- a pure
// read that returns a description of what fired (or { fired: false }).
// Persisting the resulting Decision Event is the caller's (the engine's)
// responsibility, not this function's.
//
// Convergence condition:
//   Two or more wt_signals rows (the candidate signal passed in, plus every
//   other tenant-relevant, non-dismissed signal within CONVERGENCE_WINDOW_DAYS
//   of it) share the same domain (entity/keyword overlap) AND their combined
//   confidence score meets CONVERGENCE_COMBINED_CONFIDENCE_THRESHOLD, AND at
//   least one signal in the group is individually HIGH or MODERATE
//   confidence. That floor exists so two LOW (1+1=2) or two UNKNOWN (0+0=0)
//   signals can never converge on volume alone, regardless of domain
//   overlap -- weak-signal clusters are noise, not a Decision Event.
//
// "Two" generalises to N>=2: a candidate that domain-matches three prior
// signals forms one four-signal group and fires once, not three separate
// pairwise events. Firing once per cluster with every contributing
// signal_id in inputs is the correct shape -- per-pair events would be
// noise, not signal.
//
// DISMISSED signals (wt_signals.status = 'DISMISSED' OR the tenant's own
// tenant_signal_relevance.status = 'DISMISSED') are excluded from the
// candidate pool entirely -- a human already made that call, and a
// dismissed signal must not be able to drag others into a new event.
//
// priority and confidence (the Decision Event fields) are ALWAYS null in
// this function's return value. Only the assessment layer (Phase 3) may
// set them. (Not to be confused with wt_signals.confidence, the per-signal
// field this pathway reads as an input -- same name, different thing.)

const crypto = require('crypto');
const { resolveTenant, q } = require('../../../memory/util');
const { CONVERGENCE_WINDOW_DAYS, CONVERGENCE_COMBINED_CONFIDENCE_THRESHOLD } = require('../config');

const CONFIDENCE_SCORE = { HIGH: 3, MODERATE: 2, LOW: 1, UNKNOWN: 0 };
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function tokenise(s) {
  return String(s || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];
}

function signalTokenSet(sig) {
  return new Set([...tokenise(sig.title), ...tokenise(sig.summary), ...tokenise(sig.change_description)]);
}

function signalEntitySet(sig) {
  return new Set((sig.entities || []).map(e => String(e.name || e).toLowerCase()));
}

// Domain overlap between two signals: >=2 shared tokens, or a shared
// entity name. Same threshold/style as the signal<->decision and
// signal<->programme matchers in Pathways 1 and 3, applied here
// signal-to-signal. Not shared code -- see the cleanup note in Pathway 3.
function domainOverlap(a, aTokens, aEntities, b) {
  const bTokens = signalTokenSet(b);
  const bEntities = signalEntitySet(b);
  const entityHit = [...aEntities].some(e => bEntities.has(e));
  const tokenOverlap = [...aTokens].filter(t => bTokens.has(t)).length;
  if (entityHit || tokenOverlap >= 2) {
    return { matched: true, entity_hit: entityHit, token_overlap: tokenOverlap };
  }
  return { matched: false };
}

function buildFingerprint(tenantSlug, groupSignalIds) {
  const parts = [tenantSlug, 'SIGNAL_CONVERGENCE', ...groupSignalIds.slice().sort()];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

// detectSignalConvergence(tenantSlug, signal, opts)
//   signal: the candidate public.wt_signals row being evaluated (as
//     returned by getSignalById / listTenantSignals).
//   opts.now: injectable clock for tests; defaults to the real current time.
//
// Returns { fired: false } or the standard fired shape (see Pathway 1).
async function detectSignalConvergence(tenantSlug, signal, { now = new Date() } = {}) {
  if (!signal || !signal.id) {
    throw new Error('detectSignalConvergence requires a signal with an id');
  }

  const tenant = await resolveTenant(tenantSlug);
  const windowStart = new Date(now.getTime() - CONVERGENCE_WINDOW_DAYS * MS_PER_DAY);
  const windowEnd = new Date(now.getTime() + CONVERGENCE_WINDOW_DAYS * MS_PER_DAY);
  const anchor = new Date(signal.observed_at || signal.created_at || now);

  // Tenant-relevant, non-dismissed candidate pool within the window. Not
  // listTenantSignals(): that helper has no since/status filter. Not
  // listSignals(): that helper isn't tenant-scoped. A direct query is the
  // same "pathway owns its own read" pattern already used in Pathways 1
  // and 3 where no existing exported function fit.
  const res = await q(`
    SELECT s.*, r.status AS tenant_status
    FROM public.wt_signals s
    LEFT JOIN public.tenant_signal_relevance r ON r.signal_id = s.id AND r.tenant_id = $1
    WHERE s.id != $2
      AND s.observed_at BETWEEN $3 AND $4
      AND s.status != 'DISMISSED'
      AND COALESCE(r.status, 'NEW') != 'DISMISSED'
  `, [tenant, signal.id, windowStart, windowEnd]);

  const candidateTokens = signalTokenSet(signal);
  const candidateEntities = signalEntitySet(signal);

  const groupMembers = [];
  for (const other of res.rows) {
    if (Math.abs(new Date(other.observed_at).getTime() - anchor.getTime()) > CONVERGENCE_WINDOW_DAYS * MS_PER_DAY) continue;
    const overlap = domainOverlap(signal, candidateTokens, candidateEntities, other);
    if (overlap.matched) {
      groupMembers.push({ signal: other, ...overlap });
    }
  }

  if (!groupMembers.length) {
    return { fired: false };
  }

  const allSignalsInGroup = [signal, ...groupMembers.map(m => m.signal)];
  const combinedConfidenceScore = allSignalsInGroup.reduce(
    (sum, s) => sum + (CONFIDENCE_SCORE[s.confidence] ?? CONFIDENCE_SCORE.UNKNOWN), 0,
  );
  const hasHighOrModerateFloor = allSignalsInGroup.some(s => s.confidence === 'HIGH' || s.confidence === 'MODERATE');

  if (combinedConfidenceScore < CONVERGENCE_COMBINED_CONFIDENCE_THRESHOLD || !hasHighOrModerateFloor) {
    return { fired: false };
  }

  const groupSignalIds = allSignalsInGroup.map(s => s.id);

  const lines = [];
  lines.push(`TRIGGERED BECAUSE: ${allSignalsInGroup.length} previously separate signals converged on the same domain within ${CONVERGENCE_WINDOW_DAYS} days:`);
  lines.push(`  - "${signal.title || signal.id}" (observed ${signal.observed_at}, confidence ${signal.confidence})`);
  for (const m of groupMembers) {
    const basis = m.entity_hit ? 'named the same entity as the first signal' : `shares ${m.token_overlap} keyword(s) with the first signal`;
    lines.push(`  - "${m.signal.title || m.signal.id}" (observed ${m.signal.observed_at}, confidence ${m.signal.confidence}) -- ${basis}.`);
  }
  lines.push(`Combined confidence score: ${combinedConfidenceScore} (meets threshold of ${CONVERGENCE_COMBINED_CONFIDENCE_THRESHOLD}).`);

  return {
    fired: true,
    trigger_explanation: lines.join('\n'),
    trigger_data: {
      pathway: 'SIGNAL_CONVERGENCE',
      window_days: CONVERGENCE_WINDOW_DAYS,
      combined_confidence_threshold: CONVERGENCE_COMBINED_CONFIDENCE_THRESHOLD,
      combined_confidence_score: combinedConfidenceScore,
      group_signal_ids: groupSignalIds,
      signals: allSignalsInGroup.map(s => ({
        signal_id: s.id,
        title: s.title,
        confidence: s.confidence,
        observed_at: s.observed_at,
      })),
    },
    inputs: {
      signal_ids: groupSignalIds,
    },
    fingerprint: buildFingerprint(tenantSlug, groupSignalIds),
    priority: null,
    confidence: null,
  };
}

module.exports = {
  detectSignalConvergence,
  CONFIDENCE_SCORE,
};
