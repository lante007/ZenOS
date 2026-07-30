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

function toNumber(value) {
  if (value == null) return 0;
  return Number(value);
}

router.get('/estate',
  requireRoles(
    'ORGANISATION_LEAD',
    'EVIDENCE_ANALYST',
    'COMMUNICATIONS',
    'CEO_EXEC'
  ),
  async (req, res, next) => {
    try {
      const pool = getPool();
      if (!pool) return res.status(503).json({ error: 'Database is not configured' });

      const schema = req.tenant.db_schema || req.tenant.slug || 'zenex';
      assertSchema(schema);

      const summary = await pool.query(`
        SELECT
          COUNT(*)::int AS total_records,
          COUNT(DISTINCT programme_name)::int AS total_programmes,
          MIN(CASE WHEN year ~ '^[0-9]{4}$' THEN year::int ELSE NULL END) AS earliest_year,
          MAX(CASE WHEN year ~ '^[0-9]{4}$' THEN year::int ELSE NULL END) AS latest_year,
          MAX(classified_at) AS last_ingestion
        FROM ${schema}.intelligence_records
        WHERE tenant_id = $1
          AND record_status = 'ACTIVE'
      `, [req.tenant.slug]);

      const provinceSummary = await pool.query(`
        SELECT COUNT(DISTINCT p.province)::int AS total_provinces
        FROM ${schema}.intelligence_records r
        LEFT JOIN LATERAL unnest(COALESCE(r.provinces, ARRAY[]::text[])) AS p(province) ON true
        WHERE r.tenant_id = $1
          AND r.record_status = 'ACTIVE'
      `, [req.tenant.slug]);

      const typeBreakdown = await pool.query(`
        SELECT
          document_type,
          COUNT(*)::int AS count
        FROM ${schema}.intelligence_records
        WHERE tenant_id = $1
          AND record_status = 'ACTIVE'
        GROUP BY document_type
        ORDER BY count DESC, document_type
      `, [req.tenant.slug]);

      const provincesResult = await pool.query(`
        SELECT
          province,
          COUNT(*)::int AS count
        FROM (
          SELECT UNNEST(provinces) AS province
          FROM ${schema}.intelligence_records
          WHERE tenant_id = $1
            AND record_status = 'ACTIVE'
            AND provinces IS NOT NULL
        ) p
        WHERE province IS NOT NULL
          AND province <> ''
        GROUP BY province
        ORDER BY count DESC, province
      `, [req.tenant.slug]);

      const yearsResult = await pool.query(`
        SELECT
          year,
          COUNT(*)::int AS count
        FROM ${schema}.intelligence_records
        WHERE tenant_id = $1
          AND record_status = 'ACTIVE'
          AND year IS NOT NULL
        GROUP BY year
        ORDER BY year ASC
      `, [req.tenant.slug]);

      const totalProvinceRecords = provincesResult.rows.reduce(
        (sum, province) => sum + Number(province.count || 0),
        0
      );
      const totalYearRecords = yearsResult.rows.reduce(
        (sum, year) => sum + Number(year.count || 0),
        0
      );

      const row = summary.rows[0] || {};
      const yearsSpan = row.latest_year && row.earliest_year
        ? row.latest_year - row.earliest_year
        : 0;

      return res.json({
        total_records: row.total_records || 0,
        total_programmes: row.total_programmes || 0,
        total_provinces: provinceSummary.rows[0]?.total_provinces || 0,
        years_span: yearsSpan,
        earliest_year: row.earliest_year,
        latest_year: row.latest_year,
        last_ingestion: row.last_ingestion,
        type_breakdown: typeBreakdown.rows.map(row => ({
          type: row.document_type,
          document_type: row.document_type,
          count: row.count,
        })),
        province_breakdown: provincesResult.rows.map(row => ({
          province: row.province,
          count: row.count,
          pct: totalProvinceRecords > 0
            ? Math.round((Number(row.count || 0) / totalProvinceRecords) * 100)
            : 0,
        })),
        year_breakdown: yearsResult.rows.map(row => ({
          year: row.year,
          count: row.count,
          pct: totalYearRecords > 0
            ? Math.round((Number(row.count || 0) / totalYearRecords) * 100)
            : 0,
        })),
      });
    } catch (err) {
      next(err);
    }
  }
);

