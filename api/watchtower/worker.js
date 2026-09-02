'use strict';

// api/watchtower/worker.js
// Auxeira Watchtower Observation Worker. Runs as its OWN pm2 process
// (watchtower-worker), never inside the API. It shares only the database and
// S3 with the API, not a runtime: a slow, blocked or failing source here
// cannot affect /api/intelligence/ask, and a crash restarts only this
// process.
//
// Deterministic polling loop. No LLM. External content is data only.

require('dotenv').config();

const { ensureV11Schema } = require('../memory/schema');
const { ensureSeedSources, runOnce } = require('./index');
const cfg = require('./config');

const log = (evt, fields = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), component: 'watchtower', evt, ...fields }));

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
    const { due, results } = await runOnce();
    for (const r of results) {
      log('observation', {
        source_id: r.source_id,
        source: r.source_name,
        status: r.status,
        http_status: r.http_status ?? null,
        observation_id: r.observation_id ?? null,
        is_first: r.is_first ?? null,
        changed: r.changed ?? null,
        fingerprint: r.fingerprint ?? null,
        signal_id: r.signal_id ?? null,
        signal_created: r.signal_created ?? null,
        snapshot: r.snapshot && r.snapshot.meta_key ? r.snapshot.meta_key : (r.snapshot && r.snapshot.error ? `error:${r.snapshot.error}` : null),
        bytes: r.bytes ?? null,
        truncated: r.truncated ?? null,
        error: r.error ?? null,
        duration_ms: r.duration_ms ?? null,
      });
    }
    log('tick_complete', { tick: ticks, due, observed: results.length, duration_ms: Date.now() - startedAt });
  } catch (err) {
    // A bug in a tick must not kill the loop.
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
    fetch_timeout_ms: cfg.fetchTimeoutMs,
    max_bytes: cfg.maxResponseBytes,
    s3_bucket: cfg.s3Bucket,
    s3_prefix: cfg.s3Prefix,
    respect_robots: cfg.respectRobots,
    node: process.version,
  });

  try {
    await ensureV11Schema();
    const seeded = await ensureSeedSources();
    log('seeded_sources', { count: seeded.length, sources: seeded.map(s => ({ id: s.id, name: s.name, enabled: s.enabled })) });
  } catch (err) {
    log('boot_error', { error: err.message });
    process.exit(1);
  }

  if (!cfg.enabled) {
    log('disabled', { note: 'WATCHTOWER_ENABLED=false; worker is idle. pm2 keeps it alive.' });
    // keep the process up without observing
    timer = setInterval(() => {}, 60000);
    return;
  }

  await tick(); // observe immediately on boot
  timer = setInterval(tick, cfg.pollIntervalMs);
  log('loop_started', { poll_interval_ms: cfg.pollIntervalMs });
})();
