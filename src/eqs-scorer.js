'use strict';
/**
 * ADEI EQS Scorer
 * Evidence Quality Score - three-pathway v2.0 scoring for new classifications.
 *
 * Methodology rule: score each document against its intended evidentiary
 * purpose. Process evaluations are not penalised for lacking control groups,
 * and research studies are not penalised for lacking effect sizes.
 */

function round2(value) {
  return Math.round(value * 100) / 100;
}

function getEvaluationPathway(record) {
  const docType = (record.document_type || '').toLowerCase();
  const subType = (record.evaluation_subtype || '').toLowerCase();

  if (
    docType.includes('impact') ||
    subType.includes('rct') ||
    subType.includes('randomis') ||
    subType.includes('randomiz') ||
    subType.includes('quasi') ||
    subType.includes('difference') ||
    subType.includes('regression') ||
    subType.includes('propensity')
  ) {
    return 'IMPACT';
  }

  if (
    docType.includes('process') ||
    docType.includes('implementation') ||
    docType.includes('formative') ||
    docType.includes('fidelity') ||
    subType.includes('process') ||
    subType.includes('implementation') ||
    subType.includes('formative')
  ) {
    return 'PROCESS';
  }

  if (
    docType.includes('research') ||
    docType.includes('literature') ||
    docType.includes('landscape') ||
    docType.includes('baseline') ||
    docType.includes('mapping') ||
    docType.includes('review') ||
    subType.includes('literature') ||
    subType.includes('landscape') ||
    subType.includes('baseline')
  ) {
    return 'RESEARCH';
  }

  return 'IMPACT';
}

function legacyPathwayFor(record, pathway) {
  const subType = (record.evaluation_subtype || '').toLowerCase();
  if (pathway === 'PROCESS') return 'PROCESS_IMPLEMENTATION';
  if (pathway === 'RESEARCH') return 'FORMATIVE_BASELINE';
  if (subType.includes('rct') || subType.includes('randomis') || subType.includes('randomiz') || subType.includes('quasi')) {
    return 'IMPACT_CAUSAL';
  }
  return 'IMPACT_DESCRIPTIVE';
}

function pathwayMultiplier(pathway) {
  if (pathway === 'PROCESS') return 0.75;
  if (pathway === 'RESEARCH') return 0.60;
  return 1.00;
}

function detectEQSPathway(documentType, evaluationSubtype) {
  const record = { document_type: documentType, evaluation_subtype: evaluationSubtype };
  const pathway = getEvaluationPathway(record);
  const legacy = legacyPathwayFor(record, pathway);
  const labels = {
    IMPACT_CAUSAL: 'Impact evaluation (causal design)',
    IMPACT_DESCRIPTIVE: 'Impact evaluation (descriptive design)',
    PROCESS_IMPLEMENTATION: 'Process or implementation evaluation',
    FORMATIVE_BASELINE: 'Research, baseline, landscape, or literature study',
  };
  return {
    pathway: legacy,
    scoring_pathway: pathway,
    multiplier: pathwayMultiplier(pathway),
    label: labels[legacy],
  };
}

function scoreMethodologicalRigour(record) {
  const subtype = (record.evaluation_subtype || '').toLowerCase();
  const hasControl = record.has_control_group;

  if (subtype.includes('rct') || subtype.includes('randomis') || subtype.includes('randomiz')) {
    return hasControl ? 4.5 : 4.0;
  }
  if (subtype.includes('quasi') || subtype.includes('difference-in-difference') || subtype.includes('did') || subtype.includes('propensity') || subtype.includes('regression')) {
    return hasControl ? 3.8 : 3.5;
  }
  if (subtype.includes('pre-post') || subtype.includes('pre/post')) {
    return hasControl ? 3.2 : 2.8;
  }
  if (subtype.includes('mixed')) return 3.0;
  if (subtype.includes('descriptive')) return 2.5;
  return 2.0;
}

function scoreDataQuality(record) {
  let score = 2.0;
  const learners = parseInt(record.sample_size_learners || '0', 10);
  const schools = parseInt(record.sample_size_schools || '0', 10);

  if (learners > 1000 || schools > 50) score += 1.0;
  else if (learners > 500 || schools > 20) score += 0.7;
  else if (learners > 100 || schools > 5) score += 0.3;

  if (record.theory_of_change_explicit) score += 0.3;
  if (learners > 500) score += 0.2;

  return Math.min(5.0, score);
}

function scoreTransparency(record) {
  let score = 2.5;
  if (record.theory_of_change_explicit) score += 0.5;
  if (record.null_findings_reported) score += 0.3;
  if (record.evidence_gap_1) score += 0.2;
  if (record.limitations) score += 0.2;
  if (record.cost_data_present === 'AUDITED') score += 0.3;
  else if (record.cost_data_present === 'PROXY') score += 0.1;
  return Math.min(5.0, score);
}

function scoreReplicability(record) {
  let score = 2.0;
  if (record.dosage_documented) score += 0.8;
  if (record.fidelity_reported) score += 0.8;
  if (record.population_served) score += 0.3;
  if ((record.provinces || []).length > 1) score += 0.4;
  return Math.min(5.0, score);
}

function scoreContextRelevance(record) {
  let score = 2.5;
  const policyScore = parseInt(record.policy_relevance_score || '3', 10);
  score += (policyScore - 3) * 0.4;
  if (record.nls_alignment) score += 0.3;
  if (record.funrs_alignment) score += 0.2;
  if (record.policy_alignment) score += 0.3;
  if (record.dbe_adoption_status === 'ADOPTED') score += 0.5;
  else if (record.dbe_adoption_status === 'PILOTED') score += 0.2;
  return Math.min(5.0, Math.max(1.0, score));
}

