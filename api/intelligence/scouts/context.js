'use strict';

// api/intelligence/scouts/context.js
// Plain-text renderers for Advisor prompt injection. Reads ONLY the
// surfaceable subset (VERIFIED/QUALIFIED external intelligence, SPECULATIVE
// innovation candidates) -- REJECTED/NEEDS_REVIEW items are excluded at the
// SQL level in store.js and never reach this file. Mirrors the exact shape
// of api/memory/context.js's buildMemoryContext/formatMemoryContext.

const { listSurfaceableExternalIntelligence, listSurfaceableInnovationCandidates } = require('./store');

async function buildExternalIntelligenceContext({ tenantId, limit = 5 }) {
  const items = await listSurfaceableExternalIntelligence({ tenantId, limit });
  return { items };
}

function formatExternalIntelligenceContext(ctx) {
  const items = (ctx && ctx.items) || [];
  if (!items.length) return '';
  const lines = items.map(it => `- [${it.qa_status}] ${it.claim} (source: ${it.source_url}, category: ${it.category})`);
  return [
    'EXTERNAL INTELLIGENCE (flag-gated, Grok-sourced, Claude-QA-reviewed, claim_type=signal -- not Zenex corpus evidence)',
    '',
    ...lines,
  ].join('\n');
}

async function buildInnovationContext({ tenantId, limit = 5 }) {
  const items = await listSurfaceableInnovationCandidates({ tenantId, limit });
  return { items };
}

function formatInnovationContext(ctx) {
  const items = (ctx && ctx.items) || [];
  if (!items.length) return '';
  const lines = items.map(it => `- [SPECULATIVE] ${it.idea} -- rationale: ${it.rationale} (decision_status: ${it.decision_status})`);
  return [
    'INNOVATION CANDIDATES (flag-gated, speculative hypotheses only -- NOT evidence, NOT verified, claim_type=signal)',
    '',
    ...lines,
  ].join('\n');
}

module.exports = {
  buildExternalIntelligenceContext,
  formatExternalIntelligenceContext,
  buildInnovationContext,
  formatInnovationContext,
};
