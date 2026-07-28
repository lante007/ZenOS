'use strict';

const express = require('express');
const db = require('../services/db');
const localStore = require('../services/local-store');
const { generateKnowledgeProduct } = require('../../src/claude-classifier');
const { uploadJson } = require('../../src/s3-connector');
const { requireRoles } = require('../middleware/permissions');

const router = express.Router();

const AUDIENCE_MAP = {
  TRUSTEE: 'Trustee',
  CEO: 'CEO',
  DBE_NATIONAL: 'DBE National',
  PROVINCIAL_HOD: 'Provincial HOD',
  CO_FUNDER: 'Co-Funder',
  SECTOR_PEER: 'Sector Peer',
};

function normalizeAudience(audience) {
  const key = String(audience || '').toUpperCase().replace(/[\s-]+/g, '_');
  return AUDIENCE_MAP[key] ? { db: key, ai: AUDIENCE_MAP[key] } : null;
}

router.post('/knowledge-product', requireRoles('ORGANISATION_LEAD', 'COMMUNICATIONS'), async (req, res, next) => {
  try {
    const recordId = req.body.record_id;
    const synthesisId = req.body.synthesis_id;
    const audience = normalizeAudience(req.body.audience);
    if (!audience) return res.status(400).json({ error: 'Valid audience required' });
    if (!recordId && !synthesisId) return res.status(400).json({ error: 'Either record_id or synthesis_id is required' });

    let record = null;
    let synthesis = null;
    let sourceRecords = [];
    let synthesisContext = '';

    if (synthesisId) {
      synthesis = await db.getSynthesis(req.tenant, synthesisId);
      if (!synthesis) {
        return res.status(404).json({ error: 'Synthesis not found' });
      }

      sourceRecords = await db.getRecordsByIds(req.tenant, synthesis.record_ids);
      if (!sourceRecords.length) {
        return res.status(404).json({ error: 'No source records found for synthesis' });
      }

      synthesisContext = `
This brief is derived from a strategic synthesis of ${sourceRecords.length} classified evaluation records: ${sourceRecords
  .map(r => r.programme_name)
  .join(', ')}.

CONFIRMED FINDINGS FROM SYNTHESIS:
${(synthesis.findings || [])
  .map((f, i) =>
    `${i + 1}. [${f.confidence}] ${f.finding} ` +
    `(Source: ${(f.source_record_ids || [])
      .join(', ')})`
  ).join('\n')}

EVIDENCE GAPS:
${(synthesis.evidence_gaps || [])
  .map((g, i) =>
    `${i + 1}. ${g.gap}` +
    (g.policy_relevance ?
      ` [Policy: ${g.policy_relevance}]` : '')
  ).join('\n')}

STRATEGIC LEVERAGE POINTS:
${(synthesis.leverage_points || [])
  .map((l, i) =>
    `${i + 1}. ${l.action} - ${l.rationale}`
  ).join('\n')}

Every factual claim in the brief must cite its source record ID in square brackets.
Do not introduce findings not present in this synthesis.`;

      const primaryRecord = sourceRecords[0];
      record = {
        ...primaryRecord,
        id: synthesisId,
        programme_name: sourceRecords.map(r => r.programme_name).join(' + '),
        key_finding_1: (synthesis.findings || []).map(f => f.finding).join(' '),
        key_finding_2: (synthesis.evidence_gaps || []).map(g => g.gap).join(' '),
        key_finding_3: (synthesis.leverage_points || []).map(l => l.action).join(' '),
        evidence_gap_1: (synthesis.evidence_gaps || []).map(g => g.gap).join(' '),
        decision_relevance: (synthesis.leverage_points || []).map(l => `${l.action}: ${l.rationale}`).join(' '),
      };
    } else {
      record = process.env.DATABASE_URL
        ? await db.getRecord(req.tenant, recordId)
        : localStore.getRecord(req.tenant, recordId);
      if (!record) return res.status(404).json({ error: 'Record not found' });

      const tier = record.confidence_tier || record.eqs_tier;
      if (!['TIER_1', 'TIER_2'].includes(tier)) {
        return res.status(403).json({ error: 'Knowledge products can only be generated from Tier 1 or Tier 2 records' });
      }
      sourceRecords = [record];
    }

    const claudeResponse = await generateKnowledgeProduct({
      record,
      audience: audience.db,
      tenant: req.tenant,
      synthesisContext,
    });
    const generatedAt = new Date().toISOString();
    const wordCount = claudeResponse.split(/\s+/).filter(Boolean).length;
    const programmeName = synthesisId
      ? sourceRecords.map(r => r.programme_name).join(' + ')
      : record.programme_name;
    const product = {
      id: `KP-${Date.now().toString(36).toUpperCase()}`,
      tenant_id: req.tenant.slug,
      record_id: recordId || null,
      audience: audience.db,
      content: claudeResponse,
      word_count: wordCount,
      model_used: 'claude-sonnet-4-6',
      generated_by: req.user.sub || req.user.email,
      generated_at: generatedAt,
      created_at: generatedAt,
    };

    if (process.env.DATABASE_URL) await db.createKnowledgeProduct(req.tenant, product);
    else localStore.saveKnowledgeProduct(req.tenant, product);

    const provenance = process.env.DATABASE_URL
      ? await db.saveProvenance(req.tenant, {
        synthesis_id: synthesisId || null,
        source_record_ids: synthesisId
          ? synthesis.record_ids
          : [recordId],
        audience: audience.db,
        brief_content: claudeResponse,
        generated_at: new Date(generatedAt),
        model_used: 'claude-sonnet-4-6',
        word_count: wordCount,
      })
      : null;

    await uploadJson({
      bucket: req.tenant.s3_vault_bucket,
      key: `exports/knowledge/${product.id}.json`,
      data: product,
      metadata: { tenant: req.tenant.slug, record_id: recordId || '', synthesis_id: synthesisId || '' },
    });

    res.json({
      success: true,
      audience: audience.db,
      synthesis_id: synthesisId || null,
      record_id: recordId || null,
      source_record_count: synthesisId ? sourceRecords.length : 1,
      programme_name: programmeName,
      brief: claudeResponse,
      generated_at: generatedAt,
      model: 'claude-sonnet-4-6',
      word_count: wordCount,
      provenance_id: provenance?.id || null,
      provenance_record_id: provenance?.id || null,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
