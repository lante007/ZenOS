'use strict';

// api/intelligence/agents/evidence.js
const { runSpecialistAgent } = require('./base');
const { EVIDENCE_ANALYST_CONTEXT } = require('../contexts/evidence');
const { formatLiveContext } = require('../live-data');

async function runEvidenceAgent(question, liveData) {
  return runSpecialistAgent({
    role: 'evidence_analyst',
    question,
    systemPrompt: EVIDENCE_ANALYST_CONTEXT,
    userContext: formatLiveContext(liveData),
  });
}

module.exports = { runEvidenceAgent };
