'use strict';

// api/routes/memory.js
// Additive V1.1 surface: persistent memory, decisions, outcomes, Watchtower
// sources and signals, and the intelligence graph. Admin-console only
// (mounted behind authenticate(); in-route founder-role guard, same pattern
// as the intelligence route). Nothing here touches /api/intelligence/ask,
// the job runner, the agents, or any Zenex-facing route.
//
// The admin console acts on behalf of a tenant: the target tenant comes from
// ?tenant= or the x-evidenceos-target-tenant header, defaulting to zenex.
// Every service call validates it against master.tenants.
//
// Grok intelligence directive: the /scouts/* routes below are the only
// admin-triggered entry point for a scout run. A run requires the tenant's
// EXTERNAL_INTELLIGENCE_ENABLED / INNOVATION_SCOUT_ENABLED flag (checked
// inside runAndPersistExternalIntelligence/runAndPersistInnovation,
// fail-closed); this route does not duplicate that check, it only forwards
// the guard-checked target tenant.

const express = require('express');
const { requireRoles } = require('../middleware/permissions');
const M = require('../memory');
const scoutsStore = require('../intelligence/scouts/store');
const { runAndPersistExternalIntelligence, runAndPersistInnovation } = require('../intelligence/scouts');

const router = express.Router();
const GUARD = requireRoles('SUPER_ADMIN', 'AUXEIRA_FOUNDER');

function targetTenant(req) {
  return String(req.query.tenant || req.headers['x-evidenceos-target-tenant'] || 'zenex').toLowerCase();
}
function fail(res, err) {
  const status = err && err.status ? err.status : 500;
  if (status >= 500) console.error('memory route error:', err);
  return res.status(status).json({ success: false, error: err.message || 'Request failed' });
}
const ok = (res, data, code = 200) => res.status(code).json({ success: true, data });

// ── memory ───────────────────────────────────────────
router.get('/', GUARD, async (req, res) => {
  try {
    ok(res, await M.listMemories(targetTenant(req), {
      memoryTypes: req.query.type ? String(req.query.type).split(',') : null,
      statuses: req.query.status ? String(req.query.status).split(',') : null,
      limit: req.query.limit,
    }));
  } catch (e) { fail(res, e); }
});

router.get('/search', GUARD, async (req, res) => {
  try {
    ok(res, await M.getRelevantMemory({
      tenantId: targetTenant(req),
      query: req.query.q,
      limit: req.query.limit,
      memoryTypes: req.query.type ? String(req.query.type).split(',') : null,
      includeDormant: req.query.dormant !== 'false',
      includeHistorical: req.query.historical === 'true',
    }));
  } catch (e) { fail(res, e); }
});

router.post('/', GUARD, async (req, res) => {
  try { ok(res, await M.createMemory(targetTenant(req), req.body || {}), 201); } catch (e) { fail(res, e); }
});

router.get('/:id', GUARD, async (req, res) => {
  try {
    const m = await M.getMemory(targetTenant(req), req.params.id);
    if (!m) return res.status(404).json({ success: false, error: 'Not found' });
    ok(res, m);
  } catch (e) { fail(res, e); }
});

router.patch('/:id/status', GUARD, async (req, res) => {
  try {
    const m = await M.setMemoryStatus(targetTenant(req), req.params.id, (req.body || {}).status);
    if (!m) return res.status(404).json({ success: false, error: 'Not found' });
    ok(res, m);
  } catch (e) { fail(res, e); }
});

router.post('/sweep', GUARD, async (req, res) => {
  try { ok(res, await M.sweepMemoryStates(targetTenant(req))); } catch (e) { fail(res, e); }
});

// ── decisions ────────────────────────────────────────
router.get('/decisions', GUARD, async (req, res) => {
  try {
    ok(res, await M.listDecisions(targetTenant(req), {
      statuses: req.query.status ? String(req.query.status).split(',') : null,
      limit: req.query.limit,
    }));
  } catch (e) { fail(res, e); }
});
router.post('/decisions', GUARD, async (req, res) => {
  try { ok(res, await M.createDecision(targetTenant(req), req.body || {}), 201); } catch (e) { fail(res, e); }
});
router.get('/decisions/:id', GUARD, async (req, res) => {
  try {
    const d = await M.getDecision(targetTenant(req), req.params.id);
    if (!d) return res.status(404).json({ success: false, error: 'Not found' });
    ok(res, d);
  } catch (e) { fail(res, e); }
});
// Match a supplied signal (or a raw {title,summary,change_description,entities})
// against decision revisit_conditions. Read-only: recommends, never changes.
router.post('/decisions/review-check', GUARD, async (req, res) => {
  try { ok(res, await M.matchDecisionsForSignal(targetTenant(req), req.body || {})); } catch (e) { fail(res, e); }
});
router.post('/decisions/:id/recommend-review', GUARD, async (req, res) => {
  try {
    const r = await M.recommendReview(targetTenant(req), req.params.id, (req.body || {}).signal_id, (req.body || {}).note);
    if (!r) return res.status(404).json({ success: false, error: 'Not found' });
    ok(res, r);
  } catch (e) { fail(res, e); }
});

