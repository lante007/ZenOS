'use strict';

const express = require('express');
const { listTenants } = require('../services/tenants');

const router = express.Router();

function requireFounder(req, res, next) {
  const email = req.user?.email || '';
  const allowed = process.env.FOUNDER_EMAIL || 'emmanuel@auxeira.com';
  if (email.toLowerCase() !== allowed.toLowerCase() && req.user?.role !== 'AUXEIRA_FOUNDER') {
    return res.status(403).json({ error: 'Founder console access only' });
  }
  next();
}

router.get('/tenants', requireFounder, async (_req, res, next) => {
  try {
    res.json(await listTenants());
  } catch (err) {
    next(err);
  }
});

router.get('/health', requireFounder, async (_req, res) => {
  res.json({
    status: 'ok',
    console: 'admin.auxeira.com',
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
