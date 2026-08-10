'use strict';

const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const { requireRoles } = require('../middleware/permissions');
const db = require('../services/db');
const { uploadJson } = require('../../src/s3-connector');

const anthropic = new Anthropic();

const CURRENT_YEAR = new Date().getFullYear();

function buildSystemPrompt() {
  return `You are Dr Fatima Adam, Director of Research and Evaluation at Zenex Foundation, South Africa's leading education evidence funder. You have 15 years of experience commissioning evaluations across South African schools. You also hold actuarial training and apply precise probabilistic and cost-benefit reasoning to evidence questions.

You are generating a Terms of Reference for an evaluation commission. Your writing style is:
- Formal but accessible
- Precise and evidence-grounded
- Active voice throughout
- UK English spelling
- Specific numbers not vague claims
- Decision-linked framing
- No em dashes or long dashes
- No filler phrases
- No passive constructions
- No hedging language
- Do not use "robust", "comprehensive", "leverage", "utilise", "delve into", "it is worth noting"
- Do not start sentences with "However" or "Furthermore"
- Do not use bullet points in the TOR body text, use numbered lists instead`;
}

function buildUserPrompt({ programmeName, records, gap }) {
  const {
    totalInvestment, hasEndline, firstYear, lastYear,
    yearsWithoutEndline, provinces, highestEQS, hasBaseline,
    nlsAlignment, funrsAlignment, programmeArea,
  } = gap;

  const evaluationsBlock = records.map(r =>
    `- ${r.year}: ${r.document_type} (EQS ${r.eqs_tier}, ${r.evaluation_design || 'design not recorded'})\n` +
    `  Finding 1: ${r.key_finding_1 || 'not recorded'}\n` +
    `  Finding 2: ${r.key_finding_2 || 'not recorded'}` +
    (r.limitations ? `\n  Limitations: ${r.limitations}` : '')
  ).join('\n');

  const evidenceGap = !hasEndline
    ? `No endline evaluation has been commissioned despite ${yearsWithoutEndline} years since the last evaluation and R${totalInvestment.toLocaleString()} invested.`
    : `No impact evaluation exists for this programme.`;

  return `Generate a world-class evaluation Terms of Reference for Zenex Foundation using the data below.

PROGRAMME: ${programmeName}
PROGRAMME AREA: ${programmeArea || 'not recorded'}
TOTAL INVESTMENT TO DATE: R${totalInvestment.toLocaleString()}
PROVINCES: ${provinces.join(', ') || 'not recorded'}
YEARS ACTIVE: ${firstYear} to ${lastYear}
YEARS WITHOUT ENDLINE EVALUATION: ${yearsWithoutEndline}
BASELINE DATA AVAILABLE: ${hasBaseline ? 'Yes' : 'No'}

EXISTING EVALUATIONS (${records.length} total):
${evaluationsBlock}

EVIDENCE GAP:
${evidenceGap}

HIGHEST QUALITY EVALUATION TO DATE:
EQS ${highestEQS.eqs_tier} (${highestEQS.eqs_composite}/5.0)
Design: ${highestEQS.evaluation_design || 'not recorded'}

NLS 2024-2030 ALIGNMENT: ${nlsAlignment ? 'Confirmed' : 'Not confirmed'}
FUNRS 2025 ALIGNMENT: ${funrsAlignment ? 'Confirmed' : 'Not confirmed'}

Generate a complete 11-section evaluation TOR with these sections:

1. Programme Context and Background
   (Pre-fill with the data above. Reference prior evaluations by name, year, and key finding. Include actuarial framing: what is the probability of replication given prior evidence?)

2. Evaluation Purpose and Rationale
   (Why now? What decision does this evaluation serve? Be specific about the decision-maker and the decision.)

3. Evaluation Questions
   (3 to 5 specific questions. Each question must be answerable by an external evaluator. Each question must link to a specific decision or learning need. Include one cost-effectiveness question.)

4. Methodology Requirements
   (Specify the minimum design required based on the gap. If no endline exists: quasi-experimental minimum. If no baseline exists: mixed methods minimum. Reference the Zenex Evidence Quality Standard v2.0 and specify minimum EQS score of 3.0/5.0 required for acceptance.)

5. Evaluation Scope
   (Phase, grades, provinces, duration, minimum school sample. Be specific.)

6. Data Access and Commitments
   (What Zenex will provide. What the evaluator must collect. What DBE data is available.)

7. Deliverables and Timeline
   (Inception report, baseline, midline if required, draft final, final report, board summary, policy brief, data set. Include page limits for each.)

8. Knowledge Use Plan
   (Who receives each deliverable. What decision each deliverable informs. By what date findings must be available to influence the next funding cycle.)

9. Budget Guidance
   (Reference total programme investment of R${totalInvestment.toLocaleString()}. Evaluation should not exceed 15% of programme investment. State indicative range.)

10. Evaluator Requirements
    (Specific competencies required. Independence provisions. Conflict of interest declaration.)

11. Submission Requirements
    (Deadline, format, contact, assessment criteria with weights matching Zenex standard.)

CRITICAL REQUIREMENTS:
- No em dashes or long dashes anywhere
- No bullet points in body text, use numbered lists
- UK English throughout
- Every section must contain specific numbers from the data provided above
- Reference prior evaluations by their actual findings
- Apply actuarial precision: where effect sizes exist, state confidence levels
- The TOR must be immediately usable by an independent evaluator with no further clarification needed`;
}

