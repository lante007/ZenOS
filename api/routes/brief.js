'use strict';

const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const { requireRoles } = require('../middleware/permissions');
const { getPool } = require('../services/db');
const stats = require('./stats');

const anthropic = new Anthropic();

function assertSchema(schema) {
  if (!/^[a-z][a-z0-9_]*$/.test(schema || '')) {
    throw new Error(`Unsafe tenant schema: ${schema}`);
  }
}

function toNumber(value) {
  if (value == null) return 0;
  return Number(value);
}

function formatRandCompact(value) {
  const num = Number(value) || 0;
  if (num >= 1000000) return `R${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `R${(num / 1000).toFixed(0)}K`;
  return `R${num.toLocaleString()}`;
}

function buildSystemPrompt() {
  return `You are generating a CEO Decision Brief for Sibongile Khumalo, incoming CEO of Zenex Foundation, South Africa's leading education evidence funder.

This is NOT a research summary. This is a governance document. Every section must answer a decision question, not describe a finding.

Writing rules:
- UK English throughout
- No em dashes or long dashes
- No bullet points longer than one line
- Active voice
- Maximum 700 words total
- Each section opens with the decision implication, not the evidence description
- End each gap or weakness with a recommended action in the format: Consider [specific action]
- Do not use 'robust', 'comprehensive', 'leverage' or 'utilise'`;
}

function buildUserPrompt({
  today, totalDocs, totalInvestment, programmes,
  tier1, tier2, tier3, avgEqs,
  positiveOutcomes, nullFindings, highInvestmentWeakEvidence,
  strongest, contradictions, gaps,
  evidenceCapitalRand, eroiScore, eroiLabel,
}) {
  const strongestBlock = strongest.length
    ? strongest.map(r =>
        `- ${r.programme_name} (${r.year}): ${r.key_finding_1 || 'finding not recorded'}`
        + (r.effect_direction ? ` (Effect: ${r.effect_direction}${r.effect_size_composite ? `, size ${r.effect_size_composite}` : ''})` : '')
      ).join('\n')
    : 'No Tier 1 records currently in the corpus.';

  const contradictionsBlock = contradictions.length
    ? contradictions.map(c =>
        `- ${c.programme_name}: ${c.eval_count} evaluations on record, includes both a positive finding and a null or mixed finding.`
      ).join('\n')
    : 'No direct contradictions identified in the current corpus.';

  const gapsBlock = gaps.length
    ? gaps.map(g =>
        `- ${g.programme_name}: ${formatRandCompact(g.total_grant_rand)} invested, ${g.years_without_endline != null ? `${g.years_without_endline} years` : 'unknown years'} without an endline evaluation.`
      ).join('\n')
    : 'No priority gaps currently identified.';

  return `Generate a CEO Decision Brief for Zenex Foundation using this live evidence data.

DATE: ${today}
CORPUS: ${totalDocs} classified evaluations
INVESTMENT TRACKED: R${totalInvestment.toLocaleString()}
PROGRAMMES: ${programmes}

EVIDENCE QUALITY:
Board-citable (Tier 1): ${tier1}
Reliable (Tier 2): ${tier2}
Limited confidence (Tier 3): ${tier3}
Average quality: ${avgEqs != null ? avgEqs : 'N/A'}/5.0

OUTCOME SIGNALS:
Positive outcomes confirmed: ${positiveOutcomes} evaluations
Null or mixed findings: ${nullFindings} evaluations
High investment, weak evidence: ${highInvestmentWeakEvidence} programmes above R5M

STRONGEST EVIDENCE:
${strongestBlock}

EVIDENCE CONTRADICTIONS:
${contradictionsBlock}

PRIORITY EVIDENCE GAPS:
${gapsBlock}

EROI POSITION:
Financial Capital: R${totalInvestment.toLocaleString()}
Evidence Capital: R${evidenceCapitalRand.toLocaleString()}
EROI: ${eroiScore}/100 ${eroiLabel}

SECTION HEADER FORMAT (must follow exactly, this output is machine-parsed):
Write each of the 9 section headers on its own line as "## N. Title", for example "## 1. Evidence Position". Use this exact "## N. " pattern only for these 9 headers, nowhere else in the document. Do not use bullet points in body text, use numbered lists or plain sentences instead.

Generate the brief with these nine sections. Each section must open with the decision implication, not the data.

1. Evidence Position
   What does Zenex's evidence estate tell us about the organisation's knowledge maturity right now?

2. What We Know With Confidence
   What can Zenex claim with board-level confidence? (Use only TIER_1 findings)

3. What Remains Unknown
   What material gaps exist that affect strategic decisions?

4. Where Evidence Is Strongest
   Which programmes have the most defensible evidence base?

5. Where Evidence Is Weakest
   Which high-investment programmes lack adequate evidence? For each, add: Consider [action].

6. Contradictions and Risks
   Where does the evidence contradict itself? What does that mean for resource allocation?

7. Priority Research Decisions
   What should Zenex commission next, and why? (Use the top 3 gaps data) For each, add: Consider [action].

8. Capital and Return Position
   What is the evidence-adjusted return on Zenex's investment?

9. The Question for the Board
   One sentence: what is the most important evidence question Zenex's board should discuss at its next meeting?

After each gap or weakness, include action buttons in the response as plain text markers:
[EXPLORE_EVIDENCE: programme_name]
[ADD_TO_AGENDA: programme_name]
[GENERATE_TOR: programme_name]

The frontend will convert these markers into actual buttons.`;
}

// Same light-touch cleanup as api/routes/tor.js's sanitiseTor - keep the
// two brief generators consistent in house style.
function sanitiseBrief(text) {
  return text
    .replace(/—/g, ', ')
    .replace(/–/g, ' to ')
    .replace(/\bleverage\b/gi, 'use')
    .replace(/\butilise\b/gi, 'use')
    .replace(/\brobust\b/gi, '[REVIEW]')
    .replace(/\bcomprehensive\b/gi, '[REVIEW]');
}

router.post('/ceo',
  requireRoles('CEO_EXEC'),
  async (req, res, next) => {
    try {
      const pool = getPool();
      if (!pool) return res.status(503).json({ error: 'Database is not configured' });

      const schema = req.tenant.db_schema || req.tenant.slug || 'zenex';
      assertSchema(schema);
      const tenantId = req.tenant.slug;

      // Phase 2 filters - accepted so the API signature is future-ready, but
      // ignored for now. The brief always uses the full corpus.
      const {
        period_start: periodStart = null,
        period_end: periodEnd = null,
        theme = null,
        provinces: filterProvinces = null,
      } = req.body || {};

      // STEP 1: corpus stats.
      const corpusResult = await pool.query(`
        SELECT
          COUNT(*) as total_docs,
          COUNT(*) FILTER (WHERE eqs_tier = 'TIER_1') as tier1,
          COUNT(*) FILTER (WHERE eqs_tier = 'TIER_2') as tier2,
          COUNT(*) FILTER (WHERE eqs_tier = 'TIER_3') as tier3,
          ROUND(AVG(eqs_composite)::numeric, 2) as avg_eqs,
          COUNT(DISTINCT programme_name) as programmes,
          COUNT(DISTINCT programme_area) as areas,
          COUNT(*) FILTER (
            WHERE effect_direction = 'Positive'
            AND eqs_tier IN ('TIER_1', 'TIER_2')
          ) as positive_outcomes,
          COUNT(*) FILTER (
            WHERE effect_direction = 'Null Finding'
            OR null_findings_reported = true
          ) as null_findings,
          COUNT(*) FILTER (
            WHERE endline_available = false
            AND baseline_available = true
          ) as missing_endlines,
          COUNT(*) FILTER (
            WHERE eqs_tier = 'TIER_3'
            AND total_cost_rand > 5000000
          ) as high_investment_weak_evidence
        FROM ${schema}.intelligence_records
        WHERE tenant_id = $1
          AND record_status = 'ACTIVE'
      `, [tenantId]);
      const corpus = corpusResult.rows[0];

      // STEP 2: top 3 priority evidence gaps - reuses the same prioritisation
      // engine as GET /api/stats/gaps rather than re-deriving its own.
      const { gaps: rawGaps } = await stats.getPriorityGaps(pool, schema, tenantId, 3);
      const currentYear = new Date().getFullYear();
      const gaps = rawGaps.map(g => ({
        ...g,
        years_without_endline: g.last_evaluation_year != null ? currentYear - g.last_evaluation_year : null,
      }));

      // STEP 3: strongest records - Tier 1, highest EQS first.
      const strongestResult = await pool.query(`
        SELECT id, programme_name, eqs_composite, eqs_tier,
          key_finding_1, effect_direction, effect_size_composite,
          programme_area, year
        FROM ${schema}.intelligence_records
        WHERE tenant_id = $1
          AND record_status = 'ACTIVE'
          AND eqs_tier = 'TIER_1'
        ORDER BY eqs_composite DESC
        LIMIT 3
      `, [tenantId]);

      // STEP 4: contradiction signals - programmes with both a positive
      // finding and a null/mixed finding on record.
      const contradictionsResult = await pool.query(`
        SELECT ir.programme_name,
          COUNT(*) as eval_count,
          bool_or(effect_direction = 'Positive') as has_positive,
          bool_or(null_findings_reported = true) as has_null
        FROM ${schema}.intelligence_records ir
        WHERE tenant_id = $1
          AND record_status = 'ACTIVE'
        GROUP BY programme_name
        HAVING
          bool_or(effect_direction = 'Positive')
          AND bool_or(null_findings_reported = true)
        LIMIT 3
      `, [tenantId]);

      // EROI position - reuses the same computation as GET /api/stats/cascade.
      // Also the source of total investment: family-group deduplicated, not
      // a raw SUM/SUM(DISTINCT) over total_cost_rand, which double-counts or
      // under-counts when a programme has multiple evaluation records each
      // carrying the same grant figure.
      const { evidenceCapital, eroi } = await stats.computeEvidenceCapitalAndEroi(pool, schema, tenantId);

      const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
      const totalInvestment = evidenceCapital.financial_capital_total;

      const systemPrompt = buildSystemPrompt();
      const userPrompt = buildUserPrompt({
        today,
        totalDocs: toNumber(corpus.total_docs),
        totalInvestment,
        programmes: toNumber(corpus.programmes),
        tier1: toNumber(corpus.tier1),
        tier2: toNumber(corpus.tier2),
        tier3: toNumber(corpus.tier3),
        avgEqs: corpus.avg_eqs,
        positiveOutcomes: toNumber(corpus.positive_outcomes),
        nullFindings: toNumber(corpus.null_findings),
        highInvestmentWeakEvidence: toNumber(corpus.high_investment_weak_evidence),
        strongest: strongestResult.rows,
        contradictions: contradictionsResult.rows,
        gaps,
        evidenceCapitalRand: evidenceCapital.rand_value,
        eroiScore: eroi.index,
        eroiLabel: eroi.label,
      });

      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 3000,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });

      const briefText = message.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');

      const sanitised = sanitiseBrief(briefText);

      return res.json({
        brief_text: sanitised,
        generated_at: new Date().toISOString(),
        total_docs: toNumber(corpus.total_docs),
        filters_applied: false,
        filters_note: 'Filter by period, theme or geography coming soon.',
        filters_received: {
          period_start: periodStart,
          period_end: periodEnd,
          theme,
          provinces: filterProvinces,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
