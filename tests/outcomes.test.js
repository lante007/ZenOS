'use strict';

// tests/outcomes.test.js — C5: intelligence_outcomes is append-only.
//
// A revision is always a new row (POST with original_outcome_id set), never
// an edit to the row it revises. That is enforced two ways, and this file
// tests both:
//   1. at the application layer, api/memory/outcomes.js exposes no update or
//      delete function at all (a static check of its exports);
//   2. at the database layer, a trigger rejects any UPDATE/DELETE on
//      public.intelligence_outcomes outright (see api/memory/schema.js).
//
// The one exception to (2) is a session-local escape hatch
// (app.allow_outcome_mutation) that the running application never sets, so
// it is not reachable through the API. Test cleanup uses it directly via a
// raw pool client (never through api/memory/outcomes.js) to remove the
// disposable rows these tests create, so no test data is left behind in a
// shared database. Every test that creates a row deletes it in a `finally`.

const assert = require('assert');
const crypto = require('crypto');
const { hasDatabase } = require('./helpers/env');
const outcomes = require('../api/memory/outcomes');
const { recordOutcome, listOutcomes, getOutcomeById, OUTCOME_STATUS } = outcomes;

async function deleteOutcome(pool, id) {
  if (!id) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL app.allow_outcome_mutation = 'true'");
    await client.query('DELETE FROM public.intelligence_outcomes WHERE id = $1', [id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  'the outcomes module exposes no update or delete capability at the application layer': async () => {
    const keys = Object.keys(outcomes);
    assert.deepStrictEqual(
      keys.sort(),
      ['OUTCOME_STATUS', 'getOutcomeById', 'listOutcomes', 'recordOutcome', 'sourceReliabilityStats'].sort(),
    );
    for (const key of keys) {
      assert.ok(!/update|delete|remove|edit|patch/i.test(key), `export "${key}" looks like a mutation capability, which must not exist`);
    }
  },

  'two outcomes recorded for the same job persist as two distinct rows': async () => {
    if (!hasDatabase()) return 'SKIP';
    const { getPool } = require('../api/services/db');
    const pool = getPool();
    const jobId = crypto.randomUUID();
    let a, b;
    try {
      a = await recordOutcome('zenex', { job_id: jobId, outcome_status: 'pending', decision_taken: 'Wait and see.' });
      b = await recordOutcome('zenex', { job_id: jobId, outcome_status: 'acted_on', decision_taken: 'Applied for the grant.' });
      assert.notStrictEqual(a.id, b.id);

      const list = await listOutcomes('zenex', { jobId });
      const ids = list.map(o => o.id);
      assert.ok(ids.includes(a.id));
      assert.ok(ids.includes(b.id));
      assert.strictEqual(list.length, 2);
    } finally {
      await deleteOutcome(pool, a && a.id);
      await deleteOutcome(pool, b && b.id);
    }
  },

  'a revision sets original_outcome_id, and both the original and the revision remain retrievable': async () => {
    if (!hasDatabase()) return 'SKIP';
    const { getPool } = require('../api/services/db');
    const pool = getPool();
    const jobId = crypto.randomUUID();
    let original, revision;
    try {
      original = await recordOutcome('zenex', { job_id: jobId, outcome_status: 'pending', decision_taken: 'Wait and see.' });
      assert.strictEqual(original.original_outcome_id, null);

      revision = await recordOutcome('zenex', {
        job_id: jobId,
        outcome_status: 'acted_on',
        decision_taken: 'Actually, applied for the grant.',
        original_outcome_id: original.id,
      });
      assert.strictEqual(revision.original_outcome_id, original.id);

      const fetchedOriginal = await getOutcomeById('zenex', original.id);
      const fetchedRevision = await getOutcomeById('zenex', revision.id);
      assert.ok(fetchedOriginal);
      assert.ok(fetchedRevision);
      assert.strictEqual(fetchedRevision.original_outcome_id, fetchedOriginal.id);
    } finally {
      await deleteOutcome(pool, revision && revision.id);
      await deleteOutcome(pool, original && original.id);
    }
  },

  'recordOutcome rejects an original_outcome_id that does not refer to a real outcome': async () => {
    if (!hasDatabase()) return 'SKIP';
    const bogusId = '00000000-0000-0000-0000-000000000000';
    await assert.rejects(
      () => recordOutcome('zenex', { job_id: crypto.randomUUID(), outcome_status: 'pending', original_outcome_id: bogusId }),
      /original_outcome_id/,
    );
  },

  'recordOutcome rejects an outcome_status outside the known set': async () => {
    if (!hasDatabase()) return 'SKIP';
    await assert.rejects(
      () => recordOutcome('zenex', { job_id: crypto.randomUUID(), outcome_status: 'not_a_real_status' }),
      new RegExp(OUTCOME_STATUS[0]),
    );
  },

  'the database rejects a direct UPDATE against intelligence_outcomes, even bypassing the application layer': async () => {
    if (!hasDatabase()) return 'SKIP';
    const { getPool } = require('../api/services/db');
    const pool = getPool();
    let row;
    try {
      row = await recordOutcome('zenex', { job_id: crypto.randomUUID(), outcome_status: 'pending' });
      await assert.rejects(
        () => pool.query('UPDATE public.intelligence_outcomes SET notes = $1 WHERE id = $2', ['tampered', row.id]),
        /append-only/i,
      );
    } finally {
      await deleteOutcome(pool, row && row.id);
    }
  },

  'the database rejects a direct DELETE against intelligence_outcomes without the mutation escape hatch': async () => {
    if (!hasDatabase()) return 'SKIP';
    const { getPool } = require('../api/services/db');
    const pool = getPool();
    let row;
    try {
      row = await recordOutcome('zenex', { job_id: crypto.randomUUID(), outcome_status: 'pending' });
      await assert.rejects(
        () => pool.query('DELETE FROM public.intelligence_outcomes WHERE id = $1', [row.id]),
        /append-only/i,
      );
      const stillThere = await getOutcomeById('zenex', row.id);
      assert.ok(stillThere, 'row must still exist after the rejected DELETE');
    } finally {
      await deleteOutcome(pool, row && row.id);
    }
  },

  'the session-local escape hatch is the only way to remove a row, and is not reachable through the application layer': async () => {
    if (!hasDatabase()) return 'SKIP';
    const { getPool } = require('../api/services/db');
    const pool = getPool();
    const row = await recordOutcome('zenex', { job_id: crypto.randomUUID(), outcome_status: 'pending' });
    await deleteOutcome(pool, row.id);
    const gone = await getOutcomeById('zenex', row.id);
    assert.strictEqual(gone, null);
  },
};
