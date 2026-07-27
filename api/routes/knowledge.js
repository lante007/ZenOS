'use strict';

const express = require('express');
const db = require('../services/db');
const localStore = require('../services/local-store');
const { generateKnowledgeProduct } = require('../../src/claude-classifier');
const { uploadJson } = require('../../src/s3-connector');
const { requireRoles } = require('../middleware/permissions');
const { orgTypeContext } = require('../services/org-context');

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
    const audience = normalizeAudience(req.body.audience);
    if (!recordId || !audience) return res.status(400).json({ error: 'record_id and valid audience required' });

    const record = process.env.DATABASE_URL
      ? await db.getRecord(req.tenant, recordId)
      : localStore.getRecord(req.tenant, recordId);
    if (!record) return res.status(404).json({ error: 'Record not found' });

    const tier = record.confidence_tier || record.eqs_tier;
    if (!['TIER_1', 'TIER_2'].includes(tier)) {
      return res.status(403).json({ error: 'Knowledge products can only be generated from Tier 1 or Tier 2 records' });
    }

    const brief = await generateKnowledgeProduct({
      record,
      audience: audience.ai,
      orgTypeContext: orgTypeContext(req.tenant),
    });
    const product = {
      id: `KP-${Date.now().toString(36).toUpperCase()}`,
      tenant_id: req.tenant.slug,
      record_id: recordId,
      audience: audience.db,
      content: brief,
      word_count: brief.split(/\s+/).filter(Boolean).length,
      model_used: 'claude-sonnet-4-6',
      generated_by: req.user.sub || req.user.email,
      created_at: new Date().toISOString(),
    };

    if (process.env.DATABASE_URL) await db.createKnowledgeProduct(req.tenant, product);
    else localStore.saveKnowledgeProduct(req.tenant, product);

    await uploadJson({
      bucket: req.tenant.s3_vault_bucket,
      key: `exports/knowledge/${product.id}.json`,
      data: product,
      metadata: { tenant: req.tenant.slug, record_id: recordId },
    });

    res.json({ success: true, ...product, brief });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
