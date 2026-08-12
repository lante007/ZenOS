'use strict';

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const { requireRoles } = require('../middleware/permissions');
const db = require('../services/db');
const { uploadJson } = require('../../src/s3-connector');

const anthropic = new Anthropic();

const CURRENT_YEAR = new Date().getFullYear();

// Same guard as api/services/flywheel.js - defence in depth even though
// every DB call in this file already goes through db.js's own identical
// check via withTenant/schemaFor.
function schemaFor(tenant) {
  const schema = tenant.db_schema || tenant.slug;
  if (!/^[a-z][a-z0-9_]*$/.test(schema || '')) {
    throw new Error(`Unsafe tenant schema: ${schema}`);
  }
  return schema;
}

// In-memory async job store for POST /generate. Deliberately not backed by
// RDS: jobs are short-lived (a few minutes) and single-process (pm2 runs
// this app in fork mode, not cluster), so there is no cross-process
// visibility requirement that would justify a DB round-trip on every poll.
// Jobs do not survive a pm2 restart.
const jobs = {};
const JOB_TTL_MS = 10 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of Object.entries(jobs)) {
    if (job.createdAt < cutoff) delete jobs[id];
  }
}, 60 * 1000).unref();

// Separate job store for POST /strategic-intelligence/refresh, same pattern
// as `jobs` above. Kept distinct so a jobId from one endpoint can never be
// polled against the other by mistake.
const siJobs = {};
const SI_JOB_TTL_MS = 10 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - SI_JOB_TTL_MS;
  for (const [id, job] of Object.entries(siJobs)) {
    if (job.createdAt < cutoff) delete siJobs[id];
  }
}, 60 * 1000).unref();

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

function buildUserPrompt({ programmeName, records, gap, strategicFocus, budget, openingNarrative }) {
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

  const openingNarrativeBlock = `SECTION 1 — OPENING NARRATIVE:

The following opening paragraph has been computed by the system from corpus data. Reproduce it exactly, word for word, as the first paragraph of Section 1. Do not rewrite, paraphrase, summarise, or alter it in any way.

"${openingNarrative}"

After this paragraph, continue Section 1 with additional programme context and background as instructed below. Do not repeat the facts already stated in the opening paragraph.`;

  const budgetGuidanceBlock = `SECTION 9 — BUDGET GUIDANCE:

The following figures have been computed by the system. Use them exactly as provided. Do not recalculate or modify them.

Recommended evaluation methodology: ${budget.recommendedMethodology}
Benchmark base range for this methodology: R${budget.base.min.toLocaleString()} to R${budget.base.max.toLocaleString()}
Geography adjustment applied: ${budget.geoMultiplier}x
  Reason: ${budget.geoReason}
Sample size adjustment applied: ${budget.sampleMultiplier}x
  Reason: ${budget.sampleReason}
Raw computed range: R${budget.rawMin.toLocaleString()} to R${budget.rawMax.toLocaleString()}
Governance cap (15% of R${totalInvestment.toLocaleString()}): R${budget.governanceCap.toLocaleString()}
${budget.capApplied ? 'Note: Raw range exceeded governance cap. Final range capped accordingly.' : 'Note: Raw range is within governance cap.'}

FINAL RECOMMENDED RANGE: R${budget.finalMin.toLocaleString()} to R${budget.finalMax.toLocaleString()}

In Section 9, write 3-4 sentences that:
1. State the final range clearly
2. Explain in plain language what drives the estimate (methodology type, geographic scope, sample size)
3. Note whether the governance cap was applied and why that matters
4. State that these are benchmark estimates pending empirical calibration from Zenex's own commissioning history

Do NOT write any numbers other than those provided above.
Do NOT recalculate.
Do NOT add contingency percentages or other adjustments.
The system has already computed the range.`;

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
${openingNarrativeBlock}

${budgetGuidanceBlock}

SECTION HEADER FORMAT (must follow exactly, this output is machine-parsed):
Write each of the 11 top-level section headers on its own line as "## N. Title", for example "## 1. Programme Context and Background". Use this exact "## N. " pattern only for these 11 top-level headers, nowhere else in the document. Sub-headings within a section must use a different format, for example "### 1.1 Programme Overview" or bold text, never "## N. " with a bare number. Numbered lists within a section body must use "N)" or a plain dash, never "N. " at the start of a line.

Generate a complete 11-section evaluation TOR with these sections:

1. Programme Context and Background
   (Follow the SECTION 1 — OPENING NARRATIVE instructions above exactly: reproduce that paragraph verbatim, unchanged, as the first paragraph. Then continue with additional programme context: reference prior evaluations by name, year, and key finding. Include actuarial framing: what is the probability of replication given prior evidence?)

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
   (Follow the SECTION 9 — BUDGET GUIDANCE instructions above exactly. Use only the figures provided there.)

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
  const hasProcess = records.some(r => r.document_type === 'Process Evaluation' || r.secondary_document_type === 'Process Evaluation');

  return {
    totalInvestment, hasEndline, hasBaseline, firstYear, lastYear,
    yearsWithoutEndline, provinces, highestEQS, nlsAlignment, funrsAlignment, programmeArea, hasProcess,
  };
}

