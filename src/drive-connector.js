'use strict';
/**
 * ADEI Drive Connector
 * Lists and downloads files from the Zenex Google Drive archive
 */

const { google } = require('googleapis');
const path = require('path');

function getAuth() {
  return new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
}

/**
 * List all files in a Drive folder, skipping empty files
 */
async function listFolderFiles(folderId) {
  const auth = getAuth();
  const drive = google.drive({ version: 'v3', auth });

  let allFiles = [];
  let pageToken = null;

  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'nextPageToken, files(id,name,mimeType,size,modifiedTime)',
      pageSize: 100,
      pageToken: pageToken || undefined,
    });

    const files = res.data.files || [];
    allFiles = allFiles.concat(files);
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  // Filter out empty files
  const valid = allFiles.filter(f => parseInt(f.size || '0') > 0);
  const empty = allFiles.filter(f => parseInt(f.size || '0') === 0);

  if (empty.length > 0) {
    console.log(`[DRIVE] Skipped ${empty.length} empty file(s): ${empty.map(f => f.name).join(', ')}`);
  }

  console.log(`[DRIVE] Found ${valid.length} processable files in folder`);
  return valid;
}

/**
 * Download a single file as a Buffer
 */
async function downloadFile(fileId, mimeType) {
  const auth = getAuth();
  const drive = google.drive({ version: 'v3', auth });

  // For Google Docs native formats, export as appropriate type
  if (mimeType === 'application/vnd.google-apps.document') {
    const res = await drive.files.export(
      { fileId, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      { responseType: 'arraybuffer' }
    );
    return Buffer.from(res.data);
  }

  if (mimeType === 'application/vnd.google-apps.spreadsheet') {
    const res = await drive.files.export(
      { fileId, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      { responseType: 'arraybuffer' }
    );
    return Buffer.from(res.data);
  }

  // Binary files (PDF, DOCX, PPTX)
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' }
  );
  return Buffer.from(res.data);
}

/**
 * Get file metadata
 */
async function getFileMetadata(fileId) {
  const auth = getAuth();
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.get({
    fileId,
    fields: 'id,name,mimeType,size,modifiedTime,description',
  });
  return res.data;
}

module.exports = { listFolderFiles, downloadFile, getFileMetadata };
