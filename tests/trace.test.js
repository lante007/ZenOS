'use strict';

// tests/trace.test.js — C7: the end-to-end acceptance test for Increment 3.
//
// Exercises the full loop this increment adds: Watchtower detects a change
// (a controlled source, observed twice) -> the change becomes a signal with
// a full source/observation/S3 provenance chain -> with MEMORY_CONTEXT_ENABLED
// on for a disposable test tenant, that signal is retrievable via
// buildMemoryContext -> a real Intelligence Console job runs end to end
// against the live Zenex corpus and the real Anthropic API, with the
// Advisor instructed to label every claim by source type (C3) -> Prophet
// produces a forward assessment from the signal, stateless as designed
// (C4) -> two outcomes are recorded against the job, the second an explicit
// revision of the first, and both persist as distinct append-only rows
// (C5) -> GET /api/intelligence/trace/:jobId's underlying buildJobTrace()
// reconstructs every one of those hops from the database and S3 alone.
//
// One place this test does not trust real-time production traffic: a live
// watchtower-worker process observes real due sources continuously against
// this same database, so the Advisor's default (limit 5) signal window at
// the exact moment the real job runs is not something this test can pin
// down deterministically. So: buildMemoryContext itself is proven
// separately, with a generous limit, to actually surface our controlled
// signal for the flagged tenant (the retrieval mechanism works); the real
// job is proven to complete end to end with the flag on; and the trace
// reconstruction is then proven against that same real job row with its
// memory_context_used pinned (by direct SQL — intelligence_jobs carries no
// append-only protection, unlike intelligence_outcomes) to reference our
// controlled signal. Every value the trace then reconstructs from that
// point on is otherwise entirely real: the real signal, the real
// observation, the real S3 snapshot keys, the real outcomes.
//
// Requires PostgreSQL, AWS (a real S3 snapshot) and a real Anthropic API
// key; skips cleanly without any of the three, matching the rest of this
// suite. This is the slowest test in the suite (several real Anthropic
// calls, one of them a full multi-agent orchestration run): allow several
// minutes.

const assert = require('assert');
const http = require('http');
const { hasDatabase, hasAws, hasAnthropic } = require('./helpers/env');

const QUESTION = 'What does our current programme evidence and any recent institutional signals suggest we should prioritise next?';

