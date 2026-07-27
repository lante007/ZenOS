'use strict';

const express = require('express');
const db = require('../services/db');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const alerts = process.env.DATABASE_URL
      ? await db.listAlerts(req.tenant, req.user.role)
      : [];
    res.json(alerts);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/read', async (req, res, next) => {
  try {
    const alert = process.env.DATABASE_URL
      ? await db.markAlertRead(req.tenant, req.params.id)
      : null;
    if (!alert) return res.status(404).json({ error: 'Alert not found' });
    res.json({ success: true, alert });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
