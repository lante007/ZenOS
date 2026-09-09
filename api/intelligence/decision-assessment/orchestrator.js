'use strict';

// api/intelligence/decision-assessment/orchestrator.js
//
// Phase 4: Persistence + Controlled Orchestration for Decision
// Assessment. This module owns exactly three responsibilities:
//   1. claimAssessment -- allocate a new decision_assessments row for one
//      decision_event, enforcing the approved eligibility matrix and
//      concurrency guarantee (see below).
//   2. runAssessmentPipeline -- execute the frozen specialist/Advisor
//      pipeline for one already-claimed assessment id and persist the
//      outcome atomically.
//   3. stale recovery -- on read, flip a pending/assessing row that has
//      exceeded STALE_MS back to failed, mirroring
//      api/intelligence/jobs.js's own stale-running recovery idiom
//      exactly (same started_at-anchored approach, same "stalled" wording
//      style).
//
// This module NEVER alters decision_events.status vocabulary (Phase 4
// hard invariant #12 -- migration 027 is untouched) and never writes
// decision_events.priority or decision_assessments.priority (Phase 4
// design, "no priority" -- reserved for a future Phase 5 layer).
//
// ELIGIBILITY MATRIX (Phase 4 design addendum, verbatim):
//   decision_events.status | assessment_id       | auto-eligible | manual-eligible
//   -------------------------------------------------------------------------------
//   new                    | NULL (never tried)  | YES           | YES
//   new                    | set (failed latest) | NO            | YES (new version)
//   assessed               | set                 | NO            | YES (new version, reassessment)
//   under_assessment       | set (in flight)      | NO            | NO -> 409 CONFLICT
//   dismissed / acted_on   | (any)                | NO            | NO -> 409 CONFLICT (out of scope)
//
// assessment_id semantics (hard invariants #1-4): NULL means never
// attempted; non-NULL means an attempt exists regardless of its outcome;
// it always points at the LATEST attempt; it is never nulled or reverted
// on failure. This is exactly what makes `assessment_id IS NULL` alone a
// sufficient, join-free "never attempted" signal for strict automatic
// eligibility (hard invariant #6) -- see claimAssessment's auto branch
// and auto-assess.js's candidate query.
//
// Concurrency (hard invariants #8, #10): claimAssessment locks the
// parent decision_events row with SELECT ... FOR UPDATE inside a single
// transaction that also computes the next assessment_version, inserts
// the new row, and updates the decision_events pointer -- this
// serialises every concurrent claim attempt (manual-vs-manual,
// manual-vs-auto, auto-vs-auto) for the same decision_event through one
// row lock. A manual claim against an in-flight (under_assessment) event,
// or against dismissed/acted_on, throws a CONFLICT error (mapped to HTTP
// 409 by the route) -- never queued, retried, or silently no-op'd.

const { getPool } = require('../../services/db');
const { buildDecisionAssessmentContext } = require('./context');
const { runEvidenceAnalystDecisionAgent } = require('./evidence-analyst');
const { runStrategicAnalystDecisionAgent } = require('./strategic-analyst');
const { runAdvisorDecisionAgent } = require('./advisor');

const STALE_MS = Number(process.env.DECISION_ASSESSMENT_STALE_MS || 10 * 60 * 1000);

class AssessmentError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Hard invariants #7/#9: manual eligibility is exactly `new` (including a
// failed latest attempt) or `assessed` -- never under_assessment,
// dismissed, or acted_on. Listed explicitly (not "anything except
// under_assessment") so a future decision_events status value never
// becomes silently eligible by omission.
const MANUAL_ELIGIBLE_STATUSES = ['new', 'assessed'];

