'use strict';

// tests/decision-prioritisation-orchestrator.test.js
//
// Phase 5 focused tests for the Decision Prioritisation persistence layer
// (api/intelligence/decision-prioritisation/orchestrator.js). Follows the
// exact "injectable pool against a small in-memory fake Postgres"
// convention already established by
// tests/decision-assessment-orchestrator.test.js's own makeFakeDb -- no
// live DB connection anywhere in this suite.
//
// Known test gap (same disclaimer as the Phase 4 suite this mirrors):
// BEGIN/COMMIT/ROLLBACK are no-ops here (single JS process, no real
// concurrency), so FOR UPDATE's row lock and migration 029's partial
// unique index are not truly exercised by this suite. What IS exercised
// is the sequence of reads/writes and the supersession decision itself --
// two sequential computeAndPersistPriority calls for the same
// decision_event_id, run one after another exactly as two racing workers
// would eventually be serialised by the real lock, and asserted to leave
// exactly one active record with a correct supersession chain.

const assert = require('assert');
const {
  computeAndPersistPriority,
  getActivePriorityForEvent,
  listPrioritiesForEvent,
  PrioritisationError,
  RULE_VERSION,
} = require('../api/intelligence/decision-prioritisation/orchestrator');

function makeFakeDb(initialEvents = []) {
  const events = new Map(initialEvents.map((e) => [e.id, { ...e }]));
  const priorityRecords = new Map();
  let idCounter = 1;
  const newId = () => `pri-${idCounter++}`;

  async function query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

    if (s.startsWith('SELECT id, tenant_id') && s.includes('FOR UPDATE')) {
      const [id, tenantId] = params;
      const e = events.get(id);
      return { rows: e && e.tenant_id === tenantId ? [{ id: e.id, tenant_id: e.tenant_id }] : [] };
    }

    if (s.startsWith('INSERT INTO public.priority_records')) {
      const [tenantId, decisionEventId, assessmentId, assessmentVersion, priority, priorityScore, priorityReason, contributingFactors, ruleVersion] = params;
      const id = newId();
      const record = {
        id,
        tenant_id: tenantId,
        decision_event_id: decisionEventId,
        assessment_id: assessmentId,
        assessment_version: assessmentVersion,
        priority,
        priority_score: priorityScore,
        priority_reason: priorityReason,
        contributing_factors: JSON.parse(contributingFactors),
        rule_version: ruleVersion,
        assigned_at: new Date(),
        superseded_at: null,
        superseded_by: null,
      };
      priorityRecords.set(id, record);
      return { rows: [{ id: record.id, priority: record.priority, assigned_at: record.assigned_at }] };
    }

    if (s.startsWith('UPDATE public.priority_records')) {
      const [newRecordId, decisionEventId, tenantId] = params;
      const superseded = [];
      for (const r of priorityRecords.values()) {
        if (r.decision_event_id === decisionEventId && r.tenant_id === tenantId && r.superseded_at === null && r.id !== newRecordId) {
          r.superseded_at = new Date();
          r.superseded_by = newRecordId;
          superseded.push({ id: r.id });
        }
      }
      return { rows: superseded };
    }

    if (s.includes('AND superseded_at IS NULL') && s.startsWith('SELECT * FROM public.priority_records') && !s.includes('ORDER BY')) {
      const [decisionEventId, tenantId] = params;
      const found = [...priorityRecords.values()].find(
        (r) => r.decision_event_id === decisionEventId && r.tenant_id === tenantId && r.superseded_at === null,
      );
      return { rows: found ? [{ ...found }] : [] };
    }

    if (s.startsWith('SELECT * FROM public.priority_records') && s.includes('ORDER BY assigned_at DESC')) {
      const [decisionEventId, tenantId] = params;
      const rows = [...priorityRecords.values()]
        .filter((r) => r.decision_event_id === decisionEventId && r.tenant_id === tenantId)
        .sort((a, b) => b.assigned_at - a.assigned_at)
        .map((r) => ({ ...r }));
      return { rows };
    }

    throw new Error(`fake db: unrecognised query: ${s}`);
  }

  return {
    query,
    connect: async () => ({ query, release: () => {} }),
    _events: events,
    _priorityRecords: priorityRecords,
  };
}

