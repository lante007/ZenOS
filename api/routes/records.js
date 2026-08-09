'use strict';

const express = require('express');
const db = require('../services/db');
const localStore = require('../services/local-store');
const { requireRoles } = require('../middleware/permissions');
const { ALLOWED_FIELD_NAMES, fieldDef } = require('../services/workspace-fields');

const router = express.Router();

function schemaFor(tenant) {
  const schema = tenant.db_schema || tenant.slug || 'zenex';
  if (!/^[a-z][a-z0-9_]*$/.test(schema)) {
    throw new Error(`Unsafe tenant schema: ${schema}`);
  }
  return schema;
}

function costDataPresentForSource(source) {
  if (source === 'AUDITED') return 'AUDITED';
  if (source) return 'PROXY';
  return 'ABSENT';
}

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

router.put('/:id/financials', requireRoles('ORGANISATION_LEAD'), async (req, res, next) => {
  try {
    const pool = db.getPool();
    if (!pool) {
      return res.status(503).json({ error: 'Database is not configured' });
    }

    const schema = schemaFor(req.tenant);
    const {
      total_cost_rand,
      cost_data_source,
      cost_per_learner,
      financial_year,
      cost_notes,
      audited_financials_used,
    } = req.body || {};

    const validSources = [
      'AUDITED',
      'GRANT_AGREEMENT',
      'MANAGEMENT_ACCOUNTS',
      'PROXY',
      'UNKNOWN',
    ];

    if (cost_data_source && !validSources.includes(cost_data_source)) {
      return res.status(400).json({ error: 'Invalid cost_data_source' });
    }

    const sroiReady = cost_data_source === 'AUDITED' || cost_data_source === 'PROXY';
    const result = await pool.query(`
      UPDATE ${schema}.intelligence_records
      SET
        total_cost_rand = $1,
        cost_data_present = $2,
        cost_data_source = $3,
        cost_per_learner = $4,
        financial_year = $5,
        cost_notes = $6,
        audited_financials_used = $7,
        sroi_ready = $8,
        updated_at = NOW()
      WHERE id = $9
        AND tenant_id = $10
      RETURNING id, total_cost_rand,
        cost_data_present, cost_data_source,
        cost_per_learner, financial_year,
        cost_notes, audited_financials_used,
        sroi_ready, updated_at
    `, [
      total_cost_rand || null,
      costDataPresentForSource(cost_data_source),
      cost_data_source || null,
      cost_per_learner || null,
      financial_year || null,
      cost_notes || null,
      Boolean(audited_financials_used),
      sroiReady,
      req.params.id,
      req.tenant.slug,
    ]);

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Record not found' });
    }

    await pool.query(`
      INSERT INTO ${schema}.audit_log (
        event_type, user_id,
        tenant_id, detail, created_at
      ) VALUES (
        'FINANCIAL_DATA_ADDED',
        $1, $2, $3, NOW()
      )
    `, [
      req.user?.sub,
      req.tenant.slug,
      JSON.stringify({
        record_id: req.params.id,
        cost_data_source,
        total_cost_rand,
        sroi_ready: sroiReady,
        added_by: req.user?.email,
      }),
    ]);

    return res.json({
      success: true,
      record: result.rows[0],
    });
  } catch (err) {
    next(err);
  }
});

function coerceValue(def, rawValue) {
  if (rawValue === null || rawValue === undefined || rawValue === '') return null;
  if (def.type === 'number') {
    const num = Number(rawValue);
    if (Number.isNaN(num)) throw Object.assign(new Error(`${def.field} must be numeric`), { status: 400 });
    return num;
  }
  if (def.type === 'boolean') {
    if (typeof rawValue === 'boolean') return rawValue;
    if (rawValue === 'true') return true;
    if (rawValue === 'false') return false;
    throw Object.assign(new Error(`${def.field} must be true or false`), { status: 400 });
  }
  if (def.type === 'enum') {
    if (!def.options.includes(rawValue)) {
      throw Object.assign(new Error(`${def.field} must be one of: ${def.options.join(', ')}`), { status: 400 });
    }
    return rawValue;
  }
  return String(rawValue);
}

// Generic field writer for the Evidence Intelligence Workspace (Corpus
// Health + Financial Confirmation sections). Field name is validated
// against the workspace-fields allowlist before it ever touches SQL.
router.patch('/:id/field', requireRoles('ORGANISATION_LEAD'), async (req, res, next) => {
  try {
    const pool = db.getPool();
    if (!pool) return res.status(503).json({ error: 'Database is not configured' });

    const schema = schemaFor(req.tenant);
    const { field, value, source } = req.body || {};

    if (!ALLOWED_FIELD_NAMES.includes(field)) {
      return res.status(400).json({ error: `Field '${field}' is not editable via this endpoint` });
    }

    const def = fieldDef(field);
    let coerced;
    try {
      coerced = coerceValue(def, value);
    } catch (validationErr) {
      return res.status(validationErr.status || 400).json({ error: validationErr.message });
    }

    const setClauses = [`${field} = $1`, 'manually_confirmed = true', 'manually_confirmed_by = $2', 'manually_confirmed_at = NOW()', 'updated_at = NOW()'];
    const params = [coerced, req.user?.email || req.user?.sub || null];

    if (field === 'total_cost_rand' && source) {
      const validSources = ['AUDITED', 'GRANT_AGREEMENT', 'MANAGEMENT_ACCOUNTS', 'PROXY', 'UNKNOWN'];
      if (!validSources.includes(source)) {
        return res.status(400).json({ error: 'Invalid source' });
      }
      setClauses.push(`cost_data_source = $${params.length + 1}`);
      params.push(source);
      setClauses.push(`cost_data_present = $${params.length + 1}`);
      params.push(costDataPresentForSource(source));
    }

    params.push(req.params.id, req.tenant.slug);

    const result = await pool.query(`
      UPDATE ${schema}.intelligence_records
      SET ${setClauses.join(', ')}
      WHERE id = $${params.length - 1}
        AND tenant_id = $${params.length}
      RETURNING id, ${field}, manually_confirmed, manually_confirmed_by, manually_confirmed_at
    `, params);

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Record not found' });
    }

    await pool.query(`
      INSERT INTO ${schema}.audit_log (
        event_type, user_id, tenant_id, detail, created_at
      ) VALUES ('WORKSPACE_FIELD_CONFIRMED', $1, $2, $3, NOW())
    `, [
      req.user?.sub,
      req.tenant.slug,
      JSON.stringify({
        record_id: req.params.id,
        field,
        value: coerced,
        source: source || null,
        confirmed_by: req.user?.email,
      }),
    ]);

    return res.json({ success: true, record: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
