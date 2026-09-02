'use strict';

// api/intelligence/agents/strategy.js
const { runSpecialistAgent } = require('./base');
const { STRATEGIC_ANALYST_CONTEXT } = require('../contexts/strategy');
const { formatLiveContext } = require('../live-data');

async function runStrategyAgent(question, liveData) {
  return runSpecialistAgent({
    role: 'strategic_analyst',
    question,
    systemPrompt: STRATEGIC_ANALYST_CONTEXT,
    userContext: formatLiveContext(liveData),
  });
}

module.exports = { runStrategyAgent };
