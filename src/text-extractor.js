'use strict';
/**
 * ADEI Text Extractor (Phase B3 rebuild)
 * PDF: pdf-parse + chars-per-page NEEDS_OCR gate, no retry-and-chunk fallback.
 * PPTX: python-pptx subprocess (slides + speaker notes), fed into the same
 *       length-based quality gate as PDF.
 * DOCX: mammoth body text + tables rendered as tab-separated rows.
 */

const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  TextractClient,
  StartDocumentTextDetectionCommand,
  GetDocumentTextDetectionCommand,
} = require('@aws-sdk/client-textract');

const TEXTRACT_REGION = process.env.AWS_REGION || 'us-east-1';
const textractClient = new TextractClient({ region: TEXTRACT_REGION });

const SUPPORTED_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword',
  'application/vnd.google-apps.document',
  'text/plain',
];

function isSupportedType(mimeType) {
  return SUPPORTED_TYPES.includes(mimeType) ||
    mimeType.includes('wordprocessingml') ||
    mimeType.includes('presentationml') ||
    mimeType.includes('pdf') ||
    mimeType.startsWith('text/');
}

function qualityFromLength(len) {
  if (len < 2000) return 'FAILED';
  if (len < 5000) return 'LOW';
  if (len < 15000) return 'ADEQUATE';
  return 'GOOD';
}

/**
 * Extract text from PDF buffer.
 * charsPerPage < 100 signals a scanned/image PDF (no OCR available) rather
 * than a generic FAILED, so downstream can route it differently.
 */
async function extractFromPDF(buffer) {
  let data;
  try {
    data = await pdfParse(buffer, { max: 0 });
  } catch (err) {
    throw new Error(`PDF extraction failed: ${err.message}`);
  }

  const text = data.text || '';
  const pageCount = data.numpages || 1;
  const charsPerPage = text.length / (pageCount || 1);

  if (charsPerPage < 100) {
    return {
      text: '',
      quality: 'NEEDS_OCR',
      reason: 'scanned_or_image_pdf',
      charCount: text.length,
      charsPerPage: Math.round(charsPerPage),
      pageCount,
      method: 'pdf-parse',
    };
  }

  return {
    text,
    quality: qualityFromLength(text.length),
    charsPerPage: Math.round(charsPerPage),
    pageCount,
    method: 'pdf-parse',
  };
}

const TEXTRACT_POLL_INTERVAL_MS = 10000;
const TEXTRACT_MAX_POLL_ATTEMPTS = 30; // 30 * 10s = 5 min ceiling for a large scanned PDF

function linesFromBlocks(blocks) {
  return (blocks || [])
    .filter(b => b.BlockType === 'LINE')
    .map(b => b.Text)
    .join('\n');
}

/**
 * OCR fallback for scanned/image PDFs that fail the pdf-parse text-layer
 * gate (charsPerPage < 100 in extractFromPDF). Runs against the object
 * already sitting in S3 via Textract's async document API - no local
 * rasterization or OCR binary involved, so this can't repeat the resource
 * exhaustion a local tesseract/pdftoppm install caused on this instance
 * (see commit history: that approach took prod down and was reverted).
 * Requires the object to already be in S3 (bucket/key), unlike the old
 * buffer-based approach - callers without an S3-backed document can't OCR.
 */
async function extractWithTextract(bucket, key) {
  if (!bucket || !key) {
    return { text: '', method: 'OCR_FAILED', reason: 'no_s3_location' };
  }

  try {
    console.log('Attempting Textract OCR for:', key);
    const start = await textractClient.send(new StartDocumentTextDetectionCommand({
      DocumentLocation: { S3Object: { Bucket: bucket, Name: key } },
    }));
    const jobId = start.JobId;
    console.log('Textract job:', jobId);

    let status = 'IN_PROGRESS';
    let attempts = 0;

    while (status === 'IN_PROGRESS' && attempts < TEXTRACT_MAX_POLL_ATTEMPTS) {
      await new Promise(resolve => setTimeout(resolve, TEXTRACT_POLL_INTERVAL_MS));
      const result = await textractClient.send(new GetDocumentTextDetectionCommand({ JobId: jobId }));
      status = result.JobStatus;
      attempts++;

      if (status === 'SUCCEEDED') {
        let fullText = linesFromBlocks(result.Blocks);
        let nextToken = result.NextToken;
        while (nextToken) {
          const page = await textractClient.send(new GetDocumentTextDetectionCommand({ JobId: jobId, NextToken: nextToken }));
          fullText += '\n\n' + linesFromBlocks(page.Blocks);
          nextToken = page.NextToken;
        }
        console.log('Textract extracted:', fullText.trim().length, 'chars for', key);
        return { text: fullText.trim(), method: 'textract-ocr', poll_attempts: attempts };
      }

      if (status === 'FAILED') {
        console.error('Textract job failed:', jobId, 'for', key);
        return { text: '', method: 'OCR_FAILED', reason: 'textract_job_failed' };
      }
    }

    if (status === 'IN_PROGRESS') {
      return { text: '', method: 'OCR_FAILED', reason: 'textract_timeout' };
    }
    return { text: '', method: 'OCR_FAILED', reason: `textract_status_${status}` };
  } catch (err) {
    console.error('Textract error for', key, ':', err.message);
    return { text: '', method: 'OCR_FAILED', reason: `textract_error: ${err.message}` };
  }
}

