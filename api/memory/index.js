'use strict';

// api/memory/index.js — public surface of the V1.1 memory / watchtower layer.

const { ensureV11Schema } = require('./schema');
const memories = require('./memories');
const { getRelevantMemory } = require('./retrieval');
const decisions = require('./decisions');
const outcomes = require('./outcomes');
const watchtower = require('./watchtower');
const graph = require('./graph');
const context = require('./context');
const prophet = require('./prophet-contract');

module.exports = {
  ensureV11Schema,
  ...memories,
  getRelevantMemory,
  ...decisions,
  ...outcomes,
  watchtower,
  graph,
  ...context,
  prophet,
};
