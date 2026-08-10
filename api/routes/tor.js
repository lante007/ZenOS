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

function buildUserPrompt({ programmeName, records, gap, strategicFocus }) {
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
${strategicFocus ? `\nADDITIONAL COMMISSIONING FOCUS (raised by strategic intelligence, give this explicit attention in the Evaluation Purpose and Evaluation Questions sections):\n${strategicFocus}\n` : ''}
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

const SI_OPPORTUNITY_TYPES = ['POLICY_ALIGNMENT', 'SECTOR_WHITE_SPACE', 'ZENEX_ADVANTAGE'];

function buildEvidenceSummary(records, gap) {
  const lines = records.map(r =>
    `- ${r.year}: ${r.document_type} (EQS ${r.eqs_tier}${r.eqs_composite ? ` ${r.eqs_composite}/5.0` : ''}) - ${r.key_finding_1 || 'finding not recorded'}`
  ).join('\n');
  const gapLine = !gap.hasEndline
    ? `No endline evaluation for ${gap.yearsWithoutEndline} years despite R${gap.totalInvestment.toLocaleString()} invested.`
    : `No impact evaluation exists for this programme.`;
  return `${records.length} prior evaluation${records.length !== 1 ? 's' : ''} on record.\n${lines}\n\nEvidence gap: ${gapLine}`;
}

function buildStrategicIntelligenceSystemPrompt() {
  return `You are a strategic intelligence analyst for Zenex Foundation, a South African education funder.

Your task is to identify forward-looking strategic evidence opportunities for Zenex. You have access to web search.

The objective is NOT simply to identify gaps in Zenex's own archive. Look outward and identify what Zenex may need to learn next given:

1. current South African government strategy
2. current education-sector evidence
3. gaps in the South African evidence base
4. international evidence
5. the activity of other South African education funders
6. Zenex Foundation's existing evidence and 30-year investment

RULES:
- UK English
- No em dashes
- Use specific policy references and dates
- Prefer primary and authoritative sources
- Cite the specific source supporting each strategic claim
- Do not make generic statements
- Distinguish clearly between absence of evidence and evidence of absence
- Do not invent or infer commissioning activity that cannot be supported by the search
- If web search finds nothing sufficiently specific, say so honestly
- Do not manufacture an opportunity simply to fill a card
- The output must be advisory intelligence, not a definitive commissioning recommendation
- Do NOT claim that no funder has commissioned something unless the available evidence genuinely supports that claim. If the search only establishes that no relevant commissioning was identified, state that explicitly
- Do not claim that Zenex is literally the only organisation able to answer a question unless the evidence clearly establishes this. Prefer language such as "Zenex is unusually positioned" or "Zenex has a distinctive evidence base"
- Return valid JSON only. No markdown, no preamble, no explanation outside the JSON array`;
}

function buildStrategicIntelligenceUserPrompt({ programmeName, programmeArea, existingEvidenceSummary }) {
  return `SEARCH FOR:

1. Current DBE strategy documents and implementation priorities relevant to ${programmeArea}.
2. Recent PIRLS, TIMSS, SEACMEQ and other authoritative assessment/research findings relevant to ${programmeArea}.
3. What other South African education funders are currently commissioning, studying or publishing in this area.
4. International evidence on what works in comparable education contexts.

Programme being evaluated: ${programmeName}
Programme area: ${programmeArea}

Zenex's existing evidence:
${existingEvidenceSummary}

IDENTIFY THREE STRATEGIC INTELLIGENCE OPPORTUNITIES:

1. POLICY ALIGNMENT
Identify where current DBE strategy or implementation priorities create a demand for evidence that is not adequately answered by the available evidence.
Question to answer: "What does government now need to know that the available evidence does not adequately answer?"

2. SECTOR WHITE SPACE
Identify an important evidence question where relevant South African evidence appears limited or where no relevant commissioned evaluation was identified through the searched sources.
Question to answer: "What important question is the South African sector not yet answering?"

3. ZENEX ADVANTAGE
Identify an evidence question where Zenex's accumulated investment, programme history, longitudinal evidence or position in the sector gives it an unusual ability to answer the question.
Question to answer: "What can Zenex answer unusually well because of its existing evidence and 30-year investment?"

FOR EACH OPPORTUNITY RETURN:
- opportunity_type: one of POLICY_ALIGNMENT, SECTOR_WHITE_SPACE, ZENEX_ADVANTAGE
- title: maximum 5 words
- question: the specific unanswered question
- context: maximum 2 sentences, specific rather than generic
- commissioning_suggestion: 1 actionable sentence
- sources: array of objects with "url" and "title", the authoritative sources supporting the finding
- confidence: HIGH, MODERATE or LOW
- evidence_found: true or false
- commissioning_priority_score: an object with policy_demand, evidence_white_space, zenex_advantage and potential_decision_value, each scored 1 to 10

Return a JSON array of exactly three objects, one per opportunity type, in this exact structure:

[
  {
    "opportunity_type": "POLICY_ALIGNMENT",
    "title": "...",
    "question": "...",
    "context": "...",
    "commissioning_suggestion": "...",
    "sources": [{ "url": "...", "title": "..." }],
    "confidence": "HIGH",
    "evidence_found": true,
    "commissioning_priority_score": { "policy_demand": 10, "evidence_white_space": 9, "zenex_advantage": 8, "potential_decision_value": 10 }
  }
]

Return valid JSON only.`;
}

function clampScore(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 1;
  return Math.min(10, Math.max(1, Math.round(num)));
}

function normaliseOpportunities(parsed) {
  if (!Array.isArray(parsed)) throw new Error('Strategic intelligence response was not a JSON array');
  return parsed.map(item => {
    const scores = item.commissioning_priority_score || {};
    const policyDemand = clampScore(scores.policy_demand);
    const evidenceWhiteSpace = clampScore(scores.evidence_white_space);
    const zenexAdvantage = clampScore(scores.zenex_advantage);
    const potentialDecisionValue = clampScore(scores.potential_decision_value);
    const composite = Number(((policyDemand + evidenceWhiteSpace + zenexAdvantage + potentialDecisionValue) / 4).toFixed(2));

    return {
      opportunity_type: SI_OPPORTUNITY_TYPES.includes(item.opportunity_type) ? item.opportunity_type : null,
      title: String(item.title || '').slice(0, 60),
      question: item.question || '',
      context: item.context || '',
      commissioning_suggestion: item.commissioning_suggestion || '',
      sources: Array.isArray(item.sources)
        ? item.sources.filter(s => s && s.url).map(s => ({ url: s.url, title: s.title || s.url })).slice(0, 5)
        : [],
      confidence: ['HIGH', 'MODERATE', 'LOW'].includes(item.confidence) ? item.confidence : 'LOW',
      evidence_found: item.evidence_found === true,
      commissioning_priority_score: {
        policy_demand: policyDemand,
        evidence_white_space: evidenceWhiteSpace,
        zenex_advantage: zenexAdvantage,
        potential_decision_value: potentialDecisionValue,
        composite,
      },
    };
  }).filter(item => item.opportunity_type);
}

async function runFreshStrategicIntelligence(tenant, { programmeName, programmeArea, existingEvidenceSummary, generatedBy }) {
  const systemPrompt = buildStrategicIntelligenceSystemPrompt();
  const userPrompt = buildStrategicIntelligenceUserPrompt({
    programmeName,
    programmeArea: programmeArea || 'not recorded',
    existingEvidenceSummary,
  });

  // Uses a direct API call rather than the @anthropic-ai/sdk client used
  // elsewhere in this file: the installed SDK version (0.26.x) predates the
  // web_search_20250305 server tool, and bumping that shared dependency
  // would risk the three other existing routes that depend on it.
  const apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'web-search-2025-03-05',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      // Spec called for 2000, but that consistently truncated the JSON
      // mid-generation in production testing: web search reasoning eats
      // into the same budget as the final 3-opportunity JSON output.
      max_tokens: 4000,
      system: systemPrompt,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  const message = await apiResponse.json();
  if (!apiResponse.ok) {
    throw new Error(message?.error?.message || `Anthropic API returned ${apiResponse.status}`);
  }

  let rawText = (message.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  rawText = rawText
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const firstBracket = rawText.indexOf('[');
  const lastBracket = rawText.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    rawText = rawText.slice(firstBracket, lastBracket + 1);
  }

  const parsed = JSON.parse(rawText);
  const opportunities = normaliseOpportunities(parsed);

  const saved = await db.saveStrategicIntelligence(tenant, {
    programme_name: programmeName,
    opportunities,
    model_used: 'claude-sonnet-4-6',
    generated_by: generatedBy,
  });

  return { id: saved.id, opportunities, generated_at: saved.generated_at, cached: false };
}

async function getStrategicIntelligence(tenant, params, { forceRefresh } = {}) {
  if (!forceRefresh) {
    const cached = await db.getLatestStrategicIntelligence(tenant, params.programmeName);
    if (cached) {
      const dismissed = await db.listStrategicIntelligenceDismissals(tenant, cached.id);
      const dismissedTypes = new Set(dismissed.map(d => d.opportunity_type));
      return {
        id: cached.id,
        opportunities: (cached.opportunities || []).filter(o => !dismissedTypes.has(o.opportunity_type)),
        generated_at: cached.generated_at,
        cached: true,
      };
    }
  }
  return runFreshStrategicIntelligence(tenant, params);
}

router.post('/generate',
  requireRoles('ORGANISATION_LEAD', 'EVIDENCE_ANALYST'),
  async (req, res, next) => {
    try {
      const { programme_name: programmeName, strategic_focus: strategicFocus } = req.body;
      const tenant = req.tenant;

      if (!programmeName || !String(programmeName).trim()) {
        return res.status(400).json({ error: 'programme_name is required' });
      }

      const records = await db.getProgrammeRecordsForTor(tenant, programmeName);
      if (!records || records.length === 0) {
        return res.status(404).json({ error: 'No evaluation records found for this programme' });
      }

      const gap = computeGapAnalysis(records);

      // CALL 1: TOR generation. Internal corpus only, no web search.
      const systemPrompt = buildSystemPrompt();
      const userPrompt = buildUserPrompt({ programmeName, records, gap, strategicFocus });

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

      // CALL 2: Strategic intelligence. Separate, web-search-enabled call.
      // A failure here must never fail TOR generation - the TOR is already
      // successfully produced above.
      let strategicIntelligence;
      try {
        strategicIntelligence = await getStrategicIntelligence(tenant, {
          programmeName,
          programmeArea: gap.programmeArea,
          existingEvidenceSummary: buildEvidenceSummary(records, gap),
          generatedBy: req.user?.sub,
        });
      } catch (siErr) {
        console.error(`[tor] strategic intelligence failed for "${programmeName}": ${siErr.message}`);
        strategicIntelligence = {
          id: null,
          opportunities: [],
          generated_at: null,
          cached: false,
          error: 'Strategic intelligence could not be generated. Try again.',
        };
      }

      return res.json({
        tor_text: sanitised,
        programme_name: programmeName,
        total_investment: gap.totalInvestment,
        evaluation_count: records.length,
        gap_type: gap.hasEndline ? 'no_impact_evaluation' : 'no_endline',
        years_without_endline: gap.yearsWithoutEndline,
        last_evaluation_year: gap.lastYear,
        provinces: gap.provinces,
        programme_area: gap.programmeArea,
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
        strategic_intelligence: strategicIntelligence,
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

router.post('/strategic-intelligence/refresh',
  requireRoles('ORGANISATION_LEAD', 'EVIDENCE_ANALYST'),
  async (req, res, next) => {
    try {
      const { programme_name: programmeName, programme_area: programmeArea } = req.body;
      const tenant = req.tenant;

      if (!programmeName || !String(programmeName).trim()) {
        return res.status(400).json({ error: 'programme_name is required' });
      }

      const records = await db.getProgrammeRecordsForTor(tenant, programmeName);
      if (!records || records.length === 0) {
        return res.status(404).json({ error: 'No evaluation records found for this programme' });
      }
      const gap = computeGapAnalysis(records);

      const result = await runFreshStrategicIntelligence(tenant, {
        programmeName,
        programmeArea: programmeArea || gap.programmeArea,
        existingEvidenceSummary: buildEvidenceSummary(records, gap),
        generatedBy: req.user?.sub,
      });

      return res.json({ success: true, strategic_intelligence: result });
    } catch (err) {
      next(err);
    }
  }
);

router.post('/strategic-intelligence/:id/dismiss',
  requireRoles('ORGANISATION_LEAD', 'EVIDENCE_ANALYST'),
  async (req, res, next) => {
    try {
      const { opportunity_type: opportunityType, opportunity_title: opportunityTitle } = req.body;
      if (!SI_OPPORTUNITY_TYPES.includes(opportunityType)) {
        return res.status(400).json({ error: 'A valid opportunity_type is required' });
      }
      const dismissal = await db.dismissStrategicIntelligenceOpportunity(
        req.tenant, req.params.id, opportunityType, opportunityTitle, req.user?.sub
      );
      return res.json({ success: true, dismissed: dismissal });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
