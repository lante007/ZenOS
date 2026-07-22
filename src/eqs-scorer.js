'use strict';
/**
 * ADEI EQS Scorer
 * Evidence Quality Score — five-dimension weighted formula
 * Taxonomy v2.1 · Scoring Logic v0.2
 * 
 * Formula: EQS = (Rigour × 0.35) + (Data Quality × 0.20) + (Transparency × 0.15)
 *              + (Replicability × 0.15) + (Context Relevance × 0.15)
 *
 * Tiers: Tier 1 ≥ 3.5 | Tier 2 2.5-3.49 | Tier 3 1.5-2.49 | Excluded < 1.5
 */

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

/**
 * Compute the full EQS score from a classification record
 * Returns null for research studies and formative evaluations
 */
function computeEQS(classification) {
  const docType = (classification.document_type || '').toLowerCase();
  const subtype = (classification.evaluation_subtype || '').toLowerCase();

  // Research studies: no EQS
  if (
    docType === 'research study' ||
    subtype.includes('literature') ||
    subtype.includes('landscape')
  ) {
    return {
      applicable: false,
      reason: 'Research studies do not receive EQS scores',
      eqs_composite: null,
      confidence_tier: null,
    };
  }

  const rigour = scoreMethodologicalRigour(classification);
  const dataQuality = scoreDataQuality(classification);
  const transparency = scoreTransparency(classification);
  const replicability = scoreReplicability(classification);
  const contextRelevance = scoreContextRelevance(classification);

  // Process evaluations: only Transparency and Replicability scored
  if (docType === 'process evaluation') {
    const composite = (transparency * 0.5) + (replicability * 0.5);
    return {
      applicable: true,
      partial: true,
      reason: 'Process evaluations scored on Transparency and Replicability only',
      dimensions: {
        methodological_rigour: null,
        data_quality: null,
        transparency: parseFloat(transparency.toFixed(2)),
        replicability: parseFloat(replicability.toFixed(2)),
        context_relevance: parseFloat(contextRelevance.toFixed(2)),
      },
      eqs_composite: parseFloat(composite.toFixed(2)),
      confidence_tier: composite >= 3.5 ? 'TIER_1' : composite >= 2.5 ? 'TIER_2' : 'TIER_3',
      max_possible: 3.0,
    };
  }

  // Impact evaluations: full five-dimension EQS
  const composite = (
    (rigour || 2.0) * 0.35 +
    dataQuality * 0.20 +
    transparency * 0.15 +
    replicability * 0.15 +
    contextRelevance * 0.15
  );

  let tier;
  if (composite >= 3.5) tier = 'TIER_1';
  else if (composite >= 2.5) tier = 'TIER_2';
  else if (composite >= 1.5) tier = 'TIER_3';
  else tier = 'EXCLUDED';

  return {
    applicable: true,
    partial: false,
    dimensions: {
      methodological_rigour: rigour ? parseFloat(rigour.toFixed(2)) : null,
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

module.exports = { computeEQS, computeHalfLife, computeEvidenceCapital };
