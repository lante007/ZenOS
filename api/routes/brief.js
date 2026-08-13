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
- Do not use 'robust', 'comprehensive', 'leverage' or 'utilise'

Write as a trusted senior adviser briefing the CEO, not as an external auditor finding fault.

Use language that:
- States facts clearly without catastrophising
- Frames gaps as opportunities for decision rather than failures
- Uses 'the evidence suggests' rather than 'the board should treat this as provisional'
- Reserves words like 'risk' and 'governance failure' for genuine material issues only
- Addresses Sibongile directly as a decision-maker with agency, not as a recipient of bad news`;
}

function buildUserPrompt({
  today, totalInvestment, programmes,
  tier1, tier2, tier3, avgEqs,
  positiveOutcomes, nullFindings, highInvestmentWeakEvidence,
  strongest, contradictions, gaps,
  evidenceCapitalRand, eroiScore, eroiLabel,
  highInvestmentNoEndline, highInvestmentNoEndlineTotal,
  distinctStudies, totalDocuments, tier1Count,
  financialCapitalMillions, evidenceCapitalMillions, accountabilityGapMillions,
  topGap1Programme, topGap1GrantMillions,
  topGap2Programme, topGap2GrantMillions,
  topGap3Programme, topGap3GrantMillions,
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

  const noEndlineBlock = highInvestmentNoEndline.length
    ? highInvestmentNoEndline.map(g => `- ${g.programme}: ${formatRandCompact(g.grant)}`).join('\n')
    : 'No high investment programmes (above R5m) currently without an endline evaluation.';

  return `Generate a CEO Decision Brief for Zenex Foundation using this live evidence data.

DATE: ${today}
CORPUS: ${distinctStudies} distinct evaluation studies (${totalDocuments} total documents classified)
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

HIGH INVESTMENT PROGRAMMES WITH NO ENDLINE (verified from corpus):
${noEndlineBlock}
Total: ${formatRandCompact(highInvestmentNoEndlineTotal)}

Use only these verified programmes and this verified total when making claims about unexamined investment. Do not calculate or infer figures not in this list.

EROI POSITION:
Financial Capital: R${totalInvestment.toLocaleString()}
Evidence Capital: R${evidenceCapitalRand.toLocaleString()}
EROI: ${eroiScore}/100 ${eroiLabel}

SECTION HEADER FORMAT (must follow exactly, this output is machine-parsed):
Write each of the 9 section headers on its own line as "## N. Title", for example "## 1. Evidence Position". Use this exact "## N. " pattern only for these 9 headers, nowhere else in the document. Do not use bullet points in body text, use numbered lists or plain sentences instead.

Generate the brief with these nine sections. Each section must open with the decision implication, not the data.

1. Evidence Position
   What does Zenex's evidence estate tell us about the organisation's knowledge maturity right now?
   Section 1 must open with this exact framing. Use the live figures provided. Do not paraphrase:
   'Zenex enters this leadership transition with a maturing evidence estate. Across ${distinctStudies} distinct evaluation studies covering R${financialCapitalMillions}m in investment, the organisation has generated substantial knowledge but has not yet converted enough of it into defensible, board-citable evidence assets. This is an evidence capitalisation gap. The immediate decision is not whether the evidence is good enough, but which gaps to close first and in what sequence.'
   Do not use the phrase 'under-capitalised' anywhere. Do not describe the estate as 'uneven'.

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
   Section 6 must use this framing. Do not paraphrase:
   '[Number] programme areas currently show mixed or conflicting signals. These are best read as implementation-condition signals: the evidence is telling us something about context, fidelity or delivery conditions that has not yet been fully explained. A structured synthesis across the conflicting evaluations should precede the next funding cycle for these clusters.'
   Do not frame mixed findings as programme problems or failures.

