'use strict';

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../services/db');
const storage = require('../services/storage');
const { extractText } = require('../../src/text-extractor');
const { requireRoles } = require('../middleware/permissions');
const { ALLOWED_FIELD_NAMES } = require('../services/workspace-fields');

const router = express.Router();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function schemaFor(tenant) {
  const schema = tenant.db_schema || tenant.slug;
  if (!/^[a-z][a-z0-9_]*$/.test(schema || '')) {
    throw new Error(`Unsafe tenant schema: ${schema}`);
  }
  return schema;
}

const SYSTEM_PROMPT = `You are assisting Dr Fatima Adam, you possess her skillset as Director of Research and Evaluation at Zenex Foundation, South Africa. You have actuarial training and apply precise probabilistic reasoning to evidence extraction.

Extract only what is explicitly stated in the document. Never infer or assume. Null is more valuable than wrong. Return valid JSON only.`;

const RESPONSE_SHAPE = `Return:
{
  value: string or null,
  confidence: HIGH|MODERATE|LOW,
  source_excerpt: string (max 200 chars from document),
  reasoning: string (one sentence)
}`;

const INTEGER_RESPONSE_SHAPE = `Return:
{
  value: integer or null,
  confidence: HIGH|MODERATE|LOW,
  source_excerpt: string (max 200 chars from document),
  reasoning: string (one sentence)
}`;

const FIELD_PROMPTS = {
  intervention_type: () => `What type of intervention does this evaluation study? Extract the specific intervention approach described (e.g. teacher training, materials, coaching, ICT). Max 100 characters.

${RESPONSE_SHAPE}`,

  implementation_period: () => `When did the intervention run? Extract the implementation dates or period (e.g. 2019-2021, January 2020 to March 2022). Max 50 characters.

${RESPONSE_SHAPE}`,

  policy_alignment: () => `What government policy frameworks does this evaluation reference? (e.g. CAPS, NLS 2024-2030, FUNRS 2025, DBE strategy). Max 200 characters.

${RESPONSE_SHAPE}`,

  sample_size_schools: () => `How many schools participated in this study? Return an integer or null if not stated.

${INTEGER_RESPONSE_SHAPE}`,

  baseline_year: () => `What year was the baseline evaluation or data collection conducted? Return an integer (e.g. 2019) or null if not stated.

${INTEGER_RESPONSE_SHAPE}`,

  endline_year: () => `What year was the endline evaluation or data collection conducted? Return an integer (e.g. 2022) or null if not stated.

${INTEGER_RESPONSE_SHAPE}`,

  effect_size_composite: () => `What effect size does this evaluation report? Extract any Cohen's d, percentage point gain, or standardised score improvement explicitly stated. Max 200 characters.

${RESPONSE_SHAPE}`,

  null_findings_reported: () => `Does this evaluation explicitly state that some or all outcomes showed no significant effect? Return true, false, or null if not addressed.

Return:
{
  value: boolean or null,
  confidence: HIGH|MODERATE|LOW,
  source_excerpt: string (max 200 chars from document),
  reasoning: string (one sentence)
}`,
};

const SUGGESTABLE_FIELDS = Object.keys(FIELD_PROMPTS);

router.post('/suggest', requireRoles('ORGANISATION_LEAD'), async (req, res, next) => {
  try {
    const pool = db.getPool();
    if (!pool) return res.status(503).json({ error: 'Database is not configured' });

    const { record_id: recordId, field_name: fieldName } = req.body || {};
    if (!recordId || !fieldName) {
      return res.status(400).json({ error: 'record_id and field_name are required' });
    }
    if (!SUGGESTABLE_FIELDS.includes(fieldName) || !ALLOWED_FIELD_NAMES.includes(fieldName)) {
      return res.status(400).json({ error: `Field '${fieldName}' does not support suggestions` });
    }

    const schema = schemaFor(req.tenant);
    const result = await pool.query(`
      SELECT ir.id, ir.programme_name, ir.document_type, ir.${fieldName} AS current_value,
        d.s3_key, d.filename, d.mime_type
      FROM ${schema}.intelligence_records ir
      JOIN ${schema}.documents d ON d.id = ir.document_id
      WHERE ir.id = $1
        AND ir.tenant_id = $2
    `, [recordId, req.tenant.slug]);

    const record = result.rows[0];
    if (!record) return res.status(404).json({ error: 'Record not found' });

    if (record.current_value !== null && record.current_value !== undefined && record.current_value !== '') {
      return res.status(409).json({ error: 'field already has value' });
    }

    const meta = await storage.getFileMetadata(record.s3_key, { bucket: req.tenant.s3_vault_bucket });
    const buffer = await storage.downloadFile(record.s3_key, meta.mimeType, { bucket: req.tenant.s3_vault_bucket });
    const extraction = await extractText(buffer, meta.mimeType || record.mime_type, record.filename);

    if (extraction.quality === 'FAILED' || !extraction.fullText) {
      return res.status(422).json({ error: 'Could not extract usable text from the source document' });
    }

    const userPrompt = `${FIELD_PROMPTS[fieldName]()}\n\nDOCUMENT TEXT:\n${extraction.fullText}`;

    const message = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 500,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const raw = message.content[0].text;
    let parsed;
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    } catch (e) {
      return res.status(502).json({ error: 'Model returned an unparseable response' });
    }

    return res.json({
      record_id: recordId,
      field_name: fieldName,
      suggested_value: parsed.value ?? null,
      confidence: parsed.confidence || null,
      source_excerpt: parsed.source_excerpt || null,
      reasoning: parsed.reasoning || null,
      model_used: 'claude-haiku-4-5',
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

// Reject flow: the human confirms the field should stay null rather than
// accept the AI suggestion. Recorded as a validation flag, not a value
// write, so the field remains null but the review is auditable.
router.post('/reject', requireRoles('ORGANISATION_LEAD'), async (req, res, next) => {
  try {
    const pool = db.getPool();
    if (!pool) return res.status(503).json({ error: 'Database is not configured' });

    const { record_id: recordId, field_name: fieldName } = req.body || {};
    if (!recordId || !fieldName) {
      return res.status(400).json({ error: 'record_id and field_name are required' });
    }
    if (!ALLOWED_FIELD_NAMES.includes(fieldName)) {
      return res.status(400).json({ error: `Field '${fieldName}' is not a workspace field` });
    }

    const schema = schemaFor(req.tenant);
    const flag = {
      field: fieldName,
      rule: 'HUMAN_REJECTED',
      reviewed_by: req.user?.email || null,
      reviewed_at: new Date().toISOString(),
    };

    const result = await pool.query(`
      UPDATE ${schema}.intelligence_records
      SET validation_flags = COALESCE(validation_flags, '[]'::jsonb) || $1::jsonb,
        updated_at = NOW()
      WHERE id = $2
        AND tenant_id = $3
      RETURNING id, validation_flags
    `, [JSON.stringify([flag]), recordId, req.tenant.slug]);

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Record not found' });
    }

    await pool.query(`
      INSERT INTO ${schema}.audit_log (
        event_type, user_id, tenant_id, detail, created_at
      ) VALUES ('WORKSPACE_FIELD_REJECTED', $1, $2, $3, NOW())
    `, [
      req.user?.sub,
      req.tenant.slug,
      JSON.stringify({ record_id: recordId, field: fieldName, rejected_by: req.user?.email }),
    ]);

    return res.json({ success: true, record: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
