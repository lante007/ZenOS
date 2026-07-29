#!/usr/bin/env node
'use strict';
/**
 * ADEI Ingestion Engine — Main Orchestrator
 * Auxeira EvidenceOS v1.0
 *
 * Usage:
 *   node adei-ingest.js --s3-prefix raw/documents/ # Full S3 batch
 *   node adei-ingest.js --s3-key <key>             # Single S3 document
 *   node adei-ingest.js --s3-key <key> --dry-run   # No DB write
 *   node adei-ingest.js --s3-prefix raw/documents/ --verbose
 *
 * Pipeline (8 steps, never stops mid-batch):
 *   1. Pre-scan and cluster mapping
 *   2. Data cleaning and rights check
 *   3. Programme detection
 *   4. Claude Sonnet classification (Anthropic API)
 *   5. Three-tier resolution (deterministic → Bedrock → Fatima queue)
 *   6. EQS scoring
 *   7. L3 computation (Evidence Capital, half-life, commissioning standards)
 *   8. Database write + batch report
 */

require('dotenv').config();
const { program } = require('commander');
const connector = require('./src/s3-connector');
const { extractText, isSupportedType } = require('./src/text-extractor');
const { detectProgramme } = require('./src/programme-detector');
const { classifyDocument } = require('./src/claude-classifier');
const { computeEQS, computeEvidenceCapital } = require('./src/eqs-scorer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

program
  .option('--s3-prefix <prefix>', 'S3 prefix for batch processing')
  .option('--s3-key <key>', 'Single S3 object key')
  .option('--tenant <slug>', 'Tenant slug for S3 bucket selection', process.env.EVIDENCEOS_TENANT || 'zenex')
  .option('--institution <name>', 'Client institution name', 'Zenex Foundation')
  .option('--mode <mode>', 'single | batch', 'batch')
  .option('--dry-run', 'Classify without writing to database', false)
  .option('--verbose', 'Verbose logging', false)
  .option('--output <path>', 'Output directory for results', './output')
  .parse(process.argv);

const opts = program.opts();
const log = (msg, level = 'INFO') => {
  const ts = new Date().toISOString().substring(11, 19);
  if (level === 'DEBUG' && !opts.verbose) return;
  console.log(`[${ts}] [${level}] ${msg}`);
};

// ─── Tier 1: Deterministic Rules ───────────────────────────────────────
function applyTier1Fallback(field, filename, programme) {
  const fn = filename.toLowerCase();
  const rules = {
    document_type: () => {
      if (/endline|final (evaluation|report)|summative/i.test(fn)) return { value: 'Impact Evaluation', confidence: 0.85 };
      if (/baseline|midline|inception|progress report/i.test(fn)) return { value: 'Process Evaluation', confidence: 0.85 };
      if (/literature review|landscape analysis|learning brief|review of/i.test(fn)) return { value: 'Research Study', confidence: 0.95 };
      return null;
    },
    year: () => {
      const match = fn.match(/20[12]\d/);
      if (match) return { value: match[0], confidence: 0.80 };
      return null;
    },
    programme_name: () => {
      if (programme && programme !== 'Unknown') return { value: programme, confidence: 0.90 };
      return null;
    },
  };
  const rule = rules[field];
  return rule ? rule() : null;
}

// ─── Three-Tier Resolution ──────────────────────────────────────────────
async function resolveField(field, claudeValue, claudeConf, text, filename, programme) {
  // Tier 1: If Claude confidence is high enough
  if (claudeConf >= 0.75) {
    return { value: claudeValue, confidence: claudeConf, tier: 1 };
  }

  // Tier 1 fallback: deterministic rules
  const t1 = applyTier1Fallback(field, filename, programme);
  if (t1 && t1.confidence >= 0.80) {
    return { ...t1, tier: 1 };
  }

  // Tier 2: Would call Bedrock here for complex ambiguities
  // For MVP, use Claude confidence as-is with medium confidence flag
  if (claudeConf >= 0.50) {
    return { value: claudeValue, confidence: claudeConf, tier: 2, pending: false };
  }

  // Tier 3: Fatima queue
  const fallbackValue = claudeValue || (t1 ? t1.value : 'NOT_REPORTED');
  return {
    value: fallbackValue,
    confidence: claudeConf || 0.4,
    tier: 3,
    pending: true,
  };
}

// ─── Process a single document ─────────────────────────────────────────
async function processDocument(file, opts, batchId, outputDir, processedHashes) {
  const { id: fileId, name: filename, mimeType, size } = file;
  const fileSlug = crypto.createHash('sha1').update(fileId).digest('hex').substring(0, 10).toUpperCase();
  const step = (n, msg) => log(`[${n}/8] ${filename.substring(0, 50)}: ${msg}`);

  const result = {
    file_id: fileId,
    filename,
    batch_id: batchId,
    status: 'failed',
    flags: [],
  };

  try {
    // STEP 1: Intake
    step(1, 'Intake');
    if (!isSupportedType(mimeType)) {
      result.status = 'skipped';
      result.flags.push('UNSUPPORTED_FORMAT');
      return result;
    }

    // STEP 2: Download and rights check
    step(2, 'Download and rights check');
    const buffer = await connector.downloadFile(fileId, mimeType, { tenant: opts.tenant });

    // STEP 3: Extract and clean text
    step(3, 'Text extraction and data cleaning');
    const extraction = await extractText(buffer, mimeType, filename);

    if (extraction.quality === 'FAILED') {
      result.status = 'failed';
      result.flags.push('EXTRACTION_FAILED');
      return result;
    }

    // Duplicate detection
    if (processedHashes.has(extraction.hash)) {
      result.status = 'skipped';
      result.flags.push('DUPLICATE');
      return result;
    }
    processedHashes.add(extraction.hash);

    result.extraction_quality = extraction.quality;
    result.rights_status = extraction.rights;

    // STEP 4: Programme detection
    step(4, 'Programme detection');
    const detection = detectProgramme(filename, extraction.text.substring(0, 500));
    result.programme = detection.programme;
    result.role = detection.role;
    result.phase = detection.phase;
    result.processing_order = detection.processingOrder;

    // STEP 5: Claude classification
    step(5, 'Claude Sonnet classification');
    const { classification, usage } = await classifyDocument({
      filename,
      text: extraction.text,
      programme: detection.programme,
      role: detection.role,
      phase: detection.phase,
      institution: opts.institution,
    });

    result.api_usage = usage;

    // Apply three-tier resolution to key fields
    const fatimaQueue = [];
    const resolved = {};

    for (const [field, value] of Object.entries(classification)) {
      if (field === 'confidence_scores') continue;
      const conf = (classification.confidence_scores || {})[field] || 0.75;
      const resolution = await resolveField(field, value, conf, extraction.text, filename, detection.programme);
      resolved[field] = resolution;
      if (resolution.pending) {
        fatimaQueue.push({ field, claudeValue: value, claudeConf: conf, systemRecommendation: resolution.value });
      }
    }

    result.classification = resolved;
    result.fatima_queue_items = fatimaQueue.length;

    // STEP 6: EQS Scoring
    step(6, 'EQS scoring');
    const flatClassification = Object.fromEntries(
      Object.entries(resolved).map(([k, v]) => [k, v.value])
    );
    const eqs = computeEQS(flatClassification);
    result.eqs = eqs;

    // STEP 7: L3 computation
    step(7, 'L3 computation');
    const evidenceCapital = computeEvidenceCapital(eqs, flatClassification);
    result.evidence_capital = evidenceCapital;
    result.confidence_tier = eqs.confidence_tier;

    // STEP 8: Write output
    step(8, 'Writing output');
    if (!opts.dryRun) {
      const outputFile = path.join(outputDir, `${fileSlug}.json`);
      const record = {
        adei_record_id: `ADEI-${opts.institution.substring(0,2).toUpperCase()}-${fileSlug}`,
        tenant_id: opts.tenant,
        file_id: fileId,
        s3_key: file.key || (opts.s3Key ? fileId : null),
        filename,
        batch_id: batchId,
        institution: opts.institution,
        programme: detection.programme,
        role: detection.role,
        phase: detection.phase,
        extraction_quality: extraction.quality,
        rights_status: extraction.rights,
        classification: flatClassification,
        eqs,
        evidence_capital: evidenceCapital,
        eqs_scoring_pathway: eqs.eqs_scoring_pathway,
        eqs_pathway: eqs.eqs_pathway,
        eqs_version: eqs.eqs_version,
        pathway_multiplier: eqs.pathway_multiplier,
        fatima_queue: fatimaQueue,
        api_usage: usage,
        classified_at: new Date().toISOString(),
        taxonomy_version: 'v2.1',
        scoring_logic_version: eqs.eqs_version || 'v0.2',
        status: 'PENDING_REVIEW',
      };
      fs.writeFileSync(outputFile, JSON.stringify(record, null, 2));

      if (opts.s3Prefix || opts.s3Key) {
        await connector.uploadJson({
          tenant: opts.tenant,
          key: `processed/records/${record.adei_record_id}.json`,
          data: record,
          metadata: { tenant: opts.tenant, record_id: record.adei_record_id },
        });
      }
    }

    result.status = fatimaQueue.length > 0 ? 'pending_fatima' : 'complete';
    log(`  ✓ ${filename.substring(0, 50)} → ${eqs.confidence_tier || 'N/A'} | EQS ${eqs.eqs_composite || 'N/A'} | ${fatimaQueue.length} queue items`);
    return result;

  } catch (err) {
    log(`  ✗ ${filename.substring(0, 50)}: ${err.message}`, 'ERROR');
    result.status = 'failed';
    result.error = err.message;
    return result;
  }
}

// ─── Main orchestrator ─────────────────────────────────────────────────
async function main() {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  AUXEIRA ADEI INGESTION ENGINE v1.0');
  console.log('  Evidence intelligence infrastructure for philanthropy');
  console.log('══════════════════════════════════════════════════════\n');

  if (!opts.s3Prefix && !opts.s3Key) {
    console.error('Error: provide --s3-prefix or --s3-key');
    process.exit(1);
  }

  // Create output directory
  const outputDir = path.resolve(opts.output);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const batchId = `BATCH-${Date.now()}`;
  const batchStart = Date.now();
  const processedHashes = new Set();
  const results = [];

  log(`Batch ID: ${batchId}`);
  log(`Institution: ${opts.institution}`);
  log(`Tenant: ${opts.tenant}`);
  log(`Dry run: ${opts.dryRun}`);
  log(`Output: ${outputDir}\n`);

  // Get files to process
  let files = [];
  if (opts.s3Key) {
    const meta = await connector.getFileMetadata(opts.s3Key, { tenant: opts.tenant });
    files = [meta];
    log(`Single file mode: ${meta.name}`);
  } else {
    log(`Scanning S3 prefix: ${opts.s3Prefix}`);
    files = await connector.listFolderFiles(opts.s3Prefix, { tenant: opts.tenant });

    // PRE-SCAN: Sort by processing order (parents first)
    const { detectProgramme: dp } = require('./src/programme-detector');
    files = files.map(f => {
      const det = dp(f.name, '');
      return { ...f, _order: det.processingOrder };
    }).sort((a, b) => a._order - b._order);

    log(`Pre-scan complete. Processing ${files.length} files (parents → children → research)\n`);
  }

  // Process each file — pipeline NEVER stops
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    log(`\n[${i + 1}/${files.length}] Processing: ${file.name}`);
    try {
      const result = await processDocument(file, opts, batchId, outputDir, processedHashes);
      results.push(result);
    } catch (err) {
      // Catch-all — processing continues regardless
      log(`BATCH CONTINUE after error on ${file.name}: ${err.message}`, 'ERROR');
      results.push({
        file_id: file.id,
        filename: file.name,
        status: 'failed',
        error: err.message,
        batch_id: batchId,
      });
    }

    // Rate limiting — respect Anthropic API limits
    if (i < files.length - 1) await new Promise(r => setTimeout(r, 1000));
  }

  // ─── Batch reconciliation report ───────────────────────────────────
  const batchDuration = Math.round((Date.now() - batchStart) / 1000);
  const summary = {
    batch_id: batchId,
    institution: opts.institution,
    total_files: results.length,
    complete: results.filter(r => r.status === 'complete').length,
    pending_fatima: results.filter(r => r.status === 'pending_fatima').length,
    skipped: results.filter(r => r.status === 'skipped').length,
    failed: results.filter(r => r.status === 'failed').length,
    duration_seconds: batchDuration,
    tier_1_documents: results.filter(r => r.confidence_tier === 'TIER_1').length,
    tier_2_documents: results.filter(r => r.confidence_tier === 'TIER_2').length,
    tier_3_documents: results.filter(r => r.confidence_tier === 'TIER_3').length,
    completed_at: new Date().toISOString(),
  };

  // Write batch summary
  fs.writeFileSync(
    path.join(outputDir, `batch-summary-${batchId}.json`),
    JSON.stringify(summary, null, 2)
  );

  // Write CSV report
  const csv = [
    'file_id,filename,status,programme,role,confidence_tier,eqs_composite,fatima_queue_items,extraction_quality,flags',
    ...results.map(r => [
      r.file_id,
      `"${(r.filename || '').replace(/"/g, '""')}"`,
      r.status,
      `"${r.programme || ''}"`,
      r.role || '',
      r.confidence_tier || '',
      r.eqs?.eqs_composite || '',
      r.fatima_queue_items || 0,
      r.extraction_quality || '',
      `"${(r.flags || []).join(';')}"`,
    ].join(','))
  ].join('\n');

  fs.writeFileSync(path.join(outputDir, `batch-report-${batchId}.csv`), csv);

  // Print summary
  console.log('\n══════════════════════════════════════════════════════');
  console.log(`  BATCH COMPLETE — ${batchDuration}s`);
  console.log('══════════════════════════════════════════════════════');
  console.log(`  ✓ Complete:       ${summary.complete}`);
  console.log(`  ⏳ Fatima queue:  ${summary.pending_fatima}`);
  console.log(`  ⏭ Skipped:       ${summary.skipped}`);
  console.log(`  ✗ Failed:        ${summary.failed}`);
  console.log(`  Tier 1: ${summary.tier_1_documents} | Tier 2: ${summary.tier_2_documents} | Tier 3: ${summary.tier_3_documents}`);
  console.log(`\n  Output: ${outputDir}`);
  console.log(`  Summary: batch-summary-${batchId}.json`);
  console.log(`  Report:  batch-report-${batchId}.csv`);
  console.log('══════════════════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('\nFATAL:', err.message);
  process.exit(1);
});
