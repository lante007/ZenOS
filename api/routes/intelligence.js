'use strict';

// api/routes/intelligence.js
// Intelligence Console front door. Asynchronous job model:
//   POST /api/intelligence      -> create job, return { job_id, status } (202)
//   GET  /api/intelligence/:id  -> poll job status / result
// (/ask and /ask/:id are kept as aliases for the existing frontend.)
//
// Admin console only. Mounted in server.js behind authenticate(); the
// in-route guard restricts to the founder roles, same pattern as admin-ask.js.
// No inline authenticate() here: the mount already authenticates.

const express = require('express');
const { requireRoles } = require('../middleware/permissions');
const { createIntelligenceJob, getIntelligenceJob } = require('../intelligence');
const { getSignalById } = require('../memory/watchtower');
const { runProphetAgent } = require('../intelligence/agents/prophet');
const { recordOutcome, listOutcomes } = require('../memory/outcomes');
const { buildJobTrace } = require('../memory/trace');
const { getAuthorisedTenants, isAdminRole } = require('../services/tenants');

const router = express.Router();

const GUARD = requireRoles('SUPER_ADMIN', 'AUXEIRA_FOUNDER');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Resolves the tenant scope a request is allowed to run under. This is the
// single point of authorisation for the whole Intelligence Console: it never
// trusts a tenant ID or "all tenants" request from the browser on its own —
// it only ever narrows what getAuthorisedTenants() already returned for the
// authenticated user.
//
//   - Not authorised for anything -> null (caller responds 403).
//   - Non-admin role              -> forced to mode 'tenant', their own
//                                    tenant only, regardless of what the
//                                    request body asks for.
//   - Admin role, body asks for
//     tenantMode: 'all'           -> mode 'all' over every authorised tenant.
//   - Admin role, otherwise       -> mode 'tenant'; the requested tenantId if
//                                    (and only if) it is in the authorised
//                                    set, else 'zenex' if authorised (the
//                                    unchanged V1/V1.1 default), else the
//                                    first authorised tenant.
async function resolveTenantScope(user, body) {
  const authorised = await getAuthorisedTenants(user);
  if (!authorised.length) return null;

  const authorisedSlugs = new Set(authorised.map(t => t.slug));
  const admin = isAdminRole(user && user.role);

  if (!admin) {
    const own = authorised[0];
    return { mode: 'tenant', tenant_id: own.slug, tenant_ids: null, tenants: [own] };
  }

  const requestedMode = body && body.tenantMode;
  if (requestedMode === 'all') {
    return { mode: 'all', tenant_id: null, tenant_ids: authorised.map(t => t.slug), tenants: authorised };
  }

  const requestedId = body && typeof body.tenantId === 'string' && body.tenantId.trim()
    ? body.tenantId.trim()
    : null;
  const targetSlug = requestedId && authorisedSlugs.has(requestedId)
    ? requestedId
    : (authorisedSlugs.has('zenex') ? 'zenex' : authorised[0].slug);
  const targetTenant = authorised.find(t => t.slug === targetSlug) || authorised[0];
  return { mode: 'tenant', tenant_id: targetTenant.slug, tenant_ids: null, tenants: [targetTenant] };
}

router.post(['/', '/ask'], GUARD, async (req, res) => {
  const { question } = req.body || {};
  if (!question || typeof question !== 'string' || question.trim().length === 0) {
    return res.status(400).json({ success: false, error: 'Question is required.' });
  }

  try {
    const scope = await resolveTenantScope(req.user, req.body || {});
    if (!scope) {
      return res.status(403).json({ success: false, error: 'No authorised tenant for this account.' });
    }

    const job = await createIntelligenceJob({
      question,
      userEmail: req.user && req.user.email,
      userRole: req.user && req.user.role,
      tenantId: scope.tenant_id || 'zenex',
      tenantScope: scope,
    });
    return res.status(202).json({
      success: true,
      data: { job_id: job.id, status: job.status },
    });
  } catch (err) {
    console.error('Intelligence Console job create failed:', err);
    const dbDown = /Database is not configured/i.test(err.message || '');
    return res.status(dbDown ? 503 : 500).json({
      success: false,
      error: dbDown ? 'Intelligence Console is unavailable: job store is offline.' : 'Could not start intelligence job.',
    });
  }
});

// C4: Prophet. Synchronous (a single forced tool call, not a job): takes
// one existing Watchtower signal id and returns a structured forward
// assessment. Never takes action; see api/intelligence/agents/prophet.js.
router.post('/prophet', GUARD, async (req, res) => {
  const { signalId } = req.body || {};
  if (!signalId || typeof signalId !== 'string' || !UUID_RE.test(signalId)) {
    return res.status(400).json({ success: false, error: 'A valid signalId is required.' });
  }

  try {
    const signal = await getSignalById(signalId);
    if (!signal) return res.status(404).json({ success: false, error: 'Signal not found.' });

    const result = await runProphetAgent(signal);
    if (result.status !== 'ok') {
      return res.status(502).json({ success: false, error: result.error || 'Prophet could not produce an assessment.' });
    }
    return res.json({
      success: true,
      data: { signal_id: signal.id, assessment: result.output },
    });
  } catch (err) {
    console.error('Prophet assessment failed:', err);
    const dbDown = /Database is not configured/i.test(err.message || '');
    return res.status(dbDown ? 503 : 500).json({
      success: false,
      error: dbDown ? 'Watchtower is unavailable: signal store is offline.' : 'Could not produce a Prophet assessment.',
    });
  }
});

