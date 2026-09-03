'use strict';

// tests/prophet.test.js — C4: Prophet agent shape guarantees.
//
// No live Anthropic call is made here (the same convention as
// tests/advisor.test.js): the LLM tool-call input is simulated directly so
// these tests are deterministic, free, and require no network or database.
//
// The two things C4 requires a test to confirm:
//   1. the assembled assessment always has exactly the six LAYERS fields
//      (observed_fact / interpretation / assumption / scenario / confidence
//      / recommendation, pluralised for the array fields) and passes
//      validateProphetAssessment with no errors;
//   2. no autonomous-action field can ever appear in the assessment, even
//      if a (malicious or malformed) tool-call response tries to smuggle
//      one in.

const assert = require('assert');
const {
  buildObservedFacts,
  buildProphetPrompt,
  assembleAssessment,
} = require('../api/intelligence/agents/prophet');
const { validateProphetAssessment, LAYERS } = require('../api/memory/prophet-contract');
const { hasDatabase } = require('./helpers/env');

const SIGNAL = {
  id: '11111111-1111-1111-1111-111111111111',
  source_name: 'Test Funder Bulletin',
  source_kind: 'funder',
  source_url: 'https://example.org/bulletin',
  observed_at: '2026-01-01T00:00:00.000Z',
  title: 'New grant round announced',
  change_description: 'The funder page now lists a new open grant round.',
  summary: 'A new funding round appeared where none existed before.',
  novelty: 'NEW',
  confidence: 'MODERATE',
  source_credibility: 'HIGH',
};

const WELL_FORMED_INPUT = {
  interpretations: ['This likely signals a near-term funding opportunity.'],
  assumptions: ['The grant round is open to organisations like Zenex.'],
  scenarios: [
    { description: 'Zenex applies and is shortlisted.', confidence: 'MODERATE', rests_on_assumptions: ['The grant round is open to organisations like Zenex.'] },
  ],
  confidence: 'MODERATE',
  recommendations: [
    { action: 'Review eligibility criteria and prepare an application.', consequential: false, requires_approval: false },
    { action: 'Commit programme budget toward this application.', consequential: true, requires_approval: false },
  ],
};

module.exports = {
  'buildObservedFacts derives ground-truth facts from the signal row, not from the model': async () => {
    const facts = buildObservedFacts(SIGNAL);
    assert.ok(Array.isArray(facts) && facts.length > 0);
    assert.ok(facts.some(f => f.includes('Test Funder Bulletin')));
    assert.ok(facts.some(f => f.includes('New grant round announced')));
  },

  'buildProphetPrompt embeds the observed facts and instructs the model not to restate them as its own': async () => {
    const prompt = buildProphetPrompt(SIGNAL);
    assert.ok(prompt.includes('Test Funder Bulletin'));
    assert.ok(/observed fact/i.test(prompt));
    assert.ok(/do not restate/i.test(prompt));
  },

  'assembleAssessment produces exactly the six LAYERS fields': async () => {
    const facts = buildObservedFacts(SIGNAL);
    const assessment = assembleAssessment(facts, WELL_FORMED_INPUT);
    const expectedKeys = ['observed_facts', 'interpretations', 'assumptions', 'scenarios', 'confidence', 'recommendations'];
    assert.deepStrictEqual(Object.keys(assessment).sort(), expectedKeys.sort());
    // Sanity-check these correspond to the six LAYERS the contract defines.
    assert.strictEqual(LAYERS.length, 6);
  },

  'assembleAssessment output passes validateProphetAssessment with no errors': async () => {
    const facts = buildObservedFacts(SIGNAL);
    const assessment = assembleAssessment(facts, WELL_FORMED_INPUT);
    const errors = validateProphetAssessment(assessment);
    assert.deepStrictEqual(errors, []);
  },

  'a consequential recommendation always has requires_approval forced true, regardless of model input': async () => {
    const facts = buildObservedFacts(SIGNAL);
    const assessment = assembleAssessment(facts, WELL_FORMED_INPUT);
    const consequential = assessment.recommendations.find(r => r.consequential);
    assert.ok(consequential, 'fixture must include a consequential recommendation');
    assert.strictEqual(consequential.requires_approval, true);
  },

  'no autonomous-action field ever reaches the assessment, even if the tool input tries to smuggle one in': async () => {
    const facts = buildObservedFacts(SIGNAL);
    const hostileInput = {
      ...WELL_FORMED_INPUT,
      auto_execute: true,
      executed: true,
      action_taken_automatically: 'sent the email',
    };
    const assessment = assembleAssessment(facts, hostileInput);
    const keys = Object.keys(assessment);
    for (const forbidden of ['auto_execute', 'executed', 'action_taken_automatically']) {
      assert.ok(!keys.includes(forbidden), `assessment must never contain a "${forbidden}" field`);
    }
    assert.deepStrictEqual(keys.sort(), ['assumptions', 'confidence', 'interpretations', 'observed_facts', 'recommendations', 'scenarios'].sort());
  },

  'assembleAssessment never drops observed_facts even with empty/malformed model input': async () => {
    const facts = buildObservedFacts(SIGNAL);
    const assessment = assembleAssessment(facts, {});
    assert.deepStrictEqual(assessment.observed_facts, facts);
    assert.deepStrictEqual(assessment.interpretations, []);
    assert.deepStrictEqual(assessment.assumptions, []);
    assert.deepStrictEqual(assessment.scenarios, []);
    assert.deepStrictEqual(assessment.recommendations, []);
    assert.strictEqual(assessment.confidence, 'UNKNOWN');
  },

  'getSignalById joins a real signal with its source, and that row feeds buildObservedFacts/buildProphetPrompt correctly': async () => {
    if (!hasDatabase()) return 'SKIP';
    const wt = require('../api/memory/watchtower');
    const { getSignalById } = wt;
    const { getPool } = require('../api/services/db');
    const pool = getPool();

    const source = await wt.registerSource({
      name: `prophet-test-${Date.now()}`,
      url: `https://example.org/prophet-test-${Date.now()}`,
      source_type: 'funder',
      credibility: 'HIGH',
    });

    try {
      const { observation } = await wt.recordObservation(source.id, { content: 'baseline content' });
      const { signal } = await wt.createSignal({
        source_id: source.id,
        observation_id: observation.id,
        title: 'Prophet test signal',
        summary: 'A change was detected for this test.',
        change_description: 'Content moved from baseline to a new state.',
        signal_type: 'funding_change',
        novelty: 'CHANGED',
        confidence: 'HIGH',
      });
      assert.ok(signal, 'expected createSignal to persist a signal');

      const joined = await getSignalById(signal.id);
      assert.strictEqual(joined.id, signal.id);
      assert.strictEqual(joined.source_name, source.name);
      assert.strictEqual(joined.source_url, source.url);
      assert.strictEqual(joined.source_credibility, 'HIGH');

      const facts = buildObservedFacts(joined);
      assert.ok(facts.some(f => f.includes(source.name)));
      assert.ok(facts.some(f => f.includes('Prophet test signal')));

      const prompt = buildProphetPrompt(joined);
      assert.ok(prompt.includes(source.name));

      const missing = await getSignalById('00000000-0000-0000-0000-000000000000');
      assert.strictEqual(missing, null);
    } finally {
      await pool.query('DELETE FROM public.wt_sources WHERE id = $1', [source.id]);
    }
  },
};
