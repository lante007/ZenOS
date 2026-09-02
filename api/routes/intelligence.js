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

const router = express.Router();

const GUARD = requireRoles('SUPER_ADMIN', 'AUXEIRA_FOUNDER');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.post(['/', '/ask'], GUARD, (req, res) => {
  const { question } = req.body || {};
  if (!question || typeof question !== 'string' || question.trim().length === 0) {
    return res.status(400).json({ success: false, error: 'Question is required.' });
  }

  try {
    const job = createIntelligenceJob({
      question,
      userEmail: req.user && req.user.email,
      userRole: req.user && req.user.role,
    });
    return res.status(202).json({
      success: true,
      data: { job_id: job.id, status: job.status },
    });
  } catch (err) {
    console.error('Intelligence Console job create failed:', err);
    return res.status(500).json({ success: false, error: 'Could not start intelligence job.' });
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

module.exports = router;
