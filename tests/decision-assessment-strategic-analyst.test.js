'use strict';

// tests/decision-assessment-strategic-analyst.test.js -- Contract 3, agent 2.
//
// No live Anthropic call is made here, same convention as
// tests/prophet.test.js and tests/decision-assessment-evidence-analyst.test.js:
// the tool-call input is simulated directly.

const assert = require('assert');
const {
  collectAllowedNumbers,
  extractNumericClaims,
  buildStrategicAnalystPrompt,
  assembleStrategicAssessment,
  validateStrategicAssessment,
  runStrategicAnalystDecisionAgent,
} = require('../api/intelligence/decision-assessment/strategic-analyst');
const { buildDecisionFacts } = require('../api/intelligence/decision-assessment/evidence-analyst');

const PROGRAMME_ID = '22222222-2222-2222-2222-222222222222';
const SIGNAL_ID = '11111111-1111-1111-1111-111111111111';

const CONTEXT = {
  decisionEvent: {
    id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    tenantId: 'zenex',
    triggerPathway: 'signal_touches_exposure',
    triggerExplanation: 'A funder signal touches an active programme with prior exposure.',
    triggerData: {},
    inputs: { signal_ids: [SIGNAL_ID], programme_record_ids: [PROGRAMME_ID] },
    status: 'new',
  },
  evidence: {
    signals: [{ id: SIGNAL_ID, title: 'Funder changed eligibility criteria' }],
    decisions: [],
    outcomes: [],
    programmes: [{ id: PROGRAMME_ID, programme_name: 'Youth Bursary Fund', total_cost_rand: 450000 }],
  },
  evidenceGaps: [],
  institutionalMemory: null,
  externalIntelligence: null,
  partialContext: false,
  partialContextReasons: [],
};

const VALID_EVIDENCE_OUTPUT = {
  established_findings: [
    { finding: 'The funder lowered the eligibility age cap.', source_type: 'signal', source_id: SIGNAL_ID },
  ],
  evidence_limitations: [],
  contradictions: [],
  evidence_gaps: [],
  evidence_confidence: 'MODERATE',
};

const WELL_FORMED_INPUT = {
  exposure: 'The programme carries moderate exposure given its R450000 total cost and the narrowed eligibility pool.',
  exposure_basis: 'Based on the programme total cost figure in the supplied context.',
  severity: 'MODERATE',
  uncertainty_factors: ['It is not yet known how many current applicants fall outside the new age cap.'],
  cost_of_waiting: 'Delay risks disqualifying applicants already in the pipeline before the cap change is communicated.',
  reversibility: 'PARTIALLY_REVERSIBLE',
  opportunity_cost: 'Continuing under the old criteria could mean lost eligibility for pipeline applicants.',
  timing_sensitivity: 'NEAR_TERM',
  options: [
    { action: 'Communicate the new criteria to applicants immediately.', tradeoff: 'May reduce applicant pool size.', timeframe: 'This week' },
  ],
  evidence_that_would_change_assessment: ['A breakdown of how many current applicants are affected by the new age cap.'],
  assumptions: ['The age cap change applies to the current funding cycle.'],
  strategic_confidence: 'MODERATE',
  deviation_from_evidence: '',
};

