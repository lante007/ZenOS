'use strict';

// api/intelligence/decision-events/config.js
//
// Shared, deterministic constants for the Decision Intelligence rules
// engine (Phase 2). Every trigger pathway that needs a threshold or window
// pulls it from here, so tuning one number doesn't require hunting through
// pathway files, and so two pathways never silently disagree on the same
// concept (e.g. what "approaching" means).
//
// These are code constants, not DB-backed config, following the existing
// precedent set by INVESTMENT_CAP_RAND in api/services/priority-score.js.
// They can be promoted to a DB-backed, per-tenant-configurable table later
// without changing any pathway's logic -- only how these values are read.
//
// Pathway 1's INVESTMENT_THRESHOLD_RAND deliberately stays local to
// pathways/signal-touches-exposure.js for now (already-approved code, not
// touched here). It can move into this file in a future cleanup pass.

// Pathway 2: Decision deadline approaching. review_date within this many
// days of today (inclusive of already-overdue decisions) triggers.
const DEADLINE_WINDOW_DAYS = 30;

// Pathway 4: Convergence of two previously separate signals. Signals
// observed within this many days of each other are eligible to converge.
const CONVERGENCE_WINDOW_DAYS = 14;

// Pathway 4: minimum combined confidence score across a converging group
// (HIGH=3, MODERATE=2, LOW=1, UNKNOWN=0, summed). Two MODERATE signals
// (2+2=4) is the intended minimum case. A separate floor -- at least one
// signal in the group must individually be HIGH or MODERATE -- is enforced
// in the pathway itself, so two LOW or two UNKNOWN signals can never reach
// this threshold by volume alone regardless of domain overlap.
const CONVERGENCE_COMBINED_CONFIDENCE_THRESHOLD = 4;

// Pathway 5: Opportunity window closing. A signal's extracted closing date
// within this many days of today (future only -- already-closed windows are
// excluded by the pathway itself) triggers. Deliberately between Pathway 2's
// 30 days (internal decisions move slower) and Pathway 4's 14 days (signal
// convergence moves faster) -- external opportunities move faster than
// internal decisions, slower than a signal cluster forming.
const OPPORTUNITY_WINDOW_DAYS = 21;

// Pathway 6: Reversible decision becoming irreversible. A matched
// revisit_conditions point-of-no-return date within this many days of today
// triggers -- future (approaching) AND already-passed (see the pathway file
// for why overdue is included here, unlike Pathway 5). Matches Pathway 2's
// window: both concern internal decision timing, not external/signal-cluster
// speed.
const REVERSIBILITY_WINDOW_DAYS = 30;

module.exports = {
  DEADLINE_WINDOW_DAYS,
  CONVERGENCE_WINDOW_DAYS,
  CONVERGENCE_COMBINED_CONFIDENCE_THRESHOLD,
  OPPORTUNITY_WINDOW_DAYS,
  REVERSIBILITY_WINDOW_DAYS,
};
