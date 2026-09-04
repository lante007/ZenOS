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

// The default operating tenant for single-tenant callers (unchanged from
// V1/V1.1). Multi-tenant aggregation (getAllTenantsCorpusData, below) takes
// an explicit, caller-authorised tenant list instead of relying on these.
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

// tenantId/schema default to the primary Zenex tenant so every existing
// caller (getLiveCorpusData with no extra args) is byte-for-byte unchanged.
async function chiefOfStaffLiveData(pool, schema = PRIMARY_SCHEMA, tenantId = PRIMARY_TENANT) {
  assertSchema(schema);

  const coreResult = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE record_status = 'ACTIVE')::int AS total_classified,
      ROUND(AVG(eqs_composite) FILTER (WHERE record_status = 'ACTIVE' AND eqs_composite IS NOT NULL), 2) AS avg_eqs,
      MAX(classified_at) FILTER (WHERE record_status = 'ACTIVE') AS last_ingestion,
      COUNT(*) FILTER (WHERE record_status = 'PENDING_REVIEW')::int AS pending_review
    FROM ${schema}.intelligence_records
    WHERE tenant_id = $1
  `, [tenantId]);
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
  const fc = fcResult.rows[0] || {};
  const fcAuditedCount = Number(fc.audited_count || 0);
  const fcValue = fcAuditedCount > 0 ? Number(fc.total_rand || 0) : null;

  const completeness = await computeCompleteness(pool, schema, tenantId);
  const { eroi, decisionCapital } = await computeEvidenceCapitalAndEroi(pool, schema, tenantId);

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

async function evidenceAnalystLiveData(pool, schema = PRIMARY_SCHEMA, tenantId = PRIMARY_TENANT) {
  assertSchema(schema);

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
    FROM ${schema}.intelligence_records
    WHERE tenant_id = $1
  `, [tenantId]);
  const p = pathwayResult.rows[0] || {};

  // Programmes present in the corpus with no evaluation record on file, where
  // "evaluation" means a record on the IMPACT or PROCESS EQS pathway (RESEARCH
  // pathway records are studies, not evaluations).
  const noEvalResult = await pool.query(`
    SELECT COALESCE(canonical_programme_name, programme_name) AS programme
    FROM ${schema}.intelligence_records
    WHERE tenant_id = $1
      AND record_status = 'ACTIVE'
      AND programme_name IS NOT NULL
    GROUP BY COALESCE(canonical_programme_name, programme_name)
    HAVING NOT bool_or(eqs_scoring_pathway IN ('IMPACT', 'PROCESS'))
    ORDER BY programme
  `, [tenantId]);
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
// breakdown. Dates are explicit and never inferred downstream: the current
// date, the moment the snapshot was taken, and the last ingestion are three
// separate fields.
//
// Unchanged signature/behaviour: still single-tenant, still defaults to the
// Zenex operating corpus. Multi-tenant aggregation lives in
// getAllTenantsCorpusData, below, and is additive only.
async function getLiveCorpusData(pool) {
  const now = new Date();
  const [cos, ea] = await Promise.all([
    chiefOfStaffLiveData(pool),
    evidenceAnalystLiveData(pool),
  ]);

  return {
    current_date: now.toISOString().slice(0, 10),
    corpus_snapshot_at: now.toISOString(),
    last_ingestion_date: cos.last_ingestion ? cos.last_ingestion.slice(0, 10) : null,
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

// Labelled text block for agent prompts. Everything here is aggregate state,
// never document-level evidence: it is marked as such so an agent does not
// mistake a corpus count for a retrieved finding.
function formatLiveContext(d) {
  if (!d) return 'LIVE CORPUS CONTEXT\nUnavailable for this request.';
  const pc = d.pathway_counts || {};
  const noEval = (d.programmes_without_evaluation || []).slice(0, 20).join('; ') || 'none';
  return [
    'LIVE CORPUS CONTEXT (aggregate database state, not document-level evidence)',
    `Current date: ${d.current_date}`,
    `Corpus snapshot taken: ${d.corpus_snapshot_at}`,
    `Last ingestion: ${d.last_ingestion_date || 'no timestamp on record'}`,
    '',
    `Total classified records: ${d.records}`,
    `Average EQS: ${d.avg_eqs != null ? `${d.avg_eqs} / 5.0` : 'N/A'}`,
    `Data completeness: ${d.completeness}%`,
    `Records pending expert review: ${d.pending_review}`,
    `Records with critical missing fields: ${d.missing_fields}`,
    `Financial Capital: ${d.financial_capital != null ? `R${Number(d.financial_capital).toLocaleString('en-GB')}` : 'N/A'} from ${d.financial_source_count} audited source documents (incomplete, do not cite externally)`,
    `EROI index: ${d.eroi != null ? `${d.eroi} / 100` : 'N/A'} (Decision Capital ${d.decision_capital})`,
    `Records by EQS pathway: Impact ${pc.IMPACT ?? 'n/a'}, Process ${pc.PROCESS ?? 'n/a'}, Research ${pc.RESEARCH ?? 'n/a'}, Unassigned ${pc.UNASSIGNED ?? 'n/a'}`,
    `Average EQS by pathway: Impact ${d.eqs_impact ?? 'n/a'}, Process ${d.eqs_process ?? 'n/a'}, Research ${d.eqs_research ?? 'n/a'}`,
    `Records rated AGEING: ${d.ageing_count}`,
    `Programmes with no Impact or Process evaluation on file (${d.programmes_without_evaluation_count}): ${noEval}`,
    '',
    'AVAILABLE DOCUMENT EVIDENCE: retrieve specific records with your tools. The figures above are counts and averages, not findings.',
  ].join('\n');
}

// --- Multi-tenant aggregation (Chief of Staff cross-tenant mode) ----------
//
// Reuses chiefOfStaffLiveData/evidenceAnalystLiveData above (now parametrised
// by schema/tenantId) instead of duplicating any corpus query. Never queries
// a tenant that isn't in `authorisedTenants` — the caller (routes/
// intelligence.js) is responsible for deriving that list from the tenant
// registry for an authorised admin role; this function performs no
// authorisation of its own and trusts the array it is given verbatim, in
// both directions: it will not silently expand it, and it will not query
// anything beyond it.
//
// authorisedTenants: [{ slug, name }, ...] — slug doubles as schema name and
// tenant_id, matching the convention already used by PRIMARY_TENANT/
// PRIMARY_SCHEMA and by admin-ask.js's existing per-tenant loop.
//
// Each tenant entry is best-effort: a tenant whose schema doesn't exist yet
// (e.g. not yet provisioned) fails soft with an `error` field instead of
// aborting the whole aggregation, mirroring the established pattern in
// api/routes/admin-ask.js and the /admin/corpus-health route.
async function tenantAlertsSummary(pool, schema, tenantId) {
  const res = await pool.query(`
    SELECT id, alert_type, title, priority, created_at
    FROM ${schema}.alerts
    WHERE tenant_id = $1
      AND is_read = false
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY CASE priority WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, created_at DESC
    LIMIT 10
  `, [tenantId]);
  return {
    count: res.rowCount,
    items: res.rows.map(r => ({
      alert_type: r.alert_type,
      title: r.title,
      priority: r.priority,
    })),
  };
}

async function tenantPipelineStatus(pool, schema, tenantId) {
  const res = await pool.query(`
    SELECT COUNT(*)::int AS pending
    FROM ${schema}.queue_items
    WHERE tenant_id = $1
      AND resolved_at IS NULL
  `, [tenantId]);
  const pending = Number(res.rows[0]?.pending || 0);
  return pending > 0 ? `${pending} item${pending === 1 ? '' : 's'} pending review` : 'clear';
}

async function tenantDocumentAndProgrammeCounts(pool, schema, tenantId) {
  const res = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM ${schema}.documents WHERE tenant_id = $1) AS document_count,
      (SELECT COUNT(DISTINCT COALESCE(canonical_programme_name, programme_name))::int
         FROM ${schema}.intelligence_records
         WHERE tenant_id = $1 AND record_status = 'ACTIVE' AND programme_name IS NOT NULL) AS programme_count,
      (SELECT COUNT(*)::int
         FROM ${schema}.intelligence_records
         WHERE tenant_id = $1 AND record_status = 'ACTIVE'
           AND eqs_scoring_pathway IN ('IMPACT', 'PROCESS')) AS evaluation_count
  `, [tenantId]);
  const row = res.rows[0] || {};
  return {
    document_count: Number(row.document_count || 0),
    programme_count: Number(row.programme_count || 0),
    evaluation_count: Number(row.evaluation_count || 0),
  };
}

function corpusHealthLabel(avgEqs, completenessPct) {
  if (avgEqs == null) return 'no-data';
  if (avgEqs >= 3.5 && completenessPct >= 70) return 'healthy';
  if (avgEqs >= 2.5 && completenessPct >= 40) return 'attention';
  return 'critical';
}

async function tenantSignalCount(tenantSlug) {
  try {
    const { listTenantSignals } = require('../memory/watchtower');
    const signals = await listTenantSignals(tenantSlug, { limit: 25 });
    return Array.isArray(signals) ? signals.length : 0;
  } catch {
    return 0;
  }
}

async function getAllTenantsCorpusData(pool, authorisedTenants) {
  const list = Array.isArray(authorisedTenants) ? authorisedTenants : [];
  const entries = [];

  for (const t of list) {
    const slug = typeof t === 'string' ? t : t.slug;
    const name = typeof t === 'string' ? t : (t.name || t.slug);
    if (!slug) continue;

    try {
      assertSchema(slug);
      const schema = slug;
      const tenantId = slug;

      const [cos, ea, counts, pipelineStatus, alerts, signalCount] = await Promise.all([
        chiefOfStaffLiveData(pool, schema, tenantId),
        evidenceAnalystLiveData(pool, schema, tenantId),
        tenantDocumentAndProgrammeCounts(pool, schema, tenantId),
        tenantPipelineStatus(pool, schema, tenantId),
        tenantAlertsSummary(pool, schema, tenantId),
        tenantSignalCount(slug),
      ]);

      entries.push({
        tenant_id: slug,
        tenant_name: name,
        corpus_health: corpusHealthLabel(cos.average_eqs, cos.data_completeness_pct),
        document_count: counts.document_count,
        evaluation_count: counts.evaluation_count,
        programme_count: counts.programme_count,
        completeness: cos.data_completeness_pct,
        evidence_quality: cos.average_eqs,
        last_ingestion: cos.last_ingestion,
        pipeline_status: pipelineStatus,
        intelligence_signals: signalCount,
        relevant_alerts: alerts.count,
        _pathway_counts: ea.pathway_counts,
      });
    } catch (err) {
      entries.push({
        tenant_id: slug,
        tenant_name: name,
        error: err.message || 'Tenant corpus not accessible',
      });
    }
  }

  return entries;
}

// Structured text block for the Advisor prompt in cross-tenant ("all") mode.
// One line per authorised tenant; tenants that failed are called out
// explicitly rather than silently omitted, so the Advisor never assumes
// zero activity means healthy activity.
function formatAllTenantsContext(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return 'CROSS-TENANT INTELLIGENCE SUMMARY\nNo authorised tenants available for this request.';
  }
  const lines = [
    'CROSS-TENANT INTELLIGENCE SUMMARY (aggregate database state per authorised tenant, not document-level evidence)',
    `Tenants in scope: ${entries.length}`,
    '',
  ];
  for (const e of entries) {
    if (e.error) {
      lines.push(`- ${e.tenant_name} (${e.tenant_id}): UNAVAILABLE — ${e.error}`);
      continue;
    }
    lines.push(
      `- ${e.tenant_name} (${e.tenant_id}): health=${e.corpus_health}, documents=${e.document_count}, evaluations=${e.evaluation_count}, programmes=${e.programme_count}, ` +
      `completeness=${e.completeness}%, evidence_quality=${e.evidence_quality != null ? e.evidence_quality : 'N/A'}, ` +
      `last_ingestion=${e.last_ingestion || 'none on record'}, pipeline=${e.pipeline_status}, ` +
      `recent_signals=${e.intelligence_signals}, open_alerts=${e.relevant_alerts}`
    );
  }
  lines.push(
    '',
    'Each tenant\'s figures are isolated aggregates from that tenant\'s own corpus only. Do not blend counts, averages, or evidence across tenants. When reasoning about more than one tenant, name each tenant explicitly.'
  );
  return lines.join('\n');
}

module.exports = {
  getLiveCorpusData,
  formatLiveContext,
  chiefOfStaffLiveData,
  evidenceAnalystLiveData,
  getAllTenantsCorpusData,
  formatAllTenantsContext,
};
