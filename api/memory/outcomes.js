'use strict';

// api/memory/outcomes.js
// Feedback and outcome memory: the loop
//   Signal -> Interpretation -> Recommendation -> Decision -> Outcome
// Recording is never mandatory and never blocks anything. Over time the
// accumulated outcomes let Auxeira learn which signals and sources proved
// reliable and where its confidence tends to be wrong. This is institutional
// learning through structured history, not model retraining.

const { q, resolveTenant, clampLimit } = require('./util');

const OUTCOME_STATUS = ['acted_on', 'dismissed', 'pending', 'succeeded', 'failed', 'partial'];

function rowToOutcome(r) {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    job_id: r.job_id,
    decision_id: r.decision_id,
    recommendation_summary: r.recommendation_summary,
    decision_taken: r.decision_taken,
    outcome_status: r.outcome_status,
    outcome_description: r.outcome_description,
    signal_proved_reliable: r.signal_proved_reliable,
    recorded_by: r.recorded_by,
    recorded_at: r.recorded_at,
    notes: r.notes,
    // Increment 3, C5: NULL on an original record; set on a revision, and
    // points back to the outcome it revises. Outcomes are append-only, so a
    // revision is always a new row, never an edit -- see schema.js for the
    // database-level trigger that enforces this.
    original_outcome_id: r.original_outcome_id,
  };
}

async function recordOutcome(tenantSlug, o) {
  const tenant = await resolveTenant(tenantSlug);
  if (!o || !OUTCOME_STATUS.includes(o.outcome_status)) {
    throw Object.assign(new Error(`outcome_status must be one of: ${OUTCOME_STATUS.join(', ')}`), { status: 400 });
  }
  if (o.original_outcome_id) {
    const original = await getOutcomeById(tenant, o.original_outcome_id);
    if (!original) throw Object.assign(new Error('original_outcome_id does not refer to an existing outcome for this tenant'), { status: 400 });
  }
  const res = await q(`
    INSERT INTO public.intelligence_outcomes
      (tenant_id, job_id, decision_id, recommendation_summary, decision_taken,
       outcome_status, outcome_description, signal_proved_reliable, recorded_by, notes, original_outcome_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    RETURNING *
  `, [
    tenant, o.job_id || null, o.decision_id || null,
    o.recommendation_summary || null, o.decision_taken || null,
    o.outcome_status, o.outcome_description || null,
    typeof o.signal_proved_reliable === 'boolean' ? o.signal_proved_reliable : null,
    o.recorded_by || null, o.notes || null, o.original_outcome_id || null,
  ]);
  if (res.rows[0].job_id) {
    await q(`
      INSERT INTO public.memory_links (tenant_id, from_type, from_id, to_type, to_id, relation)
      VALUES ($1,'job',$2,'outcome',$3,'OUTCOME_OF_JOB')
      ON CONFLICT DO NOTHING
    `, [tenant, res.rows[0].job_id, res.rows[0].id]).catch(() => {});
  }
  return rowToOutcome(res.rows[0]);
}

async function getOutcomeById(tenantSlug, id) {
  const tenant = await resolveTenant(tenantSlug);
  const res = await q('SELECT * FROM public.intelligence_outcomes WHERE id = $1 AND tenant_id = $2', [id, tenant]);
  return res.rows[0] ? rowToOutcome(res.rows[0]) : null;
}

async function listOutcomes(tenantSlug, { limit, jobId } = {}) {
  const tenant = await resolveTenant(tenantSlug);
  const where = ['tenant_id = $1'];
  const params = [tenant];
  if (jobId) {
    params.push(jobId);
    where.push(`job_id = $${params.length}`);
  }
  params.push(clampLimit(limit));
  const res = await q(
    `SELECT * FROM public.intelligence_outcomes WHERE ${where.join(' AND ')} ORDER BY recorded_at DESC LIMIT $${params.length}`,
    params,
  );
  return res.rows.map(rowToOutcome);
}

// Aggregate learning view: how often signals from each source proved
// reliable, and the acted-on vs dismissed split. Read-only.
async function sourceReliabilityStats(tenantSlug) {
  const tenant = await resolveTenant(tenantSlug);
  const res = await q(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE outcome_status IN ('acted_on','succeeded','partial'))::int AS acted_on,
      COUNT(*) FILTER (WHERE outcome_status = 'dismissed')::int AS dismissed,
      COUNT(*) FILTER (WHERE outcome_status = 'succeeded')::int AS succeeded,
      COUNT(*) FILTER (WHERE outcome_status = 'failed')::int AS failed,
      COUNT(*) FILTER (WHERE signal_proved_reliable IS TRUE)::int AS signal_reliable_true,
      COUNT(*) FILTER (WHERE signal_proved_reliable IS FALSE)::int AS signal_reliable_false
    FROM public.intelligence_outcomes
    WHERE tenant_id = $1
  `, [tenant]);
  return res.rows[0];
}

module.exports = { recordOutcome, listOutcomes, getOutcomeById, sourceReliabilityStats, OUTCOME_STATUS };
