'use strict';

const express = require('express');
const db = require('../services/db');

const router = express.Router();

router.post('/login', async (req, res, next) => {
  try {
    await db.createAuditLog(req.tenant, 'user_login', {
      email: req.user.email,
      role: req.user.role,
    }, req.user.email || req.user.sub);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
