'use strict';

// api/intelligence/scouts/store.js
// Persistence for external intelligence and innovation candidates. Every
// function requires an explicit tenantId, resolved via the same
// resolveTenant() used throughout the V1.1 memory/watchtower layer -- no
// new tenant-resolution logic, no unscoped/all-tenants query anywhere in
// this file (grok_intelligence_directive checkpoint 4).
//
// qa_status is set exactly once, by the QA gate, before a row is ever
// inserted -- there is no PENDING state in this schema (migration 026's
// CHECK constraint does not allow it) and no function here ever updates
// qa_status/qa_notes/provenance_chain after insert; the database's
// enforce_qa_immutability trigger rejects any attempt to do so at the SQL
// level, independent of this file. Corrections go through
// original_item_id / superseded_by instead of a mutation.
//
// listSurfaceable* functions filter to the QA-accepted subset with the
// filter IN the SQL WHERE clause, not a post-query JS filter: a REJECTED or
// NEEDS_REVIEW row is never fetched from the database by these functions in
// the first place.

const { resolveTenant, clampLimit } = require('../../memory/util');
const { getPool } = require('../../services/db');
const { ensureScoutSchema } = require('./schema');

const EXTERNAL_ALLOWED_STATUSES = ['VERIFIED', 'QUALIFIED', 'NEEDS_REVIEW', 'REJECTED'];
const INNOVATION_ALLOWED_STATUSES = ['SPECULATIVE', 'NEEDS_REVIEW', 'REJECTED'];
const DECISION_STATUSES = ['unreviewed', 'exploring', 'accepted', 'rejected', 'deferred'];
const REQUIRED_PROVENANCE_STAGES = ['grok_generation', 'claude_qa', 'system_ingestion'];

async function runQuery(text, params) {
  await ensureScoutSchema();
  const pool = getPool();
  if (!pool) throw new Error('Database is not configured');
  return pool.query(text, params);
}

// Application-level guarantee, redundant with (not a substitute for) the
// database's own jsonb_array_length >= 3 CHECK constraint: every persisted
// item must carry all three provenance stages, by name, before it ever
// reaches an INSERT statement.
function validateProvenanceChain(chain) {
  if (!Array.isArray(chain) || chain.length < 3) {
    throw Object.assign(new Error('provenance_chain must be an array with at least 3 entries'), { status: 400 });
  }
  const stages = chain.map(e => e && e.stage);
  for (const required of REQUIRED_PROVENANCE_STAGES) {
    if (!stages.includes(required)) {
      throw Object.assign(new Error(`provenance_chain is missing required stage "${required}"`), { status: 400 });
    }
  }
}

async function insertExternalIntelligence({ tenantId, category, claim, source_url, qa_status, qa_notes, provenance_chain, query_context, original_item_id = null }) {
  const tid = await resolveTenant(tenantId);
  if (!EXTERNAL_ALLOWED_STATUSES.includes(qa_status)) {
    throw Object.assign(new Error(`Invalid qa_status for external intelligence: ${qa_status}`), { status: 400 });
  }
  if (!claim || !source_url) {
    throw Object.assign(new Error('claim and source_url are required'), { status: 400 });
  }
  validateProvenanceChain(provenance_chain);

  const { rows } = await runQuery(
    `INSERT INTO external_intelligence
       (tenant_id, category, claim, source_url, qa_status, qa_notes, provenance_chain, query_context, original_item_id, qa_completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9, now())
     RETURNING *`,
    [tid, category || 'other', claim, source_url, qa_status, qa_notes || null, JSON.stringify(provenance_chain), query_context || null, original_item_id],
  );
  return rows[0];
}

async function insertInnovationCandidate({ tenantId, idea, rationale, context_summary, qa_status, qa_notes, provenance_chain, context_hash, original_item_id = null }) {
  const tid = await resolveTenant(tenantId);
  if (!INNOVATION_ALLOWED_STATUSES.includes(qa_status)) {
    throw Object.assign(new Error(`Invalid qa_status for innovation candidate: ${qa_status}`), { status: 400 });
  }
  if (!idea || !rationale) {
    throw Object.assign(new Error('idea and rationale are required'), { status: 400 });
  }
  validateProvenanceChain(provenance_chain);

  const { rows } = await runQuery(
    `INSERT INTO innovation_candidates
       (tenant_id, idea, rationale, context_summary, qa_status, qa_notes, provenance_chain, context_hash, original_item_id, qa_completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9, now())
     RETURNING *`,
    [tid, idea, rationale, context_summary || '', qa_status, qa_notes || null, JSON.stringify(provenance_chain), context_hash || null, original_item_id],
  );
  return rows[0];
}

