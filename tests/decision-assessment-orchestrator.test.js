'use strict';

// tests/decision-assessment-orchestrator.test.js
//
// Phase 4 focused tests. No live DB, no live Anthropic calls -- follows
// this codebase's established conventions exactly:
//   - tests/run.js convention: plain exported async functions, PASS on
//     no-throw, FAIL on thrown error.
//   - "injectable pool" convention already established by
//     decision-events/orchestrator.js#runOnce({ pool: injectedPool }):
//     every test below drives api/intelligence/decision-assessment/
//     orchestrator.js against a small in-memory fake Postgres (see
//     makeFakeDb below), never a real connection.
//   - runAssessmentPipeline additionally accepts an injectable `deps`
//     object (the three frozen agent-runner functions), mirroring the
//     same injection pattern, specifically so this suite never makes a
//     live Anthropic call -- consistent with the "known test gap, not
//     fixed in this increment" precedent already used for the Advisor's
//     own live-call path in Phase 3 (evidence-analyst.js /
//     strategic-analyst.js / advisor.js tests do not exercise the live
//     call path either; this suite tests orchestration/persistence
//     logic around those calls, not the calls themselves).
//
// The fake DB below implements exactly the fixed set of SQL statements
// orchestrator.js issues (claim/markAssessing/fail/complete/read), each
// recognised by a distinctive substring, backed by plain in-memory Maps
// for decision_events and decision_assessments. BEGIN/COMMIT/ROLLBACK are
// no-ops (single JS process, no real concurrency) -- FOR UPDATE's row
// lock is therefore not truly exercised by this suite; what IS exercised,
// and is the load-bearing part of the hard invariants, is the sequence of
// reads/writes and the eligibility decisions themselves.

const assert = require('assert');
const {
  claimAssessment,
  runAssessmentPipeline,
  isStale,
  recoverIfStale,
  getAssessmentById,
  listAssessmentsForEvent,
  AssessmentError,
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
        id,
        decision_event_id: decisionEventId,
        tenant_id: tenantId,
        assessment_version: version,
        status: 'pending',
        trigger_mode: mode,
        requested_by: requestedBy,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
        evidence_output: null,
        strategic_output: null,
        advisor_output: null,
        evidence_confidence: null,
        strategic_confidence: null,
        overall_confidence: null,
        partial_context: false,
        partial_context_reasons: [],
        failure_reason: null,
      });
      return { rows: [{ id, assessment_version: version }] };
    }

    if (s.startsWith('UPDATE public.decision_events') && s.includes("SET status = 'under_assessment'")) {
      const [assessmentId, decisionEventId] = params;
      const e = events.get(decisionEventId);
      if (e) {
        e.status = 'under_assessment';
        e.assessment_id = assessmentId;
      }
      return { rows: [] };
    }

    if (s.startsWith('UPDATE public.decision_assessments') && s.includes("SET status = 'assessing'")) {
      const [assessmentId] = params;
      const a = assessments.get(assessmentId);
      if (a && a.status === 'pending') {
        a.status = 'assessing';
        a.started_at = new Date().toISOString();
      }
      return { rows: [] };
    }

    if (s.startsWith('UPDATE public.decision_assessments') && s.includes("SET status = 'failed'")) {
      const [assessmentId, reason] = params;
      const a = assessments.get(assessmentId);
      if (a && a.status === 'assessing') {
        a.status = 'failed';
        a.failure_reason = reason;
        a.completed_at = new Date().toISOString();
        return { rows: [{ id: assessmentId }] };
      }
      return { rows: [] };
    }

    if (s.startsWith('UPDATE public.decision_events') && s.includes("SET status = 'new'")) {
      const [decisionEventId, assessmentId] = params;
      const e = events.get(decisionEventId);
      if (e && e.assessment_id === assessmentId && e.status === 'under_assessment') {
        e.status = 'new';
      }
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
      if (e && e.assessment_id === assessmentId && e.status === 'under_assessment') {
        e.status = 'assessed';
      }
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

    if (s.startsWith('SELECT * FROM public.decision_assessments WHERE id')) {
      const [id, tenantId] = params;
      const a = assessments.get(id);
      return { rows: a && a.tenant_id === tenantId ? [{ ...a }] : [] };
    }

    if (s.startsWith('SELECT * FROM public.decision_assessments WHERE decision_event_id')) {
      const [decisionEventId, tenantId] = params;
      const rows = [...assessments.values()]
        .filter((a) => a.decision_event_id === decisionEventId && a.tenant_id === tenantId)
        .sort((a, b) => b.assessment_version - a.assessment_version)
        .map((r) => ({ ...r }));
      return { rows };
    }

    throw new Error(`FakeDB: unrecognised query: ${s}`);
  }

  return {
    query,
    connect: async () => ({ query, release: () => {} }),
    _events: events,
    _assessments: assessments,
  };
}

