'use strict';

// api/intelligence/config.js
// Central model / token / temperature / timeout / tool configuration for the
// Intelligence Console. Agents never hard-code these. Change cost and
// performance characteristics here, not inside individual agents.

const DEFAULT_MODEL = 'claude-sonnet-4-6';

const AGENTS = {
  evidence_analyst: {
    model: DEFAULT_MODEL,
    max_tokens: 900,
    temperature: 0,
    timeout_ms: 70000,
    // Retrieval tools this agent may call during its gather phase. Calls
    // within a round run in parallel and equivalent repeats are de-duplicated,
    // so a small round budget is enough for normal questions without forcing
    // shallow answers.
    allowed_tools: ['corpus_search', 'get_programme_evidence', 'get_records', 'list_programmes', 'external_research'],
    max_tool_rounds: 3,
  },
  strategic_analyst: {
    model: DEFAULT_MODEL,
    max_tokens: 900,
    temperature: 0,
    timeout_ms: 70000,
    allowed_tools: [],
    max_tool_rounds: 0,
  },
  advisor: {
    model: DEFAULT_MODEL,
    max_tokens: 1600,
    temperature: 0.2,
    timeout_ms: 70000,
    allowed_tools: [],
    max_tool_rounds: 0,
  },
  // C4: Prophet is a single forced-tool-call agent, the same shape as
  // advisor, not a new multi-agent pipeline. It never retrieves; it only
  // reasons over the one Watchtower signal it is given.
  prophet: {
    model: DEFAULT_MODEL,
    max_tokens: 1200,
    temperature: 0.2,
    timeout_ms: 70000,
    allowed_tools: [],
    max_tool_rounds: 0,
  },
};

const ORCHESTRATION = {
  // Agents that run in parallel before synthesis. Extend this list to add
  // specialist agents without touching the route or the frontend.
  specialist_agents: ['evidence_analyst', 'strategic_analyst'],
  synthesis_agent: 'advisor',
  // How long a finished job stays in the in-memory store.
  job_retention_ms: 60 * 60 * 1000,
  // Safety ceiling on total orchestration wall time.
  total_timeout_ms: 180000,
};

function agentConfig(role) {
  const cfg = AGENTS[role];
  if (!cfg) throw new Error(`Unknown agent role: ${role}`);
  return cfg;
}

module.exports = { DEFAULT_MODEL, AGENTS, ORCHESTRATION, agentConfig };
