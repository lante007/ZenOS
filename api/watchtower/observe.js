'use strict';

// api/watchtower/observe.js
// One reliable vertical slice:
//   fetch -> normalise -> fingerprint -> compare with previous -> persist
//   observation -> retain S3 snapshot -> create a signal only on a real change.
//
// Deterministic end to end. No LLM. External content is data only.

const wt = require('../memory/watchtower');
const { fetchSource } = require('./fetcher');
const { normalise } = require('./normalise');
const { storeSnapshot } = require('./snapshot');
const cfg = require('./config');

const SIGNAL_TYPE_BY_SOURCE = {
  government: 'policy_change',
  policy: 'policy_change',
  funder: 'funding_change',
  organisation: 'org_change',
  research: 'publication',
  dataset: 'dataset_update',
  news: 'news',
  social: 'social',
};

function shortFp(fp) {
  return fp ? String(fp).slice(0, 12) : 'none';
}

// Observe a single source. Never throws: returns a structured result.
async function observeSource(source) {
  const startedAt = Date.now();
  const base = { source_id: source.id, source_name: source.name, url: source.url };

  // 1. fetch (bounded, deterministic)
  const fetched = await fetchSource(source);

  // 2. failed fetch -> persist the failure, do not touch the last success
  if (!fetched.ok) {
    const rec = await wt.recordObservation(source.id, {
      http_status: fetched.http_status,
      error: fetched.error || 'fetch failed',
    });
    return {
      ...base, status: 'fetch_failed', error: fetched.error,
      http_status: fetched.http_status, observation_id: rec.observation.id,
      changed: false, signal_id: null, snapshot: null, duration_ms: Date.now() - startedAt,
    };
  }

  // 3. normalise + fingerprint
  const { text, title } = normalise(fetched.body, fetched.content_type);
  const fingerprint = wt.fingerprint(text);

  // 4. persist observation (this computes `changed` vs the previous success)
  const rec = await wt.recordObservation(source.id, {
    content: text,
    content_fingerprint: fingerprint,
    http_status: fetched.http_status,
    published_at: fetched.published_at,
    normalised_excerpt: text.slice(0, cfg.normalisedExcerptChars),
  });
  const observationId = rec.observation.id;
  const isFirst = !rec.previous_observation_id;

  // 5. retain immutable snapshot (raw + metadata + normalised text)
  let snapshot = null;
  try {
    const s = await storeSnapshot({
      sourceId: source.id,
      observationId,
      rawBody: fetched.body,
      contentType: fetched.content_type,
      normalisedText: text,
      title,
      meta: {
        observed_at: rec.observation.observed_at,
        url: source.url,
        http_status: fetched.http_status,
        content_fingerprint: fingerprint,
        content_bytes: fetched.bytes,
        published_at: fetched.published_at,
      },
    });
    await wt.updateObservationSnapshot(observationId, {
      s3_bucket: cfg.s3Bucket, s3_key: s.meta_s3_key, raw_s3_key: s.raw_s3_key,
    });
    snapshot = { bucket: cfg.s3Bucket, meta_key: s.meta_s3_key, raw_key: s.raw_s3_key };
  } catch (e) {
    // Snapshot failure must not lose the observation. Record and continue.
    snapshot = { error: e.message };
  }

  // 6. signal only on a real change (never on the first/baseline observation)
  let signalId = null;
  let signalCreated = false;
  if (rec.changed && !isFirst) {
    const prevFp = rec.previous_fingerprint;
    const sig = await wt.createSignal({
      source_id: source.id,
      observation_id: observationId,
      observed_at: rec.observation.observed_at,
      published_at: fetched.published_at,
      title: title || `${source.name}: content changed`,
      summary: `Observed content of ${source.name} changed since the previous observation.`,
      signal_type: SIGNAL_TYPE_BY_SOURCE[source.source_type] || 'other',
      change_description: `Content changed since previous observation. Previous fingerprint ${shortFp(prevFp)} -> current ${shortFp(fingerprint)}. Source credibility: ${source.credibility}.`,
      novelty: 'CHANGED',
      relevance: null,
      confidence: 'MODERATE', // SIGNAL confidence: something was observed to change. NOT evidence confidence.
      entities: [],
      content_fingerprint: fingerprint,
      raw: {
        previous_observation_id: rec.previous_observation_id,
        previous_fingerprint: prevFp,
        current_observation_id: observationId,
        current_fingerprint: fingerprint,
        source_type: source.source_type,
        observed_via: 'watchtower_worker',
      },
    });
    signalId = sig.signal && sig.signal.id;
    signalCreated = sig.created;
  }

  return {
    ...base,
    status: 'ok',
    http_status: fetched.http_status,
    observation_id: observationId,
    is_first: isFirst,
    changed: rec.changed,
    fingerprint: shortFp(fingerprint),
    signal_id: signalId,
    signal_created: signalCreated,
    snapshot,
    bytes: fetched.bytes,
    truncated: Boolean(fetched.truncated),
    duration_ms: Date.now() - startedAt,
  };
}

module.exports = { observeSource };
