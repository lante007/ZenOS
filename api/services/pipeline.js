'use strict';

const crypto = require('crypto');
const { extractText } = require('../../src/text-extractor');
const { detectProgramme } = require('../../src/programme-detector');
const { classifyDocument } = require('../../src/claude-classifier');
const { computeEQS, computeEvidenceCapital } = require('../../src/eqs-scorer');
const db = require('./db');
const localStore = require('./local-store');
const storage = require('./storage');

function normalizeValue(value) {
  if (value === undefined) return null;
  return value;
}

function buildRecordId(tenant, sourceId) {
  const source = sourceId ? crypto.createHash('sha1').update(sourceId).digest('hex').substring(0, 8) : Date.now().toString(36);
  return `ADEI-${tenant.slug.toUpperCase()}-${source.toUpperCase()}`;
}

async function classifyBuffer({ tenant, buffer, filename, mimeType, user, s3Document }) {
  const extraction = await extractText(buffer, mimeType, filename);
  if (extraction.quality === 'FAILED') throw new Error('Text extraction failed');

  const detection = detectProgramme(filename, extraction.text.substring(0, 500));
  const { classification, usage } = await classifyDocument({
    filename,
    text: extraction.text,
    programme: detection.programme,
    role: detection.role,
    phase: detection.phase,
    institution: tenant.name,
  });

  const eqs = computeEQS(classification);
  const evidenceCapital = computeEvidenceCapital(eqs, classification);
  const queueItems = [];
  const confs = classification.confidence_scores || {};

  for (const [field, value] of Object.entries(classification)) {
    if (field === 'confidence_scores') continue;
    const confidence = confs[field] == null ? 0.75 : confs[field];
    if (confidence < 0.5) {
      queueItems.push({
        field,
        claudeValue: value,
        claudeConf: confidence,
        systemRecommendation: normalizeValue(value),
      });
    }
  }

  const recordId = buildRecordId(tenant, s3Document?.key || filename);
  const flat = { ...classification };
  delete flat.confidence_scores;

  const record = {
    id: recordId,
    adei_record_id: recordId,
    tenant_id: tenant.slug,
    filename,
    institution: tenant.name,
    programme: detection.programme,
    role: detection.role,
    ...flat,
    programme_name: flat.programme_name || detection.programme,
    phase: flat.phase || detection.phase,
    extraction_quality: extraction.quality,
    rights_status: extraction.rights,
    eqs_composite: eqs.eqs_composite,
    confidence_tier: eqs.confidence_tier || 'N_A',
    dimensions: eqs.dimensions,
    evidence_capital_score: evidenceCapital?.evidence_capital_score || null,
    half_life_rating: evidenceCapital?.half_life_rating || null,
    policy_relevance_weight: evidenceCapital?.policy_relevance_weight || null,
    sroi_eligible: eqs.sroi_eligible || false,
    board_citable: eqs.board_citable || false,
    classification_confidence: confs,
    fatima_queue: queueItems,
    fatima_queue_items: queueItems.length,
    api_usage: usage,
    classified_at: new Date().toISOString(),
    taxonomy_version: 'v2.1',
    scoring_logic_version: 'v0.2',
    status: queueItems.length > 0 ? 'PENDING_REVIEW' : 'COMPLETE',
    classified_by: user?.email || 'system',
  };

  await storage.uploadProcessedText({ tenant, recordId, text: extraction.text });
  await storage.uploadProcessedRecord({ tenant, record });

  const document = s3Document ? {
    s3_key: s3Document.key,
    filename,
    mime_type: mimeType,
    file_size_bytes: buffer.length,
    file_hash: extraction.hash,
  } : {};

  if (process.env.DATABASE_URL) {
    await db.createRecord(tenant, record, document);
  } else {
    localStore.saveRecord(tenant, record);
    localStore.addQueueItems(tenant, record, queueItems);
  }

  return record;
}

module.exports = { classifyBuffer };
