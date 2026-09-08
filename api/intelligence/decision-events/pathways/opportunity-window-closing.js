'use strict';

// api/intelligence/decision-events/pathways/opportunity-window-closing.js
//
// AUXEIRA V1.2 Decision Intelligence -- Pathway 5: "Opportunity window
// closing."
//
// *** THIS PATHWAY FIRES ON NOTHING IN THE CURRENT DATA SET. ***
// No existing source populates a machine-readable closing date anywhere in
// the schema -- not on public.wt_signals, not on intelligence_records, not
// on external_intelligence. The only place a closing date could exist today
// is inside wt_signals.raw (an untyped JSONB column), and nothing currently
// writes one there (observe.js only ever writes change-diff metadata into
// it). This pathway is architecturally complete and will fire automatically,
// with no code change, the moment a compatible source starts populating one
// of the accepted keys below. Until then, every call correctly returns
// { fired: false }. This is not a bug -- see the design conversation dated
// 2026-09-08 for the research confirming this gap before writing this file.
//
// Deterministic detection only. No LLM call, no database write, no query at
// all -- this pathway is a pure computation over the single signal object
// the engine passes in (same "engine fetches, pathway computes" shape as
// Pathway 2). Persisting the resulting Decision Event is the caller's (the
// engine's) responsibility, not this function's.
//
// Convergence condition:
//   signal.raw contains one of ACCEPTED_CLOSING_DATE_KEYS, parseable as a
//   date, AND that date is in the future (already-closed windows are
//   excluded -- see below) AND within OPPORTUNITY_WINDOW_DAYS of today.
//
// No signal_type gate: if a structured closing date is present in raw at
// all, that is deterministic enough on its own. Gating on the free-text
// signal_type convention (e.g. requiring 'funding_change') would add a
// maintenance burden as new source types are added, for no real precision
// gain.
//
// Asymmetry with Pathway 2, deliberate: Pathway 2 fires on already-overdue
// decisions because a missed internal deadline is still actionable -- you
// can still decide. This pathway excludes already-closed windows because
// the external condition has already passed -- there is nothing left to
// act on. A Decision Event for a closed opportunity would be noise, not
// urgency.
//
// DISMISSED signals (wt_signals.status = 'DISMISSED' OR this tenant's own
// tenant_signal_relevance.status = 'DISMISSED') are excluded, same as
// Pathway 4 -- a human already made that call, and this pathway must
// respect it. The input signal is expected to carry a `tenant_status`
// field when fetched via listTenantSignals() (which LEFT JOINs
// tenant_signal_relevance and aliases its status column that way); if the
// field is absent, it defaults to 'NEW' (not dismissed) rather than
// throwing, matching the same default the underlying SQL LEFT JOIN uses
// elsewhere in this codebase.
//
// priority and confidence (the Decision Event fields) are ALWAYS null in
// this function's return value. Only the assessment layer (Phase 3) may
// set them.

const crypto = require('crypto');
const { OPPORTUNITY_WINDOW_DAYS } = require('../config');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Small, documented set of accepted key names. Not centralised/generalised
// into a schema, deliberately: until a real producer exists, we don't know
// which key name it will actually use, so a short accepted-alias list is
// more honest than inventing a taxonomy for a field nothing writes yet.
const ACCEPTED_CLOSING_DATE_KEYS = [
  'closing_date',
  'deadline',
  'application_deadline',
  'window_closes_at',
  'opportunity_closes_at',
];

function daysBetween(from, to) {
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.round((b - a) / MS_PER_DAY);
}

// Returns { key, date } for the first accepted key found with a parseable
// date value, or null if none present/parseable. First match wins -- if a
// future producer somehow writes more than one of these keys, that's a
// producer-side inconsistency to fix upstream, not something this pathway
// should silently arbitrate between.
function extractClosingDate(signal) {
  const raw = signal && signal.raw;
  if (!raw || typeof raw !== 'object') return null;

  for (const key of ACCEPTED_CLOSING_DATE_KEYS) {
    if (raw[key] === undefined || raw[key] === null || raw[key] === '') continue;
    const date = new Date(raw[key]);
    if (!Number.isNaN(date.getTime())) {
      return { key, date };
    }
  }
  return null;
}

function buildFingerprint(tenantSlug, signalId, closingDateIso) {
  const parts = [tenantSlug, 'OPPORTUNITY_WINDOW_CLOSING', signalId, closingDateIso];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

// detectOpportunityWindowClosing(tenantSlug, signal, opts)
//   signal: a public.wt_signals row (as returned by getSignalById /
//     listTenantSignals). If fetched via listTenantSignals, its
//     `tenant_status` field (LEFT JOIN alias for
//     tenant_signal_relevance.status) is honoured for the DISMISSED check;
//     if absent, treated as 'NEW'.
//   opts.now: injectable clock for tests; defaults to the real current time.
//
// Returns { fired: false } or the standard fired shape (see Pathway 1).
async function detectOpportunityWindowClosing(tenantSlug, signal, { now = new Date() } = {}) {
  if (!signal || !signal.id) {
    throw new Error('detectOpportunityWindowClosing requires a signal with an id');
  }

  if (signal.status === 'DISMISSED') {
    return { fired: false };
  }
  if ((signal.tenant_status || 'NEW') === 'DISMISSED') {
    return { fired: false };
  }

  const found = extractClosingDate(signal);
  if (!found) {
    return { fired: false };
  }

  const daysUntilClosing = daysBetween(now, found.date);

  // Already closed -- excluded deliberately (see file header). Not overdue
  // in the Pathway 2 sense; there is nothing actionable left.
  if (daysUntilClosing < 0) {
    return { fired: false };
  }
  if (daysUntilClosing > OPPORTUNITY_WINDOW_DAYS) {
    return { fired: false };
  }

  const closingDateIso = found.date.toISOString().slice(0, 10);

  const trigger_explanation =
    `TRIGGERED BECAUSE: signal "${signal.title || signal.id}" carries an opportunity closing date of ` +
    `${closingDateIso} (from raw.${found.key}), ${daysUntilClosing} day${daysUntilClosing === 1 ? '' : 's'} from now, ` +
    `within the configured ${OPPORTUNITY_WINDOW_DAYS}-day monitoring window.`;

  return {
    fired: true,
    trigger_explanation,
    trigger_data: {
      pathway: 'OPPORTUNITY_WINDOW_CLOSING',
      signal_id: signal.id,
      closing_date: closingDateIso,
      closing_date_source_key: found.key,
      days_until_closing: daysUntilClosing,
      window_days: OPPORTUNITY_WINDOW_DAYS,
    },
    inputs: {
      signal_ids: [signal.id],
    },
    fingerprint: buildFingerprint(tenantSlug, signal.id, closingDateIso),
    priority: null,
    confidence: null,
  };
}

module.exports = {
  detectOpportunityWindowClosing,
  ACCEPTED_CLOSING_DATE_KEYS,
  // exported for tests only
  extractClosingDate,
};
