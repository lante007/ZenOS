'use strict';

const express = require('express');
const { requireRoles } = require('../middleware/permissions');
const { getPool } = require('../services/db');
const {
  CRITICAL_FIELDS,
  FINANCIAL_FIELDS,
  ALL_WORKSPACE_FIELDS,
  isEmpty,
  isHumanRejected,
  describeFieldFor,
} = require('../services/workspace-fields');

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
        ? row.latest_year - row.earliest_year + 1
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

// Evidence Capital + EROI, shared by GET /cascade and the CEO brief route
// (POST /api/brief/ceo), which reuses this exact computation rather than
// re-deriving its own capital/EROI figures.
async function computeEvidenceCapitalAndEroi(pool, schema, tenantId) {
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
      ROUND(AVG(eqs_composite) FILTER (WHERE eqs_composite IS NOT NULL), 2) AS avg_eqs
    FROM ${schema}.intelligence_records
    WHERE tenant_id = $1
      AND record_status = 'ACTIVE'
  `, [tenantId]);
  const ec = ecResult.rows[0];

  // Evidence Capital = Financial Capital x Evidence Decay (NOT Financial Capital x EQS).
  // The Rand value of investment that remains decision-relevant after
  // accounting for evidence aging (half_life_rating).
  //
  // Grouped by programme family (falling back to the record's own id for
  // records with no family) and de-duplicated to one grant per group via
  // MAX(total_cost_rand) - a programme with a baseline and an endline record
  // both carrying the same total_cost_rand must only count that investment
  // once, not once per evaluation record. The decay rating used per group is
  // the most-current one available in that family (CURRENT beats AGING beats
  // HISTORICAL), since a programme's evidence currency should be judged by
  // its freshest evaluation, not diluted by an older duplicate row.
  const DECAY = { CURRENT: 1.0, AGING: 0.6, HISTORICAL: 0.3 };
  const decayResult = await pool.query(`
    WITH family_grants AS (
      SELECT
        COALESCE(programme_family_id, id::text) as group_key,
        MAX(total_cost_rand) as grant_per_group
      FROM ${schema}.intelligence_records
      WHERE tenant_id = $1
        AND record_status = 'ACTIVE'
        AND total_cost_rand IS NOT NULL
      GROUP BY group_key
    ),
    family_decay AS (
      SELECT DISTINCT ON (COALESCE(programme_family_id, id::text))
        COALESCE(programme_family_id, id::text) as group_key,
        half_life_rating
      FROM ${schema}.intelligence_records
      WHERE tenant_id = $1
        AND record_status = 'ACTIVE'
        AND total_cost_rand IS NOT NULL
      ORDER BY group_key,
        CASE half_life_rating WHEN 'CURRENT' THEN 1 WHEN 'AGING' THEN 2 WHEN 'HISTORICAL' THEN 3 ELSE 4 END ASC
    )
    SELECT fg.grant_per_group, fd.half_life_rating
    FROM family_grants fg
    JOIN family_decay fd ON fd.group_key = fg.group_key
  `, [tenantId]);

  let evidenceCapitalRand = 0;
  let financialCapitalTotal = 0;
  decayResult.rows.forEach(r => {
    const grant = parseFloat(r.grant_per_group) || 0;
    const decay = DECAY[r.half_life_rating] ?? 0.5;
    financialCapitalTotal += grant;
    evidenceCapitalRand += grant * decay;
  });
  const decayLossRand = financialCapitalTotal - evidenceCapitalRand;
  const decayLossPct = financialCapitalTotal > 0
    ? Math.round((decayLossRand / financialCapitalTotal) * 100)
    : 0;
  const ecHasData = financialCapitalTotal > 0;
  const ecLabel = value => `R${value >= 1000000 ? `${(value / 1000000).toFixed(1)}m` : Math.round(value).toLocaleString()}`;

  const evidenceCapital = {
    total_records: ec.total_records,
    tier_1: ec.tier_1,
    tier_2: ec.tier_2,
    tier_3: ec.tier_3,
    not_applicable: ec.not_applicable,
    avg_eqs: ec.avg_eqs,
    current: ec.current_count,
    aging: ec.aging_count,
    historical: ec.historical_count,
    has_data: ecHasData,
    rand_value: Math.round(evidenceCapitalRand),
    financial_capital_total: Math.round(financialCapitalTotal),
    decay_loss_rand: Math.round(decayLossRand),
    decay_loss_pct: decayLossPct,
    index: ec.avg_eqs,
    index_max: 5.0,
    label: ecHasData ? ecLabel(evidenceCapitalRand) : 'N/A',
    note: ecHasData ? `of ${ecLabel(financialCapitalTotal)} invested` : 'No classified financial records yet',
    cost_data_note: 'Rand value unavailable until financial records are classified.',
    interpretation: 'Investment value adjusted for evidence currency. Aging evidence retains 60 percent of value. Historical evidence retains 30 percent.',
    formula: `Evidence Capital reflects the decision-relevant value of Zenex's investment after accounting for evidence currency. Current evaluations retain full value. Aging evaluations retain 60 percent. Historical evaluations retain 30 percent. Average evidence quality across active records: ${ec.avg_eqs != null ? `${parseFloat(ec.avg_eqs).toFixed(2)} / 5.0` : 'N/A'}.`,
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

  // EROI = five-dimension portfolio return score, computed from corpus
  // data as proxies pending Decision Capital confirmation. See
  // methodology_note below for the source field behind each dimension.
  const eroiResult = await pool.query(`
    SELECT
      -- Dimension 1: System Adoption
      COUNT(*) FILTER (WHERE dbe_adoption_status = 'ADOPTED') as adopted_count,
      COUNT(*) FILTER (WHERE dbe_adoption_status = 'PILOTED') as piloted_count,
      COUNT(*) FILTER (WHERE dbe_adoption_status = 'REFERENCED') as referenced_count,
      COUNT(*) as total_active,

      -- Dimension 2: Policy Influence
      AVG(policy_relevance_score) FILTER (WHERE eqs_tier IN ('TIER_1','TIER_2')) as avg_policy_score,
      COUNT(*) FILTER (WHERE nls_alignment = true) as nls_count,
      COUNT(*) FILTER (WHERE funrs_alignment = true) as funrs_count,

      -- Dimension 3: Learning Outcomes
      COUNT(*) FILTER (
        WHERE effect_direction = 'Positive'
        AND eqs_tier IN ('TIER_1','TIER_2')
      ) as positive_outcomes,
      COUNT(*) FILTER (
        WHERE (document_type = 'Impact Evaluation' OR secondary_document_type = 'Impact Evaluation')
        AND eqs_tier IN ('TIER_1','TIER_2')
      ) as quality_impact_evals,

      -- Dimension 4: Knowledge Assets
      COUNT(*) FILTER (WHERE eqs_tier = 'TIER_1') as tier1_count,
      COUNT(*) FILTER (WHERE eqs_tier = 'TIER_2') as tier2_count,
      COUNT(DISTINCT programme_name) as programme_count,
      MAX(year::int) - MIN(year::int) + 1 as years_of_evidence,

      -- Dimension 5: Capital Leveraged
      COUNT(*) FILTER (WHERE array_length(funder_names, 1) > 1) as multi_funder_count

    FROM ${schema}.intelligence_records
    WHERE tenant_id = $1
      AND record_status = 'ACTIVE'
  `, [tenantId]);

  const er = eroiResult.rows[0];
  const totalActive = toNumber(er.total_active) || 1;
  const adoptedCount = toNumber(er.adopted_count);
  const pilotedCount = toNumber(er.piloted_count);
  const referencedCount = toNumber(er.referenced_count);
  const avgPolicyScore = er.avg_policy_score != null ? Number(er.avg_policy_score) : null;
  const nlsCount = toNumber(er.nls_count);
  const funrsCount = toNumber(er.funrs_count);
  const positiveOutcomes = toNumber(er.positive_outcomes);
  const qualityImpactEvals = toNumber(er.quality_impact_evals);
  const tier1Count = toNumber(er.tier1_count);
  const tier2Count = toNumber(er.tier2_count);
  const programmeCount = toNumber(er.programme_count);
  const yearsOfEvidence = er.years_of_evidence != null ? Number(er.years_of_evidence) : 0;
  const multiFunderCount = toNumber(er.multi_funder_count);

  // Dimension 1: System Adoption (30%) - max score if everything adopted
  const adoptionScore = Math.min(100,
    Math.round(
      (adoptedCount * 100 + pilotedCount * 50 + referencedCount * 25) / totalActive
    )
  );

  // Dimension 2: Policy Influence (20%) - policy_relevance_score (1-5 -> 0-100)
  const policyScore = Math.round(
    ((avgPolicyScore || 1) / 5) * 100
    * (1 + (nlsCount + funrsCount) / (totalActive * 2) * 0.2)
  );

  // Dimension 3: Learning Outcomes (20%) - proportion of quality impact
  // evaluations with a positive effect direction
  const outcomesScore = qualityImpactEvals > 0
    ? Math.round((positiveOutcomes / qualityImpactEvals) * 100)
    : 0;

  // Dimension 4: Knowledge Assets (15%) - composite of corpus depth and quality
  const knowledgeScore = Math.round(
    (tier1Count * 100 + tier2Count * 60) / totalActive * 0.5
    + Math.min(50, programmeCount * 1.5 + yearsOfEvidence * 2)
  );

  // Dimension 5: Capital Leveraged (15%) - proxy: multi-funder proportion.
  // Replace with Fatima-confirmed follow-on funding data in Phase 2.
  const leverageScore = Math.round((multiFunderCount / totalActive) * 100);

  const eroiScore = Math.round(
    adoptionScore * 0.30 +
    policyScore * 0.20 +
    outcomesScore * 0.20 +
    knowledgeScore * 0.15 +
    leverageScore * 0.15
  );

  const eroiLabel = eroiScore >= 80 ? 'Outstanding'
    : eroiScore >= 65 ? 'Strong'
    : eroiScore >= 50 ? 'Established'
    : eroiScore >= 35 ? 'Developing'
    : 'Early Stage';

  const eroi = {
    index: eroiScore,
    label: eroiLabel,
    dimensions: {
      system_adoption: { score: adoptionScore, weight: 30, contribution: Math.round(adoptionScore * 0.30) },
      policy_influence: { score: policyScore, weight: 20, contribution: Math.round(policyScore * 0.20) },
      learning_outcomes: { score: outcomesScore, weight: 20, contribution: Math.round(outcomesScore * 0.20) },
      knowledge_assets: { score: knowledgeScore, weight: 15, contribution: Math.round(knowledgeScore * 0.15) },
      capital_leveraged: { score: leverageScore, weight: 15, contribution: Math.round(leverageScore * 0.15) },
    },
    has_data: ec.total_records > 0,
    methodology_note: 'Computed from corpus data. System Adoption uses dbe_adoption_status. Policy Influence uses policy_relevance scores. Learning Outcomes uses effect_direction on quality evaluations. Knowledge Assets uses corpus depth and quality. Capital Leveraged uses multi-funder proportion as proxy. Full EROI requires Decision Capital confirmation.',
  };

  return { evidenceCapital, decisionCapital, eroi };
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
          COUNT(*) FILTER (WHERE total_cost_rand IS NOT NULL)::int AS audited_count,
          COALESCE((
            SELECT SUM(grant_per_group)
            FROM (
              SELECT
                COALESCE(programme_family_id, id::text) as group_key,
                MAX(total_cost_rand) as grant_per_group
              FROM ${schema}.intelligence_records
              WHERE tenant_id = $1
                AND record_status = 'ACTIVE'
                AND total_cost_rand IS NOT NULL
              GROUP BY group_key
            ) subq
          ), 0)::bigint AS total_rand
        FROM ${schema}.intelligence_records
        WHERE tenant_id = $1
          AND record_status = 'ACTIVE'
      `, [tenantId]);

      const fc = fcResult.rows[0];
      const fcAuditedCount = toNumber(fc.audited_count);
      const fcTotalRand = toNumber(fc.total_rand);
      const financialCapital = {
        has_data: fcAuditedCount > 0,
        value: fcAuditedCount > 0 ? fcTotalRand : null,
        label: fcAuditedCount > 0
          ? `R${fcTotalRand >= 1000000
            ? `${(fcTotalRand / 1000000).toFixed(1)}m`
            : fcTotalRand.toLocaleString()}`
          : 'N/A',
        note: fcAuditedCount > 0
          ? `${fcAuditedCount} audited source documents`
          : 'Upload audited financial records to calculate Financial Capital',
        formula: 'Total funds deployed for evidence-related activities. Source: classified financial documents only.',
      };

      const { evidenceCapital, decisionCapital, eroi } = await computeEvidenceCapitalAndEroi(pool, schema, tenantId);

      return res.json({
        financial_capital: financialCapital,
        evidence_capital: evidenceCapital,
        decision_capital: decisionCapital,
        eroi,
        generated_at: new Date().toISOString(),
        corpus_size: evidenceCapital.total_records,
      });
    } catch (err) {
      next(err);
    }
  }
);

router.get('/completeness',
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

      const columns = ['id', 'programme_name', 'document_type', 'optimy_project_id', 'optimy_field_values', 'validation_flags']
        .concat(ALL_WORKSPACE_FIELDS.map(f => f.field));

      const records = await pool.query(`
        SELECT ${columns.join(', ')}
        FROM ${schema}.intelligence_records
        WHERE tenant_id = $1
          AND record_status = 'ACTIVE'
      `, [tenantId]);

      let filledCells = 0;
      const totalCells = records.rows.length * ALL_WORKSPACE_FIELDS.length;
      const criticalGaps = [];
      const financialGaps = [];
      const incompleteRecordIds = new Set();

      for (const record of records.rows) {
        for (const def of ALL_WORKSPACE_FIELDS) {
          if (!isEmpty(record[def.field]) || isHumanRejected(record, def.field)) filledCells += 1;
        }

        const missingCritical = CRITICAL_FIELDS
          .map(def => describeFieldFor(record, def))
          .filter(entry => entry.current_value === null && !entry.reviewed);
        if (missingCritical.length > 0) {
          criticalGaps.push({
            record_id: record.id,
            programme_name: record.programme_name,
            document_type: record.document_type,
            missing_fields: missingCritical,
          });
          incompleteRecordIds.add(record.id);
        }

        const missingFinancial = FINANCIAL_FIELDS
          .map(def => describeFieldFor(record, def))
          .filter(entry => entry.current_value === null && !entry.reviewed);
        if (missingFinancial.length > 0) {
          financialGaps.push({
            record_id: record.id,
            programme_name: record.programme_name,
            document_type: record.document_type,
            missing_fields: missingFinancial,
          });
          incompleteRecordIds.add(record.id);
        }
      }

      criticalGaps.sort((a, b) => b.missing_fields.length - a.missing_fields.length);
      financialGaps.sort((a, b) => b.missing_fields.length - a.missing_fields.length);

      const completenessScore = totalCells > 0 ? Math.round((filledCells / totalCells) * 100) : 0;
      const incompleteRecordCount = incompleteRecordIds.size;
      const fullyCompleteCount = records.rows.length - incompleteRecordCount;

      return res.json({
        completeness_score: completenessScore,
        overall_completeness_pct: completenessScore,
        total_active_records: records.rows.length,
        fully_complete_count: fullyCompleteCount,
        incomplete_record_count: incompleteRecordCount,
        critical_gaps_count: criticalGaps.length,
        financial_gaps_count: financialGaps.length,
        critical_gaps: criticalGaps.slice(0, 50),
        financial_gaps: financialGaps.slice(0, 50),
      });
    } catch (err) {
      next(err);
    }
  }
);

const GAP_AREA_WEIGHTS = {
  'Early Grade Literacy and Numeracy': 10,
  'Early Grade Numeracy': 9,
  'System Wide Initiatives': 8,
  'Schools Programme': 6,
  'Thought Leadership': 4,
  'Research and Evaluations': 3,
};

// Internal prioritisation model. Not exposed via the API - only the
// resulting rank/description are returned, per product decision.
function computeGapPriorityScore(r) {
  const areaScore = GAP_AREA_WEIGHTS[r.programme_area] || 5;
  const w1 = areaScore * 0.30;

  const yearsOld = 2026 - (parseInt(r.last_year, 10) || 2020);
  const ageScore = yearsOld >= 7 ? 10 : yearsOld >= 5 ? 8 : yearsOld >= 3 ? 5 : 2;
  const w2 = ageScore * 0.25;

  const grant = parseFloat(r.total_cost_rand) || 0;
  const grantScore = grant >= 50000000 ? 10
    : grant >= 20000000 ? 8
    : grant >= 10000000 ? 6
    : grant >= 5000000 ? 4
    : grant > 0 ? 2 : 1;
  const w3 = grantScore * 0.20;

  const missingScore = (r.has_baseline && !r.has_endline) ? 10
    : (!r.has_baseline && !r.has_endline) ? 8
    : (!r.has_process) ? 5 : 3;
  const w4 = missingScore * 0.15;

  const policyScore = (r.nls_alignment && r.funrs_alignment) ? 10
    : (r.nls_alignment || r.funrs_alignment) ? 6 : 2;
  const w5 = policyScore * 0.10;

  return Math.round((w1 + w2 + w3 + w4 + w5) * 10);
}

function gapDescription(r) {
  const years = 2026 - (parseInt(r.last_year, 10) || 2020);
  if (r.has_baseline && !r.has_endline) {
    return `Baseline exists. No endline evaluation commissioned in ${years} years.`;
  }
  if (!r.has_baseline && !r.has_endline) {
    return 'No impact evaluation exists despite significant investment.';
  }
  if (!r.has_process) {
    return 'Impact data present. No implementation evaluation exists.';
  }
  return `Evidence base incomplete. Last evaluation ${r.last_year}.`;
}

// Gaps engine, shared by GET /gaps and the CEO brief route (POST
// /api/brief/ceo), which reuses this exact prioritisation logic rather
// than re-deriving its own top-gaps query.
async function getPriorityGaps(pool, schema, tenantId, limit = 12) {
  const result = await pool.query(`
    SELECT
      COALESCE(canonical_programme_name, programme_name) as programme_name,
      MAX(programme_area) as programme_area,
      MAX(year) as last_year,
      MAX(total_cost_rand) as total_cost_rand,
      bool_or(
        record_series = 'BASELINE'
        OR baseline_available = true
      ) as has_baseline,
      bool_or(
        record_series = 'ENDLINE'
        OR endline_available = true
      ) as has_endline,
      bool_or(
        document_type = 'Process Evaluation'
        OR secondary_document_type = 'Process Evaluation'
      ) as has_process,
      bool_or(nls_alignment = true) as nls_alignment,
      bool_or(funrs_alignment = true) as funrs_alignment,
      COUNT(*) as eval_count
    FROM ${schema}.intelligence_records
    WHERE tenant_id = $1
      AND record_status = 'ACTIVE'
      AND programme_name IS NOT NULL
    GROUP BY COALESCE(canonical_programme_name, programme_name)
    HAVING NOT bool_or(
      record_series = 'ENDLINE'
      OR endline_available = true
    )
    AND COUNT(*) >= 1
    ORDER BY MAX(year) ASC
  `, [tenantId]);

  const rankedGaps = result.rows
    .map(r => ({ ...r, priority_score: computeGapPriorityScore(r) }))
    .sort((a, b) => b.priority_score - a.priority_score);

  const gaps = rankedGaps
    .slice(0, limit)
    .map((r, index) => ({
      rank: index + 1,
      programme_name: r.programme_name,
      programme_area: r.programme_area,
      last_evaluation_year: r.last_year != null ? parseInt(r.last_year, 10) : null,
      total_grant_rand: r.total_cost_rand != null ? Number(r.total_cost_rand) : 0,
      gap_description: gapDescription(r),
      eval_count: Number(r.eval_count),
    }));

  return { gaps, total_identified: rankedGaps.length };
}

router.get('/gaps',
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

      const { gaps, total_identified } = await getPriorityGaps(pool, schema, tenantId, 12);

      return res.json({ gaps, total_identified });
    } catch (err) {
      next(err);
    }
  }
);

router.get('/',
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

      const result = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE record_status = 'ACTIVE')::int AS documents_classified,
          COUNT(*) FILTER (WHERE record_status = 'ACTIVE' AND parent_record_id IS NULL)::int AS independent_evaluations,
          COUNT(DISTINCT programme_name) FILTER (WHERE record_status = 'ACTIVE')::int AS programmes,
          MIN(CASE WHEN record_status = 'ACTIVE' AND year ~ '^[0-9]{4}$' THEN year::int ELSE NULL END) AS earliest_year,
          MAX(CASE WHEN record_status = 'ACTIVE' AND year ~ '^[0-9]{4}$' THEN year::int ELSE NULL END) AS latest_year,
          ROUND(AVG(eqs_composite) FILTER (WHERE record_status = 'ACTIVE' AND eqs_composite IS NOT NULL)::numeric, 2) AS avg_eqs,
          ROUND(AVG(dim_methodological_rigour) FILTER (WHERE record_status = 'ACTIVE' AND dim_methodological_rigour IS NOT NULL)::numeric, 2) AS dim_methodological_rigour,
          ROUND(AVG(dim_data_quality) FILTER (WHERE record_status = 'ACTIVE' AND dim_data_quality IS NOT NULL)::numeric, 2) AS dim_data_quality,
          ROUND(AVG(dim_transparency) FILTER (WHERE record_status = 'ACTIVE' AND dim_transparency IS NOT NULL)::numeric, 2) AS dim_transparency,
          ROUND(AVG(dim_replicability) FILTER (WHERE record_status = 'ACTIVE' AND dim_replicability IS NOT NULL)::numeric, 2) AS dim_replicability,
          ROUND(AVG(dim_context_relevance) FILTER (WHERE record_status = 'ACTIVE' AND dim_context_relevance IS NOT NULL)::numeric, 2) AS dim_context_relevance,
          COUNT(*) FILTER (WHERE record_status = 'ACTIVE' AND half_life_rating = 'CURRENT')::int AS freshness_current,
          COUNT(*) FILTER (WHERE record_status = 'ACTIVE' AND half_life_rating = 'AGING')::int AS freshness_aging,
          COUNT(*) FILTER (WHERE record_status = 'ACTIVE' AND half_life_rating = 'HISTORICAL')::int AS freshness_historical,
          COUNT(*) FILTER (WHERE record_status = 'ACTIVE' AND eqs_tier = 'TIER_1')::int AS tier_1,
          COUNT(*) FILTER (WHERE record_status = 'ACTIVE' AND eqs_tier = 'TIER_2')::int AS tier_2,
          COUNT(*) FILTER (WHERE record_status = 'ACTIVE' AND eqs_tier = 'TIER_3')::int AS tier_3,
          COUNT(*) FILTER (WHERE record_status = 'ACTIVE' AND eqs_tier = 'N_A')::int AS tier_n_a,
          COUNT(*) FILTER (WHERE record_status = 'PENDING_REVIEW')::int AS pending_review
        FROM ${schema}.intelligence_records
        WHERE tenant_id = $1
      `, [tenantId]);

      const provinceResult = await pool.query(`
        SELECT COUNT(DISTINCT p.province)::int AS provinces
        FROM ${schema}.intelligence_records r
        LEFT JOIN LATERAL unnest(COALESCE(r.provinces, ARRAY[]::text[])) AS p(province) ON true
        WHERE r.tenant_id = $1
          AND r.record_status = 'ACTIVE'
      `, [tenantId]);

      const row = result.rows[0] || {};
      const yearsOfEvidence = row.earliest_year && row.latest_year
        ? (row.latest_year - row.earliest_year + 1)
        : 0;
      const activeTotal = row.documents_classified || 0;

      return res.json({
        tenant: req.tenant.slug,
        organisation: req.tenant.name,
        documents_classified: row.documents_classified || 0,
        independent_evaluations: row.independent_evaluations || 0,
        programmes: row.programmes || 0,
        provinces: provinceResult.rows[0]?.provinces || 0,
        years_of_evidence: yearsOfEvidence,
        avg_eqs: row.avg_eqs != null ? Number(row.avg_eqs) : null,
        quality_dimensions: {
          methodological_rigour: row.dim_methodological_rigour != null ? Number(row.dim_methodological_rigour) : null,
          data_quality: row.dim_data_quality != null ? Number(row.dim_data_quality) : null,
          transparency: row.dim_transparency != null ? Number(row.dim_transparency) : null,
          replicability: row.dim_replicability != null ? Number(row.dim_replicability) : null,
          context_relevance: row.dim_context_relevance != null ? Number(row.dim_context_relevance) : null,
        },
        evidence_freshness: {
          current: row.freshness_current || 0,
          aging: row.freshness_aging || 0,
          historical: row.freshness_historical || 0,
          current_pct: activeTotal > 0 ? Math.round(((row.freshness_current || 0) / activeTotal) * 100) : 0,
          aging_pct: activeTotal > 0 ? Math.round(((row.freshness_aging || 0) / activeTotal) * 100) : 0,
          historical_pct: activeTotal > 0 ? Math.round(((row.freshness_historical || 0) / activeTotal) * 100) : 0,
        },
        tier_counts: {
          TIER_1: row.tier_1 || 0,
          TIER_2: row.tier_2 || 0,
          TIER_3: row.tier_3 || 0,
          N_A: row.tier_n_a || 0,
        },
        pending_review: row.pending_review || 0,
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
        FROM ${schema}.queue_items q
        LEFT JOIN ${schema}.intelligence_records r ON r.id = q.record_id
        WHERE q.tenant_id = $1
          AND q.resolved_at IS NULL
          AND (r.record_status IS NULL OR r.record_status <> 'SOFT_DELETED')
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

// Attached to the router function itself (Express Router is a function, so
// this is safe) so other routes - the CEO brief route in particular - can
// reuse the gaps and capital/EROI logic without re-deriving their own
// versions of these queries.
router.getPriorityGaps = getPriorityGaps;
router.computeEvidenceCapitalAndEroi = computeEvidenceCapitalAndEroi;

module.exports = router;