async function claimAssessment(poolOrClient, { tenantId, decisionEventId, mode, requestedBy } = {}) {
  const pool = poolOrClient || getPool();
  if (!pool) throw new AssessmentError('Database is not configured', 'NO_DB');
  if (!tenantId) throw new AssessmentError('tenantId is required', 'BAD_REQUEST');
  if (!decisionEventId) throw new AssessmentError('decisionEventId is required', 'BAD_REQUEST');
  if (mode !== 'manual' && mode !== 'auto') throw new AssessmentError('mode must be "manual" or "auto"', 'BAD_REQUEST');

  return withTransaction(pool, async (client) => {
    const eventRes = await client.query(
      `SELECT id, tenant_id, status, assessment_id
         FROM public.decision_events
        WHERE id = $1 AND tenant_id = $2
        FOR UPDATE`,
      [decisionEventId, tenantId],
    );
    const event = eventRes.rows[0];
    if (!event) throw new AssessmentError('Decision event not found', 'NOT_FOUND');

    if (mode === 'auto') {
      // Hard invariant #6: strict auto-eligibility, status='new' AND
      // assessment_id IS NULL -- nothing else. A failed latest attempt
      // (assessment_id set, status reverted to 'new' by failAssessment
      // below) is explicitly NOT eligible (hard invariant #5: never
      // auto-retried).
      if (event.status !== 'new' || event.assessment_id !== null) {
        throw new AssessmentError('Event is not automatically eligible', 'NOT_ELIGIBLE');
      }
    } else if (!MANUAL_ELIGIBLE_STATUSES.includes(event.status)) {
      throw new AssessmentError(`Event status "${event.status}" cannot be manually (re)assessed`, 'CONFLICT');
    }

    const versionRes = await client.query(
      `SELECT COALESCE(MAX(assessment_version), 0) AS max_version
         FROM public.decision_assessments
        WHERE decision_event_id = $1`,
      [decisionEventId],
    );
    const nextVersion = Number(versionRes.rows[0].max_version) + 1;

    const insertRes = await client.query(
      `INSERT INTO public.decision_assessments
         (decision_event_id, tenant_id, assessment_version, status, trigger_mode, requested_by)
       VALUES ($1, $2, $3, 'pending', $4, $5)
       RETURNING id, assessment_version`,
      [decisionEventId, tenantId, nextVersion, mode, requestedBy || null],
    );
    const assessment = insertRes.rows[0];

    // assessment_id is set here, once, at creation of this attempt -- the
    // ONLY place any Phase 4 code writes it. It is never nulled or
    // reverted afterwards, including on failure (hard invariant #4):
    // failAssessment()/completeAssessment() below only ever advance
    // decision_events.status, never assessment_id.
    await client.query(
      `UPDATE public.decision_events
          SET status = 'under_assessment', assessment_id = $1, updated_at = now()
        WHERE id = $2`,
      [assessment.id, decisionEventId],
    );

    return { assessmentId: assessment.id, assessmentVersion: assessment.assessment_version };
  });
}

async function markAssessing(pool, assessmentId) {
  await pool.query(
    `UPDATE public.decision_assessments
        SET status = 'assessing', started_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'pending'`,
    [assessmentId],
  );
}

// Hard invariant #11: this UPDATE is the only write a failed row ever
// receives; historical rows are never subsequently modified again. The
// defensive `AND status = 'assessing'` guard means a row that has already
// terminated (e.g. via a prior stale-recovery race) is never overwritten
// a second time.
async function failAssessment(pool, assessmentId, decisionEventId, reason) {
  await withTransaction(pool, async (client) => {
    const res = await client.query(
      `UPDATE public.decision_assessments
          SET status = 'failed', failure_reason = $2, completed_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'assessing'
        RETURNING id`,
      [assessmentId, reason],
    );
    if (!res.rows.length) return;
    // Revert the event back to 'new' -- migration 027's status vocabulary
    // has no dedicated failed value, and Phase 4 must not add one (hard
    // invariant #12). assessment_id is left exactly as-is (hard
    // invariant #4): it already points at this failed attempt, and that
    // is precisely what excludes it from auto-eligibility
    // (assessment_id IS NULL is now false) while leaving it manually
    // reassessable (MANUAL_ELIGIBLE_STATUSES includes 'new').
    await client.query(
      `UPDATE public.decision_events
          SET status = 'new', updated_at = now()
        WHERE id = $1 AND assessment_id = $2 AND status = 'under_assessment'`,
      [decisionEventId, assessmentId],
    );
  });
}

async function completeAssessment(pool, assessmentId, decisionEventId, fields) {
  await withTransaction(pool, async (client) => {
    const res = await client.query(
      `UPDATE public.decision_assessments
          SET status = 'assessed',
              evidence_output = $2, strategic_output = $3, advisor_output = $4,
              evidence_confidence = $5, strategic_confidence = $6, overall_confidence = $7,
              partial_context = $8, partial_context_reasons = $9,
              completed_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'assessing'
        RETURNING id`,
      [
        assessmentId,
        JSON.stringify(fields.evidenceOutput),
        JSON.stringify(fields.strategicOutput),
        JSON.stringify(fields.advisorOutput),
        fields.evidenceConfidence || null,
        fields.strategicConfidence || null,
        fields.overallConfidence || null,
        Boolean(fields.partialContext),
        JSON.stringify(fields.partialContextReasons || []),
      ],
    );
    if (!res.rows.length) return;
    await client.query(
      `UPDATE public.decision_events
          SET status = 'assessed', updated_at = now()
        WHERE id = $1 AND assessment_id = $2 AND status = 'under_assessment'`,
      [decisionEventId, assessmentId],
    );
  });
}