module.exports = {
  'collectAllowedNumbers extracts real programme cost figures only': async () => {
    const allowed = collectAllowedNumbers(CONTEXT);
    assert.ok(allowed.has('450000'));
    assert.ok(allowed.has('25000000'));
    assert.strictEqual(allowed.size, 2);
  },

  'extractNumericClaims finds currency and percentage tokens': async () => {
    assert.deepStrictEqual(extractNumericClaims('This costs R450000 and carries a 30% risk.'), ['R450000', '30%']);
    assert.deepStrictEqual(extractNumericClaims('No numbers here.'), []);
  },

  'buildStrategicAnalystPrompt embeds facts and evidence findings, and forbids recommendation/priority': async () => {
    const facts = buildDecisionFacts(CONTEXT);
    const prompt = buildStrategicAnalystPrompt(CONTEXT, facts, VALID_EVIDENCE_OUTPUT);
    assert.ok(prompt.includes(SIGNAL_ID));
    assert.ok(/do not recommend a specific ceo action/i.test(prompt));
    assert.ok(/do not assign a priority level/i.test(prompt));
  },

  'assembleStrategicAssessment produces exactly the thirteen schema fields, no recommended_action or priority': async () => {
    const assessment = assembleStrategicAssessment(WELL_FORMED_INPUT);
    const expectedKeys = [
      'exposure', 'exposure_basis', 'severity', 'uncertainty_factors', 'cost_of_waiting',
      'reversibility', 'opportunity_cost', 'timing_sensitivity', 'options',
      'evidence_that_would_change_assessment', 'assumptions', 'strategic_confidence',
      'deviation_from_evidence',
    ];
    assert.deepStrictEqual(Object.keys(assessment).sort(), expectedKeys.sort());
    assert.ok(!('recommended_action' in assessment));
    assert.ok(!('priority' in assessment));
  },

  'a well-formed assessment citing only real context figures passes validation with no errors': async () => {
    const assessment = assembleStrategicAssessment(WELL_FORMED_INPUT);
    const allowed = collectAllowedNumbers(CONTEXT);
    const errors = validateStrategicAssessment(assessment, allowed);
    assert.deepStrictEqual(errors, []);
  },

  'validation fails closed on a fabricated currency figure not present in the supplied context': async () => {
    const hostileInput = { ...WELL_FORMED_INPUT, exposure: 'The programme carries R9999999 in exposure.' };
    const assessment = assembleStrategicAssessment(hostileInput);
    const allowed = collectAllowedNumbers(CONTEXT);
    const errors = validateStrategicAssessment(assessment, allowed);
    assert.ok(errors.some((e) => /fabricated precision is not permitted/.test(e)));
  },

  'validation fails closed on any fabricated percentage/probability figure': async () => {
    const hostileInput = { ...WELL_FORMED_INPUT, cost_of_waiting: 'There is a 70% chance this becomes urgent.' };
    const assessment = assembleStrategicAssessment(hostileInput);
    const allowed = collectAllowedNumbers(CONTEXT);
    const errors = validateStrategicAssessment(assessment, allowed);
    assert.ok(errors.some((e) => /fabricated percentage\/probability figure/.test(e)));
  },

  'validation fails closed on raw tool-call input with missing required fields (nothing present at all, not run through assemble first)': async () => {
    // This is the missing-field case: every field, including the enums, is
    // entirely absent from the raw object. Validation must run on this raw
    // shape directly -- assembleStrategicAssessment({}) would default
    // severity/reversibility/timing_sensitivity/strategic_confidence to the
    // valid enum value 'UNKNOWN' and mask this failure, which is exactly the
    // ambiguity the corrected validate-before-assemble pipeline order exists
    // to prevent.
    const allowed = collectAllowedNumbers(CONTEXT);
    const errors = validateStrategicAssessment({}, allowed);
    assert.ok(errors.some((e) => /exposure required/.test(e)));
    assert.ok(errors.some((e) => /exposure_basis required/.test(e)));
    assert.ok(errors.some((e) => /severity must be one of/.test(e)));
    assert.ok(errors.some((e) => /cost_of_waiting required/.test(e)));
    assert.ok(errors.some((e) => /options\[\] required/.test(e)));
    assert.ok(errors.some((e) => /strategic_confidence must be one of/.test(e)));
    assert.ok(errors.some((e) => /deviation_from_evidence must be a string/.test(e)));
  },

  'a raw tool-call input with explicit UNKNOWN enum values (deliberate uncertainty) passes validation, without ever going through assemble first': async () => {
    // This is the explicit-UNKNOWN case: the model actually returned
    // severity/reversibility/timing_sensitivity/strategic_confidence as
    // 'UNKNOWN', a deliberate statement of uncertainty, alongside otherwise
    // well-formed free-text fields and empty arrays. Raw validation must
    // accept this -- it is not malformed output. Note exposure/
    // exposure_basis/cost_of_waiting/opportunity_cost are not enums and so
    // have no UNKNOWN value of their own; they must merely be non-empty,
    // and here are filled with honest text describing the uncertainty.
    const raw = {
      exposure: 'Exposure could not be determined from the available evidence.',
      exposure_basis: 'No programme cost or scale figures were available in the supplied context.',
      severity: 'UNKNOWN',
      uncertainty_factors: ['Insufficient evidence to assess severity.'],
      cost_of_waiting: 'Cannot be estimated without further evidence.',
      reversibility: 'UNKNOWN',
      opportunity_cost: 'Cannot be estimated without further evidence.',
      timing_sensitivity: 'UNKNOWN',
      options: [],
      evidence_that_would_change_assessment: ['A programme cost or scale figure.'],
      assumptions: [],
      strategic_confidence: 'UNKNOWN',
      deviation_from_evidence: '',
    };
    const allowed = collectAllowedNumbers(CONTEXT);
    const errors = validateStrategicAssessment(raw, allowed);
    assert.deepStrictEqual(errors, []);
  },

  'no recommended_action or priority field ever reaches the assessment, even if the tool input tries to smuggle one in': async () => {
    const hostileInput = { ...WELL_FORMED_INPUT, recommended_action: 'Terminate immediately.', priority: 'HIGH' };
    const assessment = assembleStrategicAssessment(hostileInput);
    const keys = Object.keys(assessment);
    assert.ok(!keys.includes('recommended_action'));
    assert.ok(!keys.includes('priority'));
  },

  'deviation_from_evidence defaults to an empty string, never undefined, on malformed input': async () => {
    const assessment = assembleStrategicAssessment({});
    assert.strictEqual(assessment.deviation_from_evidence, '');
  },

  'runStrategicAnalystDecisionAgent fails closed with no context, without making an API call': async () => {
    const result = await runStrategicAnalystDecisionAgent(null, VALID_EVIDENCE_OUTPUT);
    assert.strictEqual(result.status, 'failed');
    assert.ok(/context is required/.test(result.error));
  },

  'runStrategicAnalystDecisionAgent fails closed with no valid Evidence Analyst output, without making an API call': async () => {
    const result = await runStrategicAnalystDecisionAgent(CONTEXT, null);
    assert.strictEqual(result.status, 'failed');
    assert.ok(/valid Evidence Analyst output is required/.test(result.error));
  },

  'runStrategicAnalystDecisionAgent fails closed with a malformed Evidence Analyst output (missing evidence_confidence)': async () => {
    const result = await runStrategicAnalystDecisionAgent(CONTEXT, { established_findings: [] });
    assert.strictEqual(result.status, 'failed');
    assert.ok(/valid Evidence Analyst output is required/.test(result.error));
  },

  'deterministic agent configuration matches the approved budget': async () => {
    const { agentConfig } = require('../api/intelligence/config');
    const cfg = agentConfig('strategic_analyst_decision');
    assert.strictEqual(cfg.max_tokens, 900);
    assert.strictEqual(cfg.temperature, 0);
    assert.strictEqual(cfg.timeout_ms, 70000);
    assert.deepStrictEqual(cfg.allowed_tools, []);
    assert.strictEqual(cfg.max_tool_rounds, 0);
  },
};
