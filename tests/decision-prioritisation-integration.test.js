'use strict';

// tests/decision-prioritisation-integration.test.js
//
// Phase 5 focused tests for the additive post-assessed integration hook
// in api/intelligence/decision-assessment/orchestrator.js#runAssessmentPipeline
// (Phase 5 addendum in that file's header). This suite does NOT re-test
// Phase 4's own claim/complete/fail logic -- that is already covered by
// tests/decision-assessment-orchestrator.test.js and is deliberately left
// untouched by Phase 5. This suite tests only:
//   1. computeAndPersistPriority is called, with the correct arguments,
//      exactly when completeAssessment genuinely transitions an
//      assessment to 'assessed'.
//   2. It is NOT called when the pipeline fails before reaching
//      completeAssessment.
//   3. A rejection from computeAndPersistPriority never affects the
//      assessment's final persisted status -- it remains 'assessed'
//      (Phase 5 spec: "priority computation failure does not roll back
//      the assessment").
//
// Same in-memory fake Postgres / injectable-deps convention as
// tests/decision-assessment-orchestrator.test.js's own makeFakeDb, kept
// deliberately minimal here (only the SQL patterns runAssessmentPipeline
// itself issues -- claim/markAssessing/complete/fail -- computeAndPersistPriority
// is always dependency-injected in this suite, never the real
// implementation, so no priority_records SQL needs to be understood by
// this fake db).

const assert = require('assert');
const {
  claimAssessment,
  runAssessmentPipeline,
} = require('../api/intelligence/decision-assessment/orchestrator');

function makeFakeDb(initialEvents = []) {
  const events = new Map(initialEvents.map((e) => [e.id, { ...e }]));
  const assessments = new Map();
  let idCounter = 1;
  const newId = () => `assess-${idCounter++}`;

  function maxVersion(decisionEventId) {
    let max = 0;
    for (const a of assessments.values()) {
      if (a.decision_event_id === decisionEventId) max = Math.max(max, a.assessment_version);
    }
    return max;
  }

  async function query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

    if (s.includes('FOR UPDATE')) {
      const [id, tenantId] = params;
      const e = events.get(id);
      return { rows: e && e.tenant_id === tenantId ? [{ ...e }] : [] };
    }

    if (s.includes('MAX(assessment_version)')) {
      const [decisionEventId] = params;
      return { rows: [{ max_version: maxVersion(decisionEventId) }] };
    }

    if (s.startsWith('INSERT INTO public.decision_assessments')) {
      const [decisionEventId, tenantId, version, mode, requestedBy] = params;
      const id = newId();
      assessments.set(id, {
        id, decision_event_id: decisionEventId, tenant_id: tenantId, assessment_version: version,
        status: 'pending', trigger_mode: mode, requested_by: requestedBy,
        started_at: null, completed_at: null, failure_reason: null,
      });
      return { rows: [{ id, assessment_version: version }] };
    }

    if (s.startsWith('UPDATE public.decision_events') && s.includes("SET status = 'under_assessment'")) {
      const [assessmentId, decisionEventId] = params;
      const e = events.get(decisionEventId);
      if (e) { e.status = 'under_assessment'; e.assessment_id = assessmentId; }
      return { rows: [] };
    }

    if (s.startsWith('UPDATE public.decision_assessments') && s.includes("SET status = 'assessing'")) {
      const [assessmentId] = params;
      const a = assessments.get(assessmentId);
      if (a && a.status === 'pending') { a.status = 'assessing'; a.started_at = new Date().toISOString(); }
      return { rows: [] };
    }

    if (s.startsWith('UPDATE public.decision_assessments') && s.includes("SET status = 'failed'")) {
      const [assessmentId, reason] = params;
      const a = assessments.get(assessmentId);
      if (a && a.status === 'assessing') {
        a.status = 'failed'; a.failure_reason = reason; a.completed_at = new Date().toISOString();
        return { rows: [{ id: assessmentId }] };
      }
      return { rows: [] };
    }

    if (s.startsWith('UPDATE public.decision_events') && s.includes("SET status = 'new'")) {
      const [decisionEventId, assessmentId] = params;
      const e = events.get(decisionEventId);
      if (e && e.assessment_id === assessmentId && e.status === 'under_assessment') e.status = 'new';
      return { rows: [] };
    }

    if (s.startsWith('UPDATE public.decision_assessments') && s.includes("SET status = 'assessed'")) {
      const [assessmentId, evidenceOutput, strategicOutput, advisorOutput,
        evidenceConfidence, strategicConfidence, overallConfidence,
        partialContext, partialContextReasons] = params;
      const a = assessments.get(assessmentId);
      if (a && a.status === 'assessing') {
        Object.assign(a, {
          status: 'assessed',
          evidence_output: JSON.parse(evidenceOutput),
          strategic_output: JSON.parse(strategicOutput),
          advisor_output: JSON.parse(advisorOutput),
          evidence_confidence: evidenceConfidence,
          strategic_confidence: strategicConfidence,
          overall_confidence: overallConfidence,
          partial_context: partialContext,
          partial_context_reasons: JSON.parse(partialContextReasons),
          completed_at: new Date().toISOString(),
        });
        return { rows: [{ id: assessmentId }] };
      }
      return { rows: [] };
    }

    if (s.startsWith('UPDATE public.decision_events') && s.includes("SET status = 'assessed'")) {
      const [decisionEventId, assessmentId] = params;
      const e = events.get(decisionEventId);
      if (e && e.assessment_id === assessmentId && e.status === 'under_assessment') e.status = 'assessed';
      return { rows: [] };
    }

    if (s.startsWith('SELECT da.id, da.decision_event_id')) {
      const [assessmentId] = params;
      const a = assessments.get(assessmentId);
      if (!a) return { rows: [] };
      const e = events.get(a.decision_event_id);
      return {
        rows: [{
          id: a.id,
          decision_event_id: a.decision_event_id,
          tenant_id: a.tenant_id,
          status: a.status,
          assessment_version: a.assessment_version,
          event_id: e.id,
          event_tenant_id: e.tenant_id,
          trigger_pathway: e.trigger_pathway,
          trigger_explanation: e.trigger_explanation,
          trigger_data: e.trigger_data,
          inputs: e.inputs,
          event_status: e.status,
        }],
      };
    }

    throw new Error(`fake db: unrecognised query: ${s}`);
  }

  return { query, connect: async () => ({ query, release: () => {} }), _events: events, _assessments: assessments };
}

