'use strict';

// api/intelligence/jobs.js
// Asynchronous job layer for the Intelligence Console. POST creates a job and
// returns immediately; the orchestrator runs in the background; the frontend
// polls GET /:jobId. Jobs live in an in-memory map (single pm2 fork process)
// and are best-effort mirrored to public.intelligence_jobs for observability
// and so a completed result survives a process restart.
//
// No queue or worker infrastructure: the background run is just an un-awaited
// async function on the same process, which is sufficient at current volume.

const crypto = require('crypto');
const { getPool } = require('../services/db');
const { getLiveCorpusData } = require('./live-data');
const { runIntelligence } = require('./orchestrator');
const { ORCHESTRATION } = require('./config');

const JOBS = new Map();
const STALE_RUNNING_MS = 5 * 60 * 1000;
let schemaReady = null;

async function ensureTable() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const pool = getPool();
    if (!pool) return false;
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS public.intelligence_jobs (
          id             UUID PRIMARY KEY,
          question       TEXT,
          user_email     TEXT,
          user_role      TEXT,
          status         TEXT,
          degraded       BOOLEAN DEFAULT false,
          agents         JSONB,
          telemetry      JSONB,
          answer         TEXT,
          answer_structured JSONB,
          error          TEXT,
          created_at     TIMESTAMPTZ DEFAULT NOW(),
          completed_at   TIMESTAMPTZ
        )
      `);
      return true;
    } catch (err) {
      console.error('intelligence_jobs table unavailable, running memory-only:', err.message);
      return false;
    }
  })();
  return schemaReady;
}

async function persist(job) {
  try {
    if (!(await ensureTable())) return;
    const pool = getPool();
    await pool.query(`
      INSERT INTO public.intelligence_jobs
        (id, question, user_email, user_role, status, degraded, agents, telemetry, answer, answer_structured, error, created_at, completed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        degraded = EXCLUDED.degraded,
        agents = EXCLUDED.agents,
        telemetry = EXCLUDED.telemetry,
        answer = EXCLUDED.answer,
        answer_structured = EXCLUDED.answer_structured,
        error = EXCLUDED.error,
        completed_at = EXCLUDED.completed_at
    `, [
      job.id, job.question, job.user_email || null, job.user_role || null,
      job.status, Boolean(job.degraded),
      JSON.stringify(job.agents || null), JSON.stringify(job.telemetry || null),
      job.answer || null, JSON.stringify(job.answer_structured || null),
      job.error || null,
      job.created_at, job.completed_at || null,
    ]);
  } catch (err) {
    console.error('intelligence_jobs persist failed:', err.message);
  }
}

function logJob(job) {
  console.log(JSON.stringify({
    evt: 'intelligence_job',
    job_id: job.id,
    status: job.status,
    degraded: Boolean(job.degraded),
    user: job.user_email,
    role: job.user_role,
    question_chars: (job.question || '').length,
    agents: (job.agents || []).map(a => ({ agent: a.agent, status: a.status, ms: a.execution_ms, tools: (a.tools_used || []).map(t => t.tool) })),
    model_calls: job.telemetry ? job.telemetry.model_calls : null,
    tokens_total: job.telemetry ? job.telemetry.tokens_total : null,
    total_ms: job.telemetry ? job.telemetry.total_ms : null,
    error: job.error || null,
  }));
}

async function runJob(job) {
  job.status = 'running';
  job.started_at = new Date().toISOString();
  await persist(job);

  const guard = setTimeout(() => {
    if (job.status === 'running') {
      job.status = 'failed';
      job.error = `Orchestration exceeded ${ORCHESTRATION.total_timeout_ms} ms`;
      job.completed_at = new Date().toISOString();
      persist(job);
      logJob(job);
    }
  }, ORCHESTRATION.total_timeout_ms);

  try {
    const pool = getPool();
    job.live_data = pool ? await getLiveCorpusData(pool) : null;

    const result = await runIntelligence(job.question, job.live_data, {
      user: job.user_email,
      role: job.user_role,
    });

    if (job.status === 'failed') return; // guard already fired

    job.status = result.status; // 'completed' | 'failed'
    job.degraded = result.degraded;
    job.answer = result.answer;
    job.answer_structured = result.answer_structured;
    job.agents = result.agents;
    job.telemetry = result.telemetry;
    job.context = result.context;
    job.agents_used = result.agents_used;
    job.error = result.status === 'failed' ? 'Synthesis agent failed' : null;
  } catch (err) {
    job.status = 'failed';
    job.error = err.message;
  } finally {
    clearTimeout(guard);
    job.completed_at = new Date().toISOString();
    await persist(job);
    logJob(job);
    setTimeout(() => JOBS.delete(job.id), ORCHESTRATION.job_retention_ms).unref?.();
  }
}

function createIntelligenceJob({ question, userEmail, userRole }) {
  const job = {
    id: crypto.randomUUID(),
    question: String(question).trim(),
    user_email: userEmail || null,
    user_role: userRole || null,
    status: 'queued',
    degraded: false,
    created_at: new Date().toISOString(),
  };
  JOBS.set(job.id, job);
  // Fire and forget: background run on this process.
  runJob(job).catch(err => {
    job.status = 'failed';
    job.error = `Unhandled: ${err.message}`;
    job.completed_at = new Date().toISOString();
    persist(job);
  });
  return job;
}

function publicView(job) {
  if (!job) return null;
  return {
    job_id: job.id,
    status: job.status,
    degraded: Boolean(job.degraded),
    question: job.question,
    created_at: job.created_at,
    completed_at: job.completed_at || null,
    context: job.context || null,
    agents_used: job.agents_used || [],
    agents: (job.agents || []).map(a => ({
      agent: a.agent,
      status: a.status,
      execution_ms: a.execution_ms,
      confidence: a.confidence || null,
      tools_used: (a.tools_used || []).map(t => t.tool),
      error: a.error || null,
    })),
    answer: job.status === 'completed' ? job.answer : null,
    answer_structured: job.status === 'completed' ? job.answer_structured : null,
    live_data: job.live_data || null,
    telemetry: job.telemetry || null,
    error: job.error || null,
  };
}

async function getIntelligenceJob(id) {
  const mem = JOBS.get(id);
  if (mem) return publicView(mem);

  try {
    if (!(await ensureTable())) return null;
    const pool = getPool();
    const res = await pool.query('SELECT * FROM public.intelligence_jobs WHERE id = $1', [id]);
    const row = res.rows[0];
    if (!row) return null;
    let status = row.status;
    if (status === 'running' && Date.now() - new Date(row.created_at).getTime() > STALE_RUNNING_MS) {
      status = 'failed';
    }
    return {
      job_id: row.id,
      status,
      degraded: row.degraded,
      question: row.question,
      created_at: row.created_at,
      completed_at: row.completed_at,
      context: 'advisor',
      agents_used: (row.agents || []).filter(a => a.status === 'ok').map(a => a.agent),
      agents: (row.agents || []).map(a => ({
        agent: a.agent, status: a.status, execution_ms: a.execution_ms,
        confidence: a.confidence || null, tools_used: (a.tools_used || []).map(t => t.tool), error: a.error || null,
      })),
      answer: status === 'completed' ? row.answer : null,
      answer_structured: status === 'completed' ? row.answer_structured : null,
      live_data: null,
      telemetry: row.telemetry || null,
      error: status === 'failed' && !row.error ? 'Job did not complete' : row.error,
    };
  } catch (err) {
    console.error('getIntelligenceJob DB read failed:', err.message);
    return null;
  }
}

module.exports = { createIntelligenceJob, getIntelligenceJob };
