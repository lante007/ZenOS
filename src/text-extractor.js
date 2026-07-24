'use strict';
/**
 * ADEI Text Extractor
 * Layered pipeline: metadata → structure detection → synopsis → classify
 * Falls back to chunked extraction for scanned/unstructured PDFs
 */

const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const crypto = require('crypto');

const SUPPORTED_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword',
  'application/vnd.google-apps.document',
  'text/plain',
];

/**
 * Determine if a MIME type is supported
 */
function isSupportedType(mimeType) {
  return SUPPORTED_TYPES.includes(mimeType) ||
    mimeType.includes('wordprocessingml') ||
    mimeType.includes('presentationml') ||
    mimeType.includes('pdf') ||
    mimeType.startsWith('text/');
}

/**
 * Extract text from PDF buffer
 */
async function extractFromPDF(buffer) {
  try {
    const data = await pdfParse(buffer, { max: 0 }); // 0 = all pages
    return {
      text: data.text,
      pageCount: data.numpages,
      method: 'pdf-parse',
    };
  } catch (err) {
    // Fallback: chunked extraction — first 5k + middle 5k + last 5k chars
    try {
      const data = await pdfParse(buffer, { max: 5 });
      const firstChunk = data.text.substring(0, 5000);
      const lastData = await pdfParse(buffer, { max: 0 });
      const fullText = lastData.text;
      const mid = Math.floor(fullText.length / 2);
      const midChunk = fullText.substring(mid - 2500, mid + 2500);
      const lastChunk = fullText.substring(fullText.length - 5000);
      return {
        text: firstChunk + '\n\n[...]\n\n' + midChunk + '\n\n[...]\n\n' + lastChunk,
        pageCount: lastData.numpages,
        method: 'chunked-fallback',
        quality: 'CHUNKED',
      };
    } catch (e2) {
      throw new Error(`PDF extraction failed: ${err.message}`);
    }
  }
}

/**
 * Extract text from DOCX buffer
 */
async function extractFromDOCX(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return {
    text: result.value,
    method: 'mammoth',
    warnings: result.messages,
  };
}

/**
 * Extract text from PPTX buffer (basic XML extraction)
 */
async function extractFromPPTX(buffer) {
  // Basic extraction from PPTX XML
  const str = buffer.toString('utf8', 0, Math.min(buffer.length, 500000));
  // Extract text between <a:t> tags (PowerPoint text runs)
  const matches = str.match(/<a:t[^>]*>([^<]+)<\/a:t>/g) || [];
  const text = matches
    .map(m => m.replace(/<[^>]+>/g, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    text: text || str.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').substring(0, 15000),
    method: 'pptx-xml',
  };
}

/**
 * Main extraction function — returns cleaned text and quality metadata
 */
async function extractText(buffer, mimeType, filename) {
  if (!isSupportedType(mimeType)) {
    throw new Error(`UNSUPPORTED_FORMAT: ${mimeType} for ${filename}`);
  }

  let result;

  if (mimeType === 'application/pdf' || filename.toLowerCase().endsWith('.pdf')) {
    result = await extractFromPDF(buffer);
  } else if (
    mimeType.includes('wordprocessingml') ||
    mimeType === 'application/msword' ||
    filename.toLowerCase().endsWith('.docx') ||
    filename.toLowerCase().endsWith('.doc')
  ) {
    result = await extractFromDOCX(buffer);
  } else if (
    mimeType.includes('presentationml') ||
    filename.toLowerCase().endsWith('.pptx')
  ) {
    result = await extractFromPPTX(buffer);
  } else {
    // Last resort: raw text
    result = { text: buffer.toString('utf8').substring(0, 30000), method: 'raw' };
  }

  // Clean the text
  let text = (result.text || '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // control chars
    .replace(/\s+/g, ' ')
    .trim();

  // Compute content hash for duplicate detection
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');

  // Assess quality
  let quality = 'GOOD';
  if (text.length < 200) quality = 'FAILED';
  else if (text.length < 1000) quality = 'LOW';
  else if (text.length < 3000) quality = 'ADEQUATE';

  // PII scan
  const piiPatterns = [
    /\b\d{13}\b/,                            // SA ID number
    /\b[A-Z][0-9]{8}\b/,                     // Passport
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/, // Email
  ];
  const hasPII = piiPatterns.some(p => p.test(text));

  // Truncate for classification (keep first 8000 + last 2000 chars)
  const classificationText = text.length > 10000
    ? text.substring(0, 8000) + '\n\n[...]\n\n' + text.substring(text.length - 2000)
    : text;

  return {
    text: classificationText,
    fullTextLength: text.length,
    quality,
    hash,
    rights: hasPII ? 'RESTRICTED' : 'CLEAR',
    method: result.method,
    pageCount: result.pageCount || null,
    flag: quality === 'FAILED' ? 'EXTRACTION_POOR' : null,
  };
}

module.exports = { extractText, isSupportedType };
