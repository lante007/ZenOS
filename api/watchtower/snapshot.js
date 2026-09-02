'use strict';

// api/watchtower/snapshot.js
// Immutable raw + metadata snapshot retention in S3, so an observation can be
// reconstructed later from what Auxeira actually captured, not from whatever
// the live URL returns today. Separate data class from Zenex evidence
// ingestion: it lives under the watchtower/ prefix and never touches
// raw/documents/ or processed/.

const { uploadBuffer, uploadJson, downloadFile } = require('../../src/s3-connector');
const cfg = require('./config');

const EXT_BY_CT = {
  'text/html': 'html', 'application/xhtml+xml': 'html',
  'application/json': 'json', 'application/xml': 'xml', 'text/xml': 'xml',
  'application/rss+xml': 'xml', 'application/atom+xml': 'xml',
  'text/plain': 'txt',
};

function extFor(contentType) {
  return EXT_BY_CT[String(contentType || '').toLowerCase()] || 'bin';
}

// Writes:
//   watchtower/snapshots/<sourceId>/<observationId>.<ext>   raw fetched body (capped)
//   watchtower/observations/<sourceId>/<observationId>.json  metadata + normalised text + fingerprint
// Returns { raw: {bucket,key}, meta: {bucket,key} }.
async function storeSnapshot({ sourceId, observationId, rawBody, contentType, normalisedText, title, meta }) {
  const rawKey = `${cfg.s3Prefix}snapshots/${sourceId}/${observationId}.${extFor(contentType)}`;
  const metaKey = `${cfg.s3Prefix}observations/${sourceId}/${observationId}.json`;

  const raw = await uploadBuffer({
    bucket: cfg.s3Bucket,
    key: rawKey,
    body: Buffer.from(String(rawBody || '').slice(0, cfg.snapshotStoreChars), 'utf8'),
    contentType: contentType || 'application/octet-stream',
    metadata: { source_id: sourceId, observation_id: observationId, class: 'watchtower-raw' },
  });

  const metaObj = await uploadJson({
    bucket: cfg.s3Bucket,
    key: metaKey,
    data: {
      class: 'watchtower-observation',
      source_id: sourceId,
      observation_id: observationId,
      observed_at: meta.observed_at,
      url: meta.url,
      http_status: meta.http_status,
      content_type: contentType,
      content_fingerprint: meta.content_fingerprint,
      content_bytes: meta.content_bytes,
      published_at: meta.published_at || null,
      title: title || null,
      raw_snapshot_s3_key: rawKey,
      normalised_text: String(normalisedText || '').slice(0, cfg.snapshotStoreChars),
    },
    metadata: { source_id: sourceId, observation_id: observationId, class: 'watchtower-observation' },
  });

  return { raw, meta: metaObj, raw_s3_key: rawKey, meta_s3_key: metaKey };
}

// Reconstruct the normalised text of an observation from its stored metadata
// object (used by tests and future provenance UIs).
async function reconstructObservation(metaS3Key) {
  const buf = await downloadFile(metaS3Key, null, { bucket: cfg.s3Bucket });
  return JSON.parse(buf.toString('utf8'));
}

module.exports = { storeSnapshot, reconstructObservation, extFor };
