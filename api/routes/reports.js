'use strict';

const express = require('express');
const { generateTrusteePack } = require('../../infra/functions/trustee-pack');
const { requireRoles } = require('../middleware/permissions');

const router = express.Router();

router.post('/trustee-pack', requireRoles('ORGANISATION_LEAD'), async (req, res, next) => {
  try {
    const report = await generateTrusteePack({
      tenant: req.tenant,
      date: req.body.date,
    });

    res.json({
      success: true,
      tenant: report.tenant,
      organisation: report.organisation,
      evidence_health_score: report.evidence_health_score,
      tier_distribution: report.tier_distribution,
      top_tier_1_findings: report.top_tier_1_findings,
      decision_capital_items: report.decision_capital_items,
      s3_bucket: report.bucket,
      s3_key: report.key,
      download_url: report.download_url,
      expires_in_seconds: report.expires_in_seconds,
      generated_at: report.generated_at,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
