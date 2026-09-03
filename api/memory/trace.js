'use strict';

// api/memory/trace.js
// Increment 3, C7: reconstructs the full institutional-memory trail behind
// one completed Intelligence Console job, from the database and S3 alone --
// no re-running of any agent or retrieval. This is the acceptance surface
// for the whole increment: every hop the Advisor's answer rested on (memory,
// prior decisions, Watchtower signals and the source/observation/S3 snapshot
// each signal came from) plus every outcome later recorded against the job
// must be independently reconstructable here.
//
// Prophet assessments are deliberately absent: Prophet is stateless (see
// api/intelligence/agents/prophet.js) and never persists anything, so there
// is nothing about a Prophet call to reconstruct after the fact.

const { getIntelligenceJob } = require('../intelligence/jobs');
const { getSignalById, getObservationById } = require('./watchtower');
const { listOutcomes } = require('./outcomes');

async function buildSignalProvenance(memoryContextUsed) {
  const signals = (memoryContextUsed && Array.isArray(memoryContextUsed.recent_signals))
    ? memoryContextUsed.recent_signals
    : [];
  const provenance = [];
  for (const s of signals) {
    const signal = await getSignalById(s.id);
    if (!signal) {
      provenance.push({ signal_id: s.id, found: false });
      continue;
    }
    const observation = signal.observation_id ? await getObservationById(signal.observation_id) : null;
    const previousObservation = observation && observation.previous_observation_id
      ? await getObservationById(observation.previous_observation_id)
      : null;
    provenance.push({
      signal_id: signal.id,
      found: true,
      title: signal.title,
      summary: signal.summary,
      signal_type: signal.signal_type,
      confidence: signal.confidence,
      observed_at: signal.observed_at,
      source: {
        id: signal.source_id,
        name: signal.source_name,
        url: signal.source_url,
        type: signal.source_kind,
        credibility: signal.source_credibility,
      },
      observation: observation ? {
        id: observation.id,
        observed_at: observation.observed_at,
        changed: observation.changed,
        previous_observation_id: observation.previous_observation_id,
        s3_bucket: observation.s3_bucket,
        s3_key: observation.s3_key,
        raw_s3_key: observation.raw_s3_key,
      } : null,
      previous_observation: previousObservation ? {
        id: previousObservation.id,
        observed_at: previousObservation.observed_at,
        s3_bucket: previousObservation.s3_bucket,
        s3_key: previousObservation.s3_key,
        raw_s3_key: previousObservation.raw_s3_key,
      } : null,
    });
  }
  return provenance;
}

async function buildJobTrace(jobId) {
  const job = await getIntelligenceJob(jobId);
  if (!job) return null;

  const memoryContextUsed = job.memory_context_used || null;
  const [signalProvenance, outcomes] = await Promise.all([
    buildSignalProvenance(memoryContextUsed),
    listOutcomes(job.tenant_id || 'zenex', { jobId }),
  ]);

  return {
    job: {
      job_id: job.job_id,
      status: job.status,
      tenant_id: job.tenant_id,
      question: job.question,
      created_at: job.created_at,
      started_at: job.started_at,
      completed_at: job.completed_at,
      degraded: job.degraded,
      agents_used: job.agents_used,
    },
    memory_context_used: memoryContextUsed,
    signal_provenance: signalProvenance,
    outcomes,
  };
}

module.exports = { buildJobTrace };
