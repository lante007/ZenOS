'use strict';

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { requireRoles } = require('../middleware/permissions');
const db = require('../services/db');
const { PLATFORM_KNOWLEDGE } = require('../services/platform-knowledge');

const router = express.Router();
const anthropic = new Anthropic();

function assertSchema(schema) {
  if (!/^[a-z][a-z0-9_]*$/.test(schema || '')) {
    throw new Error(`Unsafe tenant schema: ${schema}`);
  }
}

router.post('/ask',
  requireRoles('SUPER_ADMIN', 'AUXEIRA_FOUNDER'),
  async (req, res, next) => {
    try {
      const { question } = req.body || {};

      if (!question || question.trim().length < 3) {
        return res.status(400).json({ error: 'Question required' });
      }

      const pool = db.getPool();
      if (!pool) return res.status(503).json({ error: 'Database is not configured' });

      const tenants = await pool.query(`
        SELECT slug, name, organisation_type
        FROM master.tenants
        WHERE is_active = true
        ORDER BY created_at ASC
      `);

      const corpusStats = [];
      for (const tenant of tenants.rows) {
        try {
          const schema = tenant.slug;
          assertSchema(schema);
          const stats = await pool.query(`
            SELECT
              COUNT(*)::int AS total_records,
              COUNT(*) FILTER (
                WHERE eqs_tier = 'TIER_1'
              )::int AS tier_1,
              COUNT(*) FILTER (
                WHERE eqs_tier = 'TIER_2'
              )::int AS tier_2,
              ROUND(AVG(eqs_composite) FILTER (
                WHERE eqs_composite IS NOT NULL
              ), 2) AS avg_eqs,
              COUNT(*) FILTER (
                WHERE record_status = 'ACTIVE'
              )::int AS active,
              MAX(classified_at) AS last_ingestion
            FROM ${schema}.intelligence_records
            WHERE record_status = 'ACTIVE'
          `);
          const queueStats = await pool.query(`
            SELECT COUNT(*)::int AS pending
            FROM ${schema}.queue_items
            WHERE resolved_at IS NULL
          `);
          corpusStats.push({
            tenant: tenant.slug,
            name: tenant.name,
            ...stats.rows[0],
            pending_queue: queueStats.rows[0].pending,
          });
        } catch {
          corpusStats.push({
            tenant: tenant.slug,
            name: tenant.name,
            error: 'Schema not accessible',
          });
        }
      }

      const systemPrompt =
`You are Ask Auxeira, the AI assistant
for Emmanuel Luthuli, Founder and CEO
of Auxeira. You have full knowledge of
the EvidenceOS platform, its methodology,
and all tenant data shown below.

You can:
1. Explain EQS scoring calculations
   step by step for any record
2. Diagnose classification decisions
   and explain why fields were scored
   as they were
3. Compare performance across tenants
4. Explain flywheel alert logic
5. Help troubleshoot platform issues
6. Explain the Three-Capital Cascade
   methodology
7. Provide operational guidance for
   supporting tenant users

PLATFORM METHODOLOGY:
${JSON.stringify(PLATFORM_KNOWLEDGE, null, 2)}

LIVE PLATFORM DATA:
Tenants: ${JSON.stringify(tenants.rows, null, 2)}
Corpus statistics per tenant:
${JSON.stringify(corpusStats, null, 2)}

RULES:
- Be precise and specific. Reference
  actual field values and formulas.
- When explaining EQS scores, show
  the calculation numerically.
- Use UK English. No contractions.
  No em dashes.
- Never expose sensitive credentials,
  passwords, or API keys.
- If asked about a specific record,
  say you need the record ID and tenant
  to pull the full detail.
- Address Emmanuel as Lante or Emmanuel.`;

      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        temperature: 0.2,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: question,
        }],
      });

      const answer = message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('');

      return res.json({
        success: true,
        question,
        answer,
        tenants_covered: tenants.rows.length,
        generated_at: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  });

module.exports = router;
