'use strict';

const path = require('path');
const crypto = require('crypto');
const { uploadBuffer, uploadJson, downloadFile, getFileMetadata, listFolderFiles } = require('../../src/s3-connector');

function safeFilename(filename) {
  return path.basename(filename).replace(/[^a-zA-Z0-9._ -]/g, '_');
}

function rawDocumentKey(filename) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `raw/documents/${stamp}-${safeFilename(filename)}`;
}

async function uploadRawDocument({ tenant, buffer, filename, mimeType, uploadedBy }) {
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const key = rawDocumentKey(filename);
  const result = await uploadBuffer({
    bucket: tenant.s3_vault_bucket,
    key,
    body: buffer,
    contentType: mimeType,
    metadata: {
      tenant: tenant.slug,
      uploaded_by: uploadedBy || 'system',
      sha256: hash,
    },
  });
  return { ...result, hash, filename: safeFilename(filename) };
}

async function uploadProcessedText({ tenant, recordId, text }) {
  return uploadBuffer({
    bucket: tenant.s3_vault_bucket,
    key: `processed/text/${recordId}.txt`,
    body: Buffer.from(text),
    contentType: 'text/plain; charset=utf-8',
    metadata: { tenant: tenant.slug, record_id: recordId },
  });
}

async function uploadProcessedRecord({ tenant, record }) {
  return uploadJson({
    bucket: tenant.s3_vault_bucket,
    key: `processed/records/${record.adei_record_id || record.id}.json`,
    data: record,
    metadata: { tenant: tenant.slug, record_id: record.adei_record_id || record.id },
  });
}

module.exports = {
  downloadFile,
  getFileMetadata,
  listFolderFiles,
  uploadRawDocument,
  uploadProcessedText,
  uploadProcessedRecord,
};
