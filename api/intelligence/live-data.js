'use strict';

// api/intelligence/live-data.js
// Request-time live corpus data for the Intelligence Console, patterned on
// api/routes/admin-ask.js: run read-only queries against the operating
// corpus and hand back a flat object the orchestrator passes to the agents.
//
// The capital and EROI figures reuse the exact computation behind
// GET /api/stats/cascade (stats.js exports it on the router) so the numbers
// here can never drift from what the Zenex dashboard shows.

const { computeEvidenceCapitalAndEroi } = require('../routes/stats');
const {
  CRITICAL_FIELDS,
  ALL_WORKSPACE_FIELDS,
  isEmpty,
  isHumanRejected,
  describeFieldFor,
} = require('../services/workspace-fields');

// The sole operating tenant. The Intelligence Console is entirely
// Zenex-facing, so the live block targets the Zenex corpus.
const PRIMARY_TENANT = 'zenex';
const PRIMARY_SCHEMA = 'zenex';

function assertSchema(schema) {
  if (!/^[a-z][a-z0-9_]*$/.test(schema || '')) {
    throw new Error(`Unsafe tenant schema: ${schema}`);
  }
}

// Replicates the GET /api/stats/completeness computation (filled-cell ratio
// plus per-record critical-gap detection) without going through the route.
async function computeCompleteness(pool, schema, tenantId) {
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
  const criticalGapRecordIds = new Set();

  for (const record of records.rows) {
    for (const def of ALL_WORKSPACE_FIELDS) {
      if (!isEmpty(record[def.field]) || isHumanRejected(record, def.field)) filledCells += 1;
    }
    const missingCritical = CRITICAL_FIELDS
      .map(def => describeFieldFor(record, def))
      .filter(entry => entry.current_value === null && !entry.reviewed);
    if (missingCritical.length > 0) criticalGapRecordIds.add(record.id);
  }

  return {
    completeness_pct: totalCells > 0 ? Math.round((filledCells / totalCells) * 100) : 0,
    critical_gap_record_count: criticalGapRecordIds.size,
  };
}

async function chiefOfStaffLiveData(pool) {
  assertSchema(PRIMARY_SCHEMA);

  const coreResult = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE record_status = 'ACTIVE')::int AS total_classified,
      ROUND(AVG(eqs_composite) FILTER (WHERE record_status = 'ACTIVE' AND eqs_composite IS NOT NULL), 2) AS avg_eqs,
      MAX(classified_at) FILTER (WHERE record_status = 'ACTIVE') AS last_ingestion,
      COUNT(*) FILTER (WHERE record_status = 'PENDING_REVIEW')::int AS pending_review
    FROM ${PRIMARY_SCHEMA}.intelligence_records
    WHERE tenant_id = $1
  `, [PRIMARY_TENANT]);
  const core = coreResult.rows[0] || {};

  // Financial Capital: identical query to stats.js GET /cascade.
  const fcResult = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE total_cost_rand IS NOT NULL)::int AS audited_count,
      COALESCE((
        SELECT SUM(grant_per_group)
        FROM (
          SELECT
            COALESCE(programme_family_id, id::text) as group_key,
            MAX(total_cost_rand) as grant_per_group
          FROM ${PRIMARY_SCHEMA}.intelligence_records
          WHERE tenant_id = $1
            AND record_status = 'ACTIVE'
            AND total_cost_rand IS NOT NULL
          GROUP BY group_key
        ) subq
      ), 0)::bigint AS total_rand
    FROM ${PRIMARY_SCHEMA}.intelligence_records
    WHERE tenant_id = $1
      AND record_status = 'ACTIVE'
  `, [PRIMARY_TENANT]);
  const fc = fcResult.rows[0] || {};
  const fcAuditedCount = Number(fc.audited_count || 0);
  const fcValue = fcAuditedCount > 0 ? Number(fc.total_rand || 0) : null;

  const completeness = await computeCompleteness(pool, PRIMARY_SCHEMA, PRIMARY_TENANT);
  const { eroi, decisionCapital } = await computeEvidenceCapitalAndEroi(pool, PRIMARY_SCHEMA, PRIMARY_TENANT);

  const decisionCapitalStatus = decisionCapital.confirmed_instances > 0
    ? `${decisionCapital.label} across ${decisionCapital.confirmed_instances} confirmed instance${decisionCapital.confirmed_instances === 1 ? '' : 's'}`
    : 'N/A. No confirmed decision instances exist yet.';

  return {
    total_classified_records: Number(core.total_classified || 0),
    average_eqs: core.avg_eqs != null ? Number(core.avg_eqs) : null,
    data_completeness_pct: completeness.completeness_pct,
    financial_capital_value: fcValue,
    financial_capital_source_documents: fcAuditedCount,
    eroi_index: eroi.has_data ? eroi.index : null,
    decision_capital_status: decisionCapitalStatus,
    records_pending_expert_review: Number(core.pending_review || 0),
    records_with_critical_missing_fields: completeness.critical_gap_record_count,
    last_ingestion: core.last_ingestion ? new Date(core.last_ingestion).toISOString() : null,
  };
}

