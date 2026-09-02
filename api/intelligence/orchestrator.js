'use strict';

// api/intelligence/orchestrator.js
const { runEvidenceAgent } = require('./agents/evidence');
const { runStrategyAgent } = require('./agents/strategy');
const { runAdvisorAgent } = require('./agents/advisor');

async function runIntelligence(question, liveData) {
  // Run Evidence and Strategy agents in parallel
  const [evidenceResult, strategyResult] = await Promise.all([
    runEvidenceAgent(question, liveData),
    runStrategyAgent(question, liveData),
  ]);

  // Advisor synthesises both outputs into one response
  const finalAnswer = await runAdvisorAgent(question, {
    evidence: evidenceResult.output,
    strategy: strategyResult.output,
  });

  return {
    answer: finalAnswer,
    context: 'advisor',
    agents_used: [evidenceResult.agent, strategyResult.agent],
    question,
  };
}

module.exports = { runIntelligence };
