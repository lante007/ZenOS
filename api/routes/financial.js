'use strict';

const express = require('express');
const { requireRoles } = require('../middleware/permissions');
const { getPool } = require('../services/db');

const router = express.Router();

function assertSchema(schema) {
  if (!/^[a-z][a-z0-9_]*$/.test(schema || '')) {
    throw new Error(`Unsafe tenant schema: ${schema}`);
  }
}

router.get('/unconfirmed',
  requireRoles('ORGANISATION_LEAD'),
  async (req, res, next) => {
    try {
      const pool = getPool();
      if (!pool) return res.status(503).json({ error: 'Database is not configured' });

      const schema = req.tenant.db_schema || req.tenant.slug || 'zenex';
      assertSchema(schema);

      const result = await pool.query(`
        SELECT
          r.id, r.programme_name, r.document_type, d.filename,
          r.total_cost_rand, r.cost_data_source, r.cost_data_present,
          r.cost_per_learner, r.financial_year, r.cost_notes
        FROM ${schema}.intelligence_records r
        LEFT JOIN ${schema}.documents d ON d.id = r.document_id
        WHERE r.tenant_id = $1
          AND r.record_status = 'ACTIVE'
          AND r.total_cost_rand IS NOT NULL
          AND r.manually_confirmed IS NOT TRUE
        ORDER BY r.total_cost_rand DESC
      `, [req.tenant.slug]);

      const items = result.rows.map(row => ({
        record_id: row.id,
        programme_name: row.programme_name,
        document_type: row.document_type,
        filename: row.filename,
        suggested_value: row.total_cost_rand,
        source: row.cost_data_source || (row.cost_data_present === 'AUDITED' ? 'Document extraction (audited)' : 'Document extraction'),
        cost_per_learner: row.cost_per_learner,
        financial_year: row.financial_year,
        cost_notes: row.cost_notes,
      }));

      return res.json({
        count: items.length,
        items,
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
