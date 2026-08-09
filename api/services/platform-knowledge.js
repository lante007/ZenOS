'use strict';

const PLATFORM_KNOWLEDGE = {
  eqs_methodology: {
    version: 'v2.0',
    description: 'Evidence Quality Score assesses fitness for purpose across three evaluation pathways.',
    pathways: {
      IMPACT: {
        applies_to: [
          'Impact Evaluation',
          'RCT',
          'Quasi-experimental',
          'Pre-post with comparison',
        ],
        dimensions: {
          methodological_rigour: {
            weight: 0.35,
            description: 'Quality of causal inference design. RCT scores highest (4.5-5.0), pre-post without comparison scores lowest (1.0-2.0).',
          },
          data_quality: {
            weight: 0.20,
            description: 'Sample adequacy, representativeness, retention rate, measurement validity.',
          },
          transparency: {
            weight: 0.15,
            description: 'Theory of change explicit, evaluation questions stated, methods described, limitations acknowledged.',
          },
          replicability: {
            weight: 0.15,
            description: 'Dosage documented, fidelity reported, contextual moderators identified.',
          },
          context_relevance: {
            weight: 0.15,
            description: 'NLS alignment, FUNRS alignment, DBE adoption status, current policy relevance.',
          },
        },
      },
      PROCESS: {
        applies_to: [
          'Process Evaluation',
          'Implementation Evaluation',
          'Formative Evaluation',
        ],
        dimensions: {
          implementation_documentation: {
            weight: 0.35,
            description: 'Theory of change explicit, fidelity measured, dosage documented, intervention type and period recorded.',
          },
          data_quality: { weight: 0.20 },
          transparency: { weight: 0.15 },
          context_relevance: { weight: 0.15 },
          stakeholder_grounding: {
            weight: 0.15,
            description: 'Population served documented, implementing org named, external evaluator, commissioning standards met.',
          },
        },
      },
      RESEARCH: {
        applies_to: [
          'Research Study',
          'Literature Review',
          'Landscape Analysis',
          'Baseline Study',
        ],
        dimensions: {
          evidence_synthesis_quality: {
            weight: 0.35,
            description: 'Methodology described, multiple findings, gaps identified, limitations documented.',
          },
          source_quality: {
            weight: 0.20,
            description: 'Recency (post 2020), external evaluator, published status, funder documented.',
          },
          transparency: { weight: 0.15 },
          policy_relevance: { weight: 0.30 },
        },
      },
    },
    tiers: {
      TIER_1: 'EQS 3.5 and above. Publishable. Suitable for board citation and policy briefs.',
      TIER_2: 'EQS 2.5 to 3.49. Usable with caveats. Suitable for internal decision-making.',
      TIER_3: 'EQS 1.5 to 2.49. Limited use. Background context only.',
      EXCLUDED: 'EQS below 1.5. Not suitable for any use.',
    },
    half_life: {
      CURRENT: 'Documents from 2021 onwards. Full evidence capital value (100%).',
      AGING: 'Documents from 2016 to 2020. Evidence capital depreciated to 65%.',
      HISTORICAL: 'Documents before 2016. Evidence capital depreciated to 30%.',
    },
    protocol_amendments: [
      'PA1: Null findings classified at same confidence tier as positive findings.',
      'PA2: Omitted variable bias triggers UNCERTAIN confidence.',
      'PA3: SROI cost inputs from audited financials or Proxy Library only.',
      'PA4: Confidence tiers disaggregated by unit of analysis.',
      'PA5: Non-significant tested variables explicitly reported.',
      'PA6: Decision relevance weighted by assumption challenge.',
    ],
  },
  three_capital_cascade: {
    financial_capital: 'Balance sheet investment. Calculable only from classified financial records.',
    evidence_capital: 'Net quality-adjusted score. Formula: sum of (EQS/5 x depreciation_factor) across all active records.',
    decision_capital: 'Confirmed instances where evidence changed decisions. Requires manual ratification by Organisation Lead.',
    eroi: 'Evidence Quality Index. Composite index 0-100 across four dimensions: Evidence Quality (25), Currency (25), Coverage (25), Standards (25). Converts to true EROI once Decision Capital instances are confirmed by the Director of Research.',
  },
  duplicate_detection: 'On classify/process, system checks file_hash and filename against existing documents. Returns 409 with duplicate_detected error if match found.',
  flywheel_alerts: {
    types: [
      'AUDIENCE_GAP: Tier 1/2 record has no knowledge product for one or more audiences.',
      'CURRENCY_ALERT: Record rated AGING may need policy context review.',
      'COMMISSIONING_GAP: Programme has no impact evaluation since 2021.',
      'QUEUE_BACKLOG: More than 5 items pending for more than 5 days.',
      'BOARD_PROXIMITY: No trustee pack in last 85 days.',
      'ENDLINE_GAP: Impact evaluation with no linked endline record.',
    ],
    scoring: 'Urgency (0-40) + Policy relevance (0-35) + Evidence strength (0-25) = composite out of 100.',
    routing: 'Role-based. Fatima receives commissioning and quality alerts. Ruth receives audience gaps. Sibongile receives board and governance alerts.',
  },
};

module.exports = { PLATFORM_KNOWLEDGE };
