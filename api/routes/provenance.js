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

router.get('/:id',
  requireRoles(
    'ORGANISATION_LEAD', 'EVIDENCE_ANALYST',
    'COMMUNICATIONS', 'CEO_EXEC'
  ),
  async (req, res, next) => {
    try {
      const pool = getPool();
      if (!pool) return res.status(503).json({ error: 'Database is not configured' });
      const schema = req.tenant.db_schema || req.tenant.slug || 'zenex';
      assertSchema(schema);

      const prov = await pool.query(
        `SELECT * FROM ${schema}.provenance_records
         WHERE id = $1
           AND tenant_id = $2`,
        [req.params.id, req.tenant.slug]
      );

      if (!prov.rows[0]) {
        return res.status(404).json({
          error: 'Provenance record not found',
        });
      }

      const record = prov.rows[0];

      const sourceRecords = record
        .source_record_ids?.length > 0
        ? (await pool.query(
          `SELECT id, programme_name,
             document_type, eqs_composite,
             classified_at
           FROM ${schema}.intelligence_records
           WHERE id = ANY($1)
             AND tenant_id = $2
             AND record_status = 'ACTIVE'`,
          [record.source_record_ids, req.tenant.slug]
        )).rows
        : [];

      let synthesis = null;
      if (record.synthesis_id) {
        const syn = await pool.query(
          `SELECT * FROM ${schema}.syntheses
           WHERE id = $1`,
          [record.synthesis_id]
        );
        synthesis = syn.rows[0] || null;
      }

      return res.json({
        ...record,
        source_records: sourceRecords,
        synthesis,
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
