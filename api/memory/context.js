'use strict';

// api/memory/context.js
// Additive context contract for future Advisor execution. Assembles the
// institutional layer that will sit ALONGSIDE current evidence and strategic
// context: relevant memory, relevant decisions, recent signals with per-tenant
// relevance. Nothing here modifies the existing Advisor contract; a caller
// opts in by asking for this block and appending it.

const { getRelevantMemory } = require('./retrieval');
const { listDecisions } = require('./decisions');
const { listTenantSignals } = require('./watchtower');

async function buildMemoryContext({ tenantId, query, memoryLimit = 6, signalLimit = 5 } = {}) {
  const [memories, decisions, tenantSignals] = await Promise.all([
    getRelevantMemory({ tenantId, query, limit: memoryLimit, includeDormant: true, includeHistorical: false }),
    listDecisions(tenantId, { statuses: ['ACTIVE', 'REVIEW_RECOMMENDED'], limit: 10 }),
    listTenantSignals(tenantId, { limit: signalLimit }),
  ]);

  return {
    relevant_memory: memories.map(m => ({
      id: m.id, type: m.memory_type, title: m.title, content: m.content,
      status: m.status, evidence_type: m.evidence_type, confidence: m.confidence,
      source_type: m.source_type, observed_at: m.observed_at,
    })),
    relevant_decisions: decisions.map(d => ({
      id: d.id, decision: d.decision, rationale: d.rationale, status: d.status,
      decision_date: d.decision_date, confidence: d.confidence, review_date: d.review_date,
    })),
    recent_signals: tenantSignals.map(s => ({
      id: s.id, title: s.title, summary: s.summary, signal_type: s.signal_type,
      signal_confidence: s.confidence, observed_at: s.observed_at,
      tenant_relevance: s.tenant_relevance_score, tenant_status: s.tenant_status,
    })),
  };
}

// Plain-text rendering for prompt injection, clearly labelled as institutional
// context and NOT corpus evidence.
function formatMemoryContext(ctx) {
  if (!ctx) return '';
  const lines = ['INSTITUTIONAL MEMORY (not Zenex corpus evidence; internal record of what the organisation has learned and decided)'];
  if (ctx.relevant_memory.length) {
    lines.push('', 'Relevant memory:');
    for (const m of ctx.relevant_memory) lines.push(`- [${m.type}/${m.status}, ${m.confidence}] ${m.title}${m.content ? `: ${m.content.slice(0, 240)}` : ''}`);
  }
  if (ctx.relevant_decisions.length) {
    lines.push('', 'Relevant prior decisions:');
    for (const d of ctx.relevant_decisions) lines.push(`- [${d.status}${d.decision_date ? `, ${d.decision_date}` : ''}] ${d.decision}${d.rationale ? ` (rationale: ${d.rationale.slice(0, 180)})` : ''}`);
  }
  if (ctx.recent_signals.length) {
    lines.push('', 'Recent external signals (signal confidence is not evidence confidence):');
    for (const s of ctx.recent_signals) lines.push(`- [${s.signal_type || 'signal'}, ${s.signal_confidence}] ${s.title || s.summary || 'untitled'}`);
  }
  return lines.join('\n');
}

module.exports = { buildMemoryContext, formatMemoryContext };
