'use strict';

// api/memory/watchtower.js
// Auxeira Watchtower data layer: the source registry, the observation record
// (one row per fetch, with an immutable S3 snapshot reference), the signal
// model (a detected change), and the per-tenant relevance overlay.
//
// This file is data only. The Observation Worker that actually fetches
// sources runs as a separate process (Increment 2) and calls recordObservation
// / createSignal here. A slow or failed worker cannot touch this module's
// callers because they share only the database, not a runtime.
//
// Isolation: a source with NULL tenant_id and every observation / signal are
// global material, stored once. Per-tenant relevance and interpretation live
// in tenant_signal_relevance, keyed by tenant_id.

const crypto = require('crypto');
const { q, resolveTenant, clampLimit } = require('./util');

const SOURCE_TYPES = ['government', 'policy', 'research', 'organisation', 'funder', 'news', 'social', 'dataset', 'rss', 'api', 'custom'];
const FREQ_MS = { hourly: 3600e3, daily: 86400e3, weekly: 604800e3, monthly: 2592000e3 };

function fingerprint(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

// ── sources ──────────────────────────────────────────
async function registerSource(s) {
  if (!s || !s.name || !s.url || !s.source_type) {
    throw Object.assign(new Error('name, url and source_type are required'), { status: 400 });
  }
  if (!SOURCE_TYPES.includes(s.source_type)) {
    throw Object.assign(new Error(`source_type must be one of: ${SOURCE_TYPES.join(', ')}`), { status: 400 });
  }
  const tenant = s.tenant_id ? await resolveTenant(s.tenant_id) : null;
  const res = await q(`
    INSERT INTO public.wt_sources (tenant_id, name, source_type, url, enabled, crawl_frequency, credibility, config)
    VALUES ($1,$2,$3,$4,COALESCE($5,true),COALESCE($6,'weekly'),COALESCE($7,'MODERATE'),COALESCE($8,'{}'::jsonb))
    ON CONFLICT (COALESCE(tenant_id,'*'), url) DO UPDATE SET
      name = EXCLUDED.name, source_type = EXCLUDED.source_type,
      crawl_frequency = EXCLUDED.crawl_frequency, credibility = EXCLUDED.credibility,
      config = EXCLUDED.config, updated_at = NOW()
    RETURNING *
  `, [
    tenant, s.name, s.source_type, s.url,
    typeof s.enabled === 'boolean' ? s.enabled : null,
    s.crawl_frequency || null, s.credibility || null,
    s.config ? JSON.stringify(s.config) : null,
  ]);
  return res.rows[0];
}

async function updateSource(id, patch) {
  const allowed = ['name', 'source_type', 'url', 'enabled', 'crawl_frequency', 'credibility', 'config'];
  const sets = [];
  const params = [id];
  for (const k of allowed) {
    if (patch[k] === undefined) continue;
    if (k === 'source_type' && !SOURCE_TYPES.includes(patch[k])) {
      throw Object.assign(new Error(`invalid source_type`), { status: 400 });
    }
    params.push(k === 'config' ? JSON.stringify(patch[k]) : patch[k]);
    sets.push(`${k} = $${params.length}`);
  }
  if (!sets.length) throw Object.assign(new Error('no updatable fields supplied'), { status: 400 });
  sets.push('updated_at = NOW()');
  const res = await q(`UPDATE public.wt_sources SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
  return res.rows[0] || null;
}

async function listSources({ tenantId, includeGlobal = true, limit } = {}) {
  const params = [];
  const where = [];
  if (tenantId) {
    const tenant = await resolveTenant(tenantId);
    params.push(tenant);
    where.push(includeGlobal ? `(tenant_id = $${params.length} OR tenant_id IS NULL)` : `tenant_id = $${params.length}`);
  } else {
    where.push('tenant_id IS NULL');
  }
  params.push(clampLimit(limit, 100, 500));
  const res = await q(
    `SELECT * FROM public.wt_sources WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT $${params.length}`,
    params,
  );
  return res.rows;
}

// Sources whose next scheduled observation is due.
async function getDueSources(limit = 20) {
  const res = await q(
    `SELECT * FROM public.wt_sources WHERE enabled = true ORDER BY COALESCE(last_crawled_at, 'epoch') ASC LIMIT $1`,
    [clampLimit(limit, 20, 100)],
  );
  const now = Date.now();
  return res.rows.filter(s => {
    if (!s.last_crawled_at) return true;
    const period = FREQ_MS[s.crawl_frequency] || FREQ_MS.weekly;
    return now - new Date(s.last_crawled_at).getTime() >= period;
  });
}

// ── observations ─────────────────────────────────────
// Records one fetch. Compares the content fingerprint against this source's
// previous successful observation and sets `changed`. The worker is expected
// to have already written the immutable snapshot to S3 and to pass its
// bucket/key here.
async function recordObservation(sourceId, obs) {
  const prev = (await q(
    `SELECT id, content_fingerprint FROM public.wt_observations
     WHERE source_id = $1 AND error IS NULL AND content_fingerprint IS NOT NULL
     ORDER BY observed_at DESC LIMIT 1`,
    [sourceId],
  )).rows[0] || null;

  const fp = obs.content != null ? fingerprint(obs.content) : (obs.content_fingerprint || null);
  const changed = Boolean(fp && (!prev || prev.content_fingerprint !== fp));

  const res = await q(`
    INSERT INTO public.wt_observations
      (source_id, observed_at, published_at, http_status, content_fingerprint, content_bytes,
       s3_bucket, s3_key, normalised_excerpt, changed, previous_observation_id, error)
    VALUES ($1, COALESCE($2, NOW()), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    RETURNING *
  `, [
    sourceId, obs.observed_at || null, obs.published_at || null, obs.http_status ?? null,
    fp, obs.content != null ? Buffer.byteLength(String(obs.content)) : (obs.content_bytes ?? null),
    obs.s3_bucket || null, obs.s3_key || null,
    obs.normalised_excerpt || (obs.content ? String(obs.content).slice(0, 500) : null),
    changed, prev ? prev.id : null, obs.error || null,
  ]);

  await q(`
    UPDATE public.wt_sources
    SET last_crawled_at = NOW(),
        last_success_at = CASE WHEN $2::text IS NULL THEN NOW() ELSE last_success_at END,
        last_error = $2
    WHERE id = $1
  `, [sourceId, obs.error || null]);

  return {
    observation: res.rows[0],
    changed,
    previous_observation_id: prev ? prev.id : null,
    previous_fingerprint: prev ? prev.content_fingerprint : null,
  };
}

// Attach S3 snapshot references to an observation after the raw + metadata
// objects have been written. Kept separate so a snapshot upload failure never
// blocks the observation row from being persisted.
async function updateObservationSnapshot(observationId, { s3_bucket, s3_key, raw_s3_key }) {
  const res = await q(`
    UPDATE public.wt_observations
    SET s3_bucket = COALESCE($2, s3_bucket),
        s3_key = COALESCE($3, s3_key),
        raw_s3_key = COALESCE($4, raw_s3_key)
    WHERE id = $1
    RETURNING *
  `, [observationId, s3_bucket || null, s3_key || null, raw_s3_key || null]);
  return res.rows[0] || null;
}

// ── signals ──────────────────────────────────────────
// Dedup: (source_id, content_fingerprint). A re-observation of identical
// content never creates a second signal.
async function createSignal(sig) {
  if (!sig || !sig.source_id) throw Object.assign(new Error('source_id is required'), { status: 400 });
  const fp = sig.content_fingerprint || (sig.raw_text ? fingerprint(sig.raw_text) : fingerprint(`${sig.title}|${sig.summary}|${sig.change_description}`));
  const res = await q(`
    INSERT INTO public.wt_signals
      (source_id, observation_id, observed_at, published_at, title, summary, signal_type,
       change_description, novelty, relevance, confidence, entities, content_fingerprint, raw, status)
    VALUES ($1,$2,COALESCE($3,NOW()),$4,$5,$6,$7,$8,COALESCE($9,'NEW'),$10,COALESCE($11,'MODERATE'),
            COALESCE($12,'[]'::jsonb),$13,$14,'NEW')
    ON CONFLICT (source_id, content_fingerprint) DO NOTHING
    RETURNING *
  `, [
    sig.source_id, sig.observation_id || null, sig.observed_at || null, sig.published_at || null,
    sig.title || null, sig.summary || null, sig.signal_type || null, sig.change_description || null,
    sig.novelty || null, sig.relevance || null, sig.confidence || null,
    sig.entities ? JSON.stringify(sig.entities) : null, fp,
    sig.raw ? JSON.stringify(sig.raw) : null,
  ]);
  if (res.rows[0]) return { signal: res.rows[0], created: true };
  const existing = (await q('SELECT * FROM public.wt_signals WHERE source_id = $1 AND content_fingerprint = $2', [sig.source_id, fp])).rows[0];
  return { signal: existing, created: false };
}

async function listSignals({ limit, since, status } = {}) {
  const where = [];
  const params = [];
  if (since) { params.push(since); where.push(`created_at >= $${params.length}`); }
  if (status) { params.push(status); where.push(`status = $${params.length}`); }
  params.push(clampLimit(limit, 25, 200));
  const res = await q(
    `SELECT * FROM public.wt_signals ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return res.rows;
}

// Per-tenant relevance / interpretation overlay on a global signal. Isolated
// by tenant_id; nothing here is visible to another tenant.
async function upsertTenantSignalRelevance(tenantSlug, signalId, patch = {}) {
  const tenant = await resolveTenant(tenantSlug);
  const res = await q(`
    INSERT INTO public.tenant_signal_relevance
      (tenant_id, signal_id, relevance_score, interpretation, linked_decision_ids, linked_memory_ids, status, reviewed_by)
    VALUES ($1,$2,$3,$4,COALESCE($5,'{}'::uuid[]),COALESCE($6,'{}'::uuid[]),COALESCE($7,'NEW'),$8)
    ON CONFLICT (tenant_id, signal_id) DO UPDATE SET
      relevance_score = COALESCE(EXCLUDED.relevance_score, tenant_signal_relevance.relevance_score),
      interpretation  = COALESCE(EXCLUDED.interpretation, tenant_signal_relevance.interpretation),
      linked_decision_ids = CASE WHEN $5 IS NULL THEN tenant_signal_relevance.linked_decision_ids ELSE EXCLUDED.linked_decision_ids END,
      linked_memory_ids   = CASE WHEN $6 IS NULL THEN tenant_signal_relevance.linked_memory_ids ELSE EXCLUDED.linked_memory_ids END,
      status = COALESCE(EXCLUDED.status, tenant_signal_relevance.status),
      reviewed_by = COALESCE(EXCLUDED.reviewed_by, tenant_signal_relevance.reviewed_by),
      updated_at = NOW()
    RETURNING *
  `, [
    tenant, signalId, patch.relevance_score ?? null, patch.interpretation || null,
    patch.linked_decision_ids || null, patch.linked_memory_ids || null,
    patch.status || null, patch.reviewed_by || null,
  ]);
  return res.rows[0];
}

async function listTenantSignals(tenantSlug, { limit } = {}) {
  const tenant = await resolveTenant(tenantSlug);
  const res = await q(`
    SELECT s.*, r.relevance_score AS tenant_relevance_score, r.interpretation AS tenant_interpretation,
           r.status AS tenant_status, r.linked_decision_ids, r.linked_memory_ids
    FROM public.wt_signals s
    LEFT JOIN public.tenant_signal_relevance r ON r.signal_id = s.id AND r.tenant_id = $1
    ORDER BY s.created_at DESC
    LIMIT $2
  `, [tenant, clampLimit(limit, 25, 200)]);
  return res.rows;
}

module.exports = {
  fingerprint,
  registerSource, updateSource, listSources, getDueSources,
  recordObservation, updateObservationSnapshot,
  createSignal, listSignals, upsertTenantSignalRelevance, listTenantSignals,
  SOURCE_TYPES,
};