router.get('/cascade',
  requireRoles(
    'ORGANISATION_LEAD',
    'EVIDENCE_ANALYST',
    'COMMUNICATIONS',
    'CEO_EXEC'
  ),
  async (req, res, next) => {
    try {
      const pool = getPool();
      if (!pool) return res.status(503).json({ error: 'Database is not configured' });

      const schema = req.tenant.db_schema || req.tenant.slug || 'zenex';
      assertSchema(schema);
      const tenantId = req.tenant.slug;

      const fcResult = await pool.query(`
        SELECT
          COUNT(*)::int AS financial_docs,
          COALESCE(SUM(
            CASE
              WHEN cost_data_present = 'AUDITED'
              THEN 1 ELSE 0
            END
          ), 0)::int AS audited_count
        FROM ${schema}.intelligence_records
        WHERE tenant_id = $1
          AND record_status = 'ACTIVE'
          AND document_type IN (
            'Financial Record',
            'Annual Report',
            'Audited Financials',
            'Budget Document'
          )
      `, [tenantId]);

      const fc = fcResult.rows[0];
      const financialCapital = {
        has_data: fc.financial_docs > 0,
        value: null,
        label: fc.financial_docs > 0
          ? 'From classified financial records'
          : 'N/A',
        note: fc.financial_docs > 0
          ? `${fc.audited_count} audited source documents`
          : 'Upload audited financial records to calculate Financial Capital',
        formula: 'Total funds deployed for evidence-related activities. Source: classified financial documents only.',
      };

      const ecResult = await pool.query(`
        SELECT
          COUNT(*)::int AS total_records,
          COUNT(*) FILTER (WHERE eqs_tier = 'TIER_1')::int AS tier_1,
          COUNT(*) FILTER (WHERE eqs_tier = 'TIER_2')::int AS tier_2,
          COUNT(*) FILTER (WHERE eqs_tier = 'TIER_3')::int AS tier_3,
          COUNT(*) FILTER (WHERE eqs_tier = 'N_A')::int AS not_applicable,
          COUNT(*) FILTER (WHERE half_life_rating = 'CURRENT')::int AS current_count,
          COUNT(*) FILTER (WHERE half_life_rating = 'AGING')::int AS aging_count,
          COUNT(*) FILTER (WHERE half_life_rating = 'HISTORICAL')::int AS historical_count,
          ROUND(AVG(eqs_composite) FILTER (WHERE eqs_composite IS NOT NULL), 2) AS avg_eqs,
          ROUND(SUM(
            CASE
              WHEN eqs_composite IS NULL
                THEN 0
              ELSE
                (eqs_composite / 5.0)
                * CASE
                    WHEN evaluation_subtype IN ('RCT', 'Quasi-experimental')
                    THEN 1.00
                    WHEN document_type = 'Impact Evaluation'
                    THEN 0.85
                    WHEN document_type IN ('Process Evaluation', 'Implementation Evaluation')
                    THEN 0.75
                    ELSE 0.60
                  END
                * CASE half_life_rating
                    WHEN 'CURRENT' THEN 1.00
                    WHEN 'AGING' THEN 0.65
                    WHEN 'HISTORICAL' THEN 0.30
                    ELSE 1.00
                  END
            END
          ), 4) AS net_ec_index
        FROM ${schema}.intelligence_records
        WHERE tenant_id = $1
          AND record_status = 'ACTIVE'
      `, [tenantId]);

      const ec = ecResult.rows[0];
      const evidenceCapital = {
        total_records: ec.total_records,
        tier_1: ec.tier_1,
        tier_2: ec.tier_2,
        tier_3: ec.tier_3,
        not_applicable: ec.not_applicable,
        avg_eqs: ec.avg_eqs,
        net_ec_index: ec.net_ec_index,
        current: ec.current_count,
        aging: ec.aging_count,
        historical: ec.historical_count,
        has_data: ec.total_records > 0,
        label: ec.total_records > 0
          ? (ec.net_ec_index
              ? `${parseFloat(ec.net_ec_index).toFixed(2)} / 5.0`
              : 'N/A')
          : 'N/A',
        note: ec.total_records > 0
          ? `Quality-adjusted evidence index · ${ec.total_records} records`
          : 'No classified records yet',
        cost_data_note: 'Rand value unavailable until financial records are classified.',
        formula: 'Quality-adjusted evidence index (0-5.0). Formula: Σ(EQS ÷ 5 × pathway multiplier × depreciation factor) ÷ record count. Rand value unlocks when audited financial records are classified.',
      };

      const decisionTable = await pool.query('SELECT to_regclass($1) AS table_name', [`${schema}.decision_capital_instances`]);
      let dc = { instances: 0, total_rand: 0 };
      if (decisionTable.rows[0]?.table_name) {
        const dcResult = await pool.query(`
          SELECT
            COUNT(*)::int AS instances,
            COALESCE(SUM(financial_value_rand), 0) AS total_rand
          FROM ${schema}.decision_capital_instances
          WHERE tenant_id = $1
            AND confirmed_at IS NOT NULL
        `, [tenantId]);
        dc = dcResult.rows[0];
      }

      const decisionCapital = {
        confirmed_instances: toNumber(dc.instances),
        total_rand_value: toNumber(dc.total_rand),
        has_data: toNumber(dc.instances) > 0,
        label: toNumber(dc.instances) > 0
          ? `R${toNumber(dc.total_rand) >= 1000000
            ? `${(toNumber(dc.total_rand) / 1000000).toFixed(1)}m`
            : toNumber(dc.total_rand).toLocaleString()}`
          : 'N/A',
        note: toNumber(dc.instances) > 0
          ? `${dc.instances} confirmed instance${toNumber(dc.instances) !== 1 ? 's' : ''}`
          : 'No confirmed decision instances. Upload board papers to populate.',
        formula: 'Confirmed Rand value of decisions attributable to classified evidence. Source: ratified decision instances only. No estimates.',
      };

      const qualityScore = ec.avg_eqs
        ? Math.round((toNumber(ec.avg_eqs) / 5) * 25)
        : 0;

      const totalForCurrency = ec.total_records || 1;
      const currencyPct = ec.current_count / totalForCurrency;
      const currencyScore = Math.round(currencyPct * 25);

      const coverageResult = await pool.query(`
        SELECT
          COUNT(DISTINCT r.phase)::int AS phases,
          COUNT(DISTINCT r.document_type)::int AS doc_types,
          COUNT(DISTINCT p.province)::int AS provinces
        FROM ${schema}.intelligence_records r
        LEFT JOIN LATERAL unnest(COALESCE(r.provinces, ARRAY[]::text[])) AS p(province) ON true
        WHERE r.tenant_id = $1
          AND r.record_status = 'ACTIVE'
      `, [tenantId]);
      const cov = coverageResult.rows[0];
      const coverageScore = Math.min(25,
        Math.round(
          (Math.min(cov.phases, 4) / 4) * 10 +
          (Math.min(cov.doc_types, 3) / 3) * 8 +
          (Math.min(cov.provinces, 4) / 4) * 7
        )
      );

      const standardsResult = await pool.query(`
        SELECT ROUND(
          100.0 * AVG(
            (CASE WHEN methodology_description IS NOT NULL THEN 1 ELSE 0 END +
             CASE WHEN null_findings_reported IS NOT NULL THEN 1 ELSE 0 END +
             CASE WHEN limitations IS NOT NULL THEN 1 ELSE 0 END +
             CASE WHEN effect_size_composite IS NOT NULL
               OR document_type NOT IN ('Impact Evaluation')
              THEN 1 ELSE 0 END
            ) / 4.0
          ), 1
        ) AS pct
        FROM ${schema}.intelligence_records
        WHERE tenant_id = $1
          AND record_status = 'ACTIVE'
      `, [tenantId]);

      const stdPct = parseFloat(standardsResult.rows[0]?.pct || 0);
      const standardsScore = Math.round((stdPct / 100) * 25);
      const icIndex = qualityScore + currencyScore + coverageScore + standardsScore;

      const institutionalCapital = {
        index: icIndex,
        dimensions: {
          evidence_quality: {
            score: qualityScore,
            max: 25,
            label: 'Evidence quality',
          },
          currency: {
            score: currencyScore,
            max: 25,
            label: 'Evidence currency',
          },
          coverage: {
            score: coverageScore,
            max: 25,
            label: 'Portfolio coverage',
          },
          commissioning_standards: {
            score: standardsScore,
            max: 25,
            label: 'Commissioning standards',
          },
        },
        has_data: ec.total_records > 0,
        label: ec.total_records > 0 ? `${icIndex} / 100` : 'N/A',
        formula: 'Index 0–100. Four dimensions (25 pts each): Evidence Quality, Currency, Coverage, Commissioning Standards. Recalculates as corpus grows.',
      };

      return res.json({
        financial_capital: financialCapital,
        evidence_capital: evidenceCapital,
        decision_capital: decisionCapital,
        institutional_capital: institutionalCapital,
        generated_at: new Date().toISOString(),
        corpus_size: ec.total_records,
      });
    } catch (err) {
      next(err);
    }
  }
);

