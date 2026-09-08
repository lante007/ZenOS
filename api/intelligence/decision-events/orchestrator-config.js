'use strict';

// api/intelligence/decision-events/orchestrator-config.js
//
// Operational configuration for the Decision Event Orchestrator, separate
// from config.js (which holds pathway *detection* thresholds like
// DEADLINE_WINDOW_DAYS). This file is about how often/how much the
// orchestrator runs -- it carries no detection semantics and no pathway
// ever reads from it. Environment-overridable, conservative defaults, same
// convention as api/watchtower/config.js.

const n = (v, d) => {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? x : d;
};

module.exports = {
  // Worker is present but idle when disabled: pm2 keeps it up, it does nothing.
  enabled: process.env.DECISION_EVENTS_ENABLED !== 'false',

  // 15 min, not 5 (watchtower's interval): a tick here fans out across six
  // pathways x N candidate objects x M tenants, a heavier sweep than a
  // single source fetch. This is a starting estimate, not derived from
  // measured load -- revisit once real tenant/signal volume exists.
  pollIntervalMs: n(process.env.DECISION_EVENTS_POLL_INTERVAL_MS, 15 * 60 * 1000),

  // Ceiling passed to listSignals/listDecisions/listOutcomes. V1 has no
  // "since last tick" cursor (deliberate -- see orchestrator.js header):
  // every tick re-evaluates the full non-terminal candidate pool, relying
  // on fingerprint uniqueness (ON CONFLICT DO NOTHING) to make repeat
  // evaluation cheap. 200 is clampLimit()'s own max in every list function
  // this orchestrator calls -- this is a known ceiling, not a real
  // pagination strategy. Revisit if any tenant's candidate pool exceeds it.
  candidateFetchLimit: n(process.env.DECISION_EVENTS_CANDIDATE_LIMIT, 200),

  shutdownGraceMs: n(process.env.DECISION_EVENTS_SHUTDOWN_GRACE_MS, 30000),
};
