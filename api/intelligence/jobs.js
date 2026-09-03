'use strict';

// api/intelligence/jobs.js
// Asynchronous job layer for the Intelligence Console. POST creates a job and
// returns immediately; the orchestrator runs in the background on this
// process; the frontend polls GET /:jobId.
//
// PostgreSQL (public.intelligence_jobs) is the authoritative store: every
// state transition is written there, and getIntelligenceJob reads from it. A
// pm2 or API restart therefore does not orphan a job's result. A job left in
// 'running' past the stale threshold (process died mid-run) is recovered to
// 'failed' on read. No queue or worker infrastructure: the background run is
// an un-awaited async function, sufficient at current volume.

const crypto = require('crypto');
const { getPool } = require('../services/db');
const { getLiveCorpusData } = require('./live-data');
const { runIntelligence } = require('./orchestrator');
const { ORCHESTRATION } = require('./config');

const STALE_RUNNING_MS = 5 * 60 * 1000;
let schemaReady = null;

async function ensureSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const pool = getPool();
    if (!pool) throw new Error('Database is not configured; the Intelligence Console requires PostgreSQL for job state.');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.intelligence_jobs (
        id                UUID PRIMARY KEY,
        status            TEXT,
        question          TEXT,
        user_email        TEXT,
        user_role         TEXT,
        agents            JSONB,
        agent_results     JSONB,
        model_calls       INTEGER,
        telemetry         JSONB,
        degraded          BOOLEAN DEFAULT false,
        error             TEXT,
        answer            TEXT,
        answer_structured JSONB,
        live_data         JSONB,
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        started_at        TIMESTAMPTZ,
        completed_at      TIMESTAMPTZ
      )
    `);
    // Bring an older-shape table (from a prior deploy) up to date.
    for (const col of [
      'started_at TIMESTAMPTZ',
      'agent_results JSONB',
      'model_calls INTEGER',
      'live_data JSONB',
      'tenant_id TEXT',
      // Increment 3, C7: the exact institutional memory context (memory,
      // decisions, signals) the Advisor was actually given for this job, so
      // GET /trace/:jobId can reconstruct every hop without re-running
      // buildMemoryContext (which could return different rows by the time
      // someone reads the trace). NULL when MEMORY_CONTEXT_ENABLED was off
      // for the job's tenant, or the lookup failed -- same fail-open shape
      // as the memory context block itself.
      'memory_context_used JSONB',
    ]) {
      await pool.query(`ALTER TABLE public.intelligence_jobs ADD COLUMN IF NOT EXISTS ${col}`);
    }
    await pool.query('CREATE INDEX IF NOT EXISTS intelligence_jobs_created_at_idx ON public.intelligence_jobs (created_at DESC)');
    return true;
  })().catch(err => {
    schemaReady = null; // allow a later retry
    throw err;
  });
  return schemaReady;
}

async function update(id, fields) {
  const pool = getPool();
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const set = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  const values = keys.map(k => {
    const v = fields[k];
    return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
  });
  await pool.query(`UPDATE public.intelligence_jobs SET ${set} WHERE id = $1`, [id, ...values]);
}

function logJob(row) {
  console.log(JSON.stringify({
    evt: 'intelligence_job',
    job_id: row.id,
    status: row.status,
    degraded: Boolean(row.degraded),
    user: row.user_email,
    role: row.user_role,
    question_chars: (row.question || '').length,
    agents: (row.agents || []).map(a => ({ agent: a.agent, status: a.status, ms: a.execution_ms, rounds: a.rounds, tools: (a.tools_used || []).map(t => t.tool) })),
    model_calls: row.model_calls,
    tokens_total: row.telemetry ? row.telemetry.tokens_total : null,
    total_ms: row.telemetry ? row.telemetry.total_ms : null,
    error: row.error || null,
  }));
}

// Background runner. Kept separate from createIntelligenceJob so the route
// returns without waiting on the orchestrator.
async function executeJob(job) {
  let timedOut = false;
  const guard = setTimeout(async () => {
    timedOut = true;
    try {
      await update(job.id, {
        status: 'failed',
        error: `Orchestration exceeded ${ORCHESTRATION.total_timeout_ms} ms`,
        completed_at: new Date().toISOString(),
      });
      const row = await readRow(job.id);
      if (row) logJob(row);
    } catch (err) {
      console.error('intelligence job timeout write failed:', err.message);
    }
  }, ORCHESTRATION.total_timeout_ms);

  try {
    await update(job.id, { status: 'running', started_at: new Date().toISOString() });

    const pool = getPool();
    const liveData = pool ? await getLiveCorpusData(pool) : null;

    let memoryContextUsed = null;
    const result = await runIntelligence(job.question, liveData, {
      user: job.user_email,
      role: job.user_role,
      tenantId: job.tenant_id || 'zenex',
      onMemoryContext: ctx => { memoryContextUsed = ctx; },
    });
    if (timedOut) return;

    await update(job.id, {
      status: result.status,
      degraded: result.degraded,
      answer: result.answer,
      answer_structured: result.answer_structured,
      agents: result.agents,
      agent_results: result.agent_results,
      model_calls: result.telemetry ? result.telemetry.model_calls : null,
      telemetry: result.telemetry,
      live_data: liveData,
      memory_context_used: memoryContextUsed,
      error: result.status === 'failed' ? 'Synthesis agent failed' : null,
      completed_at: new Date().toISOString(),
    });
  } catch (err) {
    if (!timedOut) {
      await update(job.id, { status: 'failed', error: err.message, completed_at: new Date().toISOString() }).catch(e => console.error('job failure write failed:', e.message));
    }
  } finally {
    clearTimeout(guard);
    try {
      const row = await readRow(job.id);
      if (row) logJob(row);
    } catch { /* logging is best effort */ }
  }
}

async function readRow(id) {
  const pool = getPool();
  const res = await pool.query('SELECT * FROM public.intelligence_jobs WHERE id = $1', [id]);
  return res.rows[0] || null;
}

async function createIntelligenceJob({ question, userEmail, userRole, tenantId }) {
  await ensureSchema();
  const job = {
    id: crypto.randomUUID(),
    question: String(question).trim(),
    user_email: userEmail || null,
    user_role: userRole || null,
    tenant_id: tenantId || 'zenex',
  };
  const pool = getPool();
  await pool.query(
    `INSERT INTO public.intelligence_jobs (id, status, question, user_email, user_role, tenant_id, created_at)
     VALUES ($1, 'queued', $2, $3, $4, $5, NOW())`,
    [job.id, job.question, job.user_email, job.user_role, job.tenant_id],
  );

  executeJob(job).catch(err => {
    console.error('intelligence executeJob crashed:', err.message);
    update(job.id, { status: 'failed', error: `Unhandled: ${err.message}`, completed_at: new Date().toISOString() }).catch(() => {});
  });

  return { id: job.id, status: 'queued' };
}

function shapeRow(row) {
  const agents = Array.isArray(row.agents) ? row.agents : [];
  let status = row.status;
  if (status === 'running' && row.started_at && Date.now() - new Date(row.started_at).getTime() > STALE_RUNNING_MS) {
    status = 'failed';
  }
  return {
    job_id: row.id,
    status,
    degraded: Boolean(row.degraded),
    tenant_id: row.tenant_id || 'zenex',
    question: row.question,
    created_at: row.created_at,
    started_at: row.started_at || null,
    completed_at: row.completed_at || null,
    context: 'advisor',
    agents_used: agents.filter(a => a.status === 'ok' && a.agent !== 'advisor').map(a => a.agent),
    agents: agents.map(a => ({
      agent: a.agent,
      status: a.status,
      execution_ms: a.execution_ms,
      rounds: a.rounds ?? null,
      confidence: a.confidence || null,
      tools_used: (a.tools_used || []).map(t => t.tool),
      error: a.error || null,
    })),
    answer: status === 'completed' ? row.answer : null,
    answer_structured: status === 'completed' ? row.answer_structured : null,
    agent_results: status === 'completed' ? (row.agent_results || null) : null,
    live_data: status === 'completed' ? row.live_data : null,
    memory_context_used: status === 'completed' ? (row.memory_context_used || null) : null,
    telemetry: row.telemetry || null,
    model_calls: row.model_calls || null,
    error: status === 'failed' ? (row.error || 'Job did not complete') : null,
  };
}

async function getIntelligenceJob(id) {
  await ensureSchema();
  const row = await readRow(id);
  if (!row) return null;

  // Stale-running recovery, against PostgreSQL.
  if (row.status === 'running' && row.started_at && Date.now() - new Date(row.started_at).getTime() > STALE_RUNNING_MS) {
    await update(id, { status: 'failed', error: 'Job stalled: process did not finish it', completed_at: new Date().toISOString() }).catch(() => {});
    return shapeRow({ ...row, status: 'failed', error: 'Job stalled: process did not finish it' });
  }
  return shapeRow(row);
}

module.exports = { createIntelligenceJob, getIntelligenceJob };
