'use strict';

const express = require('express');
const db = require('../services/db');
const localStore = require('../services/local-store');
const { requireRoles } = require('../middleware/permissions');

const router = express.Router();

const SUMMARY_FIELDS = [
  'id',
  'adei_record_id',
  'tenant_id',
  'filename',
  'institution',
  'document_type',
  'programme_name',
  'programme',
  'phase',
  'year',
  'provinces',
  'key_finding_1',
  'key_finding_2',
  'key_finding_3',
  'policy_relevance_score',
  'strategic_value_score',
  'confidence_tier',
  'eqs_tier',
  'eqs_composite',
  'evidence_capital_score',
  'half_life_rating',
  'board_citable',
  'publication_status',
  'audience_relevance',
  'classified_at',
  'status',
];

function summarize(record) {
  const out = {};
  for (const field of SUMMARY_FIELDS) out[field] = record[field];
  return out;
}

function visibleRecordsForRole(records, role) {
  if (role === 'COMMUNICATIONS') {
    return records
      .filter(r => ['TIER_1', 'TIER_2'].includes(r.confidence_tier || r.eqs_tier))
      .map(summarize);
  }
  if (role === 'CEO_EXEC') return records.map(summarize);
  return records;
}

async function loadRecords(tenant, filters) {
  const rows = process.env.DATABASE_URL ? await db.listRecords(tenant, filters) : null;
  return rows || localStore.listRecords(tenant, filters);
}

async function loadRecord(tenant, id) {
  const row = process.env.DATABASE_URL ? await db.getRecord(tenant, id) : null;
  return row || localStore.getRecord(tenant, id);
}

router.get('/', requireRoles('ORGANISATION_LEAD', 'EVIDENCE_ANALYST', 'COMMUNICATIONS'), async (req, res, next) => {
  try {
    const records = await loadRecords(req.tenant, req.query);
    res.json(visibleRecordsForRole(records, req.user.role));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireRoles('ORGANISATION_LEAD', 'EVIDENCE_ANALYST', 'COMMUNICATIONS'), async (req, res, next) => {
  try {
    const record = await loadRecord(req.tenant, req.params.id);
    if (!record) return res.status(404).json({ error: 'Record not found' });
    const visible = visibleRecordsForRole([record], req.user.role)[0];
    res.json(visible);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