router.get('/portfolio',
  requireRoles(
    'ORGANISATION_LEAD',
    'EVIDENCE_ANALYST',
    'COMMUNICATIONS',
    'CEO_EXEC'
  ),
  async (req, res, next) => {
    try {
      const pool = getPool();
      if (!pool) return res.status(503).json({ error: 'Database is not configured' });

      const schema = req.tenant.db_schema || req.tenant.slug || 'zenex';
      assertSchema(schema);

      const freshness = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE half_life_rating = 'CURRENT')::int AS current_count,
          COUNT(*) FILTER (WHERE half_life_rating = 'AGING')::int AS aging_count,
          COUNT(*) FILTER (WHERE half_life_rating = 'HISTORICAL')::int AS historical_count,
          COUNT(*)::int AS total
        FROM ${schema}.intelligence_records
        WHERE tenant_id = $1
          AND record_status = 'ACTIVE'
      `, [req.tenant.slug]);

      const gaps = await pool.query(`
        SELECT COUNT(*)::int AS gap_count
        FROM ${schema}.intelligence_records
        WHERE tenant_id = $1
          AND record_status = 'ACTIVE'
          AND (
            evidence_gap_1 IS NOT NULL OR
            endline_available = false
          )
      `, [req.tenant.slug]);

      const queue = await pool.query(`
        SELECT COUNT(*)::int AS pending
        FROM ${schema}.queue_items
        WHERE tenant_id = $1
          AND resolved_at IS NULL
      `, [req.tenant.slug]);

      const programmes = await pool.query(`
        SELECT
          programme_name,
          eqs_tier,
          half_life_rating,
          year
        FROM ${schema}.intelligence_records
        WHERE tenant_id = $1
          AND record_status = 'ACTIVE'
        ORDER BY programme_name
      `, [req.tenant.slug]);

      const fr = freshness.rows[0] || {};
      const total = fr.total || 1;

      return res.json({
        freshness: {
          current: fr.current_count || 0,
          aging: fr.aging_count || 0,
          historical: fr.historical_count || 0,
          current_pct: Math.round(((fr.current_count || 0) / total) * 100),
          aging_pct: Math.round(((fr.aging_count || 0) / total) * 100),
          historical_pct: Math.round(((fr.historical_count || 0) / total) * 100),
        },
        evidence_gaps: gaps.rows[0]?.gap_count || 0,
        pending_review: queue.rows[0]?.pending || 0,
        programmes: programmes.rows,
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