function startServer(getBody) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(getBody());
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function pollJob(getIntelligenceJob, jobId, { timeoutMs = 240000, intervalMs = 3000 } = {}) {
  const startedAt = Date.now();
  for (;;) {
    const job = await getIntelligenceJob(jobId);
    if (job && (job.status === 'completed' || job.status === 'failed')) return job;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`job ${jobId} did not finish within ${timeoutMs} ms (last status: ${job && job.status})`);
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

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
  'GET /api/intelligence/trace/:jobId reconstructs the full memory/signal/outcome trail behind a real job, from the database and S3 alone': async () => {
    if (!hasDatabase() || !hasAws() || !hasAnthropic()) return 'SKIP';

    const { getPool } = require('../api/services/db');
    const wt = require('../api/memory/watchtower');
    const { observeSource } = require('../api/watchtower/observe');
    const { buildMemoryContext } = require('../api/memory/context');
    const { createIntelligenceJob, getIntelligenceJob } = require('../api/intelligence');
    const { runProphetAgent } = require('../api/intelligence/agents/prophet');
    const { recordOutcome } = require('../api/memory/outcomes');
    const { buildJobTrace } = require('../api/memory/trace');
    const { _invalidateTenantCacheForTests } = require('../api/memory/util');

    const pool = getPool();
    const stamp = Date.now();
    const tenantSlug = `zztrace${stamp}`.slice(0, 20);

    let server, source, signalId, jobId;
    let outcomeOriginal, outcomeRevision;

    try {
      // 1. A controlled source, observed twice: baseline, then a real change.
      let body = `trace test v1 ${stamp}`;
      server = await startServer(() => body);
      const { port } = server.address();
      source = await wt.registerSource({
        name: `trace-test-${stamp}`,
        url: `http://127.0.0.1:${port}/`,
        source_type: 'funder',
        credibility: 'HIGH',
      });

      const baseline = await observeSource(source);
      assert.strictEqual(baseline.status, 'ok');
      assert.strictEqual(baseline.is_first, true);
      assert.strictEqual(baseline.signal_id, null);

      body = `trace test v2, changed ${stamp}`;
      const changed = await observeSource(source);
      assert.strictEqual(changed.status, 'ok');
      assert.strictEqual(changed.changed, true);
      assert.ok(changed.signal_id, 'expected a real content change to create a signal');
      signalId = changed.signal_id;

      if (changed.snapshot && changed.snapshot.error) return 'SKIP'; // AWS env present but creds didn't actually resolve

      const signalRow = await wt.getSignalById(signalId);
      assert.ok(signalRow, 'expected the newly created signal to be retrievable');
      assert.ok(signalRow.observation_id, 'expected the signal to reference the observation that produced it');
      const observationRow = await wt.getObservationById(signalRow.observation_id);
      assert.ok(observationRow, 'expected getObservationById to find the observation');
      assert.ok(observationRow.s3_bucket && observationRow.s3_key, 'expected a real S3 snapshot reference on the observation');

      // 2. A disposable tenant with MEMORY_CONTEXT_ENABLED on — never a real
      // tenant. Force the memory-layer tenant cache to see it immediately
      // instead of racing its TTL.
      await pool.query(
        `INSERT INTO master.tenants (slug, name, subdomain, db_schema, is_active, feature_flags)
         VALUES ($1, $2, $3, $1, true, '{"MEMORY_CONTEXT_ENABLED": true}'::jsonb)`,
        [tenantSlug, `Trace Test Tenant ${stamp}`, `${tenantSlug}.test.auxeira.com`],
      );
      _invalidateTenantCacheForTests();

      // 3. The flag-gated retrieval mechanism itself: with a generous limit
      // (the live watchtower-worker also writes to this same signals table),
      // our controlled signal must be retrievable for this tenant.
      const ctxCheck = await buildMemoryContext({ tenantId: tenantSlug, query: QUESTION, signalLimit: 200 });
      assert.ok(ctxCheck.recent_signals.some(s => s.id === signalId), 'expected buildMemoryContext to surface the controlled signal for the flagged tenant');

      // 4. A real Intelligence Console job, end to end: specialist agents
      // against the live Zenex corpus, then the Advisor, all via the real
      // Anthropic API.
      const corpusCountBefore = (await pool.query(`SELECT COUNT(*)::int AS n FROM zenex.intelligence_records WHERE tenant_id = 'zenex'`)).rows[0].n;

      const created = await createIntelligenceJob({
        question: QUESTION,
        userEmail: 'trace-test@auxeira.com',
        userRole: 'SUPER_ADMIN',
        tenantId: tenantSlug,
      });
      jobId = created.id;

      const job = await pollJob(getIntelligenceJob, jobId);
      assert.strictEqual(job.status, 'completed', `expected the job to complete (error: ${job.error})`);
      assert.ok(job.answer, 'expected a rendered answer');

      const corpusCountAfter = (await pool.query(`SELECT COUNT(*)::int AS n FROM zenex.intelligence_records WHERE tenant_id = 'zenex'`)).rows[0].n;
      assert.strictEqual(corpusCountAfter, corpusCountBefore, 'the Intelligence Console must never write to the Zenex evidence corpus');

      // Soft check only: the EVIDENCE/MEMORY/SIGNAL/INFERRED/RECOMMENDATION
      // labelling instructed in C3 is free-text model output, not a schema
      // field, so it is inherently non-deterministic — log, do not fail.
      if (!/\b(EVIDENCE|MEMORY|SIGNAL|INFERRED|RECOMMENDATION)\b/.test(job.answer)) {
        console.warn('[trace.test] Advisor answer did not visibly use the C3 source-type labels; not failing on model wording.');
      }

      // 5. Prophet: stateless, takes the signal, returns a structured
      // forward assessment. Nothing here is persisted — by design (C4) — so
      // it deliberately does not appear in the trace reconstruction below.
      const prophetResult = await runProphetAgent(signalRow);
      assert.strictEqual(prophetResult.status, 'ok', `expected Prophet to produce an assessment (error: ${prophetResult.error})`);

      // 6. Two outcomes against the job: an original, and an explicit
      // revision of it. Append-only: both must persist as distinct rows.
      outcomeOriginal = await recordOutcome(tenantSlug, {
        job_id: jobId,
        outcome_status: 'pending',
        decision_taken: 'Wait and confirm before acting on the signal.',
      });
      outcomeRevision = await recordOutcome(tenantSlug, {
        job_id: jobId,
        outcome_status: 'acted_on',
        decision_taken: 'Acted on the signal after confirming it independently.',
        signal_proved_reliable: true,
        original_outcome_id: outcomeOriginal.id,
      });

      // 7. Pin the job's persisted memory context to reference our
      // controlled signal deterministically, rather than trusting whatever
      // the live worker's concurrent writes left in the real job's
      // default-window (limit 5) memory context at the exact moment it ran.
      // This is a direct, test-only patch of a row this test itself owns;
      // every value referenced from it below is otherwise entirely real.
      const memoryContextUsed = {
        relevant_memory: ctxCheck.relevant_memory,
        relevant_decisions: ctxCheck.relevant_decisions,
        recent_signals: [{ id: signalId }],
      };
      await pool.query('UPDATE public.intelligence_jobs SET memory_context_used = $2 WHERE id = $1', [jobId, JSON.stringify(memoryContextUsed)]);

      // 8. The acceptance criterion itself: every hop reconstructable from
      // the database and S3 alone.
      const trace = await buildJobTrace(jobId);
      assert.ok(trace, 'expected a trace for the completed job');
      assert.strictEqual(trace.job.job_id, jobId);
      assert.strictEqual(trace.job.status, 'completed');
      assert.strictEqual(trace.job.tenant_id, tenantSlug);

      assert.ok(trace.memory_context_used, 'expected the persisted memory context to come back in the trace');
      assert.deepStrictEqual(trace.memory_context_used.recent_signals, [{ id: signalId }]);

      assert.strictEqual(trace.signal_provenance.length, 1);
      const prov = trace.signal_provenance[0];
      assert.strictEqual(prov.signal_id, signalId);
      assert.strictEqual(prov.found, true);
      assert.strictEqual(prov.source.id, source.id);
      assert.strictEqual(prov.source.name, source.name);
      assert.strictEqual(prov.source.url, source.url);
      assert.strictEqual(prov.source.credibility, 'HIGH');
      assert.ok(prov.observation, 'expected the signal-producing observation to be reconstructed');
      assert.strictEqual(prov.observation.id, signalRow.observation_id);
      assert.strictEqual(prov.observation.changed, true);
      assert.strictEqual(prov.observation.s3_bucket, observationRow.s3_bucket);
      assert.strictEqual(prov.observation.s3_key, observationRow.s3_key);
      assert.ok(prov.previous_observation, 'expected the baseline observation this signal changed from to be reconstructed');
      assert.strictEqual(prov.previous_observation.id, baseline.observation_id);

      assert.strictEqual(trace.outcomes.length, 2);
      const outIds = trace.outcomes.map(o => o.id).sort();
      assert.deepStrictEqual(outIds, [outcomeOriginal.id, outcomeRevision.id].sort());
      const revisionInTrace = trace.outcomes.find(o => o.id === outcomeRevision.id);
      assert.strictEqual(revisionInTrace.original_outcome_id, outcomeOriginal.id);
      const originalInTrace = trace.outcomes.find(o => o.id === outcomeOriginal.id);
      assert.strictEqual(originalInTrace.original_outcome_id, null);
    } finally {
      if (server) server.close();
      if (outcomeRevision) await deleteOutcome(pool, outcomeRevision.id).catch(() => {});
      if (outcomeOriginal) await deleteOutcome(pool, outcomeOriginal.id).catch(() => {});
      if (jobId) await pool.query('DELETE FROM public.intelligence_jobs WHERE id = $1', [jobId]).catch(() => {});
      if (source && source.id) await pool.query('DELETE FROM public.wt_sources WHERE id = $1', [source.id]).catch(() => {});
      await pool.query('DELETE FROM master.tenants WHERE slug = $1', [tenantSlug]).catch(() => {});
    }
  },

  'buildJobTrace returns null for an unknown job id': async () => {
    if (!hasDatabase()) return 'SKIP';
    const { buildJobTrace } = require('../api/memory/trace');
    const trace = await buildJobTrace('00000000-0000-0000-0000-000000000000');
    assert.strictEqual(trace, null);
  },
};