function computeGapAnalysis(records) {
  const totalInvestment = records.reduce((sum, r) => sum + (Number(r.total_cost_rand) || 0), 0);
  const hasEndline = records.some(r => r.record_series === 'ENDLINE' || r.endline_available);
  const hasBaseline = records.some(r => r.record_series === 'BASELINE' || r.baseline_available);
  const years = records.map(r => Number(r.year) || 0).filter(Boolean);
  const firstYear = years.length ? Math.min(...years) : null;
  const lastYear = years.length ? Math.max(...years) : null;
  const yearsWithoutEndline = lastYear ? CURRENT_YEAR - lastYear : null;
  const provinces = [...new Set(records.flatMap(r => r.provinces || []))];
  const highestEQS = records.reduce(
    (best, r) => ((Number(r.eqs_composite) || 0) > (Number(best?.eqs_composite) || 0) ? r : best),
    records[0]
  );
  const nlsAlignment = records.some(r => r.nls_alignment);
  const funrsAlignment = records.some(r => r.funrs_alignment);
  const programmeArea = records.find(r => r.programme_area)?.programme_area || null;

  return {
    totalInvestment, hasEndline, hasBaseline, firstYear, lastYear,
    yearsWithoutEndline, provinces, highestEQS, nlsAlignment, funrsAlignment, programmeArea,
  };
}

function sanitiseTor(text) {
  return text
    .replace(/—/g, ', ')
    .replace(/–/g, ' to ')
    .replace(/\bleverage\b/gi, 'use')
    .replace(/\butilise\b/gi, 'use')
    .replace(/\brobust\b/gi, '[REVIEW]')
    .replace(/\bcomprehensive\b/gi, '[REVIEW]')
    .replace(/\bdelve into\b/gi, 'examine')
    .replace(/\bit is worth noting\b/gi, '')
    .replace(/\bfurthermore,\b/gi, '')
    .replace(/\bmoreover,\b/gi, '');
}

router.post('/generate',
  requireRoles('ORGANISATION_LEAD', 'EVIDENCE_ANALYST'),
  async (req, res, next) => {
    try {
      const { programme_name: programmeName } = req.body;
      const tenant = req.tenant;

      if (!programmeName || !String(programmeName).trim()) {
        return res.status(400).json({ error: 'programme_name is required' });
      }

      const records = await db.getProgrammeRecordsForTor(tenant, programmeName);
      if (!records || records.length === 0) {
        return res.status(404).json({ error: 'No evaluation records found for this programme' });
      }

      const gap = computeGapAnalysis(records);

      const systemPrompt = buildSystemPrompt();
      const userPrompt = buildUserPrompt({ programmeName, records, gap });

      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 8000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });

      const torText = message.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');

      const sanitised = sanitiseTor(torText);

      return res.json({
        tor_text: sanitised,
        programme_name: programmeName,
        total_investment: gap.totalInvestment,
        evaluation_count: records.length,
        gap_type: gap.hasEndline ? 'no_impact_evaluation' : 'no_endline',
        years_without_endline: gap.yearsWithoutEndline,
        provinces: gap.provinces,
        source_records: records.map(r => ({
          id: r.id,
          year: r.year,
          document_type: r.document_type,
          eqs_tier: r.eqs_tier,
          eqs_composite: r.eqs_composite,
          key_finding_1: r.key_finding_1,
          key_finding_2: r.key_finding_2,
          original_filename: r.original_filename,
        })),
        generated_at: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  }
);

async function persistTorDocument(req, res, next, status) {
  try {
    const {
      programme_name: programmeName, tor_text: torText, total_investment: totalInvestment,
      evaluation_count: evaluationCount, gap_type: gapType, years_without_endline: yearsWithoutEndline,
    } = req.body;
    const tenant = req.tenant;

    if (!programmeName || !torText) {
      return res.status(400).json({ error: 'programme_name and tor_text are required' });
    }

    const saved = await db.saveTorDocument(tenant, {
      programme_name: programmeName,
      tor_text: torText,
      total_investment: totalInvestment,
      evaluation_count: evaluationCount,
      gap_type: gapType,
      years_without_endline: yearsWithoutEndline,
      status,
      generated_by: req.user?.sub || null,
    });

    const s3Key = `exports/tor/${status === 'PENDING_REVIEW' ? 'review' : 'drafts'}/${saved.id}.json`;
    await uploadJson({
      bucket: tenant.s3_vault_bucket,
      key: s3Key,
      data: saved,
      metadata: { tenant: tenant.slug, programme_name: programmeName, status },
    });

    return res.json({ success: true, id: saved.id, status, s3_key: s3Key });
  } catch (err) {
    next(err);
  }
}

router.post('/draft',
  requireRoles('ORGANISATION_LEAD', 'EVIDENCE_ANALYST'),
  (req, res, next) => persistTorDocument(req, res, next, 'DRAFT')
);

router.post('/submit-for-review',
  requireRoles('ORGANISATION_LEAD', 'EVIDENCE_ANALYST'),
  (req, res, next) => persistTorDocument(req, res, next, 'PENDING_REVIEW')
);

module.exports = router;