function formatRandCompact(value) {
  const num = Number(value) || 0;
  if (num >= 1000000) return `R${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `R${(num / 1000).toFixed(0)}K`;
  return `R${num.toLocaleString()}`;
}

function formatTierLabel(tier) {
  if (!tier) return 'unrated';
  return String(tier).replace(/^TIER_/i, 'Tier ');
}

function narrativeGapDescription(gap) {
  if (!gap.hasEndline) {
    const baselineClause = gap.hasBaseline
      ? 'A baseline evaluation exists but no endline evaluation has been commissioned'
      : 'No baseline or endline evaluation has been commissioned';
    const yearsClause = gap.yearsWithoutEndline
      ? ` in ${gap.yearsWithoutEndline} year${gap.yearsWithoutEndline === 1 ? '' : 's'}`
      : '';
    return `${baselineClause}${yearsClause}.`;
  }
  return 'No impact evaluation exists for this programme despite prior evaluation activity.';
}

function narrativeClosing(gap) {
  return !gap.hasEndline
    ? 'This Terms of Reference proposes the endline evaluation to complete the evidence cycle.'
    : 'This Terms of Reference proposes the next evaluation to address this gap.';
}

// Section 1 opening paragraph for TOR Section 1. Principle: code computes
// the narrative from corpus data, Claude does not rewrite it - see the
// SECTION 1 block in buildUserPrompt, which instructs Claude to reproduce
// this paragraph verbatim as the opening of Section 1.
function computeOpeningNarrative(programmeName, gap, records) {
  const evalCount = records.length;
  const evalWord = evalCount === 1 ? 'evaluation' : 'evaluations';
  const hasHaveWord = evalCount === 1 ? 'has' : 'have';
  const tierLabel = formatTierLabel(gap.highestEQS?.eqs_tier);
  const investment = formatRandCompact(gap.totalInvestment);

  return `${programmeName} has received ${investment} in Zenex investment since ${gap.firstYear}. `
    + `${evalCount} ${evalWord} ${hasHaveWord} been commissioned, most recently in ${gap.lastYear} (${tierLabel} quality). `
    + `${narrativeGapDescription(gap)} ${narrativeClosing(gap)}`;
}

// Budget estimate for TOR Section 9. Principle: code determines the
// estimate, Claude only explains it in prose - see buildUserPrompt's
// SECTION 9 block, which forbids Claude from recalculating any figure.
const BENCHMARK_RATES = {
  'RCT': { min: 2500000, max: 5000000 },
  'Quasi-Experimental': { min: 1500000, max: 3000000 },
  'Mixed Methods': { min: 800000, max: 1500000 },
  'Qualitative': { min: 400000, max: 800000 },
  'Pre-Post Without Comparison': { min: 600000, max: 1200000 },
  'Cross-Sectional': { min: 500000, max: 1000000 },
  'Literature Review': { min: 150000, max: 400000 },
  'default': { min: 500000, max: 1500000 },
};

const RURAL_PROVINCES = ['Limpopo', 'Eastern Cape', 'Northern Cape', 'Mpumalanga', 'North West', 'Free State'];

const GOVERNANCE_CAP_PCT = 0.15;

function computeBudgetEstimate(records, gap) {
  const { hasBaseline, hasEndline, hasProcess, totalInvestment } = gap;

  const recommendedMethodology = (hasBaseline && !hasEndline && totalInvestment > 5000000)
    ? 'Quasi-Experimental'
    : (!hasBaseline && !hasEndline && totalInvestment > 20000000)
      ? 'RCT'
      : (!hasProcess)
        ? 'Mixed Methods'
        : 'Qualitative';

  const base = BENCHMARK_RATES[recommendedMethodology] || BENCHMARK_RATES['default'];

  const provinces = records.flatMap(r => r.provinces || []).filter(Boolean);
  const uniqueProvinces = [...new Set(provinces)];
  const ruralCount = uniqueProvinces.filter(p => RURAL_PROVINCES.includes(p)).length;
  const urbanCount = uniqueProvinces.length - ruralCount;

  let geoMultiplier = 1.0;
  let geoReason = 'Single province, standard rate';
  if (uniqueProvinces.length >= 7) {
    geoMultiplier = 1.5;
    geoReason = 'National scope (7+ provinces)';
  } else if (uniqueProvinces.length >= 4) {
    geoMultiplier = 1.3;
    geoReason = 'Multi-provincial (4+ provinces)';
  } else if (ruralCount > 0 && ruralCount >= urbanCount) {
    geoMultiplier = 1.35;
    geoReason = 'Rural-majority provinces (travel and accommodation premium)';
  } else if (uniqueProvinces.length === 1 && urbanCount === 1) {
    geoMultiplier = 0.85;
    geoReason = 'Single urban province (lower logistics cost)';
  }

  const schoolSamples = records.map(r => r.sample_size_schools).filter(Boolean);
  const avgSchools = schoolSamples.length
    ? Math.round(schoolSamples.reduce((a, b) => a + b, 0) / schoolSamples.length)
    : 0;

  let sampleMultiplier = 1.0;
  let sampleReason = 'Sample size not recorded';
  if (avgSchools > 150) {
    sampleMultiplier = 1.4;
    sampleReason = 'Large sample (150+ schools avg)';
  } else if (avgSchools > 75) {
    sampleMultiplier = 1.2;
    sampleReason = 'Moderate-large sample (75-150 schools)';
  } else if (avgSchools > 30) {
    sampleMultiplier = 1.0;
    sampleReason = 'Standard sample (30-75 schools)';
  } else if (avgSchools > 0) {
    sampleMultiplier = 0.85;
    sampleReason = 'Small sample (<30 schools)';
  }

  const rawMin = Math.round(base.min * geoMultiplier * sampleMultiplier);
  const rawMax = Math.round(base.max * geoMultiplier * sampleMultiplier);

  const governanceCap = Math.round(totalInvestment * GOVERNANCE_CAP_PCT);
  const finalMax = governanceCap > 0 ? Math.min(rawMax, governanceCap) : rawMax;
  const finalMin = Math.min(rawMin, finalMax * 0.6);
  const capApplied = finalMax < rawMax;

  return {
    recommendedMethodology, base, uniqueProvinces, ruralCount, urbanCount,
    geoMultiplier, geoReason, avgSchools, sampleMultiplier, sampleReason,
    rawMin, rawMax, governanceCap, finalMin, finalMax, capApplied,
  };
}

async function saveBudgetAuditLog(tenant, { programmeName, torId, records, gap, budget }) {
  const budgetAuditLog = {
    programme_name: programmeName,
    generated_at: new Date().toISOString(),
    inputs: {
      recommended_methodology: budget.recommendedMethodology,
      total_investment: gap.totalInvestment,
      unique_provinces: budget.uniqueProvinces,
      rural_count: budget.ruralCount,
      urban_count: budget.urbanCount,
      avg_schools_sample: budget.avgSchools,
      eval_count: records.length,
    },
    computation: {
      benchmark_base_min: budget.base.min,
      benchmark_base_max: budget.base.max,
      geo_multiplier: budget.geoMultiplier,
      geo_reason: budget.geoReason,
      sample_multiplier: budget.sampleMultiplier,
      sample_reason: budget.sampleReason,
      raw_min: budget.rawMin,
      raw_max: budget.rawMax,
      governance_cap: budget.governanceCap,
      governance_cap_pct: GOVERNANCE_CAP_PCT * 100,
      cap_applied: budget.capApplied,
      final_min: budget.finalMin,
      final_max: budget.finalMax,
    },
    note: 'Benchmark rates are illustrative estimates pending empirical calibration from Zenex historical commissioning data.',
  };

  try {
    const schema = schemaFor(tenant);
    const pool = db.getPool();
    if (!pool) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${schema}.tor_budget_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        programme_name VARCHAR(300),
        tor_id VARCHAR(100),
        audit_log JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      INSERT INTO ${schema}.tor_budget_logs (programme_name, tor_id, audit_log, created_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT DO NOTHING
    `, [programmeName, torId, JSON.stringify(budgetAuditLog)]);
  } catch (err) {
    console.error(`[tor] budget audit log failed for "${programmeName}": ${err.message}`);
  }
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

