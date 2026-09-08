'use strict';

// api/intelligence/decision-events/pathways/decision-deadline-approaching.js
//
// AUXEIRA V1.2 Decision Intelligence -- Pathway 2: "Decision deadline
// approaching."
//
// Deterministic detection only. No LLM call, no database write -- a pure
// read/compute that returns a description of what fired (or
// { fired: false }). Persisting the resulting Decision Event is the
// caller's (the engine's) responsibility, not this function's.
//
// Convergence condition:
//   decision.status is still open (ACTIVE or REVIEW_RECOMMENDED -- DORMANT
//   decisions are explicitly parked and must not trigger, same boundary as
//   Pathway 1), AND decision.review_date falls within the configured
//   monitoring window of today.
//
// Overdue decisions (review_date already passed, unactioned) are included
// deliberately, not excluded: a missed deadline is more urgent than an
// approaching one, not less. overdue:true / a negative days_until_review
// in trigger_data lets the assessment layer weight it accordingly, and the
// explanation text says so in plain language rather than requiring Emmanuel
// to interpret a negative number.
//
// priority and confidence are ALWAYS null in this function's return value.
// Only the assessment layer (Phase 3) may set them.

const crypto = require('crypto');
const { DEADLINE_WINDOW_DAYS } = require('../config');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysBetween(from, to) {
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.round((b - a) / MS_PER_DAY);
}

function buildFingerprint(tenantSlug, decisionId, reviewDateIso) {
  const parts = [tenantSlug, 'DECISION_DEADLINE_APPROACHING', decisionId, reviewDateIso];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

// detectDecisionDeadlineApproaching(tenantSlug, decision, opts)
//   decision: a public.decisions row (as returned by getDecision/listDecisions).
//   opts.now: injectable clock for tests; defaults to the real current time.
//
// Returns { fired: false } or the standard fired shape (see Pathway 1).
async function detectDecisionDeadlineApproaching(tenantSlug, decision, { now = new Date() } = {}) {
  if (!decision || !decision.id) {
    throw new Error('detectDecisionDeadlineApproaching requires a decision with an id');
  }

  if (decision.status !== 'ACTIVE' && decision.status !== 'REVIEW_RECOMMENDED') {
    return { fired: false };
  }
  if (!decision.review_date) {
    return { fired: false };
  }

  const reviewDate = new Date(decision.review_date);
  if (Number.isNaN(reviewDate.getTime())) {
    return { fired: false };
  }

  const daysUntilReview = daysBetween(now, reviewDate); // negative => overdue
  const overdue = daysUntilReview < 0;

  if (!overdue && daysUntilReview > DEADLINE_WINDOW_DAYS) {
    return { fired: false };
  }

  const reviewDateIso = reviewDate.toISOString().slice(0, 10);
  const absDays = Math.abs(daysUntilReview);
  const timingPhrase = overdue
    ? `which was due ${absDays} day${absDays === 1 ? '' : 's'} ago and has not been actioned`
    : `which is ${daysUntilReview} day${daysUntilReview === 1 ? '' : 's'} from now`;

  const trigger_explanation =
    `TRIGGERED BECAUSE: decision "${decision.decision}" (owner: ${decision.owner || 'unassigned'}, status: ${decision.status}) ` +
    `has a review date of ${reviewDateIso}, ${timingPhrase}, within the configured ${DEADLINE_WINDOW_DAYS}-day monitoring window.`;

  return {
    fired: true,
    trigger_explanation,
    trigger_data: {
      pathway: 'DECISION_DEADLINE_APPROACHING',
      decision_id: decision.id,
      review_date: reviewDateIso,
      days_until_review: daysUntilReview,
      window_days: DEADLINE_WINDOW_DAYS,
      overdue,
    },
    inputs: {
      decision_ids: [decision.id],
    },
    fingerprint: buildFingerprint(tenantSlug, decision.id, reviewDateIso),
    priority: null,
    confidence: null,
  };
}

module.exports = {
  detectDecisionDeadlineApproaching,
};
