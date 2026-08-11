'use strict';

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const storage = require('../services/storage');
const { classifyBuffer } = require('../services/pipeline');
const { requireRoles } = require('../middleware/permissions');
const db = require('../services/db');

const router = express.Router();
const upload = multer({ dest: '/tmp/adei-uploads/' });
const s3Client = new S3Client({
  region: process.env.AWS_DEFAULT_REGION || process.env.AWS_REGION || 'us-east-1',
});

function safeUploadName(filename) {
  return String(filename || 'document')
    .replace(/[^a-zA-Z0-9._\-\s]/g, '_')
    .replace(/\s+/g, '_');
}

function sendDuplicateResponse(res, err) {
  const existing = err.existingDocument || {};
  return res.status(409).json({
    error: 'duplicate_detected',
    message: 'A document with this filename or identical content already exists in the archive.',
    existing_document_id: existing.id,
    existing_record_status: existing.record_status,
    action: 'Use the existing record or upload a revised version with a different filename.',
  });
}

async function classifyFromS3Key(tenant, s3Key, filename, institution, user) {
  const meta = await storage.getFileMetadata(s3Key, { bucket: tenant.s3_vault_bucket });
  const buffer = await storage.downloadFile(s3Key, meta.mimeType, { bucket: tenant.s3_vault_bucket });
  const record = await classifyBuffer({
    tenant,
    buffer,
    filename: filename || meta.name,
    mimeType: meta.mimeType,
    user,
    s3Document: {
      ...meta,
      key: s3Key,
      filename: filename || meta.name,
    },
    institution,
  });

  return {
    success: true,
    tenant: tenant.slug,
    s3_key: s3Key,
    record_id: record.id,
    filename: record.filename,
    programme_name: record.programme_name,
    confidence_tier: record.confidence_tier,
    eqs_composite: record.eqs_composite,
    extraction_quality: record.extraction_quality,
    fatima_queue_items: record.fatima_queue_items,
  };
}

router.get('/presign', requireRoles('ORGANISATION_LEAD', 'EVIDENCE_ANALYST'), async (req, res, next) => {
  try {
    const { filename, content_type: contentType } = req.query;

    if (!filename) {
      return res.status(400).json({ error: 'filename required' });
    }

    const key = `raw/documents/${Date.now()}-${safeUploadName(filename)}`;
    const command = new PutObjectCommand({
      Bucket: req.tenant.s3_vault_bucket,
      Key: key,
      ContentType: contentType || 'application/octet-stream',
    });

    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 900 });

    return res.json({
      upload_url: uploadUrl,
      s3_key: key,
      expires_in: 900,
    });
  } catch (err) {
    next(err);
  }
});

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
    if (err.code === 'DUPLICATE_DOCUMENT') return sendDuplicateResponse(res, err);
    next(err);
  }
});

router.post('/', requireRoles('ORGANISATION_LEAD', 'EVIDENCE_ANALYST'), async (req, res, next) => {
  const key = req.body.s3_key || req.body.key;
  if (!key) return res.status(400).json({ error: 's3_key required' });

  try {
    const result = await classifyFromS3Key(req.tenant, key, req.body.filename, req.body.institution || req.tenant.name, req.user);

    await db.createAuditLog(req.tenant, 'classification_triggered', {
      s3_key: key,
      record_id: result.record_id,
    }, req.user.email || req.user.sub);

    res.json(result);
  } catch (err) {
    if (err.code === 'DUPLICATE_DOCUMENT') return sendDuplicateResponse(res, err);
    next(err);
  }
});

router.post('/process', requireRoles('ORGANISATION_LEAD', 'EVIDENCE_ANALYST'), async (req, res, next) => {
  try {
    const { s3_key: s3Key, filename, institution } = req.body;

    if (!s3Key) {
      return res.status(400).json({ error: 's3_key required' });
    }

    const result = await classifyFromS3Key(
      req.tenant,
      s3Key,
      filename,
      institution || req.tenant.name,
      req.user
    );

    await db.createAuditLog(req.tenant, 'document_uploaded', {
      s3_key: s3Key,
      filename: filename || result.filename,
    }, req.user.email || req.user.sub);
    await db.createAuditLog(req.tenant, 'classification_triggered', {
      s3_key: s3Key,
      record_id: result.record_id,
    }, req.user.email || req.user.sub);

    return res.json(result);
  } catch (err) {
    if (err.code === 'DUPLICATE_DOCUMENT') return sendDuplicateResponse(res, err);
    next(err);
  }
});

router.post('/comparison-feedback', requireRoles('ORGANISATION_LEAD', 'EVIDENCE_ANALYST'), async (req, res, next) => {
  try {
    const { record_id: recordId, system_values: systemValues, manual_values: manualValues } = req.body;

    if (!recordId) {
      return res.status(400).json({ error: 'record_id required' });
    }

    await db.createAuditLog(req.tenant, 'MANUAL_CLASSIFICATION_COMPARISON', {
      record_id: recordId,
      system_values: systemValues || {},
      manual_values: manualValues || {},
    }, req.user.email || req.user.sub);

    return res.json({ success: true });
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