// The actual generation work - unchanged from the previous synchronous
// handler, just extracted so it can run detached from the request/response
// cycle. No change to the Claude call logic or prompts themselves.
async function runTorGeneration(tenant, { programmeName, strategicFocus, records, generatedBy, jobId }) {
  const gap = computeGapAnalysis(records);

  // Budget: code computes the estimate, Claude only explains it in prose.
  // See buildUserPrompt's SECTION 9 block, which forbids recalculation.
  const budget = computeBudgetEstimate(records, gap);
  await saveBudgetAuditLog(tenant, { programmeName, torId: jobId || null, records, gap, budget });

  // Section 1 opening: code computes the narrative from corpus data, Claude
  // reproduces it verbatim rather than writing its own. See buildUserPrompt's
  // SECTION 1 block, which forbids rewriting.
  const openingNarrative = computeOpeningNarrative(programmeName, gap, records);

  // CALL 1: TOR generation. Internal corpus only, no web search.
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt({ programmeName, records, gap, strategicFocus, budget, openingNarrative });

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
      generatedBy,
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

  return {
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
  };
}

router.post('/generate',
  requireRoles('ORGANISATION_LEAD', 'EVIDENCE_ANALYST'),
  async (req, res, next) => {
    // Auth and tenant access are already enforced above this handler by
    // authenticate()/assertNoBoardAccess (server.js) and requireRoles just
    // above, so by the time this body runs auth has already succeeded.
    try {
      schemaFor(req.tenant);

      const { programme_name: programmeName, strategic_focus: strategicFocus } = req.body;
      const tenant = req.tenant;

      if (!programmeName || !String(programmeName).trim()) {
        return res.status(400).json({ error: 'programme_name is required' });
      }

      // Fast, cheap validation happens synchronously, before any job is
      // created - only the slow Claude calls run in the background.
      const records = await db.getProgrammeRecordsForTor(tenant, programmeName);
      if (!records || records.length === 0) {
        return res.status(404).json({ error: 'No evaluation records found for this programme' });
      }

      // De-dup: reuse an existing pending job for the same programme and
      // tenant rather than spawning a second one from a rapid double-click.
      const existing = Object.entries(jobs).find(([, job]) =>
        job.status === 'pending' &&
        job.tenantId === tenant.slug &&
        job.programmeName === programmeName
      );
      if (existing) {
        return res.status(202).json({ jobId: existing[0], status: 'pending' });
      }

      const jobId = crypto.randomUUID();
      jobs[jobId] = {
        status: 'pending',
        result: null,
        error: null,
        tenantId: tenant.slug,
        userId: req.user?.sub || null,
        programmeName,
        createdAt: Date.now(),
      };

      res.status(202).json({ jobId, status: 'pending' });

      (async () => {
        try {
          const result = await runTorGeneration(tenant, {
            programmeName, strategicFocus, records, generatedBy: req.user?.sub, jobId,
          });
          jobs[jobId].status = 'complete';
          jobs[jobId].result = result;
        } catch (err) {
          console.error(`[tor] generation job ${jobId} failed: ${err.message}`);
          jobs[jobId].status = 'failed';
          jobs[jobId].error = err.message;
        }
      })();
    } catch (err) {
      next(err);
    }
  }
);