7. Priority Research Decisions
   What should Zenex commission next, and why? (Use the top 3 gaps data) For each, add: Consider [action].
   Section 7 must use this exact sequenced structure:
   First: ${topGap1Programme} (R${topGap1GrantMillions}m) - commission endline evaluation.
   Second: ${topGap2Programme} (R${topGap2GrantMillions}m) - verify active status, then decide on evaluation.
   Third: ${topGap3Programme} (R${topGap3GrantMillions}m) - assess pairing or coordinated evaluation with the second programme given thematic overlap.
   Do not add language that withholds further disbursement. Keep recommendations as evaluation actions only.

8. Capital and Return Position
   What is the evidence-adjusted return on Zenex's investment?
   IMPORTANT: Do not describe EROI as a ratio of financial to evidence capital. EROI is a weighted institutional return score across five dimensions: system adoption, policy influence, learning outcomes, knowledge assets and capital leverage.
   For Section 8, use this framing:
   First sentence: describe EROI as a score measuring institutional return, not a spending ratio.
   Second sentence: separately describe the evidence-accountability gap as the difference between financial_capital and evidence_capital.
   Example framing:
   'An EROI score of [N]/100 indicates that Zenex's measured institutional return across adoption, policy influence, learning outcomes, knowledge assets and capital leverage is at a developing stage. Separately, financial capital of R[X] recorded in the corpus exceeds evidence-adjusted capital of R[Y], indicating an evidence accountability gap of R[Z] that represents investment not yet substantiated by classified evidence.'
   Section 8 must include this structured display block. Wrap it in [CAPITAL_BLOCK] tags:
   [CAPITAL_BLOCK]
   R${financialCapitalMillions}m | Financial capital evidenced
   R${evidenceCapitalMillions}m | Evidence-adjusted capital
   R${accountabilityGapMillions}m | Evidence accountability gap
   [/CAPITAL_BLOCK]
   After the [CAPITAL_BLOCK], include this exact sentence:
   'The R${accountabilityGapMillions}m gap reflects evidence depreciation: investment whose associated evaluations have aged beyond current decision-relevance thresholds. The underlying evidence exists in the corpus but carries reduced decision weight given its currency.'
   Do not describe the gap as unclassified or unsubstantiated investment. All R${financialCapitalMillions}m is classified. The gap reflects evidence currency decay, not absence of evidence.