// Executes the frozen specialist/Advisor pipeline for one already-claimed
// assessment and persists the outcome. `options.deps` is injectable
// purely for tests (see
// tests/decision-assessment-orchestrator.test.js) -- it defaults to the
// real, unmodified agent-runner functions in production, exactly
// mirroring the existing `pool` injection convention already established
// by decision-events/orchestrator.js#runOnce({ pool }).
async function runAssessmentPipeline(assessmentId, options = {}) {
  const pool = options.pool || getPool();
  if (!pool) throw new AssessmentError('Database is not configured', 'NO_DB');
  const deps = Object.assign({
    buildDecisionAssessmentContext,
    runEvidenceAnalystDecisionAgent,
    runStrategicAnalystDecisionAgent,
    runAdvisorDecisionAgent,
  }, options.deps || {});

  const rows = (await pool.query(
    `SELECT da.id, da.decision_event_id, da.tenant_id, da.status,
            de.id AS event_id, de.tenant_id AS event_tenant_id, de.trigger_pathway,
            de.trigger_explanation, de.trigger_data, de.inputs, de.status AS event_status
       FROM public.decision_assessments da
       JOIN public.decision_events de ON de.id = da.decision_event_id
      WHERE da.id = $1`,
    [assessmentId],
  )).rows;
  const row = rows[0];
  if (!row) throw new AssessmentError('Assessment not found', 'NOT_FOUND');
  if (row.status !== 'pending') return; // already progressed (race) -- nothing to do

  await markAssessing(pool, assessmentId);

  const decisionEventId = row.decision_event_id;

  try {
    const context = await deps.buildDecisionAssessmentContext({
      id: row.event_id,
      tenant_id: row.event_tenant_id,
      trigger_pathway: row.trigger_pathway,
      trigger_explanation: row.trigger_explanation,
      trigger_data: row.trigger_data,
      inputs: row.inputs,
      status: row.event_status,
    });

    const evidenceResult = await deps.runEvidenceAnalystDecisionAgent(context);
    if (evidenceResult.status !== 'ok') {
      await failAssessment(pool, assessmentId, decisionEventId, `Evidence Analyst (Decision) failed: ${evidenceResult.error}`);
      return;
    }

    const strategicResult = await deps.runStrategicAnalystDecisionAgent(context, evidenceResult.output);
    if (strategicResult.status !== 'ok') {
      await failAssessment(pool, assessmentId, decisionEventId, `Strategic Analyst (Decision) failed: ${strategicResult.error}`);
      return;
    }

    // Fail-closed (Q1): the Advisor is never called unless both
    // specialists returned status 'ok' above -- enforced here by
    // sequencing/early-return (belt and braces alongside advisor.js's own
    // internal fail-closed check): the pipeline never even makes the
    // call if either specialist failed.
    const advisorResult = await deps.runAdvisorDecisionAgent(context, evidenceResult, strategicResult);
    if (advisorResult.status !== 'ok') {
      await failAssessment(pool, assessmentId, decisionEventId, `Advisor (Decision) failed: ${advisorResult.error}`);
      return;
    }

    await completeAssessment(pool, assessmentId, decisionEventId, {
      evidenceOutput: evidenceResult.output,
      strategicOutput: strategicResult.output,
      advisorOutput: advisorResult.output,
      evidenceConfidence: evidenceResult.output.evidence_confidence,
      strategicConfidence: strategicResult.output.strategic_confidence,
      overallConfidence: advisorResult.output.overall_confidence,
      partialContext: context.partialContext,
      partialContextReasons: context.partialContextReasons,
    });
  } catch (err) {
    await failAssessment(pool, assessmentId, decisionEventId, `Unhandled error: ${err.message}`).catch(() => {});
  }
}

// Stale recovery, applied on read -- exact idiom mirrored from
// api/intelligence/jobs.js#getIntelligenceJob. Anchors on
// started_at || created_at because a 'pending' row (claimed but whose
// background pipeline never started -- e.g. a process crash between
// claim and runAssessmentPipeline) has no started_at yet.
function isStale(row) {
  if (!row || (row.status !== 'pending' && row.status !== 'assessing')) return false;
  const anchor = row.started_at || row.created_at;
  if (!anchor) return false;
  return Date.now() - new Date(anchor).getTime() > STALE_MS;
}

async function recoverIfStale(pool, row) {
  if (!isStale(row)) return row;
  const reason = 'stalled: process did not finish it';
  await failAssessment(pool, row.id, row.decision_event_id, reason).catch(() => {});
  return { ...row, status: 'failed', failure_reason: reason };
}

async function getAssessmentById(pool, assessmentId, tenantId) {
  const db = pool || getPool();
  const res = await db.query(
    `SELECT * FROM public.decision_assessments WHERE id = $1 AND tenant_id = $2`,
    [assessmentId, tenantId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return recoverIfStale(db, row);
}

async function listAssessmentsForEvent(pool, decisionEventId, tenantId) {
  const db = pool || getPool();
  const res = await db.query(
    `SELECT * FROM public.decision_assessments
      WHERE decision_event_id = $1 AND tenant_id = $2
      ORDER BY assessment_version DESC`,
    [decisionEventId, tenantId],
  );
  const out = [];
  for (const row of res.rows) {
    out.push(await recoverIfStale(db, row));
  }
  return out;
}

module.exports = {
  AssessmentError,
  withTransaction,
  claimAssessment,
  runAssessmentPipeline,
  failAssessment,
  completeAssessment,
  markAssessing,
  isStale,
  recoverIfStale,
  getAssessmentById,
  listAssessmentsForEvent,
  MANUAL_ELIGIBLE_STATUSES,
  STALE_MS,
};
