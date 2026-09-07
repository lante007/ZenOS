'use strict';

// api/intelligence/scouts/innovation.js
// Runs the raw Grok ideation call and shapes results into a strict, minimal
// item shape. Does not call the QA gate and does not persist -- see
// scouts/external.js for the same separation of concerns.

const crypto = require('crypto');
const { grokIdeation } = require('../grok');

function contextHash(context) {
  return crypto.createHash('sha256').update(String(context || '')).digest('hex');
}

// Drops anything missing an idea or a rationale. Exported so hostile/
// malformed Grok output can be tested directly without a live API call.
function shapeItem(raw, contextSummary) {
  if (!raw || typeof raw !== 'object') return null;
  const idea = typeof raw.idea === 'string' ? raw.idea.trim() : '';
  const rationale = typeof raw.rationale === 'string' ? raw.rationale.trim() : '';
  if (!idea || !rationale) return null;
  return { idea, rationale, context_summary: contextSummary };
}

// Returns { ok, items, error, model, prompt_hash, context_hash }. items are
// shaped, deduplicated raw candidates -- NOT yet QA'd, NOT yet persisted.
// Every item here is a hypothesis by construction: this scout never claims
// to retrieve anything real. Never throws.
async function runInnovationScout({ context, constraints, limit = 5 }) {
  if (!context || !String(context).trim()) {
    return { ok: false, error: 'context is required', items: [], model: null, prompt_hash: null, context_hash: null };
  }
  const hash = contextHash(context);
  const result = await grokIdeation({ context, constraints, limit });
  if (!result.ok) {
    return { ok: false, error: result.error, items: [], model: result.model, prompt_hash: result.prompt_hash, context_hash: hash };
  }
  const contextSummary = String(context).slice(0, 500);
  const seen = new Set();
  const items = [];
  for (const raw of result.items) {
    const shaped = shapeItem(raw, contextSummary);
    if (!shaped) continue;
    const key = shaped.idea;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(shaped);
  }
  return { ok: true, error: null, items, model: result.model, prompt_hash: result.prompt_hash, context_hash: hash };
}

module.exports = { runInnovationScout, shapeItem, contextHash };
