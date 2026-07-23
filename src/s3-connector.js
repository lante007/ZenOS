'use strict';
/**
 * EvidenceOS S3 Connector
 * Tenant-scoped document storage for raw files, extracted text, and ADEI records.
 */

const {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');
const path = require('path');

const REGION = process.env.AWS_REGION || 'us-east-1';
const s3 = new S3Client({ region: REGION });

const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
};

function getTenantBucket(tenantOrBucket) {
  if (tenantOrBucket && tenantOrBucket.includes('auxeira-')) return tenantOrBucket;
  const tenant = tenantOrBucket || process.env.EVIDENCEOS_TENANT || process.env.TENANT || 'zenex';
  return process.env.AWS_S3_BUCKET || process.env.S3_BUCKET || `auxeira-evidenceos-${tenant}`;
}

function inferMimeType(key, contentType) {
  if (contentType && contentType !== 'binary/octet-stream') return contentType;
  return MIME_BY_EXT[path.extname(key).toLowerCase()] || 'application/octet-stream';
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function toFileObject(object, bucket) {
  const key = object.Key || object.key;
  return {
    id: key,
    key,
    bucket,
    name: path.basename(key),
    mimeType: inferMimeType(key, object.ContentType),
    size: String(object.Size || object.ContentLength || 0),
    modifiedTime: object.LastModified ? object.LastModified.toISOString() : undefined,
  };
}

async function listFolderFiles(prefix = 'raw/documents/', options = {}) {
  const bucket = options.bucket || getTenantBucket(options.tenant);
  const files = [];
  let ContinuationToken;

  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken,
    }));

    for (const object of res.Contents || []) {
      if (!object.Key || object.Key.endsWith('/.keep') || object.Key.endsWith('/')) continue;
      if ((object.Size || 0) <= 0) continue;
      files.push(toFileObject(object, bucket));
    }

    ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (ContinuationToken);

  console.log(`[S3] Found ${files.length} processable file(s) in s3://${bucket}/${prefix}`);
  return files;
}

async function getFileMetadata(key, options = {}) {
  const bucket = options.bucket || getTenantBucket(options.tenant);
  const res = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  return toFileObject({ Key: key, ...res }, bucket);
}

async function downloadFile(key, _mimeType, options = {}) {
  const bucket = options.bucket || getTenantBucket(options.tenant);
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return streamToBuffer(res.Body);
}

async function uploadBuffer({ bucket, tenant, key, body, contentType, metadata = {} }) {
  const targetBucket = bucket || getTenantBucket(tenant);
  await s3.send(new PutObjectCommand({
    Bucket: targetBucket,
    Key: key,
    Body: body,
    ContentType: contentType || inferMimeType(key),
    ServerSideEncryption: 'AES256',
    Metadata: Object.fromEntries(
      Object.entries(metadata).map(([k, v]) => [k, String(v)])
    ),
  }));
  return { bucket: targetBucket, key };
}

async function uploadJson({ bucket, tenant, key, data, metadata }) {
  return uploadBuffer({
    bucket,
    tenant,
    key,
    body: Buffer.from(JSON.stringify(data, null, 2)),
    contentType: 'application/json',
    metadata,
  });
}

module.exports = {
  getTenantBucket,
  listFolderFiles,
  getFileMetadata,
  downloadFile,
  uploadBuffer,
  uploadJson,
};