// ── outcomes (feedback loop) ─────────────────────────
router.get('/outcomes', GUARD, async (req, res) => {
  try { ok(res, await M.listOutcomes(targetTenant(req), { limit: req.query.limit, jobId: req.query.job_id })); } catch (e) { fail(res, e); }
});
router.post('/outcomes', GUARD, async (req, res) => {
  try { ok(res, await M.recordOutcome(targetTenant(req), req.body || {}), 201); } catch (e) { fail(res, e); }
});
router.get('/outcomes/reliability', GUARD, async (req, res) => {
  try { ok(res, await M.sourceReliabilityStats(targetTenant(req))); } catch (e) { fail(res, e); }
});

// ── watchtower: sources ──────────────────────────────
router.get('/sources', GUARD, async (req, res) => {
  try { ok(res, await M.watchtower.listSources({ tenantId: targetTenant(req), includeGlobal: req.query.global !== 'false', limit: req.query.limit })); } catch (e) { fail(res, e); }
});
router.post('/sources', GUARD, async (req, res) => {
  try { ok(res, await M.watchtower.registerSource(req.body || {}), 201); } catch (e) { fail(res, e); }
});
router.patch('/sources/:id', GUARD, async (req, res) => {
  try {
    const s = await M.watchtower.updateSource(req.params.id, req.body || {});
    if (!s) return res.status(404).json({ success: false, error: 'Not found' });
    ok(res, s);
  } catch (e) { fail(res, e); }
});

// ── watchtower: signals ──────────────────────────────
router.get('/signals', GUARD, async (req, res) => {
  try { ok(res, await M.watchtower.listTenantSignals(targetTenant(req), { limit: req.query.limit })); } catch (e) { fail(res, e); }
});
// Manual signal entry, useful before the Observation Worker exists.
router.post('/signals', GUARD, async (req, res) => {
  try { ok(res, await M.watchtower.createSignal(req.body || {}), 201); } catch (e) { fail(res, e); }
});
router.patch('/signals/:id/relevance', GUARD, async (req, res) => {
  try { ok(res, await M.watchtower.upsertTenantSignalRelevance(targetTenant(req), req.params.id, req.body || {})); } catch (e) { fail(res, e); }
});

// ── graph ────────────────────────────────────────────
router.post('/entities', GUARD, async (req, res) => {
  try { ok(res, await M.graph.upsertEntity(req.body || {}), 201); } catch (e) { fail(res, e); }
});
router.post('/links', GUARD, async (req, res) => {
  try { ok(res, await M.graph.link(targetTenant(req), req.body || {}), 201); } catch (e) { fail(res, e); }
});
router.get('/graph/:type/:id/neighbours', GUARD, async (req, res) => {
  try { ok(res, await M.graph.neighbours(targetTenant(req), req.params.type, req.params.id, { limit: req.query.limit })); } catch (e) { fail(res, e); }
});

// ── scouts: external intelligence ────────────────────
// Full-audit read (every qa_status, including REJECTED/NEEDS_REVIEW) --
// this is the admin cockpit's QA visibility view, distinct from the
// Advisor's surfaceable-only read in api/intelligence/scouts/context.js.
router.get('/scouts/external', GUARD, async (req, res) => {
  try {
    ok(res, await scoutsStore.listExternalIntelligence({
      tenantId: targetTenant(req),
      limit: req.query.limit,
      statuses: req.query.status ? String(req.query.status).split(',') : null,
    }));
  } catch (e) { fail(res, e); }
});
router.post('/scouts/external/run', GUARD, async (req, res) => {
  try {
    const body = req.body || {};
    const result = await runAndPersistExternalIntelligence({
      tenantId: targetTenant(req),
      query: body.query,
      category: body.category,
      limit: body.limit,
    });
    ok(res, result, result.ok ? 201 : 200);
  } catch (e) { fail(res, e); }
});

// ── scouts: innovation ───────────────────────────────
router.get('/scouts/innovation', GUARD, async (req, res) => {
  try {
    ok(res, await scoutsStore.listInnovationCandidates({
      tenantId: targetTenant(req),
      limit: req.query.limit,
      statuses: req.query.status ? String(req.query.status).split(',') : null,
    }));
  } catch (e) { fail(res, e); }
});
router.post('/scouts/innovation/run', GUARD, async (req, res) => {
  try {
    const body = req.body || {};
    const result = await runAndPersistInnovation({
      tenantId: targetTenant(req),
      context: body.context,
      constraints: body.constraints,
      limit: body.limit,
    });
    ok(res, result, result.ok ? 201 : 200);
  } catch (e) { fail(res, e); }
});
// Human decision on a speculative candidate. The ONLY mutable fields on
// innovation_candidates beyond superseded_by -- qa_status/qa_notes/
// provenance_chain remain immutable (DB trigger), enforced independently of
// this route.
router.patch('/scouts/innovation/:id/decision', GUARD, async (req, res) => {
  try {
    const body = req.body || {};
    const row = await scoutsStore.setInnovationDecisionStatus({
      tenantId: targetTenant(req),
      id: req.params.id,
      decisionStatus: body.decision_status,
      decisionNotes: body.decision_notes,
      decisionBy: (req.user && req.user.email) || body.decision_by,
    });
    ok(res, row);
  } catch (e) { fail(res, e); }
});

module.exports = router;
