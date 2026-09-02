'use strict';

// api/intelligence/index.js
// Public surface of the Intelligence Console engine. The route layer uses the
// job functions; runIntelligence is exported for direct/synchronous use in
// tests and scripts.

const { createIntelligenceJob, getIntelligenceJob } = require('./jobs');
const { runIntelligence } = require('./orchestrator');

module.exports = { createIntelligenceJob, getIntelligenceJob, runIntelligence };
