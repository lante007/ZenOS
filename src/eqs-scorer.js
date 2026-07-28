'use strict';
/**
 * ADEI EQS Scorer
 * Evidence Quality Score — pathway-based v2.0 scoring for new classifications
 * Taxonomy v2.1 · Scoring Logic v2.0
 *
 * EQS v2.0 uses five equally weighted dimensions, with the fifth dimension
 * adapted to the document pathway. Existing database records are not rescored.
 */

function detectEQSPathway(documentType, evaluationSubtype) {
  const dt = (documentType || '').toLowerCase();
  const es = (evaluationSubtype || '').toLowerCase();

  if (dt.includes('impact')) {
    if (
      es.includes('rct') ||
      es.includes('randomis') ||
      es.includes('quasi')
    ) {
      return {
        pathway: 'IMPACT_CAUSAL',
        multiplier: 1.00,
        label: 'Impact evaluation (causal design)',
      };
    }
    return {
      pathway: 'IMPACT_DESCRIPTIVE',
      multiplier: 0.85,
      label: 'Impact evaluation (descriptive design)',
    };
  }
  if (dt.includes('process') || dt.includes('implementation')) {
    return {
      pathway: 'PROCESS_IMPLEMENTATION',
      multiplier: 0.75,
      label: 'Process or implementation evaluation',
    };
  }
  if (
    dt.includes('research') ||
    dt.includes('formative') ||
    dt.includes('baseline') ||
    dt.includes('landscape') ||
    dt.includes('literature')
  ) {
    return {
      pathway: 'FORMATIVE_BASELINE',
      multiplier: 0.60,
      label: 'Formative, baseline, or landscape study',
    };
  }
  return {
    pathway: 'NOT_APPLICABLE',
    multiplier: null,
    label: 'No EQS pathway applicable',
  };
}

// Scoring rubrics per dimension
function scoreMethodologicalRigour(classification) {
  const subtype = (classification.evaluation_subtype || '').toLowerCase();
  const hasControl = classification.has_control_group;

  if (subtype.includes('rct') || subtype.includes('randomis')) {
    return hasControl ? 4.5 : 4.0;
  }
  if (subtype.includes('quasi') || subtype.includes('difference-in-difference') || subtype.includes('did')) {
    return hasControl ? 3.8 : 3.5;
  }
  if (subtype.includes('pre-post') || subtype.includes('pre/post')) {
    return hasControl ? 3.2 : 2.8;
  }
  if (subtype.includes('mixed')) {
    return 3.0;
  }
  if (subtype.includes('descriptive') || subtype.includes('formative')) {
    return 2.5;
  }
  if (subtype.includes('literature') || subtype.includes('landscape')) {
    return null; // Research studies do not receive Rigour score
  }
  return 2.0; // Default for unclear methodology
}

function scoreDataQuality(classification) {
  let score = 2.0;
  const learners = parseInt(classification.sample_size_learners || '0');
  const schools = parseInt(classification.sample_size_schools || '0');

  // Sample size contribution
  if (learners > 1000 || schools > 50) score += 1.0;
  else if (learners > 500 || schools > 20) score += 0.7;
  else if (learners > 100 || schools > 5) score += 0.3;

  // Instruments
  if (classification.theory_of_change_explicit) score += 0.3;

  // Attrition / retention implied
  if (learners > 500) score += 0.2;

  return Math.min(5.0, score);
}

function scoreTransparency(classification) {
  let score = 2.5;
  if (classification.theory_of_change_explicit) score += 0.5;
  if (classification.null_findings_reported) score += 0.3;
  if (classification.evidence_gap_1) score += 0.2;
  if (classification.cost_data_present === 'AUDITED') score += 0.3;
  else if (classification.cost_data_present === 'PROXY') score += 0.1;
  return Math.min(5.0, score);
}

function scoreReplicability(classification) {
  let score = 2.0;
  if (classification.dosage_documented) score += 0.8;
  if (classification.fidelity_reported) score += 0.8;
  if ((classification.provinces || []).length > 1) score += 0.4; // multi-province
  return Math.min(5.0, score);
}

function scoreContextRelevance(classification) {
  let score = 2.5;
  const policyScore = parseInt(classification.policy_relevance_score || '3');
  score += (policyScore - 3) * 0.4; // Scale: 1→-0.8, 3→0, 5→+0.8
  if (classification.nls_alignment) score += 0.3;
  if (classification.funrs_alignment) score += 0.2;
  if (classification.dbe_adoption_status === 'ADOPTED') score += 0.5;
  else if (classification.dbe_adoption_status === 'PILOTED') score += 0.2;
  return Math.min(5.0, Math.max(1.0, score));
}