/**
 * Extract text from DOCX buffer: raw body text via mammoth, plus any
 * tables rendered separately as tab-separated rows and appended after
 * the body. Mammoth converts tables to HTML natively (no style map is
 * needed to get the structure); we read that HTML and join cells with
 * tabs rather than reconstructing Markdown formatting.
 */
function decodeHtmlEntities(str) {
  return str
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function cellText(cellHtml) {
  return decodeHtmlEntities(cellHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function htmlTableToTabSeparated(tableHtml) {
  const rowMatches = tableHtml.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  const rows = rowMatches
    .map(rowHtml => {
      const cellMatches = rowHtml.match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/gi) || [];
      return cellMatches.map(cellText).join('\t');
    })
    .filter(row => row.length > 0);
  return rows.join('\n');
}

async function extractTablesAsTabSeparated(buffer) {
  const { value: html } = await mammoth.convertToHtml({ buffer });
  const tableMatches = html.match(/<table[^>]*>[\s\S]*?<\/table>/gi) || [];
  return tableMatches
    .map(htmlTableToTabSeparated)
    .filter(Boolean);
}

async function extractFromDOCX(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  const bodyText = result.value || '';

  let tables = [];
  try {
    tables = await extractTablesAsTabSeparated(buffer);
  } catch {
    tables = [];
  }

  const text = tables.length
    ? `${bodyText}\n\n--- TABLES ---\n\n${tables.join('\n\n')}`
    : bodyText;

  return {
    text,
    tableCount: tables.length,
    method: 'mammoth+tables',
    warnings: result.messages,
  };
}

/**
 * Extract text from PPTX buffer via a python-pptx subprocess: slide body
 * text plus speaker notes, in slide order, with explicit slide separators.
 * Output is plain text fed into the same length-based quality gate as PDF.
 */
const PPTX_SCRIPT = path.join(__dirname, 'pptx_extract.py');

async function extractFromPPTX(buffer) {
  const tmpFile = path.join(os.tmpdir(), `pptx-${crypto.randomUUID()}.pptx`);
  fs.writeFileSync(tmpFile, buffer);

  let text;
  try {
    text = execFileSync('python3', [PPTX_SCRIPT, tmpFile], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (err) {
    throw new Error(`python-pptx extraction failed: ${err.stderr || err.message}`);
  } finally {
    fs.unlinkSync(tmpFile);
  }

  return {
    text,
    quality: qualityFromLength(text.length),
    method: 'python-pptx',
  };
}

/**
 * Main extraction function - returns cleaned text and quality metadata.
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
    result = { text: buffer.toString('utf8').substring(0, 30000), method: 'raw' };
  }

  // Preserve structural whitespace (slide separators, DOCX table tabs) -
  // only collapse runs of plain spaces and excess blank lines, not tabs/newlines.
  let text = (result.text || '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/ +/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const hash = crypto.createHash('sha256').update(buffer).digest('hex');

  const piiPatterns = [
    /\b\d{13}\b/,
    /\b[A-Z][0-9]{8}\b/,
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
  ];
  const hasPII = piiPatterns.some(p => p.test(text));

  // Final content-quality backstop: applies regardless of file type,
  // except NEEDS_OCR which is a more specific signal than generic FAILED.
  if (result.quality !== 'NEEDS_OCR' && text.length < 2000) {
    return {
      text: '',
      quality: 'FAILED',
      reason: result.reason || 'insufficient_content',
      charCount: text.length,
      hash,
      rights: hasPII ? 'RESTRICTED' : 'CLEAR',
      method: result.method,
      pageCount: result.pageCount || null,
      flag: 'EXTRACTION_POOR',
    };
  }

  const quality = result.quality || qualityFromLength(text.length);

  // classificationText: legacy head+tail slice, kept for any caller that
  // still wants a pre-truncated string. fullText: the untruncated cleaned
  // text - callers doing their own budgeting (claude-classifier.js Pass 1/
  // Pass 2's buildStructuredExcerpt(), wired in B6) should use this instead,
  // otherwise the structured budget never gets more than 10000 chars to
  // work with and never actually engages. See docs/B4_NOTES.md.
  const classificationText = text.length > 10000
    ? text.substring(0, 8000) + '\n\n[...]\n\n' + text.substring(text.length - 2000)
    : text;

  return {
    text: classificationText,
    fullText: text,
    fullTextLength: text.length,
    quality,
    hash,
    rights: hasPII ? 'RESTRICTED' : 'CLEAR',
    method: result.method,
    pageCount: result.pageCount || null,
    charsPerPage: result.charsPerPage || null,
    tableCount: result.tableCount || null,
    flag: quality === 'FAILED' || quality === 'NEEDS_OCR' ? 'EXTRACTION_POOR' : null,
  };
}

module.exports = { extractText, isSupportedType, extractWithTextract, qualityFromLength };