router.get('/generate/status/:jobId',
  requireRoles('ORGANISATION_LEAD', 'EVIDENCE_ANALYST'),
  (req, res, next) => {
    try {
      schemaFor(req.tenant);

      const job = jobs[req.params.jobId];
      // A jobId alone is not an authorisation boundary: a job belonging to
      // a different tenant or a different user within the same tenant
      // returns 404, not 403, so its existence is never confirmed to an
      // unauthorised caller.
      if (!job || job.tenantId !== req.tenant.slug || job.userId !== (req.user?.sub || null)) {
        return res.status(404).json({ error: 'Job not found' });
      }

      const response = { jobId: req.params.jobId, status: job.status };
      if (job.status === 'complete') response.result = job.result;
      if (job.status === 'failed') response.error = job.error;
      return res.json(response);
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
    // Async job pattern, same as POST /generate - this call makes a
    // synchronous, web-search-enabled Claude call that can run past
    // CloudFront's origin timeout, so it must not block the response.
    try {
      const { programme_name: programmeName, programme_area: programmeArea } = req.body;
      const tenant = req.tenant;

      if (!programmeName || !String(programmeName).trim()) {
        return res.status(400).json({ error: 'programme_name is required' });
      }

      // Fast, cheap validation happens synchronously, before any job is
      // created - only the slow Claude call runs in the background.
      const records = await db.getProgrammeRecordsForTor(tenant, programmeName);
      if (!records || records.length === 0) {
        return res.status(404).json({ error: 'No evaluation records found for this programme' });
      }
      const gap = computeGapAnalysis(records);

      // De-dup: reuse an existing pending job for the same programme and
      // tenant rather than spawning a second one from a rapid double-click.
      const existing = Object.entries(siJobs).find(([, job]) =>
        job.status === 'pending' &&
        job.tenantId === tenant.slug &&
        job.programmeName === programmeName
      );
      if (existing) {
        return res.status(202).json({ jobId: existing[0], status: 'pending' });
      }

      const jobId = crypto.randomUUID();
      siJobs[jobId] = {
        status: 'pending',
        result: null,
        error: null,
        tenantId: tenant.slug,
        userId: req.user?.sub || null,
        programmeName,
        createdAt: Date.now(),
      };

      res.status(202).json({ jobId, status: 'pending' });

      (async () => {
        try {
          const result = await runFreshStrategicIntelligence(tenant, {
            programmeName,
            programmeArea: programmeArea || gap.programmeArea,
            existingEvidenceSummary: buildEvidenceSummary(records, gap),
            generatedBy: req.user?.sub,
          });
          siJobs[jobId].status = 'complete';
          siJobs[jobId].result = result;
        } catch (err) {
          console.error(`[tor] strategic intelligence refresh job ${jobId} failed: ${err.message}`);
          siJobs[jobId].status = 'failed';
          siJobs[jobId].error = err.message;
        }
      })();
    } catch (err) {
      next(err);
    }
  }
);

router.get('/strategic-intelligence/status/:jobId',
  requireRoles('ORGANISATION_LEAD', 'EVIDENCE_ANALYST'),
  (req, res, next) => {
    try {
      const job = siJobs[req.params.jobId];
      // A jobId alone is not an authorisation boundary: a job belonging to
      // a different tenant or a different user within the same tenant
      // returns 404, not 403, so its existence is never confirmed to an
      // unauthorised caller.
      if (!job || job.tenantId !== req.tenant.slug || job.userId !== (req.user?.sub || null)) {
        return res.status(404).json({ error: 'Job not found' });
      }

      if (job.status === 'complete') {
        return res.json({
          status: 'complete',
          opportunities: job.result?.opportunities || [],
          id: job.result?.id,
          generated_at: job.result?.generated_at,
        });
      }
      if (job.status === 'failed') {
        return res.json({ status: 'failed', error: job.error });
      }
      return res.json({ status: 'pending' });
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
