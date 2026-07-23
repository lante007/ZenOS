'use strict';

const express = require('express');
const db = require('../services/db');
const localStore = require('../services/local-store');
const { requireRoles } = require('../middleware/permissions');

const router = express.Router();

router.get('/', requireRoles('ORGANISATION_LEAD'), async (req, res, next) => {
  try {
    const rows = process.env.DATABASE_URL ? await db.listQueue(req.tenant) : null;
    res.json(rows || localStore.listQueue(req.tenant));
  } catch (err) {
    next(err);
  }
});

router.post('/:id/resolve', requireRoles('ORGANISATION_LEAD'), async (req, res, next) => {
  try {
    const value = req.body.value || req.body.resolved_value;
    if (value == null) return res.status(400).json({ error: 'value required' });

    const resolved = process.env.DATABASE_URL
      ? await db.resolveQueueItem(req.tenant, req.params.id, value, req.user.sub, req.body.override)
      : localStore.resolveQueueItem(req.tenant, req.params.id, value, req.user.email, req.body.override);

    if (!resolved) return res.status(404).json({ error: 'Queue item not found' });
    res.json({ success: true, resolved });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
