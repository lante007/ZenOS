'use strict';

// api/intelligence/decision-events/worker.js
// Auxeira Decision Event Orchestration Worker. Runs as its OWN pm2 process
// (decision-events-worker), separate from both the API and
// watchtower-worker: a slow tick, a bug in one pathway, or a crash here
// cannot affect signal ingestion or /api/intelligence/ask, and a restart
// here restarts only this process.
//
// Deterministic tick loop. No LLM. This process only calls runOnce() from
// orchestrator.js and logs the result -- it contains no detection or
// persistence logic of its own. See orchestrator.js for the full design
// rationale and explicit scope boundaries.

require('dotenv').config();

const { ensureV11Schema } = require('../../memory/schema');
const { runOnce } = require('./orchestrator');
const cfg = require('./orchestrator-config');

const log = (evt, fields = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), component: 'decision-events', evt, ...fields }));

let stopping = false;
let ticking = false;
let timer = null;
let ticks = 0;

async function tick() {
  if (stopping || ticking) return;
  ticking = true;
  const startedAt = Date.now();
  ticks += 1;
  try {
    const stats = await runOnce();
    log('tick_complete', {
      tick: ticks,
      tenants_processed: stats.tenants_processed,
      candidates_evaluated: stats.candidates_evaluated,
      events_fired: stats.events_fired,
      events_inserted: stats.events_inserted,
      events_deduped_in_tick: stats.events_deduped_in_tick,
      events_conflict_no_op: stats.events_conflict_no_op,
      outcomes_skipped_no_decision: stats.outcomes_skipped_no_decision,
      error_count: stats.errors.length,
      duration_ms: Date.now() - startedAt,
    });
    for (const e of stats.errors) {
      log('tick_error_detail', { tick: ticks, ...e });
    }
  } catch (err) {
    // A bug in a tick must not kill the loop. runOnce() already catches
    // everything it knows about; this is the last-resort backstop.
    log('tick_error', { tick: ticks, error: err.message, stack: (err.stack || '').split('\n').slice(0, 3).join(' | ') });
  } finally {
    ticking = false;
  }
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log('shutdown_begin', { signal });
  if (timer) clearInterval(timer);
  const deadline = Date.now() + cfg.shutdownGraceMs;
  while (ticking && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200));
  }
  log('shutdown_complete', { forced: ticking });
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', reason => log('unhandled_rejection', { reason: String(reason && reason.message || reason) }));
process.on('uncaughtException', err => { log('uncaught_exception', { error: err.message }); process.exit(1); });

(async () => {
  log('starting', {
    enabled: cfg.enabled,
    poll_interval_ms: cfg.pollIntervalMs,
    candidate_fetch_limit: cfg.candidateFetchLimit,
    node: process.version,
  });

  try {
    // The orchestrator reads wt_signals/decisions/outcomes -- all V1.1
    // memory tables. decision_events itself is created by its own
    // migration (027), already applied; not part of this call.
    await ensureV11Schema();
  } catch (err) {
    log('boot_error', { error: err.message });
    process.exit(1);
  }

  if (!cfg.enabled) {
    log('disabled', { note: 'DECISION_EVENTS_ENABLED=false; worker is idle. pm2 keeps it alive.' });
    timer = setInterval(() => {}, 60000);
    return;
  }

  await tick(); // run immediately on boot
  timer = setInterval(tick, cfg.pollIntervalMs);
  log('loop_started', { poll_interval_ms: cfg.pollIntervalMs });
})();
