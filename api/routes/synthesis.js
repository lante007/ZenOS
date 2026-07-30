'use strict';

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../services/db');
const { requireRoles } = require('../middleware/permissions');
const { orgTypeContext } = require('../services/org-context');

const router = express.Router();

function buildCorpusSummary(records) {
  return records.map(record => ({
    id: record.id,
    programme_name: record.programme_name,
    document_type: record.document_type,
    evaluation_subtype: record.evaluation_subtype,
    key_finding_1: record.key_finding_1,
    key_finding_2: record.key_finding_2,
    key_finding_3: record.key_finding_3,
    eqs_composite: record.eqs_composite,
    eqs_tier: record.eqs_tier,
    phase: record.phase,
    provinces: record.provinces,
    year: record.year,
    methodology_description: record.methodology_description,
    evidence_gap_1: record.evidence_gap_1,
    effect_size_composite: record.effect_size_composite,
    effect_direction: record.effect_direction,
    implementing_organisation_name: record.implementing_organisation_name,
  }));
}

function parseSynthesis(text, recordsSearched) {
  const recordIds = [...new Set((text.match(/\bADEI-[A-Z0-9-]+\b/g) || []))];
  const confidenceMatch = text.match(/\b(HIGH|MODERATE|LOW)\b/i);
  const contradictionMatch = text.match(/(?:contradictory evidence|contradictions?)[:\s-]+([^\n]+)/i);
  const actionMatch = text.match(/recommended action[:\s-]+([^\n]+)/i);

  return {
    answer: text,
    confidence: confidenceMatch ? confidenceMatch[1].toUpperCase() : 'LOW',
    records_searched: recordsSearched,
    supporting_record_ids: recordIds,
    contradictions: contradictionMatch ? contradictionMatch[1].trim() : null,
    recommended_action: actionMatch ? actionMatch[1].trim() : 'Review the cited records and commission additional evidence where the corpus is insufficient.',
    generated_at: new Date().toISOString(),
  };
}

router.post('/', requireRoles('ORGANISATION_LEAD', 'EVIDENCE_ANALYST'), async (req, res, next) => {
  try {
    const question = String(req.body.question || '').trim();
    if (!question) return res.status(400).json({ error: 'question is required' });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured' });

    const records = process.env.DATABASE_URL ? await db.listRecords(req.tenant, {}) : [];
    const corpusSummary = buildCorpusSummary(records);
    const organisationType = req.tenant.organisation_type || 'FUNDER';
    const attributionContext = orgTypeContext(req.tenant);

    const system = `You are the evidence intelligence engine for ${req.tenant.name}, a ${organisationType} in South Africa's education sector. You have access to ${corpusSummary.length} classified evaluation records from the ADEI corpus.

Answer the question using ONLY the evidence in these records. For each finding cited, include the record ID in brackets. Rate your overall confidence as HIGH, MODERATE, or LOW. Flag any contradictory evidence explicitly. If the corpus does not contain sufficient evidence to answer confidently, say so clearly.

Write in UK English, senior consultant register. No contractions. No em dashes.

When no contradictions exist between the classified records, set the contradictions field to null exactly. Do not write any text. Return null.

Attribution rule: This organisation is a ${organisationType}. ${attributionContext}`;

    const user = `${question}

CLASSIFIED CORPUS (${corpusSummary.length} records):
${JSON.stringify(corpusSummary, null, 2)}`;

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      temperature: 0.2,
      system,
      messages: [{ role: 'user', content: user }],
    });

    const text = message.content?.[0]?.text || '';
    res.json(parseSynthesis(text, corpusSummary.length));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
