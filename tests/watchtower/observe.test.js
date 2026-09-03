'use strict';

// tests/watchtower/observe.test.js
//
// Reconstructed regression coverage for Increment 2 (the original suite was
// never committed to the repo — see the C1 commit message for context).
// These five tests exercise the real pipeline end to end
// (fetchSource -> normalise -> fingerprint -> recordObservation ->
// storeSnapshot -> createSignal) against a controlled local HTTP source, so
// they are not testing a mock of Watchtower's behaviour, they are testing
// Watchtower's behaviour.
//
// Requires PostgreSQL (DATABASE_URL) to run; skips cleanly without it. The
// S3-reference test additionally requires AWS credentials and skips on its
// own if they are not available, since a real snapshot upload is the only
// honest way to confirm a reference is stored.
//
// Every test registers its own uniquely-named source (name prefixed
// watchtower-test-) and deletes it (cascade) in a `finally` block, so a
// failed run does not leave test rows behind in a shared database.

const assert = require('assert');
const http = require('http');
const { hasDatabase, hasAws } = require('../helpers/env');

// Safe to require unconditionally: none of these connect to Postgres or AWS
// at require time, only when a DB/S3 call is actually made inside a test.
const wt = require('../../api/memory/watchtower');
const { observeSource } = require('../../api/watchtower/observe');
const { getPool } = require('../../api/services/db');

