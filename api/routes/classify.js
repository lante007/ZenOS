'use strict';

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const storage = require('../services/storage');
const { classifyBuffer } = require('../services/pipeline');
const { requireRoles } = require('../middleware/permissions');
const db = require('../services/db');

const router = express.Router();
const upload = multer({ dest: '/tmp/adei-uploads/' });

router.post('/upload', requireRoles('ORGANISATION_LEAD', 'EVIDENCE_ANALYST'), upload.single('document'), async (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const buffer = fs.readFileSync(req.file.path);
    const uploaded = await storage.uploadRawDocument({
      tenant: req.tenant,
      buffer,
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
      uploadedBy: req.user.email,
    });

    const record = await classifyBuffer({
      tenant: req.tenant,
      buffer,
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
      user: req.user,
      s3Document: uploaded,
    });

    await db.createAuditLog(req.tenant, 'document_uploaded', {
      s3_key: uploaded.key,
      filename: req.file.originalname,
    }, req.user.email || req.user.sub);
    await db.createAuditLog(req.tenant, 'classification_triggered', {
      s3_key: uploaded.key,
      record_id: record.id,
    }, req.user.email || req.user.sub);

    fs.unlinkSync(req.file.path);
    res.json({
      success: true,
      tenant: req.tenant.slug,
      s3_key: uploaded.key,
      record_id: record.id,
      filename: record.filename,
      confidence_tier: record.confidence_tier,
      eqs_composite: record.eqs_composite,
      fatima_queue_items: record.fatima_queue_items,
    });
  } catch (err) {
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    next(err);
  }
});

router.post('/', requireRoles('ORGANISATION_LEAD', 'EVIDENCE_ANALYST'), async (req, res, next) => {
  const key = req.body.s3_key || req.body.key;
  if (!key) return res.status(400).json({ error: 's3_key required' });

  try {
    const meta = await storage.getFileMetadata(key, { bucket: req.tenant.s3_vault_bucket });
    const buffer = await storage.downloadFile(key, meta.mimeType, { bucket: req.tenant.s3_vault_bucket });
    const record = await classifyBuffer({
      tenant: req.tenant,
      buffer,
      filename: meta.name,
      mimeType: meta.mimeType,
      user: req.user,
      s3Document: meta,
    });

    await db.createAuditLog(req.tenant, 'classification_triggered', {
      s3_key: key,
      record_id: record.id,
    }, req.user.email || req.user.sub);

    res.json({
      success: true,
      tenant: req.tenant.slug,
      record_id: record.id,
      filename: record.filename,
      confidence_tier: record.confidence_tier,
      eqs_composite: record.eqs_composite,
      fatima_queue_items: record.fatima_queue_items,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/batch', requireRoles('ORGANISATION_LEAD', 'EVIDENCE_ANALYST'), async (req, res, next) => {
  try {
    const prefix = req.body.s3_prefix || 'raw/documents/';
    const files = await storage.listFolderFiles(prefix, { bucket: req.tenant.s3_vault_bucket });
    res.json({
      success: true,
      tenant: req.tenant.slug,
      prefix,
      queued: files.length,
      message: 'Batch listing complete. Use adei-ingest.js --s3-prefix for CLI processing.',
      files: files.map(f => ({ key: f.key, name: f.name, size: f.size })),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
