'use strict';

// api/intelligence/decision-assessment/auto-assess.js
//
// Phase 4: approved automatic assessment trigger. Called from the
// existing decision-events-worker tick (see worker.js's additive
// runAutoAssessTick() call) -- this file adds no new pm2 process and no
// polling loop of its own; it rides the existing decision-events-worker
// cadence, in its own separately try/caught call.
//
// Per-tenant feature-gated (AUTO_ASSESS_ENABLED, default false, fails
// closed via getFeatureFlag -- same convention already established by
// MEMORY_CONTEXT_ENABLED / EXTERNAL_INTELLIGENCE_ENABLED /
// INNOVATION_SCOUT_ENABLED). A tenant with the flag off is never
// auto-assessed, full stop.
//
// Eligibility (Phase 4 design addendum, hard invariant #6): strictly
// status='new' AND assessment_id IS NULL. No join against
// decision_assessments is needed or performed -- assessment_id is never
// nulled on failure (hard invariant #4), so IS NULL alone reliably means
// "never attempted", and a failed latest attempt (assessment_id set,
// status reverted to 'new' by orchestrator.js#failAssessment) is
// correctly excluded from this query without inspecting
// decision_assessments at all.
//
// claimAssessment (orchestrator.js) re-checks this same eligibility
// inside its own row-locked transaction before inserting -- this
// module's candidate query is a cheap first pass, not the authority; a
// race lost between this SELECT and the claim (e.g. a manual trigger or
// a concurrent auto tick won first) surfaces as a CONFLICT/NOT_ELIGIBLE
// error here, which is expected and swallowed as a skip, never retried
// (hard invariant #5).

const { listTenants, getFeatureFlag } = require('../../services/tenants');
const { getPool } = require('../../services/db');
const { claimAssessment, runAssessmentPipeline } = require('./orchestrator');

const DEFAULT_LIMIT = Number(process.env.AUTO_ASSESS_BATCH_LIMIT || 20);

async function runAutoAssessTick(options = {}) {
  const pool = options.pool || getPool();
  const limit = options.limit || DEFAULT_LIMIT;
  const stats = {
    tenants_checked: 0,
    tenants_enabled: 0,
    candidates_found: 0,
    claimed: 0,
    skipped_conflict: 0,
    errors: [],
  };

  if (!pool) return stats;

  const tenants = options.tenants || await listTenants();
  for (const tenant of tenants) {
    if (tenant.is_active === false) continue;
    stats.tenants_checked += 1;

    let enabled = false;
    try {
      enabled = await getFeatureFlag(tenant.slug, 'AUTO_ASSESS_ENABLED');
    } catch (err) {
      stats.errors.push({ tenant: tenant.slug, scope: 'feature_flag', message: err.message });
      continue;
    }
    if (!enabled) continue;
    stats.tenants_enabled += 1;

    let candidates;
    try {
      const res = await pool.query(
        `SELECT id FROM public.decision_events
          WHERE tenant_id = $1 AND status = 'new' AND assessment_id IS NULL
          ORDER BY created_at ASC
          LIMIT $2`,
        [tenant.slug, limit],
      );
      candidates = res.rows;
    } catch (err) {
      stats.errors.push({ tenant: tenant.slug, scope: 'candidate_query', message: err.message });
      continue;
    }
    stats.candidates_found += candidates.length;

    for (const candidate of candidates) {
      try {
        const { assessmentId } = await claimAssessment(pool, {
          tenantId: tenant.slug,
          decisionEventId: candidate.id,
          mode: 'auto',
        });
        stats.claimed += 1;
        await runAssessmentPipeline(assessmentId, { pool, deps: options.deps });
      } catch (err) {
        if (err.code === 'CONFLICT' || err.code === 'NOT_ELIGIBLE' || err.code === 'NOT_FOUND') {
          stats.skipped_conflict += 1;
        } else {
          stats.errors.push({ tenant: tenant.slug, decision_event_id: candidate.id, message: err.message });
        }
      }
    }
  }

  return stats;
}

module.exports = { runAutoAssessTick };