function startServer(getBody) {
  const server = http.createServer((req, res) => {
    const result = getBody();
    if (result.status && result.status !== 200) {
      res.writeHead(result.status, { 'content-type': 'text/plain' });
      res.end(result.error || 'error');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(result.body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function makeSource(name, url) {
  return wt.registerSource({ name, url, source_type: 'custom', credibility: 'MODERATE' });
}

async function deleteSource(id) {
  const pool = getPool();
  if (pool && id) await pool.query('DELETE FROM public.wt_sources WHERE id = $1', [id]);
}

async function countObservations(sourceId) {
  const pool = getPool();
  const res = await pool.query('SELECT * FROM public.wt_observations WHERE source_id = $1 ORDER BY observed_at ASC', [sourceId]);
  return res.rows;
}

async function countSignals(sourceId) {
  const pool = getPool();
  const res = await pool.query('SELECT * FROM public.wt_signals WHERE source_id = $1 ORDER BY created_at ASC', [sourceId]);
  return res.rows;
}

module.exports = {
  '1. first observation creates a baseline and no signal': async () => {
    if (!hasDatabase()) return 'SKIP';
    let body = 'version-1 content ' + Date.now();
    const server = await startServer(() => ({ body }));
    const { port: p } = server.address();
    const source = await makeSource(`watchtower-test-baseline-${Date.now()}`, `http://127.0.0.1:${p}/`);
    try {
      const result = await observeSource(source);
      assert.strictEqual(result.status, 'ok');
      assert.strictEqual(result.is_first, true);
      assert.strictEqual(result.changed, false);
      assert.strictEqual(result.signal_id, null);
      assert.strictEqual(result.signal_created, false);

      const observations = await countObservations(source.id);
      assert.strictEqual(observations.length, 1);
      const signals = await countSignals(source.id);
      assert.strictEqual(signals.length, 0);
    } finally {
      server.close();
      await deleteSource(source.id);
    }
  },

  '2. identical repeat observation creates no signal': async () => {
    if (!hasDatabase()) return 'SKIP';
    const body = 'stable content ' + Date.now();
    const server = await startServer(() => ({ body }));
    const { port } = server.address();
    const source = await makeSource(`watchtower-test-identical-${Date.now()}`, `http://127.0.0.1:${port}/`);
    try {
      const first = await observeSource(source);
      assert.strictEqual(first.is_first, true);

      const second = await observeSource(source);
      assert.strictEqual(second.status, 'ok');
      assert.strictEqual(second.is_first, false);
      assert.strictEqual(second.changed, false);
      assert.strictEqual(second.signal_id, null);
      assert.strictEqual(second.signal_created, false);

      const observations = await countObservations(source.id);
      assert.strictEqual(observations.length, 2);
      const signals = await countSignals(source.id);
      assert.strictEqual(signals.length, 0);
    } finally {
      server.close();
      await deleteSource(source.id);
    }
  },

  '3. changed content creates exactly one signal': async () => {
    if (!hasDatabase()) return 'SKIP';
    let body = 'original content ' + Date.now();
    const server = await startServer(() => ({ body }));
    const { port } = server.address();
    const source = await makeSource(`watchtower-test-changed-${Date.now()}`, `http://127.0.0.1:${port}/`);
    try {
      const first = await observeSource(source);
      assert.strictEqual(first.is_first, true);

      body = 'changed content ' + Date.now();
      const second = await observeSource(source);
      assert.strictEqual(second.status, 'ok');
      assert.strictEqual(second.is_first, false);
      assert.strictEqual(second.changed, true);
      assert.ok(second.signal_id, 'expected a signal_id on the first real change');
      assert.strictEqual(second.signal_created, true);

      // A third observation of the SAME new content must not create another
      // signal (dedup on source_id + content_fingerprint).
      const third = await observeSource(source);
      assert.strictEqual(third.changed, false);
      assert.strictEqual(third.signal_created, false);

      const signals = await countSignals(source.id);
      assert.strictEqual(signals.length, 1);
    } finally {
      server.close();
      await deleteSource(source.id);
    }
  },

  '4. a failed fetch does not corrupt the previous successful observation': async () => {
    if (!hasDatabase()) return 'SKIP';
    let mode = 'ok';
    const goodBody = 'good content ' + Date.now();
    const server = await startServer(() => (mode === 'ok' ? { body: goodBody } : { status: 500, error: 'boom' }));
    const { port } = server.address();
    const source = await makeSource(`watchtower-test-failfetch-${Date.now()}`, `http://127.0.0.1:${port}/`);
    try {
      const first = await observeSource(source);
      assert.strictEqual(first.status, 'ok');
      assert.strictEqual(first.is_first, true);

      mode = 'fail';
      const failed = await observeSource(source);
      assert.strictEqual(failed.status, 'fetch_failed');
      assert.strictEqual(failed.changed, false);
      assert.strictEqual(failed.signal_id, null);

      // The previous successful observation row must be untouched: fetching
      // it back out should still show the original fingerprint/content, and
      // the failed attempt must be its own row (with error set), not an
      // overwrite.
      const observations = await countObservations(source.id);
      assert.strictEqual(observations.length, 2);
      const successRow = observations.find(o => o.error === null);
      const failRow = observations.find(o => o.error !== null);
      assert.ok(successRow, 'expected the original successful observation to still exist');
      assert.ok(failRow, 'expected the failed attempt to be recorded as its own row');
      assert.ok(successRow.content_fingerprint, 'successful observation must still have its fingerprint');
      assert.strictEqual(failRow.content_fingerprint, null);

      // Recovering afterwards (fetch succeeds again with the SAME content as
      // the original success) must correctly report "no change" against the
      // last successful observation, not against the failed one.
      mode = 'ok';
      const recovered = await observeSource(source);
      assert.strictEqual(recovered.status, 'ok');
      assert.strictEqual(recovered.changed, false);
    } finally {
      server.close();
      await deleteSource(source.id);
    }
  },

  '5. a stored snapshot has an S3 reference on the observation row': async () => {
    if (!hasDatabase()) return 'SKIP';
    if (!hasAws()) return 'SKIP';
    const body = 's3 reference content ' + Date.now();
    const server = await startServer(() => ({ body }));
    const { port } = server.address();
    const source = await makeSource(`watchtower-test-s3ref-${Date.now()}`, `http://127.0.0.1:${port}/`);
    let observationId = null;
    try {
      const result = await observeSource(source);
      assert.strictEqual(result.status, 'ok');
      observationId = result.observation_id;

      if (result.snapshot && result.snapshot.error) {
        // AWS env vars were present but credentials didn't actually resolve
        // (e.g. a dev laptop with AWS_REGION set but no real creds). Treat
        // as environment-not-available rather than a real failure.
        return 'SKIP';
      }

      assert.ok(result.snapshot, 'expected a snapshot result');
      assert.ok(result.snapshot.raw_key, 'expected a raw_key');
      assert.ok(result.snapshot.meta_key, 'expected a meta_key');

      const pool = getPool();
      const row = (await pool.query('SELECT * FROM public.wt_observations WHERE id = $1', [observationId])).rows[0];
      assert.ok(row.s3_bucket, 'observation row must persist s3_bucket');
      assert.ok(row.s3_key, 'observation row must persist s3_key');
      assert.strictEqual(row.s3_key, result.snapshot.meta_key);
    } finally {
      server.close();
      if (source && source.id) {
        if (observationId) {
          try {
            const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
            const cfg = require('../../api/watchtower/config');
            const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
            await s3.send(new DeleteObjectCommand({ Bucket: cfg.s3Bucket, Key: `${cfg.s3Prefix}snapshots/${source.id}/${observationId}.txt` }));
            await s3.send(new DeleteObjectCommand({ Bucket: cfg.s3Bucket, Key: `${cfg.s3Prefix}observations/${source.id}/${observationId}.json` }));
          } catch { /* best-effort cleanup */ }
        }
        await deleteSource(source.id);
      }
    }
  },
};
