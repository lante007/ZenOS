'use strict';

// api/intelligence/decision-events/pathways/reversible-becoming-irreversible.js
//
// AUXEIRA V1.2 Decision Intelligence -- Pathway 6: "Reversible decision
// becoming irreversible."
//
// *** THIS PATHWAY FIRES ON NOTHING IN THE CURRENT DATA SET. ***
// No decision in the corpus has ever had a point-of-no-return date recorded.
// public.decisions has no reversibility column and no act-by/lock-in date
// column distinct from review_date (already Pathway 2's). The only place
// such a date could exist is as a new, optional key inside an individual
// revisit_conditions element (an existing JSONB array, but nothing has ever
// written one of the accepted keys below into it -- createDecision persists
// revisit_conditions verbatim from whatever the caller sends, and no route
// or UI currently sends this key). This pathway is architecturally complete
// and will fire automatically, with no code change, the moment a decision
// is created or updated with one of ACCEPTED_IRREVERSIBLE_DATE_KEYS inside
// a revisit_conditions entry. Until then, every call correctly returns
// { fired: false }. This is not a bug -- see the design conversation dated
// 2026-09-08 for the research confirming this gap before writing this file.
//
// Deterministic detection only. No LLM call, no database write -- a pure
// read that returns a description of what fired (or { fired: false }).
// Persisting the resulting Decision Event is the caller's (the engine's)
// responsibility, not this function's.
//
// Convergence condition:
//   The incoming signal matches a decision via matchDecisionsForSignal
//   (api/memory/decisions.js, reused unmodified -- same function Pathway 1
//   already reuses for its Half A), AND that match is a CONDITION_MATCH
//   (not a loose TEXTUAL_OVERLAP -- see below for why), AND the decision's
//   status is ACTIVE (the one status meaning "currently open and
//   reversible" -- DORMANT is explicitly parked, same boundary as Pathways
//   1 and 2; REVIEW_RECOMMENDED is already surfaced through the existing
//   review flow and firing here too would be a duplicate event for a
//   decision already in the review queue), AND the specific
//   revisit_conditions entry that matched carries one of
//   ACCEPTED_IRREVERSIBLE_DATE_KEYS, parseable as a date, within
//   REVERSIBILITY_WINDOW_DAYS of today.
//
// Only CONDITION_MATCH is eligible, not TEXTUAL_OVERLAP: a point-of-no-return
// date belongs to a specific stated revisit_conditions entry, and a loose
// textual overlap with the decision's own text has no such entry to read the
// date from. Firing on a TEXTUAL_OVERLAP match here would mean attaching a
// decision-level date lookup to a signal that never actually triggered any
// of the decision's own stated conditions -- not the same fact.
//
// Overdue handling, deliberate asymmetry with Pathway 5: already-passed
// point-of-no-return dates ARE included, not excluded. Pathway 5 excludes
// closed opportunity windows because nothing is actionable once an external
// window shuts. Here, a decision silently crossing its own stated
// point-of-no-return with no Decision Event raised is itself the fact worth
// recording -- a governance/decision-hygiene signal, not noise. The
// trigger_explanation says so explicitly for overdue cases (see below).
//
// priority and confidence (the Decision Event fields) are ALWAYS null in
// this function's return value. Only the assessment layer (Phase 3) may
// set them.