// Surfaceable = eligible for Advisor context injection. Hard-filtered in
// SQL to VERIFIED/QUALIFIED, excludes anything already superseded by a
// correction.
async function listSurfaceableExternalIntelligence({ tenantId, limit = 5 }) {
  const tid = await resolveTenant(tenantId);
  const { rows } = await runQuery(
    `SELECT id, category, claim, source_url, qa_status, qa_notes, created_at
       FROM external_intelligence
      WHERE tenant_id = $1
        AND qa_status IN ('VERIFIED', 'QUALIFIED')
        AND superseded_by IS NULL
      ORDER BY created_at DESC
      LIMIT $2`,
    [tid, clampLimit(limit, 5, 20)],
  );
  return rows;
}

// Surfaceable = eligible for Advisor context injection. Hard-filtered in
// SQL to SPECULATIVE (the only accepted status an innovation candidate can
// ever hold), excludes anything already superseded by a correction.
async function listSurfaceableInnovationCandidates({ tenantId, limit = 5 }) {
  const tid = await resolveTenant(tenantId);
  const { rows } = await runQuery(
    `SELECT id, idea, rationale, decision_status, qa_status, created_at
       FROM innovation_candidates
      WHERE tenant_id = $1
        AND qa_status = 'SPECULATIVE'
        AND superseded_by IS NULL
      ORDER BY created_at DESC
      LIMIT $2`,
    [tid, clampLimit(limit, 5, 20)],
  );
  return rows;
}

// Full-audit reads (admin console only): every status, optionally filtered.
// Never used by the Advisor context path.
async function listExternalIntelligence({ tenantId, limit = 25, statuses = null }) {
  const tid = await resolveTenant(tenantId);
  const lim = clampLimit(limit, 25, 200);
  const params = [tid];
  let statusClause = '';
  if (Array.isArray(statuses) && statuses.length) {
    const valid = statuses.filter(s => EXTERNAL_ALLOWED_STATUSES.includes(s));
    if (valid.length) {
      params.push(valid);
      statusClause = `AND qa_status = ANY($${params.length})`;
    }
  }
  params.push(lim);
  const { rows } = await runQuery(
    `SELECT * FROM external_intelligence WHERE tenant_id = $1 ${statusClause} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows;
}

async function listInnovationCandidates({ tenantId, limit = 25, statuses = null }) {
  const tid = await resolveTenant(tenantId);
  const lim = clampLimit(limit, 25, 200);
  const params = [tid];
  let statusClause = '';
  if (Array.isArray(statuses) && statuses.length) {
    const valid = statuses.filter(s => INNOVATION_ALLOWED_STATUSES.includes(s));
    if (valid.length) {
      params.push(valid);
      statusClause = `AND qa_status = ANY($${params.length})`;
    }
  }
  params.push(lim);
  const { rows } = await runQuery(
    `SELECT * FROM innovation_candidates WHERE tenant_id = $1 ${statusClause} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows;
}

// The only mutation ever applied to a QA'd row's non-audit fields on
// innovation_candidates. qa_status/qa_notes/provenance_chain are untouched
// and untouchable (DB trigger); this updates human judgement only.
async function setInnovationDecisionStatus({ tenantId, id, decisionStatus, decisionNotes, decisionBy }) {
  const tid = await resolveTenant(tenantId);
  if (!DECISION_STATUSES.includes(decisionStatus)) {
    throw Object.assign(new Error(`Invalid decision_status: ${decisionStatus}`), { status: 400 });
  }
  const { rows } = await runQuery(
    `UPDATE innovation_candidates
        SET decision_status = $1, decision_notes = $2, decision_by = $3, decision_at = now()
      WHERE id = $4 AND tenant_id = $5
      RETURNING *`,
    [decisionStatus, decisionNotes || null, decisionBy || null, id, tid],
  );
  if (!rows[0]) throw Object.assign(new Error('Not found'), { status: 404 });
  return rows[0];
}

// Correction path: after inserting a new row with original_item_id set to
// the row it supersedes, this points the original at the correction. The
// only mutation ever applied to an external_intelligence/innovation_candidates
// row's QA-adjacent identity beyond decision fields above.
async function markSuperseded({ tenantId, kind, originalId, newId }) {
  const tid = await resolveTenant(tenantId);
  const table = kind === 'EXTERNAL' ? 'external_intelligence' : kind === 'INNOVATION' ? 'innovation_candidates' : null;
  if (!table) throw new Error(`markSuperseded: unknown kind "${kind}"`);
  const { rows } = await runQuery(
    `UPDATE ${table} SET superseded_by = $1 WHERE id = $2 AND tenant_id = $3 RETURNING *`,
    [newId, originalId, tid],
  );
  if (!rows[0]) throw Object.assign(new Error('Not found'), { status: 404 });
  return rows[0];
}

module.exports = {
  insertExternalIntelligence,
  insertInnovationCandidate,
  listSurfaceableExternalIntelligence,
  listSurfaceableInnovationCandidates,
  listExternalIntelligence,
  listInnovationCandidates,
  setInnovationDecisionStatus,
  markSuperseded,
  validateProvenanceChain,
  EXTERNAL_ALLOWED_STATUSES,
  INNOVATION_ALLOWED_STATUSES,
  DECISION_STATUSES,
};