9. The Question for the Board
   One sentence: what is the most important evidence question Zenex's board should discuss at its next meeting?
   End Section 9 with this board question constructed from live data:
   'Given that only ${tier1Count} of ${distinctStudies} distinct evaluation studies currently meet EvidenceOS board-citable standard, and R${topGap1GrantMillions}m in investment has no endline evidence on record, what minimum evidence threshold should Zenex require before approving the next round of programme disbursements?'
   Use the live figures provided. Do not paraphrase the structure.

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

      // STEP 1B: corpus counts for the prompt's live figures - distinct
      // studies (root records only) vs total documents classified, alongside
      // the existing corpus stats query above.
      const countsResult = await pool.query(`
        SELECT
          COUNT(*) as total_documents,
          COUNT(*) FILTER (WHERE parent_record_id IS NULL) as distinct_studies,
          COUNT(*) FILTER (WHERE eqs_tier = 'TIER_1') as tier1_count,
          COUNT(*) FILTER (WHERE eqs_tier = 'TIER_2') as tier2_count,
          COUNT(*) FILTER (WHERE eqs_tier = 'TIER_3') as tier3_count
        FROM ${schema}.intelligence_records
        WHERE tenant_id = $1
          AND record_status = 'ACTIVE'
      `, [tenantId]);
      const {
        total_documents: totalDocuments,
        distinct_studies: distinctStudies,
        tier1_count: tier1Count,
        tier2_count: tier2Count,
        tier3_count: tier3Count,
      } = countsResult.rows[0];

      // STEP 2: top 3 priority evidence gaps - reuses the same prioritisation
      // engine as GET /api/stats/gaps rather than re-deriving its own.
      const { gaps: rawGaps } = await stats.getPriorityGaps(pool, schema, tenantId, 3);
      const currentYear = new Date().getFullYear();
      const gaps = rawGaps.map(g => ({
        ...g,
        years_without_endline: g.last_evaluation_year != null ? currentYear - g.last_evaluation_year : null,
      }));

      // STEP 2B: top gap figures for Section 7's sequenced structure.
      const topGap1 = gaps[0];
      const topGap2 = gaps[1];
      const topGap3 = gaps[2];
      const topGap1Programme = topGap1?.programme_name || 'Not identified';
      const topGap1GrantMillions = topGap1 ? Math.round(topGap1.total_grant_rand / 1000000 * 10) / 10 : 0;
      const topGap2Programme = topGap2?.programme_name || 'Not identified';
      const topGap2GrantMillions = topGap2 ? Math.round(topGap2.total_grant_rand / 1000000 * 10) / 10 : 0;
      const topGap3Programme = topGap3?.programme_name || 'Not identified';
      const topGap3GrantMillions = topGap3 ? Math.round(topGap3.total_grant_rand / 1000000 * 10) / 10 : 0;

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

      // STEP 5: verified high-investment (>R5m) programmes with no endline
      // evaluation on record. Passed to Claude as a closed, pre-computed list
      // so the model cannot infer or calculate its own unverified total.
      const noEndlineResult = await pool.query(`
        SELECT
          COALESCE(canonical_programme_name, programme_name) as programme,
          MAX(total_cost_rand) as grant,
          bool_or(
            record_series = 'ENDLINE'
            OR endline_available = true
            OR secondary_document_type = 'Impact Evaluation'
          ) as has_endline
        FROM ${schema}.intelligence_records
        WHERE tenant_id = $1
          AND record_status = 'ACTIVE'
          AND total_cost_rand > 5000000
        GROUP BY COALESCE(canonical_programme_name, programme_name)
        HAVING NOT bool_or(
          record_series = 'ENDLINE'
          OR endline_available = true
          OR secondary_document_type = 'Impact Evaluation'
        )
        ORDER BY MAX(total_cost_rand) DESC
        LIMIT 5
      `, [tenantId]);
      const highInvestmentNoEndline = noEndlineResult.rows;
      const highInvestmentNoEndlineTotal = highInvestmentNoEndline.reduce((sum, r) => sum + toNumber(r.grant), 0);

      // EROI position - reuses the same computation as GET /api/stats/cascade.
      // Also the source of total investment: family-group deduplicated, not
      // a raw SUM/SUM(DISTINCT) over total_cost_rand, which double-counts or
      // under-counts when a programme has multiple evaluation records each
      // carrying the same grant figure.
      const { evidenceCapital, eroi } = await stats.computeEvidenceCapitalAndEroi(pool, schema, tenantId);

      const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
      const totalInvestment = evidenceCapital.financial_capital_total;

      // Capital figures in millions, rounded to 1 decimal, for the Section 1
      // opening framing and the Section 8 [CAPITAL_BLOCK] display.
      const financialCapitalMillions = Math.round(totalInvestment / 1000000 * 10) / 10;
      const evidenceCapitalMillions = Math.round(evidenceCapital.rand_value / 1000000 * 10) / 10;
      const accountabilityGapMillions = Math.round((totalInvestment - evidenceCapital.rand_value) / 1000000 * 10) / 10;

      const systemPrompt = buildSystemPrompt();
      const userPrompt = buildUserPrompt({
        today,
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
        highInvestmentNoEndline,
        highInvestmentNoEndlineTotal,
        distinctStudies: toNumber(distinctStudies),
        totalDocuments: toNumber(totalDocuments),
        tier1Count: toNumber(tier1Count),
        financialCapitalMillions,
        evidenceCapitalMillions,
        accountabilityGapMillions,
        topGap1Programme,
        topGap1GrantMillions,
        topGap2Programme,
        topGap2GrantMillions,
        topGap3Programme,
        topGap3GrantMillions,
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
