'use strict';

// tests/decision-assessment-evidence-analyst.test.js -- Contract 3, agent 1.
//
// No live Anthropic call is made here (same convention as
// tests/prophet.test.js and tests/advisor.test.js): the tool-call input is
// simulated directly so these tests are deterministic, free, and require
// no network or database.

const assert = require('assert');
const {
  buildDecisionFacts,
  buildProvenanceIndex,
  buildEvidenceAnalystPrompt,
  assembleEvidenceAssessment,
  validateEvidenceAssessment,
} = require('../api/intelligence/decision-assessment/evidence-analyst');

const SIGNAL_ID = '11111111-1111-1111-1111-111111111111';
const PROGRAMME_ID = '22222222-2222-2222-2222-222222222222';
const DECISION_ID = '33333333-3333-3333-3333-333333333333';
const OUTCOME_ID = '44444444-4444-4444-4444-444444444444';

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
    decisions: [{ id: DECISION_ID, decision: 'Renew bursary agreement', status: 'pending' }],
    outcomes: [{ id: OUTCOME_ID, title: 'Prior cohort completion rate', value: 0.82 }],
    programmes: [{ id: PROGRAMME_ID, programme_name: 'Youth Bursary Fund', total_cost_rand: 450000, programme_area: 'Education', evidence_gap_1: 'No post-2024 completion data' }],
  },
  evidenceGaps: ['No post-2024 completion data'],
  institutionalMemory: { note: 'this must never be read by buildDecisionFacts' },
  externalIntelligence: { note: 'this must never be read by buildDecisionFacts' },
  partialContext: true,
  partialContextReasons: ['programme (unresolvable-id-999): programme record not found'],
};

const WELL_FORMED_INPUT = {
  established_findings: [
    { finding: 'The funder lowered the eligibility age cap from 35 to 30.', source_type: 'signal', source_id: SIGNAL_ID },
    { finding: 'The Youth Bursary Fund programme has a total cost of R450000.', source_type: 'programme', source_id: PROGRAMME_ID },
  ],
  evidence_limitations: ['Prior cohort completion data is limited to one cohort.'],
  contradictions: [],
  evidence_gaps: ['No post-2024 completion data', 'programme (unresolvable-id-999): programme record not found'],
  evidence_confidence: 'MODERATE',
};

