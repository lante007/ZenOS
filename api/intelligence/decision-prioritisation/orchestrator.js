'use strict';

// api/intelligence/decision-prioritisation/orchestrator.js
//
// Phase 5: Decision Prioritisation -- persistence layer. Consumes one
// completed Decision Assessment (status = 'assessed') and produces a
// persisted Priority Record (public.priority_records, migration 029).
//
// This module owns exactly one responsibility: computeAndPersistPriority,
// called as an additive post-assessed step from
// api/intelligence/decision-assessment/orchestrator.js#runAssessmentPipeline,
// immediately after that module's own completeAssessment() has committed.
// It never runs inside the same transaction as completeAssessment(), and
// its failure can never roll back an assessment -- by construction, it is
// only ever invoked after that transaction has already committed (see the
// hook in decision-assessment/orchestrator.js). Any error thrown here is
// caught and logged by the caller, not by this module.
//
// Concurrency: mirrors Phase 4's exact pattern (claimAssessment) --
// SELECT ... FOR UPDATE on the parent decision_events row inside a single
// transaction that also inserts the new Priority Record and supersedes
// the prior active one, serialising every concurrent completion for the
// same decision_event_id through one row lock. Migration 029's partial
// unique index (decision_event_id WHERE superseded_at IS NULL) is a
// second, database-level backstop against two rows ever being
// simultaneously active for the same event, independent of the lock.
//
// Priority computation itself is fully deterministic (see ./rules.js) --
// this module's only job is field extraction from the assessment/event
// row shapes and persistence; it makes no LLM call and no judgement call
// of its own.

const { getPool } = require('../../services/db');
const { RULE_VERSION, computePriority } = require('./rules');

class PrioritisationError extends Error {
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

function extractDaysUntilReview(triggerData) {
  const v = triggerData && triggerData.days_until_review;
  return v === undefined ? null : v;
}

// tenantId, decisionEventId, assessmentId, assessmentVersion,
// strategicOutput (strategic_output.output), advisorOutput
// (advisor_output.output), partialContext (decision_assessments
// .partial_context), triggerPathway, triggerData (decision_events
// .trigger_data) are all supplied by the caller -- this module reads
// nothing from the database itself except the row lock; it trusts the
// already-persisted, already-validated values the Phase 4 pipeline just
// wrote/loaded, exactly like completeAssessment() does for its own write.
async function computeAndPersistPriority(poolOrClient, {
  tenantId,
  decisionEventId,
  assessmentId,
  assessmentVersion,
  strategicOutput,
  advisorOutput,
  partialContext,
  triggerPathway,
  triggerData,
} = {}) {
  const pool = poolOrClient || getPool();
  if (!pool) throw new PrioritisationError('Database is not configured', 'NO_DB');
  if (!tenantId) throw new PrioritisationError('tenantId is required', 'BAD_REQUEST');
  if (!decisionEventId) throw new PrioritisationError('decisionEventId is required', 'BAD_REQUEST');
  if (!assessmentId) throw new PrioritisationError('assessmentId is required', 'BAD_REQUEST');
  if (!assessmentVersion) throw new PrioritisationError('assessmentVersion is required', 'BAD_REQUEST');

  const startedAt = Date.now();

  const strategic = strategicOutput || {};
  const advisor = advisorOutput || {};

  const { priority, priorityReason, contributingFactors } = computePriority({
    overallConfidence: advisor.overall_confidence,
    exposure: strategic.exposure,
    costOfWaiting: strategic.cost_of_waiting,
    severity: strategic.severity,
    reversibility: strategic.reversibility,
    timingSensitivity: strategic.timing_sensitivity,
    partialContext: Boolean(partialContext),
    triggerPathway,
    daysUntilReview: extractDaysUntilReview(triggerData),
  });

  const result = await withTransaction(pool, async (client) => {
    const eventRes = await client.query(
      `SELECT id, tenant_id
         FROM public.decision_events
        WHERE id = $1 AND tenant_id = $2
        FOR UPDATE`,
      [decisionEventId, tenantId],
    );
    if (!eventRes.rows.length) {
      throw new PrioritisationError('Decision event not found', 'NOT_FOUND');
    }

    const insertRes = await client.query(
      `INSERT INTO public.priority_records
         (tenant_id, decision_event_id, assessment_id, assessment_version,
          priority, priority_score, priority_reason, contributing_factors, rule_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, priority, assigned_at`,
      [
        tenantId,
        decisionEventId,
        assessmentId,
        assessmentVersion,
        priority,
        null,
        priorityReason,
        JSON.stringify(contributingFactors),
        RULE_VERSION,
      ],
    );
    const record = insertRes.rows[0];

    const supersedeRes = await client.query(
      `UPDATE public.priority_records
          SET superseded_at = now(), superseded_by = $1
        WHERE decision_event_id = $2
          AND tenant_id = $3
          AND superseded_at IS NULL
          AND id <> $1
        RETURNING id`,
      [record.id, decisionEventId, tenantId],
    );

    return { record, supersededIds: supersedeRes.rows.map((r) => r.id) };
  });

  console.log('priority computed:', {
    tenant_id: tenantId,
    decision_event_id: decisionEventId,
    assessment_id: assessmentId,
    assessment_version: assessmentVersion,
    priority,
    rule_version: RULE_VERSION,
    superseded: result.supersededIds,
    elapsed_ms: Date.now() - startedAt,
  });

  return {
    priorityRecordId: result.record.id,
    priority: result.record.priority,
    assignedAt: result.record.assigned_at,
    supersededIds: result.supersededIds,
  };
}

async function getActivePriorityForEvent(pool, decisionEventId, tenantId) {
  const db = pool || getPool();
  const res = await db.query(
    `SELECT * FROM public.priority_records
      WHERE decision_event_id = $1 AND tenant_id = $2 AND superseded_at IS NULL`,
    [decisionEventId, tenantId],
  );
  return res.rows[0] || null;
}

async function listPrioritiesForEvent(pool, decisionEventId, tenantId) {
  const db = pool || getPool();
  const res = await db.query(
    `SELECT * FROM public.priority_records
      WHERE decision_event_id = $1 AND tenant_id = $2
      ORDER BY assigned_at DESC`,
    [decisionEventId, tenantId],
  );
  return res.rows;
}

module.exports = {
  PrioritisationError,
  computeAndPersistPriority,
  getActivePriorityForEvent,
  listPrioritiesForEvent,
  RULE_VERSION,
};
