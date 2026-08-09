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
          id, programme_name, document_type, filename,
          total_cost_rand, cost_data_source, cost_data_present,
          cost_per_learner, financial_year, cost_notes
        FROM ${schema}.intelligence_records
        WHERE tenant_id = $1
          AND record_status = 'ACTIVE'
          AND total_cost_rand IS NOT NULL
          AND manually_confirmed IS NOT TRUE
        ORDER BY total_cost_rand DESC
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