// C5: outcomes (the feedback loop). Distinct from /api/memory/outcomes (the
// admin-console-wide, tenant-by-query view): these are scoped to a single
// Intelligence Console job, and the tenant is resolved from that job, not
// from a query param. Append-only: a revision is a new POST with
// originalOutcomeId set, never an edit to the row it revises. Placed above
// the /:jobId catch-all below so 'outcomes' is never read as a job id.
router.post('/outcomes', GUARD, async (req, res) => {
  const {
    jobId, outcomeStatus, decisionTaken, outcomeDescription,
    signalProvedReliable, notes, originalOutcomeId, recommendationSummary,
  } = req.body || {};
  if (!jobId || typeof jobId !== 'string' || !UUID_RE.test(jobId)) {
    return res.status(400).json({ success: false, error: 'A valid jobId is required.' });
  }

  try {
    const job = await getIntelligenceJob(jobId);
    if (!job) return res.status(404).json({ success: false, error: 'Job not found.' });

    const outcome = await recordOutcome(job.tenant_id || 'zenex', {
      job_id: jobId,
      recommendation_summary: recommendationSummary,
      decision_taken: decisionTaken,
      outcome_status: outcomeStatus,
      outcome_description: outcomeDescription,
      signal_proved_reliable: signalProvedReliable,
      recorded_by: (req.user && req.user.email) || null,
      notes,
      original_outcome_id: originalOutcomeId,
    });
    return res.status(201).json({ success: true, data: outcome });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('Outcome record failed:', err);
    const dbDown = /Database is not configured/i.test(err.message || '');
    return res.status(dbDown ? 503 : status).json({
      success: false,
      error: dbDown ? 'Intelligence Console is unavailable: outcome store is offline.' : (err.message || 'Could not record outcome.'),
    });
  }
});

router.get('/outcomes', GUARD, async (req, res) => {
  const { jobId } = req.query;
  if (!jobId || typeof jobId !== 'string' || !UUID_RE.test(jobId)) {
    return res.status(400).json({ success: false, error: 'A valid jobId query parameter is required.' });
  }

  try {
    const job = await getIntelligenceJob(jobId);
    if (!job) return res.status(404).json({ success: false, error: 'Job not found.' });

    const outcomes = await listOutcomes(job.tenant_id || 'zenex', { jobId });
    return res.json({ success: true, data: outcomes });
  } catch (err) {
    console.error('Outcome list failed:', err);
    const dbDown = /Database is not configured/i.test(err.message || '');
    return res.status(dbDown ? 503 : 500).json({
      success: false,
      error: dbDown ? 'Intelligence Console is unavailable: outcome store is offline.' : 'Could not list outcomes.',
    });
  }
});

// C7: the full trace behind one job -- memory context actually used,
// signal provenance (source + observation + S3 snapshot chain) for every
// signal that context contained, and every outcome recorded against the
// job -- reconstructed from the database and S3 alone. Placed above the
// /:jobId catch-all below so 'trace' is never read as a job id.
router.get('/trace/:jobId', GUARD, async (req, res) => {
  const { jobId } = req.params;
  if (!UUID_RE.test(jobId || '')) {
    return res.status(400).json({ success: false, error: 'Invalid job id.' });
  }

  try {
    const trace = await buildJobTrace(jobId);
    if (!trace) return res.status(404).json({ success: false, error: 'Job not found.' });
    return res.json({ success: true, data: trace });
  } catch (err) {
    console.error('Intelligence Console trace read failed:', err);
    return res.status(500).json({ success: false, error: 'Could not build job trace.' });
  }
});

// Lightweight tenant list for the Console's tenant selector. Names only
// (no internal fields beyond slug/name), scoped by the same authorisation
// used for /ask itself -- a tenant user only ever sees their own tenant.
router.get('/tenants', GUARD, async (req, res) => {
  try {
    const authorised = await getAuthorisedTenants(req.user);
    return res.json({
      success: true,
      data: {
        tenants: authorised.map(t => ({ tenant_id: t.slug, name: t.name })),
        can_view_all: isAdminRole(req.user && req.user.role) && authorised.length > 1,
      },
    });
  } catch (err) {
    console.error('Intelligence Console tenant list failed:', err);
    return res.status(500).json({ success: false, error: 'Could not list authorised tenants.' });
  }
});

router.get(['/:jobId', '/ask/:jobId'], GUARD, async (req, res) => {
  const { jobId } = req.params;
  if (!UUID_RE.test(jobId || '')) {
    return res.status(400).json({ success: false, error: 'Invalid job id.' });
  }

  try {
    const job = await getIntelligenceJob(jobId);
    if (!job) return res.status(404).json({ success: false, error: 'Job not found.' });
    return res.json({ success: true, data: job });
  } catch (err) {
    console.error('Intelligence Console job read failed:', err);
    return res.status(500).json({ success: false, error: 'Could not read intelligence job.' });
  }
});

// Exported for tests only (tests/tenant-scope.test.js) -- the router
// itself is still the module's primary export and mount shape.
router.resolveTenantScope = resolveTenantScope;
module.exports = router;