const BASE_EVENT = { id: 'event-1', tenant_id: 'tenant-a' };
const BASE_FIELDS = {
  tenantId: 'tenant-a',
  decisionEventId: 'event-1',
  assessmentId: 'assess-1',
  assessmentVersion: 1,
  strategicOutput: { exposure: 'R1,000,000', cost_of_waiting: 'manageable', severity: 'HIGH', reversibility: 'REVERSIBLE', timing_sensitivity: 'NOT_TIME_SENSITIVE' },
  advisorOutput: { overall_confidence: 'HIGH' },
  partialContext: false,
  triggerPathway: 'SIGNAL_TOUCHES_EXPOSURE',
  triggerData: {},
};

module.exports = {
  'creates a priority record with correct priority for HIGH confidence + HIGH severity -> HIGH': async () => {
    const db = makeFakeDb([BASE_EVENT]);
    const result = await computeAndPersistPriority(db, BASE_FIELDS);
    assert.strictEqual(result.priority, 'HIGH');
    const stored = db._priorityRecords.get(result.priorityRecordId);
    assert.strictEqual(stored.rule_version, RULE_VERSION);
    assert.strictEqual(stored.priority_reason.length > 0, true);
  },

  'creates a priority record with LOW for LOW confidence + partial context': async () => {
    const db = makeFakeDb([BASE_EVENT]);
    const result = await computeAndPersistPriority(db, {
      ...BASE_FIELDS,
      advisorOutput: { overall_confidence: 'LOW' },
      partialContext: true,
    });
    assert.strictEqual(result.priority, 'LOW');
  },

  'contributing_factors persisted contains the fields used in the decision': async () => {
    const db = makeFakeDb([BASE_EVENT]);
    const result = await computeAndPersistPriority(db, BASE_FIELDS);
    const stored = db._priorityRecords.get(result.priorityRecordId);
    assert.strictEqual(stored.contributing_factors.severity, 'HIGH');
    assert.strictEqual(stored.contributing_factors.overall_confidence, 'HIGH');
  },

  'rule_version is v1.0 on all created records': async () => {
    const db = makeFakeDb([BASE_EVENT]);
    const result = await computeAndPersistPriority(db, BASE_FIELDS);
    const stored = db._priorityRecords.get(result.priorityRecordId);
    assert.strictEqual(stored.rule_version, 'v1.0');
  },

  'supersession: a second completed assessment supersedes the first and both link correctly': async () => {
    const db = makeFakeDb([BASE_EVENT]);
    const first = await computeAndPersistPriority(db, BASE_FIELDS);
    const second = await computeAndPersistPriority(db, { ...BASE_FIELDS, assessmentId: 'assess-2', assessmentVersion: 2 });

    const firstRecord = db._priorityRecords.get(first.priorityRecordId);
    const secondRecord = db._priorityRecords.get(second.priorityRecordId);

    assert.ok(firstRecord.superseded_at, 'first record should have superseded_at set');
    assert.strictEqual(firstRecord.superseded_by, second.priorityRecordId);
    assert.strictEqual(secondRecord.superseded_at, null);
    assert.strictEqual(second.supersededIds.includes(first.priorityRecordId), true);
  },

  'only one active (non-superseded) record exists after supersession': async () => {
    const db = makeFakeDb([BASE_EVENT]);
    await computeAndPersistPriority(db, BASE_FIELDS);
    await computeAndPersistPriority(db, { ...BASE_FIELDS, assessmentId: 'assess-2', assessmentVersion: 2 });
    await computeAndPersistPriority(db, { ...BASE_FIELDS, assessmentId: 'assess-3', assessmentVersion: 3 });

    const active = [...db._priorityRecords.values()].filter((r) => r.superseded_at === null);
    assert.strictEqual(active.length, 1);
    assert.strictEqual(active[0].assessment_id, 'assess-3');
  },

  'GET active priority (getActivePriorityForEvent) returns the current active record': async () => {
    const db = makeFakeDb([BASE_EVENT]);
    await computeAndPersistPriority(db, BASE_FIELDS);
    const second = await computeAndPersistPriority(db, { ...BASE_FIELDS, assessmentId: 'assess-2', assessmentVersion: 2 });

    const active = await getActivePriorityForEvent(db, 'event-1', 'tenant-a');
    assert.strictEqual(active.id, second.priorityRecordId);
    assert.strictEqual(active.superseded_at, null);
  },

  'GET active priority returns null when no record exists yet': async () => {
    const db = makeFakeDb([BASE_EVENT]);
    const active = await getActivePriorityForEvent(db, 'event-1', 'tenant-a');
    assert.strictEqual(active, null);
  },

  'listPrioritiesForEvent returns full history, newest first': async () => {
    const db = makeFakeDb([BASE_EVENT]);
    const first = await computeAndPersistPriority(db, BASE_FIELDS);
    const second = await computeAndPersistPriority(db, { ...BASE_FIELDS, assessmentId: 'assess-2', assessmentVersion: 2 });

    const history = await listPrioritiesForEvent(db, 'event-1', 'tenant-a');
    assert.strictEqual(history.length, 2);
    assert.strictEqual(history[0].id, second.priorityRecordId);
    assert.strictEqual(history[1].id, first.priorityRecordId);
  },

  'tenant isolation: tenant A cannot read tenant B priority records': async () => {
    const db = makeFakeDb([BASE_EVENT, { id: 'event-2', tenant_id: 'tenant-b' }]);
    await computeAndPersistPriority(db, BASE_FIELDS);
    await computeAndPersistPriority(db, { ...BASE_FIELDS, tenantId: 'tenant-b', decisionEventId: 'event-2', assessmentId: 'assess-b1' });

    const activeForA = await getActivePriorityForEvent(db, 'event-1', 'tenant-a');
    const activeForBViaWrongTenant = await getActivePriorityForEvent(db, 'event-2', 'tenant-a');
    assert.ok(activeForA);
    assert.strictEqual(activeForBViaWrongTenant, null);

    const historyForA = await listPrioritiesForEvent(db, 'event-1', 'tenant-b');
    assert.strictEqual(historyForA.length, 0);
  },

  'concurrent-style completions (two sequential calls) do not duplicate active records': async () => {
    const db = makeFakeDb([BASE_EVENT]);
    const [a, b] = [
      await computeAndPersistPriority(db, { ...BASE_FIELDS, assessmentId: 'assess-a', assessmentVersion: 1 }),
      await computeAndPersistPriority(db, { ...BASE_FIELDS, assessmentId: 'assess-b', assessmentVersion: 2 }),
    ];
    const activeRecords = [...db._priorityRecords.values()].filter((r) => r.superseded_at === null);
    assert.strictEqual(activeRecords.length, 1);
    assert.notStrictEqual(a.priorityRecordId, b.priorityRecordId);
  },

  'throws NOT_FOUND when decision event does not exist for the given tenant': async () => {
    const db = makeFakeDb([BASE_EVENT]);
    await assert.rejects(
      computeAndPersistPriority(db, { ...BASE_FIELDS, tenantId: 'wrong-tenant' }),
      (err) => err instanceof PrioritisationError && err.code === 'NOT_FOUND',
    );
  },

  'throws BAD_REQUEST when required identifiers are missing': async () => {
    const db = makeFakeDb([BASE_EVENT]);
    await assert.rejects(
      computeAndPersistPriority(db, { ...BASE_FIELDS, decisionEventId: undefined }),
      (err) => err instanceof PrioritisationError && err.code === 'BAD_REQUEST',
    );
  },
};
