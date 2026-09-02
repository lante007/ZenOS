'use strict';

// api/routes/intelligence.js
// Intelligence Console front door. One question in, one synthesised response
// out. The multi-agent orchestration lives in api/intelligence/ (orchestrator
// -> Evidence + Strategy agents in parallel -> Advisor synthesis). This route
// only gathers live corpus data and delegates.
//
// Admin console only. Mounted in server.js behind authenticate(); the
// in-route guard restricts to the founder roles, same pattern as admin-ask.js.

const express = require('express');
const { requireRoles } = require('../middleware/permissions');
const { getPool } = require('../services/db');
const { runIntelligence } = require('../intelligence');
const { getLiveCorpusData } = require('../intelligence/live-data');

const router = express.Router();

router.post('/ask',
  requireRoles('SUPER_ADMIN', 'AUXEIRA_FOUNDER'),
  async (req, res) => {
    const { question } = req.body || {};

    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'Question is required.' });
    }

    try {
      const pool = getPool();
      const liveData = pool ? await getLiveCorpusData(pool) : null;

      const result = await runIntelligence(question.trim(), liveData);

      return res.json({
        success: true,
        data: {
          ...result,
          generated_at: new Date().toISOString(),
        },
      });
    } catch (err) {
      console.error('Intelligence Console error:', err);
      return res.status(500).json({ success: false, error: 'Intelligence query failed.' });
    }
  });

module.exports = router;
