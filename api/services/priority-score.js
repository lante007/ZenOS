'use strict';

const AREA_ALIGNMENT = {
  'Early Grade Literacy and Numeracy': 100,
  'Early Grade Numeracy': 90,
  'System Wide Initiatives': 80,
  'Schools Programme': 60,
  'Research and Evaluations': 40,
  'Thought Leadership': 40,
};

const WEIGHTS = {
  strategicAlignment: 0.30,
  evidenceAge: 0.25,
  investmentMagnitude: 0.20,
  evidenceGapSeverity: 0.15,
  dbePolicyRelevance: 0.10,
};

const SEVERITY_SCORE = { HIGH: 100, MEDIUM: 60, LOW: 30 };

const INVESTMENT_CAP_RAND = 25_000_000;
const AGE_YEARS_FOR_MAX_SCORE = 10;

function strategicAlignmentScore(programmeArea) {
  return AREA_ALIGNMENT[programmeArea] ?? 50;
}

function evidenceAgeScore(yearValue, referenceDate = new Date()) {
  const year = parseInt(yearValue, 10);
  if (!Number.isFinite(year)) return 50;
  const yearsSince = referenceDate.getFullYear() - year;
  return Math.min(100, Math.max(0, Math.round((yearsSince / AGE_YEARS_FOR_MAX_SCORE) * 100)));
}

function investmentMagnitudeScore(totalCostRand) {
  const value = Number(totalCostRand) || 0;
  return Math.min(100, Math.max(0, Math.round((value / INVESTMENT_CAP_RAND) * 100)));
}

function evidenceGapSeverityScore(priority) {
  return SEVERITY_SCORE[priority] ?? SEVERITY_SCORE.MEDIUM;
}

function dbePolicyRelevanceScore(record) {
  if (record.nls_alignment === true && record.funrs_alignment === true) return 100;
  if (record.nls_alignment === true || record.funrs_alignment === true) return 70;

  const text = (record.policy_alignment || '').toLowerCase();
  if (
    text.includes('nls 2024') ||
    text.includes('nls2024') ||
    text.includes('funrs 2025') ||
    text.includes('funrs2025') ||
    text.includes('national literacy') ||
    text.includes('reading panel')
  ) {
    return 80;
  }
  if (text.length > 10) return 40;
  return 0;
}

function computePriorityScore(record, { priority } = {}) {
  const strategic = strategicAlignmentScore(record.programme_area);
  const age = evidenceAgeScore(record.year);
  const investment = investmentMagnitudeScore(record.total_cost_rand);
  const severity = evidenceGapSeverityScore(priority);
  const policy = dbePolicyRelevanceScore(record);

  const score =
    strategic * WEIGHTS.strategicAlignment +
    age * WEIGHTS.evidenceAge +
    investment * WEIGHTS.investmentMagnitude +
    severity * WEIGHTS.evidenceGapSeverity +
    policy * WEIGHTS.dbePolicyRelevance;

  return Math.round(Math.min(100, Math.max(0, score)));
}

function tierForScore(score) {
  if (score >= 80) return 'CRITICAL';
  if (score >= 50) return 'IMPORTANT';
  return 'INFORMATIONAL';
}

// Operational alerts (queue backlog, board proximity) aren't tied to a single
// evidence record, so strategic alignment / investment / policy relevance
// have no data to score against. Running them through computePriorityScore
// with neutral defaults for those factors mutes their severity (a HIGH
// operational alert would land as INFORMATIONAL, the lowest tier, which
// contradicts the alert being raised as urgent in the first place). Map
// severity straight to a score instead.
const OPERATIONAL_SCORE = { HIGH: 85, MEDIUM: 65, LOW: 35 };

function operationalPriorityScore(priority) {
  return OPERATIONAL_SCORE[priority] ?? OPERATIONAL_SCORE.MEDIUM;
}

module.exports = {
  AREA_ALIGNMENT,
  computePriorityScore,
  operationalPriorityScore,
  tierForScore,
  strategicAlignmentScore,
  evidenceAgeScore,
  investmentMagnitudeScore,
  evidenceGapSeverityScore,
  dbePolicyRelevanceScore,
};
