'use strict';

// api/memory/memories.js
// Persistent institutional memory: create, retrieve, and the lifecycle state
// machine. Memory is never deleted. Old memory becomes DORMANT then
// HISTORICAL but stays queryable, and a fresh access or a matching signal
// moves it to REACTIVATED with its provenance intact.

const { q, resolveTenant, clampLimit } = require('./util');

const VALID_STATUS = ['ACTIVE', 'DORMANT', 'HISTORICAL', 'REACTIVATED'];
const DORMANT_AFTER_DAYS = 90;
const HISTORICAL_AFTER_DAYS = 365;

function rowToMemory(r) {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    memory_type: r.memory_type,
    title: r.title,
    content: r.content,
    structured_payload: r.structured_payload,
    source_type: r.source_type,
    source_id: r.source_id,
    evidence_type: r.evidence_type,
    confidence: r.confidence,
    status: r.status,
    relevance_score: r.relevance_score != null ? Number(r.relevance_score) : null,
    observed_at: r.observed_at,
    last_accessed_at: r.last_accessed_at,
    reactivated_at: r.reactivated_at,
    expires_at: r.expires_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

async function createMemory(tenantSlug, m) {
  const tenant = await resolveTenant(tenantSlug);
  if (!m || !m.title || !m.memory_type) {
    throw Object.assign(new Error('memory_type and title are required'), { status: 400 });
  }
  const res = await q(`
    INSERT INTO public.memories
      (tenant_id, memory_type, title, content, structured_payload, source_type, source_id,
       evidence_type, confidence, status, relevance_score, observed_at, expires_at, last_accessed_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,
            COALESCE($8,'none'), COALESCE($9,'MODERATE'), 'ACTIVE', $10, $11, $12, NOW())
    RETURNING *
  `, [
    tenant, m.memory_type, m.title, m.content || null,
    m.structured_payload ? JSON.stringify(m.structured_payload) : null,
    m.source_type || 'manual', m.source_id || null,
    m.evidence_type || null, m.confidence || null,
    m.relevance_score ?? null, m.observed_at || null, m.expires_at || null,
  ]);
  return rowToMemory(res.rows[0]);
}

async function getMemory(tenantSlug, id, { touch = true } = {}) {
  const tenant = await resolveTenant(tenantSlug);
  const res = await q('SELECT * FROM public.memories WHERE id = $1 AND tenant_id = $2', [id, tenant]);
  if (!res.rows[0]) return null;
  if (touch) return touchMemory(tenant, id);
  return rowToMemory(res.rows[0]);
}

// Records an access. A DORMANT or HISTORICAL memory that is accessed again
// becomes REACTIVATED (provenance columns are untouched).
async function touchMemory(tenantSlug, id, reason) {
  const tenant = await resolveTenant(tenantSlug);
  const res = await q(`
    UPDATE public.memories
    SET last_accessed_at = NOW(),
        updated_at = NOW(),
        status = CASE WHEN status IN ('DORMANT','HISTORICAL') THEN 'REACTIVATED' ELSE status END,
        reactivated_at = CASE WHEN status IN ('DORMANT','HISTORICAL') THEN NOW() ELSE reactivated_at END,
        structured_payload = CASE
          WHEN status IN ('DORMANT','HISTORICAL') AND $3::text IS NOT NULL
          THEN jsonb_set(COALESCE(structured_payload,'{}'::jsonb), '{reactivation_reason}', to_jsonb($3::text))
          ELSE structured_payload END
    WHERE id = $1 AND tenant_id = $2
    RETURNING *
  `, [id, tenant, reason || null]);
  return res.rows[0] ? rowToMemory(res.rows[0]) : null;
}

async function setMemoryStatus(tenantSlug, id, status) {
  const tenant = await resolveTenant(tenantSlug);
  if (!VALID_STATUS.includes(status)) throw Object.assign(new Error(`Invalid status: ${status}`), { status: 400 });
  const res = await q(
    'UPDATE public.memories SET status = $3, updated_at = NOW() WHERE id = $1 AND tenant_id = $2 RETURNING *',
    [id, tenant, status],
  );
  return res.rows[0] ? rowToMemory(res.rows[0]) : null;
}

async function listMemories(tenantSlug, { memoryTypes, statuses, limit, since } = {}) {
  const tenant = await resolveTenant(tenantSlug);
  const where = ['tenant_id = $1'];
  const params = [tenant];
  if (Array.isArray(memoryTypes) && memoryTypes.length) {
    params.push(memoryTypes);
    where.push(`memory_type = ANY($${params.length})`);
  }
  if (Array.isArray(statuses) && statuses.length) {
    params.push(statuses);
    where.push(`status = ANY($${params.length})`);
  }
  if (since) {
    params.push(since);
    where.push(`created_at >= $${params.length}`);
  }
  params.push(clampLimit(limit));
  const res = await q(
    `SELECT * FROM public.memories WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT $${params.length}`,
    params,
  );
  return res.rows.map(rowToMemory);
}

// Lifecycle sweep. ACTIVE/REACTIVATED memories untouched for a long time
// become DORMANT; DORMANT ones untouched for much longer become HISTORICAL.
// Nothing is deleted. Returns counts. Safe to run repeatedly.
async function sweepMemoryStates(tenantSlug) {
  const tenant = await resolveTenant(tenantSlug);
  const toDormant = await q(`
    UPDATE public.memories
    SET status = 'DORMANT', updated_at = NOW()
    WHERE tenant_id = $1 AND status IN ('ACTIVE','REACTIVATED')
      AND COALESCE(last_accessed_at, created_at) < NOW() - ($2 || ' days')::interval
    RETURNING id
  `, [tenant, DORMANT_AFTER_DAYS]);
  const toHistorical = await q(`
    UPDATE public.memories
    SET status = 'HISTORICAL', updated_at = NOW()
    WHERE tenant_id = $1 AND status = 'DORMANT'
      AND COALESCE(last_accessed_at, created_at) < NOW() - ($2 || ' days')::interval
    RETURNING id
  `, [tenant, HISTORICAL_AFTER_DAYS]);
  return { to_dormant: toDormant.rowCount, to_historical: toHistorical.rowCount };
}

module.exports = {
  createMemory, getMemory, touchMemory, setMemoryStatus, listMemories, sweepMemoryStates,
  rowToMemory, VALID_STATUS, DORMANT_AFTER_DAYS, HISTORICAL_AFTER_DAYS,
};
