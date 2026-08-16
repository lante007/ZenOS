'use strict';

const express = require('express');
const crypto = require('crypto');
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
    existing_record_id: existing.record_id,
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
    eqs_tier: record.eqs_tier,
    eqs_composite: record.eqs_composite,
    extraction_quality: record.extraction_quality,
    fatima_queue_items: record.fatima_queue_items,
  };
}

// In-memory async job store for POST /process - same pattern as
// api/routes/tor.js's `jobs`. Large-file classification (S3 download +
// text extraction + Claude call) can run 60-120s, which exceeds
// CloudFront's origin read timeout if done synchronously, so the request
// returns immediately and the caller polls GET /process/status/:jobId.
// Jobs do not survive a pm2 restart.
const classifyJobs = {};
const CLASSIFY_JOB_TTL_MS = 10 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - CLASSIFY_JOB_TTL_MS;
  for (const [id, job] of Object.entries(classifyJobs)) {
    if (job.createdAt < cutoff) delete classifyJobs[id];
  }
}, 60 * 1000).unref();

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

    const tenant = req.tenant;

    // De-dup: reuse an existing pending job for the same document rather
    // than spawning a second classification from a rapid double-click.
    const existing = Object.entries(classifyJobs).find(([, job]) =>
      job.status === 'pending' &&
      job.tenantId === tenant.slug &&
      job.s3Key === s3Key
    );
    if (existing) {
      return res.status(202).json({ jobId: existing[0], status: 'pending' });
    }

    const jobId = crypto.randomUUID();
    classifyJobs[jobId] = {
      status: 'pending',
      result: null,
      error: null,
      code: null,
      existingRecordId: null,
      tenantId: tenant.slug,
      userId: req.user?.sub || null,
      s3Key,
      createdAt: Date.now(),
    };

    res.status(202).json({ jobId, status: 'pending' });

    (async () => {
      try {
        const result = await classifyFromS3Key(tenant, s3Key, filename, institution || tenant.name, req.user);

        await db.createAuditLog(tenant, 'document_uploaded', {
          s3_key: s3Key,
          filename: filename || result.filename,
        }, req.user.email || req.user.sub);
        await db.createAuditLog(tenant, 'classification_triggered', {
          s3_key: s3Key,
          record_id: result.record_id,
        }, req.user.email || req.user.sub);

        classifyJobs[jobId].status = 'complete';
        classifyJobs[jobId].result = result;
      } catch (err) {
        const message = err.code === 'DUPLICATE_DOCUMENT'
          ? 'A document with this filename or identical content already exists in the archive.'
          : err.message;
        console.error(`[classify] process job ${jobId} failed: ${err.message}`);
        classifyJobs[jobId].status = 'failed';
        classifyJobs[jobId].error = message;
        classifyJobs[jobId].code = err.code || null;
        classifyJobs[jobId].existingRecordId = err.existingDocument?.record_id || null;
      }
    })();
  } catch (err) {
    next(err);
  }
});

router.get('/status/:jobId', requireRoles('ORGANISATION_LEAD', 'EVIDENCE_ANALYST'), (req, res, next) => {
  try {
    const job = classifyJobs[req.params.jobId];
    // A jobId alone is not an authorisation boundary: a job belonging to
    // a different tenant or a different user within the same tenant
    // returns 404, not 403, so its existence is never confirmed to an
    // unauthorised caller.
    if (!job || job.tenantId !== req.tenant.slug || job.userId !== (req.user?.sub || null)) {
      return res.status(404).json({ error: 'Job not found' });
    }

    if (job.status === 'pending') {
      return res.json({ status: 'pending' });
    }
    if (job.status === 'failed') {
      return res.json({
        status: 'failed',
        error: job.error,
        code: job.code,
        existing_record_id: job.existingRecordId,
      });
    }
    return res.json({
      status: 'complete',
      record_id: job.result.record_id,
      programme_name: job.result.programme_name,
      eqs_tier: job.result.eqs_tier,
      eqs_composite: job.result.eqs_composite,
      extraction_quality: job.result.extraction_quality,
    });
  } catch (err) {
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