const OK_EVIDENCE = {
  agent: 'evidence_analyst_decision',
  status: 'ok',
  execution_ms: 10,
  model: 'test',
  usage: { input_tokens: 1, output_tokens: 1 },
  decision_event_id: 'evt-1',
  output: { established_findings: [], evidence_limitations: [], evidence_gaps: [], evidence_confidence: 'MODERATE' },
  error: null,
};
const OK_STRATEGIC = {
  agent: 'strategic_analyst_decision',
  status: 'ok',
  execution_ms: 10,
  model: 'test',
  usage: { input_tokens: 1, output_tokens: 1 },
  decision_event_id: 'evt-1',
  output: { options: [], exposure: 'X', exposure_basis: 'Y', strategic_confidence: 'MODERATE' },
  error: null,
};
const OK_ADVISOR = {
  agent: 'advisor_decision',
  status: 'ok',
  execution_ms: 10,
  model: 'test',
  usage: { input_tokens: 1, output_tokens: 1 },
  decision_event_id: 'evt-1',
  output: { situation: 'S', overall_confidence: 'MODERATE' },
  error: null,
};
const FAKE_CONTEXT = {
  decisionEvent: { id: 'evt-1', tenantId: 'zenex' },
  evidence: { signals: [], decisions: [], outcomes: [], programmes: [] },
  evidenceGaps: [],
  institutionalMemory: null,
  externalIntelligence: null,
  partialContext: false,
  partialContextReasons: [],
};