const crypto = require('crypto');
const { matchDecisionsForSignal } = require('../../../memory/decisions');
const { REVERSIBILITY_WINDOW_DAYS } = require('../config');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Brand-new convention, no precedent in this codebase (unlike Pathway 5's
// wt_signals.raw, which is at least an existing-but-unused JSONB column).
// Small, documented accepted-alias list, same rationale as Pathway 5: until
// a real producer exists we don't know which key name it will reach for.
const ACCEPTED_IRREVERSIBLE_DATE_KEYS = [
  'irreversible_after',
  'point_of_no_return',
  'locks_in_at',
  'becomes_irreversible_at',
  'irreversible_date',
];

function daysBetween(from, to) {
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.round((b - a) / MS_PER_DAY);
}

// Returns { key, date } for the first accepted key found on a single
// revisit_conditions element with a parseable date value, or null. First
// match wins, same convention as Pathway 5's extractClosingDate.
function extractIrreversibleDate(condition) {
  if (!condition || typeof condition !== 'object') return null;

  for (const key of ACCEPTED_IRREVERSIBLE_DATE_KEYS) {
    if (condition[key] === undefined || condition[key] === null || condition[key] === '') continue;
    const date = new Date(condition[key]);
    if (!Number.isNaN(date.getTime())) {
      return { key, date };
    }
  }
  return null;
}

function buildFingerprint(tenantSlug, eligible) {
  // Deliberately NOT signal-scoped: the underlying fact (this decision has
  // this point-of-no-return date) belongs to the decision, not to whichever
  // signal happened to reveal it. A second, later signal matching the same
  // decision/condition/date must not produce a second event.
  const parts = [
    tenantSlug,
    'REVERSIBLE_BECOMING_IRREVERSIBLE',
    ...eligible
      .map(e => `${e.decision.id}:${e.key}:${e.date.toISOString().slice(0, 10)}`)
      .sort(),
  ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

// detectReversibleBecomingIrreversible(tenantSlug, signal, opts)
//   signal: a public.wt_signals row (as returned by getSignalById /
//     listTenantSignals) -- passed through unmodified to
//     matchDecisionsForSignal.
//   opts.now: injectable clock for tests; defaults to the real current time.
//
// Returns { fired: false } or the standard fired shape (see Pathway 1).
async function detectReversibleBecomingIrreversible(tenantSlug, signal, { now = new Date() } = {}) {
  if (!signal || !signal.id) {
    throw new Error('detectReversibleBecomingIrreversible requires a signal with an id');
  }

  const matches = (await matchDecisionsForSignal(tenantSlug, signal))
    .filter(m => m.decision.status === 'ACTIVE' && m.strength === 'CONDITION_MATCH');

  const eligible = [];
  for (const m of matches) {
    for (const hit of m.matched_conditions) {
      const fullCondition = (m.decision.revisit_conditions || [])
        .find(c => (c.description || null) === hit.condition);
      if (!fullCondition) continue;

      const found = extractIrreversibleDate(fullCondition);
      if (!found) continue;

      const daysUntil = daysBetween(now, found.date); // negative => already passed
      if (daysUntil > REVERSIBILITY_WINDOW_DAYS) continue;

      eligible.push({
        decision: m.decision,
        condition_description: hit.condition,
        key: found.key,
        date: found.date,
        daysUntil,
        overdue: daysUntil < 0,
      });
    }
  }

  if (!eligible.length) {
    return { fired: false };
  }

  const decisionIds = [...new Set(eligible.map(e => e.decision.id))];

  const lines = [];
  lines.push(`TRIGGERED BECAUSE: signal "${signal.title || signal.id}" matched ${eligible.length} decision condition(s) whose stated reversibility window has closed or is closing:`);
  for (const e of eligible) {
    const dateIso = e.date.toISOString().slice(0, 10);
    if (e.overdue) {
      lines.push(`  - decision "${e.decision.decision}" (owner: ${e.decision.owner || 'unassigned'}) became irreversible ${Math.abs(e.daysUntil)} day(s) ago (${dateIso}, condition: "${e.condition_description || 'unnamed condition'}", via revisit_conditions.${e.key}) without a recorded Decision Event.`);
    } else {
      lines.push(`  - decision "${e.decision.decision}" (owner: ${e.decision.owner || 'unassigned'}) becomes irreversible in ${e.daysUntil} day(s) (${dateIso}, condition: "${e.condition_description || 'unnamed condition'}", via revisit_conditions.${e.key}), within the configured ${REVERSIBILITY_WINDOW_DAYS}-day monitoring window.`);
    }
  }

  return {
    fired: true,
    trigger_explanation: lines.join('\n'),
    trigger_data: {
      pathway: 'REVERSIBLE_BECOMING_IRREVERSIBLE',
      signal_id: signal.id,
      window_days: REVERSIBILITY_WINDOW_DAYS,
      matches: eligible.map(e => ({
        decision_id: e.decision.id,
        condition_description: e.condition_description,
        irreversible_date: e.date.toISOString().slice(0, 10),
        irreversible_date_source_key: e.key,
        days_until_irreversible: e.daysUntil,
        overdue: e.overdue,
      })),
    },
    inputs: {
      signal_ids: [signal.id],
      decision_ids: decisionIds,
    },
    fingerprint: buildFingerprint(tenantSlug, eligible),
    priority: null,
    confidence: null,
  };
}

module.exports = {
  detectReversibleBecomingIrreversible,
  ACCEPTED_IRREVERSIBLE_DATE_KEYS,
  // exported for tests only
  extractIrreversibleDate,
};
