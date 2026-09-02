'use strict';

// api/watchtower/index.js — programmatic surface (used by the worker and tests).

const { observeSource } = require('./observe');
const { ensureSeedSources, SEED_SOURCES } = require('./seed-sources');
const wt = require('../memory/watchtower');
const cfg = require('./config');

// Observe every due source once. Sequential, so one slow source cannot pile
// up concurrent fetches. Returns per-source results.
async function runOnce({ limit = cfg.maxSourcesPerTick } = {}) {
  const due = await wt.getDueSources(limit);
  const results = [];
  for (const source of due) {
    results.push(await observeSource(source));
  }
  return { due: due.length, results };
}

module.exports = { observeSource, runOnce, ensureSeedSources, SEED_SOURCES, config: cfg };
