'use strict';

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const db = require('../services/db');

router.get('/', authenticate(), async (req, res) => {
  try {
    const pool = db.getPool();

    const result = await pool.query(`
      SELECT email, full_name, role, features_enabled, last_login_at, is_active
      FROM zenex.users
      WHERE tenant_id = $1
      AND email = $2
    `, [req.user.tenant_id, req.user.email]);

    if (result.rowCount === 0) {
      return res.json({
        email: req.user.email,
        role: req.user.role,
        features_enabled: {},
      });
    }

    const user = result.rows[0];

    res.json({
      email: user.email,
      full_name: user.full_name,
      role: user.role,
      features_enabled: user.features_enabled || {},
      last_login_at: user.last_login_at,
    });
  } catch (err) {
    console.error('/api/me error:', err);
    res.json({
      email: req.user.email,
      role: req.user.role,
      features_enabled: {},
    });
  }
});

module.exports = router;
