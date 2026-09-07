'use strict';

// api/intelligence/scouts/external.js
// Runs the raw Grok web-search call and shapes results into a strict,
// minimal item shape. Does not call the QA gate and does not persist --
// orchestration (grok -> QA -> persist) lives in scouts/index.js so each
// stage stays independently testable.

const { grokWebSearch, EXTERNAL_CATEGORIES } = require('../grok');

// Drops anything missing a claim or a well-formed http(s) source_url.
// Exported so hostile/malformed Grok output can be tested directly without
// a live API call.
function shapeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const claim = typeof raw.claim === 'string' ? raw.claim.trim() : '';
  const sourceUrl = typeof raw.source_url === 'string' ? raw.source_url.trim() : '';
  if (!claim || !sourceUrl) return null;
  let parsedUrl;
  try {
    parsedUrl = new URL(sourceUrl);
  } catch {
    return null;
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') return null;
  const category = EXTERNAL_CATEGORIES.includes(raw.category) ? raw.category : 'other';
  return { claim, source_url: sourceUrl, category };
}

// Returns { ok, items, error, model, prompt_hash }. items are shaped,
// deduplicated raw candidates -- NOT yet QA'd, NOT yet persisted. Never
// throws.
async function runExternalIntelligenceScout({ query, category, limit = 5 }) {
  if (!query || !String(query).trim()) {
    return { ok: false, error: 'query is required', items: [], model: null, prompt_hash: null };
  }
  const result = await grokWebSearch({ query, category, limit });
  if (!result.ok) {
    return { ok: false, error: result.error, items: [], model: result.model, prompt_hash: result.prompt_hash };
  }
  const seen = new Set();
  const items = [];
  for (const raw of result.items) {
    const shaped = shapeItem(raw);
    if (!shaped) continue;
    const key = `${shaped.source_url}::${shaped.claim}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(shaped);
  }
  return { ok: true, error: null, items, model: result.model, prompt_hash: result.prompt_hash };
}

module.exports = { runExternalIntelligenceScout, shapeItem };