async function evidenceAnalystLiveData(pool) {
  assertSchema(PRIMARY_SCHEMA);

  const pathwayResult = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE record_status = 'ACTIVE')::int AS total_classified,
      COUNT(*) FILTER (WHERE record_status = 'ACTIVE' AND eqs_scoring_pathway = 'IMPACT')::int AS impact_count,
      COUNT(*) FILTER (WHERE record_status = 'ACTIVE' AND eqs_scoring_pathway = 'PROCESS')::int AS process_count,
      COUNT(*) FILTER (WHERE record_status = 'ACTIVE' AND eqs_scoring_pathway = 'RESEARCH')::int AS research_count,
      COUNT(*) FILTER (WHERE record_status = 'ACTIVE' AND eqs_scoring_pathway IS NULL)::int AS unassigned_count,
      ROUND(AVG(eqs_composite) FILTER (WHERE record_status = 'ACTIVE' AND eqs_scoring_pathway = 'IMPACT' AND eqs_composite IS NOT NULL), 2) AS impact_avg_eqs,
      ROUND(AVG(eqs_composite) FILTER (WHERE record_status = 'ACTIVE' AND eqs_scoring_pathway = 'PROCESS' AND eqs_composite IS NOT NULL), 2) AS process_avg_eqs,
      ROUND(AVG(eqs_composite) FILTER (WHERE record_status = 'ACTIVE' AND eqs_scoring_pathway = 'RESEARCH' AND eqs_composite IS NOT NULL), 2) AS research_avg_eqs,
      COUNT(*) FILTER (WHERE record_status = 'ACTIVE' AND half_life_rating = 'AGING')::int AS aging_count
    FROM ${PRIMARY_SCHEMA}.intelligence_records
    WHERE tenant_id = $1
  `, [PRIMARY_TENANT]);
  const p = pathwayResult.rows[0] || {};

  // Programmes present in the corpus with no evaluation record on file, where
  // "evaluation" means a record on the IMPACT or PROCESS EQS pathway (RESEARCH
  // pathway records are studies, not evaluations).
  const noEvalResult = await pool.query(`
    SELECT COALESCE(canonical_programme_name, programme_name) AS programme
    FROM ${PRIMARY_SCHEMA}.intelligence_records
    WHERE tenant_id = $1
      AND record_status = 'ACTIVE'
      AND programme_name IS NOT NULL
    GROUP BY COALESCE(canonical_programme_name, programme_name)
    HAVING NOT bool_or(eqs_scoring_pathway IN ('IMPACT', 'PROCESS'))
    ORDER BY programme
  `, [PRIMARY_TENANT]);
  const programmesWithoutEvaluation = noEvalResult.rows.map(r => r.programme);

  return {
    total_classified_records: Number(p.total_classified || 0),
    pathway_counts: {
      IMPACT: Number(p.impact_count || 0),
      PROCESS: Number(p.process_count || 0),
      RESEARCH: Number(p.research_count || 0),
      UNASSIGNED: Number(p.unassigned_count || 0),
    },
    pathway_avg_eqs: {
      IMPACT: p.impact_avg_eqs != null ? Number(p.impact_avg_eqs) : null,
      PROCESS: p.process_avg_eqs != null ? Number(p.process_avg_eqs) : null,
      RESEARCH: p.research_avg_eqs != null ? Number(p.research_avg_eqs) : null,
    },
    records_rated_ageing: Number(p.aging_count || 0),
    programmes_without_evaluation_count: programmesWithoutEvaluation.length,
    programmes_without_evaluation: programmesWithoutEvaluation.slice(0, 25),
  };
}

// Flat snapshot consumed by the orchestrator and the agents. Merges the
// Chief-of-Staff-level corpus metrics with the Evidence-Analyst pathway
// breakdown into the shape the evidence agent's runtime block expects.
async function getLiveCorpusData(pool) {
  const [cos, ea] = await Promise.all([
    chiefOfStaffLiveData(pool),
    evidenceAnalystLiveData(pool),
  ]);

  return {
    records: cos.total_classified_records,
    avg_eqs: cos.average_eqs,
    completeness: cos.data_completeness_pct,
    financial_capital: cos.financial_capital_value,
    financial_source_count: cos.financial_capital_source_documents,
    eroi: cos.eroi_index,
    decision_capital: cos.decision_capital_status,
    pending_review: cos.records_pending_expert_review,
    missing_fields: cos.records_with_critical_missing_fields,
    last_ingestion: cos.last_ingestion,
    eqs_impact: ea.pathway_avg_eqs.IMPACT,
    eqs_process: ea.pathway_avg_eqs.PROCESS,
    eqs_research: ea.pathway_avg_eqs.RESEARCH,
    pathway_counts: ea.pathway_counts,
    ageing_count: ea.records_rated_ageing,
    programmes_without_evaluation: ea.programmes_without_evaluation,
    programmes_without_evaluation_count: ea.programmes_without_evaluation_count,
  };
}

module.exports = {
  getLiveCorpusData,
  chiefOfStaffLiveData,
  evidenceAnalystLiveData,
};
