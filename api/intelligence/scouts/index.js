'use strict';

// api/intelligence/scouts/index.js
// Orchestrates a single scout run end to end: Grok generation -> Claude QA
// gate -> provenance chain assembly -> persistence. This is the only place
// that wires those stages together; each stage (grok.js, qa-gate.js,
// external.js/innovation.js, store.js) stays independently testable.
//
// Feature-flag gated: EXTERNAL_INTELLIGENCE_ENABLED / INNOVATION_SCOUT_ENABLED
// gate whether a run is even allowed to start for a tenant, fail-closed on
// any flag-lookup error -- the same fail-closed pattern MEMORY_CONTEXT_ENABLED
// already uses in agents/advisor.js.
//
// REJECTED and NEEDS_REVIEW items ARE persisted here (for audit -- nothing
// a scout produced is silently discarded), they are simply excluded from
// every surfaceable/Advisor-facing read by store.js's hard SQL filter.

const { getFeatureFlag } = require('../../services/tenants');
const { runExternalIntelligenceScout } = require('./external');
const { runInnovationScout } = require('./innovation');
const { runQaGate, QA_PROMPT_VERSION } = require('../qa-gate');
const { insertExternalIntelligence, insertInnovationCandidate } = require('./store');

async function flagEnabled(tenantId, flagName) {
  try {
    return await getFeatureFlag(tenantId, flagName);
  } catch {
    return false; // fail closed: a flag lookup error must never enable a run
  }
}

// Assembles the mandatory three-stage provenance chain: grok_generation,
// claude_qa, system_ingestion, in that order. feature_flag_state is the
// resolved boolean at the exact moment of ingestion, so a flag later
// toggled off then on again does not retroactively obscure which
// configuration accepted which item.
function buildProvenanceChain({ model, promptHash, qaResult, tenantId, flagState }) {
  const now = new Date().toISOString();
  return [
    { stage: 'grok_generation', model, timestamp: now, prompt_hash: promptHash },
    { stage: 'claude_qa', model: qaResult.model, version: QA_PROMPT_VERSION, timestamp: qaResult.qa_completed_at, qa_status: qaResult.qa_status, qa_notes: qaResult.qa_notes },
    { stage: 'system_ingestion', timestamp: now, tenant_id: tenantId, feature_flag_state: flagState },
  ];
}

// Runs the External Intelligence Scout for one tenant/query and persists
// every QA'd item.
async function runAndPersistExternalIntelligence({ tenantId, query, category, limit = 5 }) {
  const enabled = await flagEnabled(tenantId, 'EXTERNAL_INTELLIGENCE_ENABLED');
  if (!enabled) {
    return { ok: false, error: 'EXTERNAL_INTELLIGENCE_ENABLED is not enabled for this tenant', items: [] };
  }

  const scoutResult = await runExternalIntelligenceScout({ query, category, limit });
  if (!scoutResult.ok) {
    return { ok: false, error: scoutResult.error, items: [] };
  }
  if (!scoutResult.items.length) {
    return { ok: true, error: null, items: [] };
  }

  const qaResults = await runQaGate(scoutResult.items, 'EXTERNAL');

  const persisted = [];
  for (let i = 0; i < scoutResult.items.length; i += 1) {
    const item = scoutResult.items[i];
    const qa = qaResults[i];
    const provenance_chain = buildProvenanceChain({
      model: scoutResult.model,
      promptHash: scoutResult.prompt_hash,
      qaResult: qa,
      tenantId,
      flagState: enabled,
    });
    const row = await insertExternalIntelligence({
      tenantId,
      category: item.category,
      claim: item.claim,
      source_url: item.source_url,
      qa_status: qa.qa_status,
      qa_notes: qa.qa_notes,
      provenance_chain,
      query_context: query,
    });
    persisted.push(row);
  }
  return { ok: true, error: null, items: persisted };
}

// Runs the Innovation Scout for one tenant/context and persists every QA'd
// candidate.
async function runAndPersistInnovation({ tenantId, context, constraints, limit = 5 }) {
  const enabled = await flagEnabled(tenantId, 'INNOVATION_SCOUT_ENABLED');
  if (!enabled) {
    return { ok: false, error: 'INNOVATION_SCOUT_ENABLED is not enabled for this tenant', items: [] };
  }

  const scoutResult = await runInnovationScout({ context, constraints, limit });
  if (!scoutResult.ok) {
    return { ok: false, error: scoutResult.error, items: [] };
  }
  if (!scoutResult.items.length) {
    return { ok: true, error: null, items: [] };
  }

  const qaResults = await runQaGate(scoutResult.items, 'INNOVATION');

  const persisted = [];
  for (let i = 0; i < scoutResult.items.length; i += 1) {
    const item = scoutResult.items[i];
    const qa = qaResults[i];
    const provenance_chain = buildProvenanceChain({
      model: scoutResult.model,
      promptHash: scoutResult.prompt_hash,
      qaResult: qa,
      tenantId,
      flagState: enabled,
    });
    const row = await insertInnovationCandidate({
      tenantId,
      idea: item.idea,
      rationale: item.rationale,
      context_summary: item.context_summary,
      qa_status: qa.qa_status,
      qa_notes: qa.qa_notes,
      provenance_chain,
      context_hash: scoutResult.context_hash,
    });
    persisted.push(row);
  }
  return { ok: true, error: null, items: persisted };
}

module.exports = {
  runAndPersistExternalIntelligence,
  runAndPersistInnovation,
  buildProvenanceChain,
};
