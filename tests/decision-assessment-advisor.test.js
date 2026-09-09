'use strict';

// tests/decision-assessment-advisor.test.js -- Contract 3, agent 3 (Advisor).
//
// No live Anthropic call is made here (same convention as
// tests/prophet.test.js, tests/advisor.test.js, and the two decision-
// assessment specialist test files): the tool-call input is simulated
// directly so these tests are deterministic, free, and require no network
// or database.

const assert = require('assert');
const {
  runAdvisorDecisionAgent,
  checkFailClosed,
  buildProvenanceIndexFromEvidenceOutput,
  computeConfidenceCeiling,
  recommendationMatchesASuppliedOption,
  buildAdvisorDecisionPrompt,
  assembleDecisionAssessment,
  validateDecisionAssessment,
} = require('../api/intelligence/decision-assessment/advisor');
const { buildDecisionFacts } = require('../api/intelligence/decision-assessment/evidence-analyst');
const { collectAllowedNumbers } = require('../api/intelligence/decision-assessment/strategic-analyst');

const SIGNAL_ID = '11111111-1111-1111-1111-111111111111';
const PROGRAMME_ID = '22222222-2222-2222-2222-222222222222';

const CONTEXT = {
  decisionEvent: {
    id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    tenantId: 'zenex',
    triggerPathway: 'signal_touches_exposure',
    triggerExplanation: 'A funder signal touches an active programme with prior exposure.',
    triggerData: { programme_name: 'Youth Bursary Fund' },
    inputs: { signal_ids: [SIGNAL_ID], programme_record_ids: [PROGRAMME_ID] },
    status: 'new',
  },
  evidence: {
    signals: [{ id: SIGNAL_ID, title: 'Funder changed eligibility criteria', change_description: 'Age cap lowered from 35 to 30.' }],
    decisions: [],
    outcomes: [],
    programmes: [{ id: PROGRAMME_ID, programme_name: 'Youth Bursary Fund', total_cost_rand: 450000, programme_area: 'Education' }],
  },
  evidenceGaps: [],
  institutionalMemory: null,
  externalIntelligence: null,
  partialContext: false,
  partialContextReasons: [],
};

const PARTIAL_CONTEXT = { ...CONTEXT, partialContext: true, partialContextReasons: ['programme (x): programme record not found'] };

const VALID_EVIDENCE_OUTPUT = {
  established_findings: [
    { finding: 'The funder lowered the eligibility age cap from 35 to 30.', source_type: 'signal', source_id: SIGNAL_ID },
    { finding: 'The Youth Bursary Fund programme has a total cost of R450000.', source_type: 'programme', source_id: PROGRAMME_ID },
  ],
  evidence_limitations: [],
  contradictions: [],
  evidence_gaps: [],
  evidence_confidence: 'MODERATE',
};

const VALID_STRATEGIC_OUTPUT = {
  exposure: 'Moderate exposure to reduced enrolment.',
  exposure_basis: 'Based on the R450000 programme cost and the lowered age cap.',
  severity: 'MODERATE',
  uncertainty_factors: ['Unclear how many current beneficiaries fall outside the new age cap.'],
  cost_of_waiting: 'Delay risks missing the funder\'s renewal window.',
  reversibility: 'PARTIALLY_REVERSIBLE',
  opportunity_cost: 'Continued funding of an increasingly narrow cohort.',
  timing_sensitivity: 'NEAR_TERM',
  options: [
    { action: 'Renew the agreement under the new eligibility terms.', tradeoff: 'Smaller eligible cohort.', timeframe: 'Within 30 days.' },
    { action: 'Renegotiate the age cap with the funder.', tradeoff: 'Risk of losing the funder entirely.', timeframe: 'Within 60 days.' },
  ],
  evidence_that_would_change_assessment: ['Actual count of beneficiaries above the new age cap.'],
  assumptions: [],
  strategic_confidence: 'MODERATE',
  deviation_from_evidence: '',
};

const EVIDENCE_RESULT_OK = { agent: 'evidence_analyst_decision', status: 'ok', output: VALID_EVIDENCE_OUTPUT, error: null };
const STRATEGIC_RESULT_OK = { agent: 'strategic_analyst_decision', status: 'ok', output: VALID_STRATEGIC_OUTPUT, error: null };

