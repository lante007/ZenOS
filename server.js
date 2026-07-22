'use strict';
/**
 * EvidenceOS API Server — Zenex Foundation
 * Auxeira · Evidence intelligence infrastructure for philanthropy
 *
 * Routes:
 *   GET  /api/health
 *   GET  /api/stats
 *   GET  /api/records
 *   GET  /api/records/:id
 *   POST /api/classify          { file_id, institution }
 *   POST /api/classify/upload   multipart file upload
 *   GET  /api/queue
 *   POST /api/queue/:id/resolve { value, override }
 *   POST /api/knowledge-product { record_id, audience }
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const { downloadFile, getFileMetadata } = require('./src/drive-connector');
const { extractText } = require('./src/text-extractor');
const { detectProgramme } = require('./src/programme-detector');
const { classifyDocument, generateKnowledgeProduct } = require('./src/claude-classifier');
const { computeEQS, computeEvidenceCapital } = require('./src/eqs-scorer');

const app = express();
const upload = multer({ dest: '/tmp/adei-uploads/' });
const OUTPUT_DIR = path.resolve('./output');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

app.use(cors());
app.use(express.json());

// Serve the frontend from /web
app.use(express.static(path.join(__dirname, 'web')));

// ── HELPERS ───────────────────────────────────────────────────
function loadRecords() {
  if (!fs.existsSync(OUTPUT_DIR)) return [];
  return fs.readdirSync(OUTPUT_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('batch'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, f), 'utf8')); }
      catch { return null; }
    })
    .filter(Boolean);
}

function loadQueue() {
  const queueFile = path.join(OUTPUT_DIR, 'fatima-queue.json');
  if (!fs.existsSync(queueFile)) return [];
  try { return JSON.parse(fs.readFileSync(queueFile, 'utf8')); }
  catch { return []; }
}

function saveQueue(queue) {
  fs.writeFileSync(path.join(OUTPUT_DIR, 'fatima-queue.json'), JSON.stringify(queue, null, 2));
}

async function runPipeline(buffer, filename, mimeType, institution) {
  const extraction = await extractText(buffer, mimeType, filename);
  if (extraction.quality === 'FAILED') throw new Error('Text extraction failed');

  const detection = detectProgramme(filename, extraction.text.substring(0, 500));
  const { classification, usage } = await classifyDocument({
    filename, text: extraction.text,
    programme: detection.programme,
    role: detection.role,
    phase: detection.phase,
  });

  const eqs = computeEQS(classification);
  const ec = computeEvidenceCapital(eqs, classification);

  const fatimaQueue = [];
  const confs = classification.confidence_scores || {};
  for (const [field, value] of Object.entries(classification)) {
    if (field === 'confidence_scores') continue;
    if ((confs[field] || 0.75) < 0.5) {
      fatimaQueue.push({ field, value, confidence: confs[field] || 0.4 });
    }
  }

  const recordId = `ADEI-${institution.substring(0,2).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;

  const record = {
    id: recordId,
    adei_record_id: recordId,
    filename,
    institution: institution || 'Zenex Foundation',
    ...classification,
    eqs_composite: eqs.eqs_composite,
    confidence_tier: eqs.confidence_tier,
    dimensions: eqs.dimensions,
    evidence_capital_score: ec?.evidence_capital_score || null,
    half_life_rating: ec?.half_life_rating || null,
    fatima_queue_items: fatimaQueue.length,
    api_usage: usage,
    classified_at: new Date().toISOString(),
    taxonomy_version: 'v2.1',
    status: fatimaQueue.length > 0 ? 'PENDING_REVIEW' : 'COMPLETE',
  };

  // Save record
  fs.writeFileSync(path.join(OUTPUT_DIR, `${recordId}.json`), JSON.stringify(record, null, 2));

  // Add to Fatima queue
  if (fatimaQueue.length > 0) {
    const queue = loadQueue();
    fatimaQueue.forEach(item => queue.push({
      id: `Q-${Date.now()}-${Math.random().toString(36).substring(2,6)}`,
      document: filename,
      record_id: recordId,
      field: item.field,
      question: `The field "${item.field}" was classified as "${item.value}" with ${Math.round(item.confidence * 100)}% confidence. Please confirm or override.`,
      recommendation: item.value,
      confidence: item.confidence,
    }));
    saveQueue(queue);
  }

  return record;
}

// ── ROUTES ───────────────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    institution: 'Zenex Foundation',
    taxonomy_version: 'v2.1',
    records: loadRecords().length,
    queue: loadQueue().length,
    timestamp: new Date().toISOString(),
  });
});

// Dashboard stats
app.get('/api/stats', (req, res) => {
  const records = loadRecords();
  res.json(records);
});

// All records
app.get('/api/records', (req, res) => {
  let records = loadRecords();
  if (req.query.tier) records = records.filter(r => r.confidence_tier === req.query.tier);
  if (req.query.type) records = records.filter(r => r.document_type === req.query.type);
  if (req.query.phase) records = records.filter(r => r.phase === req.query.phase);
  if (req.query.q) {
    const q = req.query.q.toLowerCase();
    records = records.filter(r => (r.filename + r.programme_name + r.phase + r.document_type).toLowerCase().includes(q));
  }
  res.json(records);
});

// Single record
app.get('/api/records/:id', (req, res) => {
  const records = loadRecords();
  const record = records.find(r => r.id === req.params.id || r.adei_record_id === req.params.id);
  if (!record) return res.status(404).json({ error: 'Record not found' });
  res.json(record);
});

// Classify from Google Drive file ID
app.post('/api/classify', async (req, res) => {
  const { file_id, institution } = req.body;
  if (!file_id) return res.status(400).json({ error: 'file_id required' });

  try {
    const meta = await getFileMetadata(file_id);
    const buffer = await downloadFile(file_id, meta.mimeType);
    const record = await runPipeline(buffer, meta.name, meta.mimeType, institution || 'Zenex Foundation');
    res.json({ success: true, record_id: record.id, filename: record.filename, confidence_tier: record.confidence_tier, eqs_composite: record.eqs_composite });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Classify from file upload
app.post('/api/classify/upload', upload.single('document'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const buffer = fs.readFileSync(req.file.path);
    const mimeType = req.file.mimetype;
    const filename = req.file.originalname;
    const institution = req.body.institution || 'Zenex Foundation';

    const record = await runPipeline(buffer, filename, mimeType, institution);
    fs.unlinkSync(req.file.path); // Clean up temp file

    res.json({ success: true, record_id: record.id, filename: record.filename, confidence_tier: record.confidence_tier, eqs_composite: record.eqs_composite });
  } catch (err) {
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: err.message });
  }
});

// Fatima queue
app.get('/api/queue', (req, res) => {
  res.json(loadQueue());
});

// Resolve queue item
app.post('/api/queue/:id/resolve', (req, res) => {
  const queue = loadQueue();
  const idx = queue.findIndex(q => q.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Queue item not found' });

  const resolved = queue.splice(idx, 1)[0];
  resolved.resolved_value = req.body.value || resolved.recommendation;
  resolved.resolved_by = 'Fatima Adam';
  resolved.resolved_at = new Date().toISOString();
  resolved.is_override = req.body.override === true;

  // Update the record
  const recordFile = path.join(OUTPUT_DIR, `${resolved.record_id}.json`);
  if (fs.existsSync(recordFile)) {
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    record[resolved.field] = resolved.resolved_value;
    record.fatima_reviewed_at = new Date().toISOString();
    fs.writeFileSync(recordFile, JSON.stringify(record, null, 2));
  }

  saveQueue(queue);
  res.json({ success: true, resolved });
});

// Generate knowledge product
app.post('/api/knowledge-product', async (req, res) => {
  const { record_id, audience } = req.body;
  if (!record_id || !audience) return res.status(400).json({ error: 'record_id and audience required' });

  const records = loadRecords();
  const record = records.find(r => r.id === record_id || r.adei_record_id === record_id);
  if (!record) return res.status(404).json({ error: 'Record not found' });

  try {
    const brief = await generateKnowledgeProduct({ record, audience });
    res.json({ success: true, audience, brief, record_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Batch classify entire Drive folder
app.post('/api/classify/batch', async (req, res) => {
  const { folder_id, institution } = req.body;
  if (!folder_id) return res.status(400).json({ error: 'folder_id required' });
  res.json({ success: true, message: 'Batch classification started. Use the ingestion engine (node adei-ingest.js) for production batches.', folder_id });
});

// Fallback: serve index.html for SPA routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'web', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  EvidenceOS API — Zenex Foundation`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  API: http://localhost:${PORT}/api/health\n`);
});

module.exports = app;