function scorePathwayDimension(classification, pathway) {
  const subtype = (classification.evaluation_subtype || '').toLowerCase();
  const hasControl = classification.has_control_group;

  if (pathway === 'IMPACT_CAUSAL') {
    if (subtype.includes('rct') || subtype.includes('randomis')) return hasControl ? 4.5 : 4.0;
    if (subtype.includes('quasi') || subtype.includes('difference-in-difference') || subtype.includes('did')) {
      return hasControl ? 4.0 : 3.5;
    }
    if (subtype.includes('pre-post') || subtype.includes('pre/post')) return hasControl ? 3.0 : 2.0;
    return 1.5;
  }

  if (pathway === 'IMPACT_DESCRIPTIVE') {
    if (hasControl) return 3.0;
    if (subtype.includes('pre-post') || subtype.includes('pre/post')) return 2.5;
    return 1.8;
  }

  if (pathway === 'PROCESS_IMPLEMENTATION') {
    let score = 1.5;
    if (classification.theory_of_change_explicit) score += 0.8;
    if (classification.fidelity_reported) score += 1.0;
    if (classification.dosage_documented) score += 0.8;
    if (classification.methodology_description) score += 0.4;
    if (classification.evidence_gap_1) score += 0.2;
    return Math.min(5.0, score);
  }

  if (pathway === 'FORMATIVE_BASELINE') {
    let score = 2.0;
    if (classification.methodology_description) score += 0.6;
    if (classification.evidence_gap_1) score += 0.7;
    if (classification.evidence_gap_2) score += 0.4;
    if (classification.policy_relevance_score >= 4) score += 0.4;
    if (classification.key_finding_1 && classification.key_finding_2) score += 0.4;
    return Math.min(5.0, score);
  }

  return null;
}

/**
 * Compute the full EQS score from a classification record
 * Returns null for research studies and formative evaluations
 */
function computeEQS(classification) {
  const pathwayInfo = detectEQSPathway(
    classification.document_type,
    classification.evaluation_subtype
  );

  if (pathwayInfo.pathway === 'NOT_APPLICABLE') {
    return {
      applicable: false,
      reason: 'No EQS pathway applicable',
      eqs_pathway: pathwayInfo.pathway,
      eqs_version: 'v2.0',
      pathway_multiplier: pathwayInfo.multiplier,
      eqs_composite: null,
      confidence_tier: null,
    };
  }

  const dataQuality = scoreDataQuality(classification);
  const transparency = scoreTransparency(classification);
  const replicability = scoreReplicability(classification);
  const contextRelevance = scoreContextRelevance(classification);
  const pathwayDimension = scorePathwayDimension(classification, pathwayInfo.pathway);

  const composite = (
    dataQuality * 0.20 +
    transparency * 0.20 +
    replicability * 0.20 +
    contextRelevance * 0.20 +
    (pathwayDimension || 1.0) * 0.20
  );

  let tier;
  if (composite >= 3.5) tier = 'TIER_1';
  else if (composite >= 2.5) tier = 'TIER_2';
  else if (composite >= 1.5) tier = 'TIER_3';
  else tier = 'EXCLUDED';

  return {
    applicable: true,
    partial: false,
    eqs_pathway: pathwayInfo.pathway,
    eqs_version: 'v2.0',
    pathway_multiplier: pathwayInfo.multiplier,
    dimensions: {
      methodological_rigour: pathwayDimension ? parseFloat(pathwayDimension.toFixed(2)) : null,
      data_quality: parseFloat(dataQuality.toFixed(2)),
      transparency: parseFloat(transparency.toFixed(2)),
      replicability: parseFloat(replicability.toFixed(2)),
      context_relevance: parseFloat(contextRelevance.toFixed(2)),
    },
    eqs_composite: parseFloat(composite.toFixed(2)),
    confidence_tier: tier,
    board_citable: tier === 'TIER_1',
    sroi_eligible: tier !== 'EXCLUDED' && classification.cost_data_present !== 'ABSENT',
    publishable: tier === 'TIER_1' || tier === 'TIER_2',
  };
}

/**
 * Compute evidence half-life rating
 * Current: valid for 2024-2028 | Aging: 2019-2023 | Historical: before 2019
 */
function computeHalfLife(classification) {
  const year = parseInt(classification.year || '0');
  if (!year) return { rating: 'UNKNOWN', weight: 0.65 };
  if (year >= 2021) return { rating: 'CURRENT', weight: 1.0 };
  if (year >= 2016) return { rating: 'AGING', weight: 0.65 };
  return { rating: 'HISTORICAL', weight: 0.30 };
}

/**
 * Compute Evidence Capital Score for a single document
 * EC = EQS Composite × Half-Life Weight × Policy Relevance Weight
 */
function computeEvidenceCapital(eqs, classification) {
  if (!eqs.eqs_composite) return null;
  const halfLife = computeHalfLife(classification);
  const policyWeight = Math.min(1.0, (parseInt(classification.policy_relevance_score || '3')) / 5);
  const ec = eqs.eqs_composite * halfLife.weight * policyWeight;
  return {
    evidence_capital_score: parseFloat(ec.toFixed(3)),
    half_life_rating: halfLife.rating,
    half_life_weight: halfLife.weight,
    policy_relevance_weight: parseFloat(policyWeight.toFixed(2)),
  };
}

module.exports = { detectEQSPathway, computeEQS, computeHalfLife, computeEvidenceCapital };
