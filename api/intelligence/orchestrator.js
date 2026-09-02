'use strict';

// api/intelligence/orchestrator.js
// Runs the specialist agents in parallel, then the synthesis agent. Handles
// partial failure explicitly: a specialist failing degrades the answer but
// does not fail the job; only the synthesis agent failing (or every agent
// failing) fails the job. Emits a telemetry object for observability.

const { ORCHESTRATION } = require('./config');
const { runEvidenceAgent } = require('./agents/evidence');
const { runStrategyAgent } = require('./agents/strategy');
const { runAdvisorAgent } = require('./agents/advisor');

const SPECIALIST_RUNNERS = {
  evidence_analyst: runEvidenceAgent,
  strategic_analyst: runStrategyAgent,
};

function agentTelemetry(r) {
  return {
    agent: r.agent,
    status: r.status,
    execution_ms: r.execution_ms,
    model: r.model,
    rounds: r.rounds ?? 0,
    tokens: r.usage || { input_tokens: 0, output_tokens: 0 },
    tools_used: (r.tool_calls || []).map(t => ({ tool: t.tool, ok: t.ok, cached: Boolean(t.cached), ms: t.ms, summary: t.summary })),
    confidence: r.output && r.output.confidence ? r.output.confidence : null,
    error: r.error || null,
  };
}

async function runIntelligence(question, liveData, meta = {}) {
  const startedAt = Date.now();
  const roles = ORCHESTRATION.specialist_agents;

  const settled = await Promise.all(
    roles.map(async role => {
      const runner = SPECIALIST_RUNNERS[role];
      if (!runner) {
        return { agent: role, status: 'failed', execution_ms: 0, model: null, usage: {}, tool_calls: [], output: null, error: `No runner registered for ${role}` };
      }
      try {
        return await runner(question, liveData);
      } catch (err) {
        return { agent: role, status: 'failed', execution_ms: 0, model: null, usage: {}, tool_calls: [], output: null, error: err.message };
      }
    }),
  );

  const advisor = await runAdvisorAgent(question, settled);

  const degraded = settled.some(r => r.status !== 'ok');
  const allSpecialistsFailed = settled.every(r => r.status !== 'ok');
  const status = advisor.status === 'ok' ? 'completed' : 'failed';

  const agents = [...settled.map(agentTelemetry), agentTelemetry(advisor)];
  const usageTotal = agents.reduce(
    (acc, a) => ({
      input_tokens: acc.input_tokens + (a.tokens.input_tokens || 0),
      output_tokens: acc.output_tokens + (a.tokens.output_tokens || 0),
    }),
    { input_tokens: 0, output_tokens: 0 },
  );

  let answer = advisor.markdown;
  if (advisor.status !== 'ok') {
    answer = `## Synthesis unavailable\n\nThe Advisor failed to produce a synthesis (${advisor.error}). `
      + (allSpecialistsFailed
        ? 'Every specialist agent also failed. Re-run the query.'
        : 'The specialist analyses below did run. Re-run the query, or inspect the raw agent output.');
  }

  return {
    status,
    answer,
    answer_structured: advisor.output || null,
    context: 'advisor',
    agents_used: settled.filter(r => r.status === 'ok').map(r => r.agent),
    agents,
    agent_results: [
      ...settled.map(r => ({ agent: r.agent, status: r.status, output: r.output || null, error: r.error || null })),
      { agent: 'advisor', status: advisor.status, output: advisor.output || null, error: advisor.error || null },
    ],
    degraded,
    telemetry: {
      question_chars: (question || '').length,
      user: meta.user || null,
      role: meta.role || null,
      total_ms: Date.now() - startedAt,
      model_calls: agents.length,
      tokens_total: usageTotal,
      specialist_status: settled.map(r => ({ agent: r.agent, status: r.status })),
      advisor_status: advisor.status,
    },
  };
}

module.exports = { runIntelligence };