function tierForComposite(composite) {
  if (composite >= 3.5) return 'TIER_1';
  if (composite >= 2.5) return 'TIER_2';
  if (composite >= 1.5) return 'TIER_3';
  return 'EXCLUDED';
}

function scoreImpactEvaluation(record) {
  const dim1 = scoreMethodologicalRigour(record);
  const dim2 = scoreDataQuality(record);
  const dim3 = scoreTransparency(record);
  const dim4 = scoreReplicability(record);
  const dim5 = scoreContextRelevance(record);
  const composite = dim1 * 0.35 + dim2 * 0.20 + dim3 * 0.15 + dim4 * 0.15 + dim5 * 0.15;

  return {
    composite: round2(composite),
    pathway: 'IMPACT',
    dimensions: {
      methodological_rigour: round2(dim1),
      data_quality: round2(dim2),
      transparency: round2(dim3),
      replicability: round2(dim4),
      context_relevance: round2(dim5),
    },
  };
}

function scoreProcessEvaluation(record) {
  const implScore = [
    record.theory_of_change_explicit,
    record.fidelity_reported,
    record.dosage_documented,
    record.intervention_type != null,
    record.implementation_period != null,
  ].filter(Boolean).length;
  const dim1 = 1 + (implScore / 5) * 4;

  const dim2 = scoreDataQuality(record);
  const dim3 = scoreTransparency(record);
  const dim4 = scoreContextRelevance(record);

  const stakeholderScore = [
    record.population_served != null,
    record.implementing_organisation_name != null,
    record.external_evaluator,
    (record.commissioning_standards_met || 0) >= 5,
  ].filter(Boolean).length;
  const dim5 = 1 + (stakeholderScore / 4) * 4;

  const composite = dim1 * 0.35 + dim2 * 0.20 + dim3 * 0.15 + dim4 * 0.15 + dim5 * 0.15;

  return {
    composite: round2(composite),
    pathway: 'PROCESS',
    dimensions: {
      implementation_documentation: round2(dim1),
      methodological_rigour: round2(dim1),
      data_quality: round2(dim2),
      transparency: round2(dim3),
      context_relevance: round2(dim4),
      stakeholder_grounding: round2(dim5),
      replicability: round2(dim5),
    },
  };
}

function scoreResearchStudy(record) {
  const synthesisScore = [
    (record.methodology_description || '').length > 100,
    record.key_finding_1 != null,
    record.key_finding_2 != null,
    record.evidence_gap_1 != null,
    record.limitations != null,
  ].filter(Boolean).length;
  const dim1 = 1 + (synthesisScore / 5) * 4;

  const sourceScore = [
    parseInt(record.year || 0, 10) >= 2020,
    record.external_evaluator,
    record.publication_status === 'Published',
    (record.funder_names || []).length > 0,
  ].filter(Boolean).length;
  const dim2 = 1 + (sourceScore / 4) * 4;

  const dim3 = scoreTransparency(record);
  const dim4 = scoreContextRelevance(record);

  const composite = dim1 * 0.35 + dim2 * 0.20 + dim3 * 0.15 + dim4 * 0.30;

  return {
    composite: round2(composite),
    pathway: 'RESEARCH',
    dimensions: {
      evidence_synthesis_quality: round2(dim1),
      methodological_rigour: round2(dim1),
      source_quality: round2(dim2),
      data_quality: round2(dim2),
      transparency: round2(dim3),
      policy_relevance: round2(dim4),
      context_relevance: round2(dim4),
      replicability: null,
    },
  };
}

function computeEQS(record) {
  const pathway = getEvaluationPathway(record);
  let result;
  if (pathway === 'PROCESS') result = scoreProcessEvaluation(record);
  else if (pathway === 'RESEARCH') result = scoreResearchStudy(record);
  else result = scoreImpactEvaluation(record);

  const tier = tierForComposite(result.composite);
  const legacyPathway = legacyPathwayFor(record, pathway);

  return {
    applicable: true,
    partial: false,
    pathway,
    eqs_scoring_pathway: pathway,
    eqs_pathway: legacyPathway,
    eqs_version: 'v2.0',
    pathway_multiplier: pathwayMultiplier(pathway),
    dimensions: result.dimensions,
    eqs_composite: result.composite,
    confidence_tier: tier,
    board_citable: tier === 'TIER_1',
    sroi_eligible: tier !== 'EXCLUDED' && record.cost_data_present !== 'ABSENT',
    publishable: tier === 'TIER_1' || tier === 'TIER_2',
  };
}

function computeHalfLife(record) {
  const year = parseInt(record.year || '0', 10);
  if (!year) return { rating: 'UNKNOWN', weight: 0.65 };
  if (year >= 2021) return { rating: 'CURRENT', weight: 1.0 };
  if (year >= 2016) return { rating: 'AGING', weight: 0.65 };
  return { rating: 'HISTORICAL', weight: 0.30 };
}

function computeEvidenceCapital(eqs, record) {
  if (!eqs.eqs_composite) return null;
  const halfLife = computeHalfLife(record);
  const policyWeight = Math.min(1.0, parseInt(record.policy_relevance_score || '3', 10) / 5);
  const ec = eqs.eqs_composite * halfLife.weight * policyWeight;
  return {
    evidence_capital_score: parseFloat(ec.toFixed(3)),
    half_life_rating: halfLife.rating,
    half_life_weight: halfLife.weight,
    policy_relevance_weight: parseFloat(policyWeight.toFixed(2)),
  };
}

module.exports = {
  detectEQSPathway,
  getEvaluationPathway,
  scoreImpactEvaluation,
  scoreProcessEvaluation,
  scoreResearchStudy,
  computeEQS,
  computeHalfLife,
  computeEvidenceCapital,
};
