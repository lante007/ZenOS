'use strict';

// api/routes/priorities.js
//
// Phase 5: read model for Priority Records. Mounted at
// /api/decision-events in server.js, alongside decision-events.js, so
// these routes inherit the exact same middleware chain (tenant
// resolution, authentication, board-access exclusion) already documented
// in that file's header -- see decision-events.js for the full mounting
// rationale.
//
// Every query is tenant-scoped via req.tenant.slug (server-derived,
// never client-supplied), matching decision-events.js's own convention
// exactly.
//
// No POST/PATCH route here by design (Phase 5 spec): a Priority Record
// is written only by the prioritisation layer
// (api/intelligence/decision-prioritisation/orchestrator.js), triggered
// automatically when a Decision Assessment reaches status='assessed' --
// never by manual/API input.

const express = require('express');
const { getPool } = require('../services/db');
const { getActivePriorityForEvent, listPrioritiesForEvent } = require('../intelligence/decision-prioritisation/orchestrator');

const router = express.Router();

// GET /api/decision-events/:id/priority -- the current active (not
// superseded) Priority Record for a Decision Event. 404 if none exists
// yet (e.g. the event has never completed an assessment).
router.get('/:id/priority', async (req, res, next) => {
  try {
    const pool = getPool();
    if (!pool) return res.status(500).json({ error: 'Database is not configured' });
    const record = await getActivePriorityForEvent(pool, req.params.id, req.tenant.slug);
    if (!record) return res.status(404).json({ error: 'No priority record found for this decision event' });
    res.json(record);
  } catch (err) {
    next(err);
  }
});

// GET /api/decision-events/:id/priorities -- full Priority Record
// history for a Decision Event (including superseded records), newest
// first.
router.get('/:id/priorities', async (req, res, next) => {
  try {
    const pool = getPool();
    if (!pool) return res.status(500).json({ error: 'Database is not configured' });
    const records = await listPrioritiesForEvent(pool, req.params.id, req.tenant.slug);
    res.json({ priorities: records });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