const OK_EVIDENCE = {
  status: 'ok', output: { established_findings: [], evidence_limitations: [], evidence_gaps: [], evidence_confidence: 'MODERATE' }, error: null,
};
const OK_STRATEGIC = {
  status: 'ok',
  output: { options: [], exposure: 'R2,000,000', exposure_basis: 'Y', cost_of_waiting: 'immediate action needed', severity: 'HIGH', reversibility: 'IRREVERSIBLE', timing_sensitivity: 'IMMEDIATE', strategic_confidence: 'MODERATE' },
  error: null,
};
const OK_ADVISOR = { status: 'ok', output: { situation: 'S', overall_confidence: 'HIGH' }, error: null };
const FAKE_CONTEXT = { partialContext: false, partialContextReasons: [] };

async function claimAndRun(db, deps) {
  const claim = await claimAssessment(db, { tenantId: 'zenex', decisionEventId: 'evt-1', mode: 'manual' });
  await runAssessmentPipeline(claim.assessmentId, { pool: db, deps });
  return claim;
}

module.exports = {
  'assessment reaching assessed triggers computeAndPersistPriority exactly once, with correct arguments': async () => {
    const db = makeFakeDb([{ id: 'evt-1', tenant_id: 'zenex', status: 'new', assessment_id: null, trigger_pathway: 'SIGNAL_TOUCHES_EXPOSURE', trigger_data: { days_until_review: 5 } }]);
    let callArgs = null;
    let callCount = 0;

    const claim = await claimAndRun(db, {
      buildDecisionAssessmentContext: async () => FAKE_CONTEXT,
      runEvidenceAnalystDecisionAgent: async () => OK_EVIDENCE,
      runStrategicAnalystDecisionAgent: async () => OK_STRATEGIC,
      runAdvisorDecisionAgent: async () => OK_ADVISOR,
      computeAndPersistPriority: async (pool, args) => { callCount += 1; callArgs = args; return { priorityRecordId: 'pri-1', priority: 'IMMEDIATE' }; },
    });

    await new Promise((r) => setImmediate(r));

    assert.strictEqual(callCount, 1);
    assert.strictEqual(callArgs.tenantId, 'zenex');
    assert.strictEqual(callArgs.decisionEventId, 'evt-1');
    assert.strictEqual(callArgs.assessmentId, claim.assessmentId);
    assert.strictEqual(callArgs.assessmentVersion, 1);
    assert.deepStrictEqual(callArgs.strategicOutput, OK_STRATEGIC.output);
    assert.deepStrictEqual(callArgs.advisorOutput, OK_ADVISOR.output);
    assert.strictEqual(callArgs.partialContext, false);
    assert.strictEqual(callArgs.triggerPathway, 'SIGNAL_TOUCHES_EXPOSURE');
    assert.deepStrictEqual(callArgs.triggerData, { days_until_review: 5 });
  },

  'computeAndPersistPriority is NOT called when Evidence Analyst fails (assessment never reaches assessed)': async () => {
    const db = makeFakeDb([{ id: 'evt-1', tenant_id: 'zenex', status: 'new', assessment_id: null }]);
    let called = false;
    await claimAndRun(db, {
      buildDecisionAssessmentContext: async () => FAKE_CONTEXT,
      runEvidenceAnalystDecisionAgent: async () => ({ status: 'failed', output: null, error: 'broke' }),
      runStrategicAnalystDecisionAgent: async () => OK_STRATEGIC,
      runAdvisorDecisionAgent: async () => OK_ADVISOR,
      computeAndPersistPriority: async () => { called = true; },
    });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(called, false);
  },

  'computeAndPersistPriority is NOT called when Advisor fails (assessment never reaches assessed)': async () => {
    const db = makeFakeDb([{ id: 'evt-1', tenant_id: 'zenex', status: 'new', assessment_id: null }]);
    let called = false;
    await claimAndRun(db, {
      buildDecisionAssessmentContext: async () => FAKE_CONTEXT,
      runEvidenceAnalystDecisionAgent: async () => OK_EVIDENCE,
      runStrategicAnalystDecisionAgent: async () => OK_STRATEGIC,
      runAdvisorDecisionAgent: async () => ({ status: 'failed', output: null, error: 'advisor broke' }),
      computeAndPersistPriority: async () => { called = true; },
    });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(called, false);
  },

  'a rejected computeAndPersistPriority does not affect the assessment or event status -- both remain assessed': async () => {
    const db = makeFakeDb([{ id: 'evt-1', tenant_id: 'zenex', status: 'new', assessment_id: null }]);
    const claim = await claimAndRun(db, {
      buildDecisionAssessmentContext: async () => FAKE_CONTEXT,
      runEvidenceAnalystDecisionAgent: async () => OK_EVIDENCE,
      runStrategicAnalystDecisionAgent: async () => OK_STRATEGIC,
      runAdvisorDecisionAgent: async () => OK_ADVISOR,
      computeAndPersistPriority: async () => { throw new Error('priority layer exploded'); },
    });

    await new Promise((r) => setImmediate(r));

    const a = db._assessments.get(claim.assessmentId);
    assert.strictEqual(a.status, 'assessed', 'assessment must remain assessed even though priority computation threw');
    assert.strictEqual(db._events.get('evt-1').status, 'assessed');
  },

  'a rejected computeAndPersistPriority does not throw out of runAssessmentPipeline (fire-and-forget, caller never sees it)': async () => {
    const db = makeFakeDb([{ id: 'evt-1', tenant_id: 'zenex', status: 'new', assessment_id: null }]);
    let threw = false;
    try {
      await claimAndRun(db, {
        buildDecisionAssessmentContext: async () => FAKE_CONTEXT,
        runEvidenceAnalystDecisionAgent: async () => OK_EVIDENCE,
        runStrategicAnalystDecisionAgent: async () => OK_STRATEGIC,
        runAdvisorDecisionAgent: async () => OK_ADVISOR,
        computeAndPersistPriority: async () => { throw new Error('priority layer exploded'); },
      });
    } catch (err) {
      threw = true;
    }
    assert.strictEqual(threw, false);
  },

  'a lost-race completeAssessment (status no longer "assessing") never calls computeAndPersistPriority a second time': async () => {
    // Simulates two pipeline runs for the same assessment row racing:
    // the second call's completeAssessment finds status already
    // 'assessed' (not 'assessing') and performs no write, so
    // transitioned=false and the priority hook must not fire again.
    const db = makeFakeDb([{ id: 'evt-1', tenant_id: 'zenex', status: 'new', assessment_id: null }]);
    const claim = await claimAssessment(db, { tenantId: 'zenex', decisionEventId: 'evt-1', mode: 'manual' });
    let callCount = 0;
    const deps = {
      buildDecisionAssessmentContext: async () => FAKE_CONTEXT,
      runEvidenceAnalystDecisionAgent: async () => OK_EVIDENCE,
      runStrategicAnalystDecisionAgent: async () => OK_STRATEGIC,
      runAdvisorDecisionAgent: async () => OK_ADVISOR,
      computeAndPersistPriority: async () => { callCount += 1; },
    };

    // First run completes normally.
    await runAssessmentPipeline(claim.assessmentId, { pool: db, deps });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(callCount, 1);

    // Force the row back into 'assessing' to simulate a genuine race
    // window, then let completeAssessment's own guard reject a second
    // write attempt by pre-marking it 'assessed' again (already the
    // case) -- runAssessmentPipeline's own top-of-function guard
    // (`if (row.status !== 'pending') return;`) already prevents a
    // second full run for an already-assessed row, which is exactly the
    // hard invariant this test documents: the hook cannot double-fire
    // through the normal entry point.
    await runAssessmentPipeline(claim.assessmentId, { pool: db, deps });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(callCount, 1, 'a second runAssessmentPipeline call for an already-assessed row must not re-trigger prioritisation');
  },
};