const WELL_FORMED_INPUT = {
  situation: 'The Youth Bursary Fund\'s funder has lowered the eligibility age cap, requiring a renewal decision.',
  what_the_evidence_establishes: [
    { point: 'The funder lowered the eligibility age cap from 35 to 30.', source_type: 'signal', source_id: SIGNAL_ID },
  ],
  what_we_do_not_know: ['How many current beneficiaries fall outside the new age cap.'],
  strategic_assessment: 'Moderate, near-term exposure with partial reversibility.',
  recommended_action: 'Renew the agreement under the new eligibility terms.',
  deviation_note: '',
  evidence_still_needed: ['Actual count of beneficiaries above the new age cap.'],
  overall_confidence: 'MODERATE',
};

module.exports = {
  'checkFailClosed returns null (no reason) when both specialists are ok with valid output': async () => {
    const reason = checkFailClosed(EVIDENCE_RESULT_OK, STRATEGIC_RESULT_OK);
    assert.strictEqual(reason, null);
  },

  'checkFailClosed fails closed when the Evidence Analyst failed': async () => {
    const failedEvidence = { agent: 'evidence_analyst_decision', status: 'failed', output: null, error: 'timed out' };
    const reason = checkFailClosed(failedEvidence, STRATEGIC_RESULT_OK);
    assert.ok(reason);
    assert.ok(/Evidence Analyst/.test(reason));
    assert.ok(/timed out/.test(reason));
  },

  'checkFailClosed fails closed when the Strategic Analyst failed': async () => {
    const failedStrategic = { agent: 'strategic_analyst_decision', status: 'failed', output: null, error: 'malformed tool call' };
    const reason = checkFailClosed(EVIDENCE_RESULT_OK, failedStrategic);
    assert.ok(reason);
    assert.ok(/Strategic Analyst/.test(reason));
    assert.ok(/malformed tool call/.test(reason));
  },

  'checkFailClosed fails closed on a status-ok result with a malformed output shape': async () => {
    const hostileOk = { agent: 'evidence_analyst_decision', status: 'ok', output: { evidence_confidence: 'HIGH' }, error: null };
    const reason = checkFailClosed(hostileOk, STRATEGIC_RESULT_OK);
    assert.ok(reason);
    assert.ok(/Evidence Analyst/.test(reason));
  },

  'runAdvisorDecisionAgent fails closed with no context, without making an API call': async () => {
    const result = await runAdvisorDecisionAgent(null, EVIDENCE_RESULT_OK, STRATEGIC_RESULT_OK);
    assert.strictEqual(result.status, 'failed');
    assert.ok(/context is required/.test(result.error));
  },

  'runAdvisorDecisionAgent fails closed and preserves the Evidence Analyst failure, without making an API call': async () => {
    const failedEvidence = { agent: 'evidence_analyst_decision', status: 'failed', output: null, error: 'network error' };
    const result = await runAdvisorDecisionAgent(CONTEXT, failedEvidence, STRATEGIC_RESULT_OK);
    assert.strictEqual(result.status, 'failed');
    assert.ok(/Evidence Analyst/.test(result.error));
    assert.ok(/network error/.test(result.error));
    assert.strictEqual(result.output, null);
  },

  'runAdvisorDecisionAgent fails closed and preserves the Strategic Analyst failure, without making an API call': async () => {
    const failedStrategic = { agent: 'strategic_analyst_decision', status: 'failed', output: null, error: 'provenance rejected' };
    const result = await runAdvisorDecisionAgent(CONTEXT, EVIDENCE_RESULT_OK, failedStrategic);
    assert.strictEqual(result.status, 'failed');
    assert.ok(/Strategic Analyst/.test(result.error));
    assert.ok(/provenance rejected/.test(result.error));
    assert.strictEqual(result.output, null);
  },

  'buildProvenanceIndexFromEvidenceOutput indexes only the Evidence Analyst\'s own established findings': async () => {
    const idx = buildProvenanceIndexFromEvidenceOutput(VALID_EVIDENCE_OUTPUT);
    assert.ok(idx.has(`signal:${SIGNAL_ID}`));
    assert.ok(idx.has(`programme:${PROGRAMME_ID}`));
    assert.strictEqual(idx.size, 2);
  },

  'buildProvenanceIndexFromEvidenceOutput does not index anything from raw context evidence the Evidence Analyst did not establish': async () => {
    const sparseEvidenceOutput = { ...VALID_EVIDENCE_OUTPUT, established_findings: [] };
    const idx = buildProvenanceIndexFromEvidenceOutput(sparseEvidenceOutput);
    assert.strictEqual(idx.size, 0);
  },

  'computeConfidenceCeiling returns the weaker of the two specialist confidences when context is not partial': async () => {
    assert.strictEqual(computeConfidenceCeiling('HIGH', 'MODERATE', false), 'MODERATE');
    assert.strictEqual(computeConfidenceCeiling('LOW', 'HIGH', false), 'LOW');
    assert.strictEqual(computeConfidenceCeiling('HIGH', 'HIGH', false), 'HIGH');
  },

  'computeConfidenceCeiling caps at MODERATE when context is partial, even if both specialists were HIGH': async () => {
    assert.strictEqual(computeConfidenceCeiling('HIGH', 'HIGH', true), 'MODERATE');
  },

  'computeConfidenceCeiling never relaxes below the weaker specialist confidence even when context is partial': async () => {
    assert.strictEqual(computeConfidenceCeiling('LOW', 'UNKNOWN', true), 'UNKNOWN');
  },

  'recommendationMatchesASuppliedOption matches an exact or near-exact option action': async () => {
    assert.ok(recommendationMatchesASuppliedOption('Renew the agreement under the new eligibility terms.', VALID_STRATEGIC_OUTPUT.options));
  },

  'recommendationMatchesASuppliedOption returns false for a recommendation not among the supplied options': async () => {
    assert.strictEqual(recommendationMatchesASuppliedOption('Terminate the agreement immediately.', VALID_STRATEGIC_OUTPUT.options), false);
  },

  'buildAdvisorDecisionPrompt embeds evidence findings, strategic options, and the provenance instruction': async () => {
    const facts = buildDecisionFacts(CONTEXT);
    const prompt = buildAdvisorDecisionPrompt(CONTEXT, facts, VALID_EVIDENCE_OUTPUT, VALID_STRATEGIC_OUTPUT);
    assert.ok(prompt.includes(SIGNAL_ID));
    assert.ok(prompt.includes('Renew the agreement under the new eligibility terms.'));
    assert.ok(/what_the_evidence_establishes/.test(prompt));
    assert.ok(/priority/i.test(prompt));
  },

  'buildAdvisorDecisionPrompt labels institutional memory and external intelligence as context only, never evidence': async () => {
    const memoryContext = {
      ...CONTEXT,
      institutionalMemory: { relevant_memory: [{ type: 'note', status: 'active', confidence: 'MODERATE', title: 'Prior funder relationship note', content: 'Funder has renewed twice before.' }], relevant_decisions: [], recent_signals: [] },
    };
    const facts = buildDecisionFacts(memoryContext);
    const prompt = buildAdvisorDecisionPrompt(memoryContext, facts, VALID_EVIDENCE_OUTPUT, VALID_STRATEGIC_OUTPUT);
    assert.ok(prompt.includes('INSTITUTIONAL MEMORY'));
    assert.ok(prompt.includes('CONTEXT ONLY'));
  },

  'assembleDecisionAssessment produces exactly the eight schema fields': async () => {
    const assessment = assembleDecisionAssessment(WELL_FORMED_INPUT);
    const expectedKeys = [
      'situation', 'what_the_evidence_establishes', 'what_we_do_not_know', 'strategic_assessment',
      'recommended_action', 'deviation_note', 'evidence_still_needed', 'overall_confidence',
    ];
    assert.deepStrictEqual(Object.keys(assessment).sort(), expectedKeys.sort());
  },

  'no priority field ever reaches the assessment, even if the tool input tries to smuggle one in': async () => {
    const hostileInput = { ...WELL_FORMED_INPUT, priority: 'HIGH' };
    const assessment = assembleDecisionAssessment(hostileInput);
    assert.ok(!Object.keys(assessment).includes('priority'));
  },

  'a well-formed assessment with real provenance and a matching option passes validation with no errors': async () => {
    const assessment = assembleDecisionAssessment(WELL_FORMED_INPUT);
    const provenanceIndex = buildProvenanceIndexFromEvidenceOutput(VALID_EVIDENCE_OUTPUT);
    const allowedNumbers = collectAllowedNumbers(CONTEXT);
    const errors = validateDecisionAssessment(assessment, {
      provenanceIndex,
      evidenceConfidence: VALID_EVIDENCE_OUTPUT.evidence_confidence,
      strategicConfidence: VALID_STRATEGIC_OUTPUT.strategic_confidence,
      partialContext: false,
      strategicOptions: VALID_STRATEGIC_OUTPUT.options,
      allowedNumbers,
    });
    assert.deepStrictEqual(errors, []);
  },

  'validation fails closed on a hallucinated source_id not established by the Evidence Analyst': async () => {
    const hostileInput = {
      ...WELL_FORMED_INPUT,
      what_the_evidence_establishes: [
        ...WELL_FORMED_INPUT.what_the_evidence_establishes,
        { point: 'This programme has a history of late reporting.', source_type: 'programme', source_id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' },
      ],
    };
    const assessment = assembleDecisionAssessment(hostileInput);
    const provenanceIndex = buildProvenanceIndexFromEvidenceOutput(VALID_EVIDENCE_OUTPUT);
    const errors = validateDecisionAssessment(assessment, { provenanceIndex, evidenceConfidence: 'MODERATE', strategicConfidence: 'MODERATE', partialContext: false, strategicOptions: VALID_STRATEGIC_OUTPUT.options, allowedNumbers: collectAllowedNumbers(CONTEXT) });
    assert.ok(errors.some((e) => /unverifiable provenance/.test(e)));
  },

  'validation fails closed when what_the_evidence_establishes cites a source the context/evidence contains but the Evidence Analyst never established': async () => {
    // PROGRAMME_ID is real evidence in CONTEXT, but this Evidence Analyst
    // output never established a finding from it -- promoting it here must
    // still fail. This is precisely the "cannot promote raw context to
    // evidence" boundary.
    const sparseEvidenceOutput = { established_findings: [VALID_EVIDENCE_OUTPUT.established_findings[0]], evidence_limitations: [], contradictions: [], evidence_gaps: [], evidence_confidence: 'MODERATE' };
    const hostileInput = {
      ...WELL_FORMED_INPUT,
      what_the_evidence_establishes: [
        { point: 'The programme costs R450000.', source_type: 'programme', source_id: PROGRAMME_ID },
      ],
    };
    const assessment = assembleDecisionAssessment(hostileInput);
    const provenanceIndex = buildProvenanceIndexFromEvidenceOutput(sparseEvidenceOutput);
    const errors = validateDecisionAssessment(assessment, { provenanceIndex, evidenceConfidence: 'MODERATE', strategicConfidence: 'MODERATE', partialContext: false, strategicOptions: VALID_STRATEGIC_OUTPUT.options, allowedNumbers: collectAllowedNumbers(CONTEXT) });
    assert.ok(errors.some((e) => /unverifiable provenance/.test(e)));
  },

  'validation fails closed when overall_confidence exceeds the weaker specialist confidence': async () => {
    const assessment = assembleDecisionAssessment({ ...WELL_FORMED_INPUT, overall_confidence: 'HIGH' });
    const provenanceIndex = buildProvenanceIndexFromEvidenceOutput(VALID_EVIDENCE_OUTPUT);
    const errors = validateDecisionAssessment(assessment, {
      provenanceIndex,
      evidenceConfidence: 'MODERATE',
      strategicConfidence: 'HIGH',
      partialContext: false,
      strategicOptions: VALID_STRATEGIC_OUTPUT.options,
      allowedNumbers: collectAllowedNumbers(CONTEXT),
    });
    assert.ok(errors.some((e) => /exceeds the permitted ceiling/.test(e)));
  },

  'validation fails closed on overall_confidence HIGH when context is partial, even if both specialists were HIGH': async () => {
    const assessment = assembleDecisionAssessment({ ...WELL_FORMED_INPUT, overall_confidence: 'HIGH' });
    const provenanceIndex = buildProvenanceIndexFromEvidenceOutput(VALID_EVIDENCE_OUTPUT);
    const errors = validateDecisionAssessment(assessment, {
      provenanceIndex,
      evidenceConfidence: 'HIGH',
      strategicConfidence: 'HIGH',
      partialContext: true,
      strategicOptions: VALID_STRATEGIC_OUTPUT.options,
      allowedNumbers: collectAllowedNumbers(CONTEXT),
    });
    assert.ok(errors.some((e) => /exceeds the permitted ceiling/.test(e)));
    assert.ok(errors.some((e) => /partial context/.test(e)));
  },

  'validation passes overall_confidence MODERATE when context is partial and both specialists were HIGH': async () => {
    const assessment = assembleDecisionAssessment({ ...WELL_FORMED_INPUT, overall_confidence: 'MODERATE' });
    const provenanceIndex = buildProvenanceIndexFromEvidenceOutput(VALID_EVIDENCE_OUTPUT);
    const errors = validateDecisionAssessment(assessment, {
      provenanceIndex,
      evidenceConfidence: 'HIGH',
      strategicConfidence: 'HIGH',
      partialContext: true,
      strategicOptions: VALID_STRATEGIC_OUTPUT.options,
      allowedNumbers: collectAllowedNumbers(CONTEXT),
    });
    assert.deepStrictEqual(errors, []);
  },

  'validation fails closed when recommended_action departs from the supplied options without a deviation_note': async () => {
    const assessment = assembleDecisionAssessment({ ...WELL_FORMED_INPUT, recommended_action: 'Terminate the agreement immediately.', deviation_note: '' });
    const provenanceIndex = buildProvenanceIndexFromEvidenceOutput(VALID_EVIDENCE_OUTPUT);
    const errors = validateDecisionAssessment(assessment, {
      provenanceIndex,
      evidenceConfidence: 'MODERATE',
      strategicConfidence: 'MODERATE',
      partialContext: false,
      strategicOptions: VALID_STRATEGIC_OUTPUT.options,
      allowedNumbers: collectAllowedNumbers(CONTEXT),
    });
    assert.ok(errors.some((e) => /deviation_note required/.test(e)));
  },

  'validation passes when recommended_action departs from the supplied options but deviation_note explains why': async () => {
    const assessment = assembleDecisionAssessment({ ...WELL_FORMED_INPUT, recommended_action: 'Pause the programme pending clarification.', deviation_note: 'Neither supplied option addresses the immediate need to pause outreach while eligibility is clarified with the funder.' });
    const provenanceIndex = buildProvenanceIndexFromEvidenceOutput(VALID_EVIDENCE_OUTPUT);
    const errors = validateDecisionAssessment(assessment, {
      provenanceIndex,
      evidenceConfidence: 'MODERATE',
      strategicConfidence: 'MODERATE',
      partialContext: false,
      strategicOptions: VALID_STRATEGIC_OUTPUT.options,
      allowedNumbers: collectAllowedNumbers(CONTEXT),
    });
    assert.deepStrictEqual(errors, []);
  },

  'validation fails closed on a fabricated percentage figure in a free-text field': async () => {
    const assessment = assembleDecisionAssessment({ ...WELL_FORMED_INPUT, strategic_assessment: 'There is a 70% chance the funder withdraws entirely.' });
    const provenanceIndex = buildProvenanceIndexFromEvidenceOutput(VALID_EVIDENCE_OUTPUT);
    const errors = validateDecisionAssessment(assessment, {
      provenanceIndex,
      evidenceConfidence: 'MODERATE',
      strategicConfidence: 'MODERATE',
      partialContext: false,
      strategicOptions: VALID_STRATEGIC_OUTPUT.options,
      allowedNumbers: collectAllowedNumbers(CONTEXT),
    });
    assert.ok(errors.some((e) => /fabricated percentage/.test(e)));
  },

  'validation fails closed on a fabricated currency figure not present anywhere in the supplied context': async () => {
    const assessment = assembleDecisionAssessment({ ...WELL_FORMED_INPUT, recommended_action: 'Approve an additional R2000000 in emergency funding.' });
    const provenanceIndex = buildProvenanceIndexFromEvidenceOutput(VALID_EVIDENCE_OUTPUT);
    const errors = validateDecisionAssessment(assessment, {
      provenanceIndex,
      evidenceConfidence: 'MODERATE',
      strategicConfidence: 'MODERATE',
      partialContext: false,
      strategicOptions: VALID_STRATEGIC_OUTPUT.options,
      allowedNumbers: collectAllowedNumbers(CONTEXT),
    });
    assert.ok(errors.some((e) => /fabricated precision is not permitted/.test(e)));
  },

  'validation passes a real currency figure already present in the supplied context': async () => {
    const assessment = assembleDecisionAssessment({ ...WELL_FORMED_INPUT, strategic_assessment: 'The programme represents a total cost of R450000 at stake.' });
    const provenanceIndex = buildProvenanceIndexFromEvidenceOutput(VALID_EVIDENCE_OUTPUT);
    const errors = validateDecisionAssessment(assessment, {
      provenanceIndex,
      evidenceConfidence: 'MODERATE',
      strategicConfidence: 'MODERATE',
      partialContext: false,
      strategicOptions: VALID_STRATEGIC_OUTPUT.options,
      allowedNumbers: collectAllowedNumbers(CONTEXT),
    });
    assert.deepStrictEqual(errors, []);
  },

  'validation fails closed on raw tool-call input with missing required fields, not run through assemble first': async () => {
    const provenanceIndex = buildProvenanceIndexFromEvidenceOutput(VALID_EVIDENCE_OUTPUT);
    const errors = validateDecisionAssessment({}, { provenanceIndex, evidenceConfidence: 'MODERATE', strategicConfidence: 'MODERATE', partialContext: false, strategicOptions: [], allowedNumbers: new Set() });
    assert.ok(errors.some((e) => /situation required/.test(e)));
    assert.ok(errors.some((e) => /what_the_evidence_establishes\[\] required/.test(e)));
    assert.ok(errors.some((e) => /what_we_do_not_know\[\] required/.test(e)));
    assert.ok(errors.some((e) => /strategic_assessment required/.test(e)));
    assert.ok(errors.some((e) => /recommended_action required/.test(e)));
    assert.ok(errors.some((e) => /evidence_still_needed\[\] required/.test(e)));
    assert.ok(errors.some((e) => /overall_confidence must be one of/.test(e)));
  },

  'a raw tool-call input with explicit UNKNOWN overall_confidence (deliberate uncertainty) passes validation': async () => {
    const raw = {
      situation: 'Insufficient basis to assess.',
      what_the_evidence_establishes: [],
      what_we_do_not_know: ['Everything material.'],
      strategic_assessment: 'Cannot be assessed.',
      recommended_action: 'Gather more evidence before deciding.',
      deviation_note: '',
      evidence_still_needed: ['Any evidence at all.'],
      overall_confidence: 'UNKNOWN',
    };
    const provenanceIndex = buildProvenanceIndexFromEvidenceOutput(VALID_EVIDENCE_OUTPUT);
    const errors = validateDecisionAssessment(raw, { provenanceIndex, evidenceConfidence: 'UNKNOWN', strategicConfidence: 'UNKNOWN', partialContext: true, strategicOptions: [], allowedNumbers: new Set() });
    assert.deepStrictEqual(errors, []);
  },

  'overall_confidence is normalised to UNKNOWN on malformed/missing input rather than defaulting to a false HIGH': async () => {
    const assessment = assembleDecisionAssessment({ situation: 'x' });
    assert.strictEqual(assessment.overall_confidence, 'UNKNOWN');
  },

  'deviation_note defaults to an empty string, never undefined, on malformed input': async () => {
    const assessment = assembleDecisionAssessment({});
    assert.strictEqual(assessment.deviation_note, '');
  },

  'deterministic agent configuration matches the approved budget and is separate from the QUESTION-mode advisor key': async () => {
    const { agentConfig } = require('../api/intelligence/config');
    const cfg = agentConfig('advisor_decision');
    assert.strictEqual(cfg.max_tokens, 1600);
    assert.strictEqual(cfg.temperature, 0.2);
    assert.strictEqual(cfg.timeout_ms, 70000);
    assert.deepStrictEqual(cfg.allowed_tools, []);
    assert.strictEqual(cfg.max_tool_rounds, 0);

    const questionAdvisorCfg = agentConfig('advisor');
    assert.strictEqual(questionAdvisorCfg.max_tokens, 1600);
    assert.strictEqual(questionAdvisorCfg.temperature, 0.2);
    assert.strictEqual(questionAdvisorCfg.timeout_ms, 70000);
  },
};

