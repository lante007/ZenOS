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
          ? `${ec.total_records} records · EC index ${ec.net_ec_index}`
          : 'N/A',
        note: ec.total_records > 0
          ? `Tier 1: ${ec.tier_1} · Aging: ${ec.aging_count}`
          : 'No classified records yet',
        formula: 'Σ(EQS ÷ 5 × pathway multiplier × depreciation factor). RCT=1.0, Process=0.75, Formative=0.60. Current=1.0, Aging=0.65, Historical=0.30.',
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

module.exports = router;
