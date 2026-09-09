'use strict';

// api/routes/decision-events.js
//
// Phase 4: manual assessment trigger + read model for Decision Events /
// Decision Assessments. Mounted in server.js AFTER
// `app.use('/api', authenticate(), assertNoBoardAccess)`, so every route
// here already inherits tenant resolution (tenantMiddleware, mounted
// globally before this), authentication, and the board-access exclusion
// automatically -- the same convention as alerts.js/stats.js/etc.
//
// Role guard: the manual trigger (POST /:id/assess) is restricted to
// SUPER_ADMIN / AUXEIRA_FOUNDER, the same requireRoles(...) pattern used
// as `GUARD` on every route in api/routes/memory.js and
// api/routes/intelligence.js. Explicit product decision (previously an
// open item in this file); the GET read routes below are left
// unrestricted -- unchanged from the original design -- any
// authenticated, non-board caller scoped to their own tenant may read,
// matching the default posture of every other route mounted after the
// same middleware line.
//
// Every query is tenant-scoped via req.tenant.slug (server-derived by
// tenantMiddleware, never client-supplied) -- claimAssessment,
// getAssessmentById and listAssessmentsForEvent all take tenantId as a
// mandatory parameter and filter by it.

const express = require('express');
const { getPool } = require('../services/db');
const { requireRoles } = require('../middleware/permissions');
const {
  claimAssessment,
  runAssessmentPipeline,
  getAssessmentById,
  listAssessmentsForEvent,
} = require('../intelligence/decision-assessment/orchestrator');

const router = express.Router();
const ASSESS_GUARD = requireRoles('SUPER_ADMIN', 'AUXEIRA_FOUNDER');

function mapClaimError(err, res) {
  if (err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message });
  if (err.code === 'CONFLICT' || err.code === 'NOT_ELIGIBLE') return res.status(409).json({ error: err.message });
  if (err.code === 'BAD_REQUEST') return res.status(400).json({ error: err.message });
  return null;
}

// POST /api/decision-events/:id/assess -- manual trigger. Returns 202
// immediately (fire-and-forget background execution), exactly like
// jobs.js#createIntelligenceJob; PostgreSQL is the authoritative record
// of outcome, polled via the GET routes below. under_assessment ->
// CONFLICT -> HTTP 409, never queued/retried/silently no-op'd (hard
// invariant #8).
router.post('/:id/assess', ASSESS_GUARD, async (req, res, next) => {
  try {
    const pool = getPool();
    if (!pool) return res.status(500).json({ error: 'Database is not configured' });

    let claim;
    try {
      claim = await claimAssessment(pool, {
        tenantId: req.tenant.slug,
        decisionEventId: req.params.id,
        mode: 'manual',
        requestedBy: req.user && req.user.email,
      });
    } catch (err) {
      const mapped = mapClaimError(err, res);
      if (mapped) return mapped;
      throw err;
    }

    runAssessmentPipeline(claim.assessmentId, { pool }).catch((err) => {
      console.error('decision assessment pipeline crashed:', err.message);
    });

    res.status(202).json({
      assessment_id: claim.assessmentId,
      assessment_version: claim.assessmentVersion,
      status: 'pending',
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/decision-events/:id -- the event and its current assessment
// pointer only (not the assessment body itself -- see /assessments/:aid
// below).
router.get('/:id', async (req, res, next) => {
  try {
    const pool = getPool();
    if (!pool) return res.status(500).json({ error: 'Database is not configured' });
    const result = await pool.query(
      `SELECT id, tenant_id, trigger_pathway, trigger_explanation, status, priority, assessment_id, created_at, updated_at
         FROM public.decision_events
        WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.tenant.slug],
    );
    const event = result.rows[0];
    if (!event) return res.status(404).json({ error: 'Decision event not found' });
    res.json(event);
  } catch (err) {
    next(err);
  }
});

// GET /api/decision-events/:id/assessments -- full version history,
// newest first. Stale pending/assessing rows are recovered on read.
router.get('/:id/assessments', async (req, res, next) => {
  try {
    const pool = getPool();
    if (!pool) return res.status(500).json({ error: 'Database is not configured' });
    const rows = await listAssessmentsForEvent(pool, req.params.id, req.tenant.slug);
    res.json({ assessments: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/decision-events/assessments/:aid -- a single assessment by id.
router.get('/assessments/:aid', async (req, res, next) => {
  try {
    const pool = getPool();
    if (!pool) return res.status(500).json({ error: 'Database is not configured' });
    const row = await getAssessmentById(pool, req.params.aid, req.tenant.slug);
    if (!row) return res.status(404).json({ error: 'Assessment not found' });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