module.exports = {
  'buildDecisionFacts restates hydrated evidence as source-tagged sentences': async () => {
    const facts = buildDecisionFacts(CONTEXT);
    assert.ok(Array.isArray(facts) && facts.length > 0);
    assert.ok(facts.some((f) => f.includes(SIGNAL_ID) && f.includes('source_type: signal')));
    assert.ok(facts.some((f) => f.includes(PROGRAMME_ID) && f.includes('source_type: programme')));
    assert.ok(facts.some((f) => f.includes(DECISION_ID)));
    assert.ok(facts.some((f) => f.includes(OUTCOME_ID)));
  },

  'buildDecisionFacts surfaces partial context reasons as plain fact': async () => {
    const facts = buildDecisionFacts(CONTEXT);
    assert.ok(facts.some((f) => f.includes('INCOMPLETE')));
    assert.ok(facts.some((f) => f.includes('unresolvable-id-999')));
  },

  'buildDecisionFacts never reads institutional memory or external intelligence': async () => {
    const facts = buildDecisionFacts(CONTEXT);
    const joined = facts.join(' ');
    assert.ok(!joined.includes('this must never be read'));
  },

  'buildEvidenceAnalystPrompt embeds the facts and instructs provenance citation': async () => {
    const facts = buildDecisionFacts(CONTEXT);
    const prompt = buildEvidenceAnalystPrompt(CONTEXT, facts);
    assert.ok(prompt.includes(SIGNAL_ID));
    assert.ok(/source_type and source_id/i.test(prompt));
  },

  'assembleEvidenceAssessment produces exactly the five schema fields': async () => {
    const assessment = assembleEvidenceAssessment(WELL_FORMED_INPUT);
    const expectedKeys = ['established_findings', 'evidence_limitations', 'contradictions', 'evidence_gaps', 'evidence_confidence'];
    assert.deepStrictEqual(Object.keys(assessment).sort(), expectedKeys.sort());
  },

  'a well-formed assessment with real provenance passes validation with no errors': async () => {
    const assessment = assembleEvidenceAssessment(WELL_FORMED_INPUT);
    const provenanceIndex = buildProvenanceIndex(CONTEXT);
    const errors = validateEvidenceAssessment(assessment, provenanceIndex);
    assert.deepStrictEqual(errors, []);
  },

  'validation fails closed on a hallucinated source_id not present in the supplied context': async () => {
    const hostileInput = {
      ...WELL_FORMED_INPUT,
      established_findings: [
        ...WELL_FORMED_INPUT.established_findings,
        { finding: 'This programme has a history of late reporting.', source_type: 'programme', source_id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' },
      ],
    };
    const assessment = assembleEvidenceAssessment(hostileInput);
    const provenanceIndex = buildProvenanceIndex(CONTEXT);
    const errors = validateEvidenceAssessment(assessment, provenanceIndex);
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => /unverifiable provenance/.test(e)));
  },

  'validation fails closed on a source_type outside the allowed enum (e.g. a smuggled memory citation)': async () => {
    const hostileInput = {
      ...WELL_FORMED_INPUT,
      established_findings: [
        { finding: 'Institutional memory suggests this funder is reliable.', source_type: 'memory', source_id: 'whatever' },
      ],
    };
    const assessment = assembleEvidenceAssessment(hostileInput);
    const provenanceIndex = buildProvenanceIndex(CONTEXT);
    const errors = validateEvidenceAssessment(assessment, provenanceIndex);
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => /source_type must be signal\|decision\|outcome\|programme/.test(e)));
  },

  'validation fails closed on raw tool-call input with a missing required field (evidence_confidence absent, not run through assemble first)': async () => {
    // This is the missing-field case: evidence_confidence is entirely absent
    // from the raw object, not explicitly set to 'UNKNOWN'. Validation must
    // run on this raw shape directly -- assembleEvidenceAssessment({}) would
    // default evidence_confidence to the valid enum value 'UNKNOWN' and mask
    // this failure, which is exactly the ambiguity the corrected validate-
    // before-assemble pipeline order exists to prevent.
    const provenanceIndex = buildProvenanceIndex(CONTEXT);
    const errors = validateEvidenceAssessment({}, provenanceIndex);
    assert.ok(errors.some((e) => /established_findings\[\] required/.test(e)));
    assert.ok(errors.some((e) => /evidence_limitations\[\] required/.test(e)));
    assert.ok(errors.some((e) => /contradictions\[\] required/.test(e)));
    assert.ok(errors.some((e) => /evidence_gaps\[\] required/.test(e)));
    assert.ok(errors.some((e) => /evidence_confidence must be one of/.test(e)));
  },

  'a raw tool-call input with an explicit UNKNOWN evidence_confidence (deliberate uncertainty) passes validation, without ever going through assemble first': async () => {
    // This is the explicit-UNKNOWN case: the model actually returned
    // evidence_confidence: 'UNKNOWN' as a deliberate statement of
    // uncertainty, alongside otherwise well-formed (if empty) arrays. Raw
    // validation must accept this -- it is not malformed output.
    const raw = {
      established_findings: [],
      evidence_limitations: [],
      contradictions: [],
      evidence_gaps: [],
      evidence_confidence: 'UNKNOWN',
    };
    const provenanceIndex = buildProvenanceIndex(CONTEXT);
    const errors = validateEvidenceAssessment(raw, provenanceIndex);
    assert.deepStrictEqual(errors, []);
  },

  'no strategic/priority/recommendation field ever reaches the assessment, even if the tool input tries to smuggle one in': async () => {
    const hostileInput = {
      ...WELL_FORMED_INPUT,
      recommended_action: 'Terminate the agreement immediately.',
      priority: 'HIGH',
      cost_of_waiting: 'R1,000,000 per month',
    };
    const assessment = assembleEvidenceAssessment(hostileInput);
    const keys = Object.keys(assessment);
    for (const forbidden of ['recommended_action', 'priority', 'cost_of_waiting']) {
      assert.ok(!keys.includes(forbidden), `assessment must never contain a "${forbidden}" field`);
    }
  },

  'evidence_confidence is normalised to UNKNOWN on malformed/missing input rather than defaulting to a false HIGH': async () => {
    const assessment = assembleEvidenceAssessment({ established_findings: [] });
    assert.strictEqual(assessment.evidence_confidence, 'UNKNOWN');
  },

  'deterministic agent configuration matches the approved budget': async () => {
    const { agentConfig } = require('../api/intelligence/config');
    const cfg = agentConfig('evidence_analyst_decision');
    assert.strictEqual(cfg.max_tokens, 900);
    assert.strictEqual(cfg.temperature, 0);
    assert.strictEqual(cfg.timeout_ms, 70000);
    assert.deepStrictEqual(cfg.allowed_tools, []);
    assert.strictEqual(cfg.max_tool_rounds, 0);
  },
};
