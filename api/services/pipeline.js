'use strict';

const crypto = require('crypto');
const { extractText } = require('../../src/text-extractor');
const { detectProgramme } = require('../../src/programme-detector');
const {
  classifyPass1,
  classifyPass2,
  mergeClassification,
  validateClassification,
  needsPass2: checkNeedsPass2,
} = require('../../src/claude-classifier');
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

  if (process.env.DATABASE_URL) {
    const pool = db.getPool();
    const schema = tenant.db_schema || tenant.slug || 'zenex';
    const existingDoc = await pool.query(`
      SELECT d.id, d.filename, COALESCE(r.record_status, d.ingestion_status) AS record_status
      FROM ${schema}.documents d
      LEFT JOIN ${schema}.intelligence_records r
        ON r.document_id = d.id
      WHERE d.tenant_id = $1
        AND (
          d.file_hash = $2
          OR d.filename = $3
        )
      LIMIT 1
    `, [tenant.slug, extraction.hash, filename]);

    if (existingDoc.rows.length > 0) {
      const duplicate = new Error('duplicate_detected');
      duplicate.code = 'DUPLICATE_DOCUMENT';
      duplicate.existingDocument = existingDoc.rows[0];
      throw duplicate;
    }
  }

  const detection = detectProgramme(filename, extraction.text.substring(0, 500));

  // Minimum text gate before Claude call. Use fullText (not the legacy
  // pre-truncated extraction.text) so this reflects genuine content volume.
  const fullText = extraction.fullText || extraction.text;
  if (fullText.length < 2000) {
    throw new Error(`Insufficient text for classification: ${fullText.length} chars`);
  }

  const { pass1, usage: usage1 } = await classifyPass1({
    filename,
    text: fullText,
    programme: detection.programme,
    role: detection.role,
    phase: detection.phase,
    institution: tenant.name,
  });

  const requiresPass2 = checkNeedsPass2(pass1.document_type);
  let pass2 = null;
  let usage2 = null;
  if (requiresPass2) {
    const result2 = await classifyPass2({ text: fullText, pass1 });
    pass2 = result2.pass2;
    usage2 = result2.usage;
  }

  const flags = validateClassification(pass1, pass2, extraction.quality);
  const classification = mergeClassification(pass1, pass2, flags);
  const usage = {
    input_tokens: usage1.input_tokens + (usage2 ? usage2.input_tokens : 0),
    output_tokens: usage1.output_tokens + (usage2 ? usage2.output_tokens : 0),
    input_words: usage1.input_words + (usage2 ? usage2.input_words : 0),
    output_words: usage1.output_words + (usage2 ? usage2.output_words : 0),
    latency_ms: usage1.latency_ms + (usage2 ? usage2.latency_ms : 0),
    model: usage1.model,
    bedrock_agent: false,
  };

  const eqs = computeEQS(classification, { flags, extractionQuality: extraction.quality });
  const evidenceCapital = computeEvidenceCapital(eqs, classification);
  const queueItems = [];
  const confs = classification.confidence_scores || {};

  for (const [field, value] of Object.entries(classification)) {
    if (field === 'confidence_scores' || field === 'validation_flags') continue;
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
    eqs_scoring_pathway: eqs.eqs_scoring_pathway,
    eqs_pathway: eqs.eqs_pathway,
    eqs_version: eqs.eqs_version,
    pathway_multiplier: eqs.pathway_multiplier,
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
    scoring_logic_version: eqs.eqs_version || 'v0.2',
    status: queueItems.length > 0 ? 'PENDING_REVIEW' : 'COMPLETE',
    classified_by: user?.email || 'system',
    extraction_pass: 1,
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

/**
 * Phase B8 utility: skip re-classifying a record a human has already
 * confirmed. Not used during B6 new-document ingestion (new documents
 * always create new records, so there is nothing to preserve yet).
 */
function shouldSkipManuallyConfirmed(existingRecord) {
  if (!existingRecord) return false;
  if (existingRecord.manually_confirmed === true) {
    console.log('Skipping manually confirmed record:', existingRecord.id);
    return true;
  }
  if (existingRecord.manually_confirmed_at != null) {
    console.log('Skipping manually confirmed record:', existingRecord.id);
    return true;
  }
  return false;
}

module.exports = { classifyBuffer, shouldSkipManuallyConfirmed };
