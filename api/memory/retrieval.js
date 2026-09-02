'use strict';

// api/memory/retrieval.js
// Relevance-driven memory retrieval. V1.1 uses Postgres full-text (tsvector)
// plus ILIKE fallback and a recency tie-breaker. It never returns the whole
// store and never dumps memory into an LLM prompt wholesale: callers get a
// bounded, ranked slice. Semantic vector search (pgvector) is the future
// path and is deliberately out of scope here.

const { q, resolveTenant, clampLimit } = require('./util');
const { rowToMemory } = require('./memories');

function toQuery(text) {
  // Build a websearch-style tsquery input; also keep the raw string for ILIKE.
  const cleaned = String(text || '').trim().slice(0, 400);
  return cleaned;
}

async function getRelevantMemory({
  tenantId, query: queryText, limit = 8,
  memoryTypes = null, includeDormant = true, includeHistorical = false,
  touch = true,
} = {}) {
  const tenant = await resolveTenant(tenantId);
  const text = toQuery(queryText);
  if (!text) return [];

  const statuses = ['ACTIVE', 'REACTIVATED'];
  if (includeDormant) statuses.push('DORMANT');
  if (includeHistorical) statuses.push('HISTORICAL');

  const params = [tenant, text, `%${text.replace(/[%_]/g, '')}%`, statuses];
  let typeClause = '';
  if (Array.isArray(memoryTypes) && memoryTypes.length) {
    params.push(memoryTypes);
    typeClause = `AND memory_type = ANY($${params.length})`;
  }
  params.push(clampLimit(limit, 8, 50));

  const res = await q(`
    SELECT *,
      ts_rank(search_tsv, websearch_to_tsquery('english', $2)) AS rank,
      (search_tsv @@ websearch_to_tsquery('english', $2)) AS tsv_hit
    FROM public.memories
    WHERE tenant_id = $1
      AND status = ANY($4)
      ${typeClause}
      AND (
        search_tsv @@ websearch_to_tsquery('english', $2)
        OR title ILIKE $3
        OR content ILIKE $3
      )
    ORDER BY
      (search_tsv @@ websearch_to_tsquery('english', $2)) DESC,
      ts_rank(search_tsv, websearch_to_tsquery('english', $2)) DESC,
      COALESCE(relevance_score, 0) DESC,
      updated_at DESC
    LIMIT $${params.length}
  `, params);

  const rows = res.rows;
  if (touch && rows.length) {
    const ids = rows.map(r => r.id);
    await q(`
      UPDATE public.memories
      SET last_accessed_at = NOW(),
          status = CASE WHEN status IN ('DORMANT','HISTORICAL') THEN 'REACTIVATED' ELSE status END,
          reactivated_at = CASE WHEN status IN ('DORMANT','HISTORICAL') THEN NOW() ELSE reactivated_at END,
          updated_at = NOW()
      WHERE tenant_id = $1 AND id = ANY($2)
    `, [tenant, ids]);
  }

  return rows.map(r => ({
    ...rowToMemory(r),
    match_rank: r.rank != null ? Number(r.rank) : 0,
    full_text_hit: Boolean(r.tsv_hit),
  }));
}

module.exports = { getRelevantMemory };