module.exports = {

  'isStale: a pending/assessing row past STALE_MS is stale; anything else is not': async () => {
    const old = new Date(Date.now() - 999999999).toISOString();
    const recent = new Date().toISOString();
    assert.strictEqual(isStale({ status: 'pending', created_at: old }), true);
    assert.strictEqual(isStale({ status: 'assessing', started_at: old }), true);
    assert.strictEqual(isStale({ status: 'pending', created_at: recent }), false);
    assert.strictEqual(isStale({ status: 'assessed', created_at: old }), false);
    assert.strictEqual(isStale({ status: 'failed', created_at: old }), false);
    assert.strictEqual(isStale(null), false);
  },

  'claimAssessment (auto): a "new" event with assessment_id NULL is eligible and claimed': async () => {
    const db = makeFakeDb([{ id: 'evt-1', tenant_id: 'zenex', status: 'new', assessment_id: null }]);
    const claim = await claimAssessment(db, { tenantId: 'zenex', decisionEventId: 'evt-1', mode: 'auto' });
    assert.strictEqual(claim.assessmentVersion, 1);
    assert.strictEqual(db._events.get('evt-1').status, 'under_assessment');
    assert.strictEqual(db._events.get('evt-1').assessment_id, claim.assessmentId);
  },

  'claimAssessment (auto): hard invariant #6 -- a "new" event with a non-null assessment_id (failed latest attempt) is NOT auto-eligible': async () => {
    const db = makeFakeDb([{ id: 'evt-1', tenant_id: 'zenex', status: 'new', assessment_id: 'assess-prior' }]);
    await assert.rejects(
      claimAssessment(db, { tenantId: 'zenex', decisionEventId: 'evt-1', mode: 'auto' }),
      (err) => err instanceof AssessmentError && err.code === 'NOT_ELIGIBLE',
    );
  },

  'claimAssessment (manual): a "new" event with a failed latest attempt IS manually eligible and creates the next version': async () => {
    const db = makeFakeDb([{ id: 'evt-1', tenant_id: 'zenex', status: 'new', assessment_id: 'assess-prior' }]);
    db._assessments.set('assess-prior', { id: 'assess-prior', decision_event_id: 'evt-1', tenant_id: 'zenex', assessment_version: 1, status: 'failed' });
    const claim = await claimAssessment(db, { tenantId: 'zenex', decisionEventId: 'evt-1', mode: 'manual' });
    assert.strictEqual(claim.assessmentVersion, 2);
  },

  'claimAssessment (manual): an "assessed" event is manually eligible (reassessment) and increments version': async () => {
    const db = makeFakeDb([{ id: 'evt-1', tenant_id: 'zenex', status: 'assessed', assessment_id: 'assess-1' }]);
    db._assessments.set('assess-1', { id: 'assess-1', decision_event_id: 'evt-1', tenant_id: 'zenex', assessment_version: 1, status: 'assessed' });
    const claim = await claimAssessment(db, { tenantId: 'zenex', decisionEventId: 'evt-1', mode: 'manual' });
    assert.strictEqual(claim.assessmentVersion, 2);
  },

  'claimAssessment (manual): hard invariant #8 -- under_assessment (in flight) is CONFLICT, never queued/no-op\'d': async () => {
    const db = makeFakeDb([{ id: 'evt-1', tenant_id: 'zenex', status: 'under_assessment', assessment_id: 'assess-1' }]);
    await assert.rejects(
      claimAssessment(db, { tenantId: 'zenex', decisionEventId: 'evt-1', mode: 'manual' }),
      (err) => err instanceof AssessmentError && err.code === 'CONFLICT',
    );
  },

  'claimAssessment (manual): hard invariant #9 -- dismissed/acted_on are out of scope, rejected as CONFLICT, never silently accepted': async () => {
    const dbDismissed = makeFakeDb([{ id: 'evt-1', tenant_id: 'zenex', status: 'dismissed', assessment_id: null }]);
    await assert.rejects(
      claimAssessment(dbDismissed, { tenantId: 'zenex', decisionEventId: 'evt-1', mode: 'manual' }),
      (err) => err instanceof AssessmentError && err.code === 'CONFLICT',
    );
    const dbActedOn = makeFakeDb([{ id: 'evt-1', tenant_id: 'zenex', status: 'acted_on', assessment_id: null }]);
    await assert.rejects(
      claimAssessment(dbActedOn, { tenantId: 'zenex', decisionEventId: 'evt-1', mode: 'manual' }),
      (err) => err instanceof AssessmentError && err.code === 'CONFLICT',
    );
  },

  'claimAssessment: an unknown decision_event_id/tenant_id pair is NOT_FOUND': async () => {
    const db = makeFakeDb([{ id: 'evt-1', tenant_id: 'zenex', status: 'new', assessment_id: null }]);
    await assert.rejects(
      claimAssessment(db, { tenantId: 'zenex', decisionEventId: 'does-not-exist', mode: 'manual' }),
      (err) => err instanceof AssessmentError && err.code === 'NOT_FOUND',
    );
    await assert.rejects(
      claimAssessment(db, { tenantId: 'optima', decisionEventId: 'evt-1', mode: 'manual' }),
      (err) => err instanceof AssessmentError && err.code === 'NOT_FOUND',
      'tenant isolation: the same event id under a different tenant must not be found',
    );
  },

  'claimAssessment: rejects missing/invalid arguments (BAD_REQUEST), never silently defaults': async () => {
    const db = makeFakeDb([]);
    await assert.rejects(claimAssessment(db, { decisionEventId: 'evt-1', mode: 'manual' }), (e) => e.code === 'BAD_REQUEST');
    await assert.rejects(claimAssessment(db, { tenantId: 'zenex', mode: 'manual' }), (e) => e.code === 'BAD_REQUEST');
    await assert.rejects(claimAssessment(db, { tenantId: 'zenex', decisionEventId: 'evt-1', mode: 'bogus' }), (e) => e.code === 'BAD_REQUEST');
  },

  'runAssessmentPipeline: full success path persists all three envelopes and advances both rows to assessed': async () => {
    const db = makeFakeDb([{ id: 'evt-1', tenant_id: 'zenex', status: 'new', assessment_id: null }]);
    const claim = await claimAssessment(db, { tenantId: 'zenex', decisionEventId: 'evt-1', mode: 'manual' });

    await runAssessmentPipeline(claim.assessmentId, {
      pool: db,
      deps: {
        buildDecisionAssessmentContext: async () => FAKE_CONTEXT,
        runEvidenceAnalystDecisionAgent: async () => OK_EVIDENCE,
        runStrategicAnalystDecisionAgent: async () => OK_STRATEGIC,
        runAdvisorDecisionAgent: async () => OK_ADVISOR,
      },
    });

    const a = db._assessments.get(claim.assessmentId);
    assert.strictEqual(a.status, 'assessed');
    assert.deepStrictEqual(a.evidence_output, OK_EVIDENCE.output);
    assert.deepStrictEqual(a.strategic_output, OK_STRATEGIC.output);
    assert.deepStrictEqual(a.advisor_output, OK_ADVISOR.output);
    assert.strictEqual(a.overall_confidence, 'MODERATE');
    assert.strictEqual(db._events.get('evt-1').status, 'assessed');
    assert.strictEqual(db._events.get('evt-1').assessment_id, claim.assessmentId, 'assessment_id must still point at this (now successful) attempt');
  },

  'runAssessmentPipeline: Evidence Analyst failure -- Strategic Analyst and Advisor are never called, event reverts to new, assessment_id untouched': async () => {
    const db = makeFakeDb([{ id: 'evt-1', tenant_id: 'zenex', status: 'new', assessment_id: null }]);
    const claim = await claimAssessment(db, { tenantId: 'zenex', decisionEventId: 'evt-1', mode: 'manual' });

    let strategicCalled = false;
    let advisorCalled = false;
    await runAssessmentPipeline(claim.assessmentId, {
      pool: db,
      deps: {
        buildDecisionAssessmentContext: async () => FAKE_CONTEXT,
        runEvidenceAnalystDecisionAgent: async () => ({ ...OK_EVIDENCE, status: 'failed', output: null, error: 'evidence broke' }),
        runStrategicAnalystDecisionAgent: async () => { strategicCalled = true; return OK_STRATEGIC; },
        runAdvisorDecisionAgent: async () => { advisorCalled = true; return OK_ADVISOR; },
      },
    });

    assert.strictEqual(strategicCalled, false, 'Strategic Analyst must never be called after an Evidence Analyst failure');
    assert.strictEqual(advisorCalled, false, 'Advisor must never be called after an Evidence Analyst failure');
    const a = db._assessments.get(claim.assessmentId);
    assert.strictEqual(a.status, 'failed');
    assert.ok(a.failure_reason.includes('evidence broke'));
    const e = db._events.get('evt-1');
    assert.strictEqual(e.status, 'new', 'a failed assessment must revert decision_events.status to "new" (hard invariant: no dedicated failed status in migration 027)');
    assert.strictEqual(e.assessment_id, claim.assessmentId, 'hard invariant #4: assessment_id is never nulled or reverted on failure -- it must still point at this failed attempt');
  },

  'runAssessmentPipeline: Strategic Analyst failure -- Advisor is never called (fail-closed, Q1)': async () => {
    const db = makeFakeDb([{ id: 'evt-1', tenant_id: 'zenex', status: 'new', assessment_id: null }]);
    const claim = await claimAssessment(db, { tenantId: 'zenex', decisionEventId: 'evt-1', mode: 'manual' });

    let advisorCalled = false;
    await runAssessmentPipeline(claim.assessmentId, {
      pool: db,
      deps: {
        buildDecisionAssessmentContext: async () => FAKE_CONTEXT,
        runEvidenceAnalystDecisionAgent: async () => OK_EVIDENCE,
        runStrategicAnalystDecisionAgent: async () => ({ ...OK_STRATEGIC, status: 'failed', output: null, error: 'strategic broke' }),
        runAdvisorDecisionAgent: async () => { advisorCalled = true; return OK_ADVISOR; },
      },
    });

    assert.strictEqual(advisorCalled, false, 'Advisor must never be called after a Strategic Analyst failure (fail-closed, Q1)');
    const a = db._assessments.get(claim.assessmentId);
    assert.strictEqual(a.status, 'failed');
    assert.ok(a.failure_reason.includes('strategic broke'));
  },

  'runAssessmentPipeline: Advisor failure -- assessment fails, event reverts to new, assessment_id untouched': async () => {
    const db = makeFakeDb([{ id: 'evt-1', tenant_id: 'zenex', status: 'new', assessment_id: null }]);
    const claim = await claimAssessment(db, { tenantId: 'zenex', decisionEventId: 'evt-1', mode: 'manual' });

    await runAssessmentPipeline(claim.assessmentId, {
      pool: db,
      deps: {
        buildDecisionAssessmentContext: async () => FAKE_CONTEXT,
        runEvidenceAnalystDecisionAgent: async () => OK_EVIDENCE,
        runStrategicAnalystDecisionAgent: async () => OK_STRATEGIC,
        runAdvisorDecisionAgent: async () => ({ ...OK_ADVISOR, status: 'failed', output: null, error: 'advisor broke' }),
      },
    });

    const a = db._assessments.get(claim.assessmentId);
    assert.strictEqual(a.status, 'failed');
    assert.ok(a.failure_reason.includes('advisor broke'));
    assert.strictEqual(db._events.get('evt-1').status, 'new');
    assert.strictEqual(db._events.get('evt-1').assessment_id, claim.assessmentId);
  },

  'runAssessmentPipeline: an unhandled exception mid-pipeline still fails the assessment atomically rather than leaving it stuck assessing': async () => {
    const db = makeFakeDb([{ id: 'evt-1', tenant_id: 'zenex', status: 'new', assessment_id: null }]);
    const claim = await claimAssessment(db, { tenantId: 'zenex', decisionEventId: 'evt-1', mode: 'manual' });

    await runAssessmentPipeline(claim.assessmentId, {
      pool: db,
      deps: {
        buildDecisionAssessmentContext: async () => { throw new Error('context blew up'); },
      },
    });

    const a = db._assessments.get(claim.assessmentId);
    assert.strictEqual(a.status, 'failed');
    assert.ok(a.failure_reason.includes('context blew up'));
  },

  'runAssessmentPipeline: reassessment after a failure creates a new immutable row -- the old failed row is never modified': async () => {
    const db = makeFakeDb([{ id: 'evt-1', tenant_id: 'zenex', status: 'new', assessment_id: null }]);
    const claim1 = await claimAssessment(db, { tenantId: 'zenex', decisionEventId: 'evt-1', mode: 'manual' });
    await runAssessmentPipeline(claim1.assessmentId, {
      pool: db,
      deps: {
        buildDecisionAssessmentContext: async () => FAKE_CONTEXT,
        runEvidenceAnalystDecisionAgent: async () => ({ ...OK_EVIDENCE, status: 'failed', output: null, error: 'first attempt broke' }),
      },
    });
    const failedSnapshot = { ...db._assessments.get(claim1.assessmentId) };

    const claim2 = await claimAssessment(db, { tenantId: 'zenex', decisionEventId: 'evt-1', mode: 'manual' });
    assert.strictEqual(claim2.assessmentVersion, 2);
    assert.notStrictEqual(claim2.assessmentId, claim1.assessmentId);

    await runAssessmentPipeline(claim2.assessmentId, {
      pool: db,
      deps: {
        buildDecisionAssessmentContext: async () => FAKE_CONTEXT,
        runEvidenceAnalystDecisionAgent: async () => OK_EVIDENCE,
        runStrategicAnalystDecisionAgent: async () => OK_STRATEGIC,
        runAdvisorDecisionAgent: async () => OK_ADVISOR,
      },
    });

    assert.deepStrictEqual(db._assessments.get(claim1.assessmentId), failedSnapshot, 'the historical failed row must never be modified by a later reassessment');
    assert.strictEqual(db._assessments.get(claim2.assessmentId).status, 'assessed');
    assert.strictEqual(db._events.get('evt-1').assessment_id, claim2.assessmentId, 'assessment_id must now point at the latest (successful) attempt');
    assert.strictEqual(db._events.get('evt-1').status, 'assessed');
  },

  'recoverIfStale / getAssessmentById: a stuck "assessing" row past STALE_MS is recovered to failed on read, and the event reverts to new': async () => {
    const db = makeFakeDb([{ id: 'evt-1', tenant_id: 'zenex', status: 'under_assessment', assessment_id: 'assess-1' }]);
    db._assessments.set('assess-1', {
      id: 'assess-1',
      decision_event_id: 'evt-1',
      tenant_id: 'zenex',
      assessment_version: 1,
      status: 'assessing',
      started_at: new Date(Date.now() - 999999999).toISOString(),
      created_at: new Date(Date.now() - 999999999).toISOString(),
    });

    const result = await getAssessmentById(db, 'assess-1', 'zenex');
    assert.strictEqual(result.status, 'failed');
    assert.ok(result.failure_reason.includes('stalled'));
    assert.strictEqual(db._events.get('evt-1').status, 'new');
  },

  'recoverIfStale: a recent "assessing" row is left untouched': async () => {
    const db = makeFakeDb([{ id: 'evt-1', tenant_id: 'zenex', status: 'under_assessment', assessment_id: 'assess-1' }]);
    db._assessments.set('assess-1', {
      id: 'assess-1', decision_event_id: 'evt-1', tenant_id: 'zenex', assessment_version: 1,
      status: 'assessing', started_at: new Date().toISOString(), created_at: new Date().toISOString(),
    });
    const result = await recoverIfStale(db, db._assessments.get('assess-1'));
    assert.strictEqual(result.status, 'assessing');
  },

  'listAssessmentsForEvent: returns full version history newest-first, tenant-scoped': async () => {
    const db = makeFakeDb([{ id: 'evt-1', tenant_id: 'zenex', status: 'assessed', assessment_id: 'assess-2' }]);
    db._assessments.set('assess-1', { id: 'assess-1', decision_event_id: 'evt-1', tenant_id: 'zenex', assessment_version: 1, status: 'failed', created_at: new Date().toISOString() });
    db._assessments.set('assess-2', { id: 'assess-2', decision_event_id: 'evt-1', tenant_id: 'zenex', assessment_version: 2, status: 'assessed', created_at: new Date().toISOString() });
    db._assessments.set('assess-other-tenant', { id: 'assess-other-tenant', decision_event_id: 'evt-1', tenant_id: 'optima', assessment_version: 1, status: 'assessed', created_at: new Date().toISOString() });

    const rows = await listAssessmentsForEvent(db, 'evt-1', 'zenex');
    assert.strictEqual(rows.length, 2, 'must not include another tenant\'s row for the same decision_event_id');
    assert.strictEqual(rows[0].assessment_version, 2);
    assert.strictEqual(rows[1].assessment_version, 1);
  },

};
