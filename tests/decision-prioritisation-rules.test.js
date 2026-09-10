'use strict';

// tests/decision-prioritisation-rules.test.js
//
// Phase 5 focused tests for the pure, deterministic V1.0 prioritisation
// rules (api/intelligence/decision-prioritisation/rules.js). No DB, no
// LLM call -- computePriority() is a plain function of its input fields.
// Follows tests/run.js's convention exactly (plain exported async
// functions, PASS on no-throw).

const assert = require('assert');
const { RULE_VERSION, computePriority } = require('../api/intelligence/decision-prioritisation/rules');

module.exports = {
  'rule_version is v1.0': async () => {
    assert.strictEqual(RULE_VERSION, 'v1.0');
  },

  'HIGH confidence + cost_of_waiting contains "immediate" -> IMMEDIATE': async () => {
    const result = computePriority({
      overallConfidence: 'HIGH',
      costOfWaiting: 'Immediate action required to avoid loss',
      reversibility: 'REVERSIBLE',
      timingSensitivity: 'NOT_TIME_SENSITIVE',
      severity: 'LOW',
      partialContext: false,
    });
    assert.strictEqual(result.priority, 'IMMEDIATE');
    assert.ok(result.priorityReason.length > 0);
  },

  'HIGH confidence + cost_of_waiting contains "critical" (case-insensitive) -> IMMEDIATE': async () => {
    const result = computePriority({
      overallConfidence: 'MODERATE',
      costOfWaiting: 'this is CRITICAL to resolve',
      reversibility: 'REVERSIBLE',
      timingSensitivity: 'NOT_TIME_SENSITIVE',
      severity: 'LOW',
    });
    assert.strictEqual(result.priority, 'IMMEDIATE');
  },

  'HIGH confidence + reversibility IRREVERSIBLE -> IMMEDIATE': async () => {
    const result = computePriority({
      overallConfidence: 'HIGH',
      costOfWaiting: 'no particular urgency',
      reversibility: 'IRREVERSIBLE',
      timingSensitivity: 'NOT_TIME_SENSITIVE',
      severity: 'LOW',
    });
    assert.strictEqual(result.priority, 'IMMEDIATE');
  },

  'HIGH confidence + reversibility PARTIALLY_REVERSIBLE -> IMMEDIATE (spec-to-enum mapping)': async () => {
    const result = computePriority({
      overallConfidence: 'HIGH',
      costOfWaiting: 'no particular urgency',
      reversibility: 'PARTIALLY_REVERSIBLE',
      timingSensitivity: 'NOT_TIME_SENSITIVE',
      severity: 'LOW',
    });
    assert.strictEqual(result.priority, 'IMMEDIATE');
  },

  'HIGH confidence + timing_sensitivity IMMEDIATE -> IMMEDIATE (spec-to-enum mapping)': async () => {
    const result = computePriority({
      overallConfidence: 'HIGH',
      costOfWaiting: 'no particular urgency',
      reversibility: 'REVERSIBLE',
      timingSensitivity: 'IMMEDIATE',
      severity: 'LOW',
    });
    assert.strictEqual(result.priority, 'IMMEDIATE');
  },

  'HIGH confidence + DECISION_DEADLINE_APPROACHING with days_until_review < 7 -> IMMEDIATE': async () => {
    const result = computePriority({
      overallConfidence: 'HIGH',
      costOfWaiting: 'no particular urgency',
      reversibility: 'REVERSIBLE',
      timingSensitivity: 'NOT_TIME_SENSITIVE',
      severity: 'LOW',
      triggerPathway: 'DECISION_DEADLINE_APPROACHING',
      daysUntilReview: 3,
    });
    assert.strictEqual(result.priority, 'IMMEDIATE');
  },

  'HIGH confidence + DECISION_DEADLINE_APPROACHING with days_until_review >= 7 does NOT trigger IMMEDIATE deadline clause': async () => {
    const result = computePriority({
      overallConfidence: 'HIGH',
      costOfWaiting: 'no particular urgency',
      reversibility: 'REVERSIBLE',
      timingSensitivity: 'NOT_TIME_SENSITIVE',
      severity: 'LOW',
      triggerPathway: 'DECISION_DEADLINE_APPROACHING',
      daysUntilReview: 10,
    });
    assert.notStrictEqual(result.priority, 'IMMEDIATE');
  },

  'HIGH confidence + severity HIGH (none of the IMMEDIATE conditions) -> HIGH': async () => {
    const result = computePriority({
      overallConfidence: 'HIGH',
      costOfWaiting: 'manageable',
      reversibility: 'REVERSIBLE',
      timingSensitivity: 'NOT_TIME_SENSITIVE',
      severity: 'HIGH',
    });
    assert.strictEqual(result.priority, 'HIGH');
  },

  'HIGH confidence + severity CRITICAL -> HIGH (CRITICAL satisfies "severity is HIGH", spec-to-enum mapping)': async () => {
    const result = computePriority({
      overallConfidence: 'HIGH',
      costOfWaiting: 'manageable',
      reversibility: 'REVERSIBLE',
      timingSensitivity: 'NOT_TIME_SENSITIVE',
      severity: 'CRITICAL',
    });
    assert.strictEqual(result.priority, 'HIGH');
  },

  'HIGH confidence + timing_sensitivity NEAR_TERM -> HIGH (spec-to-enum mapping)': async () => {
    const result = computePriority({
      overallConfidence: 'HIGH',
      costOfWaiting: 'manageable',
      reversibility: 'REVERSIBLE',
      timingSensitivity: 'NEAR_TERM',
      severity: 'LOW',
    });
    assert.strictEqual(result.priority, 'HIGH');
  },

  'MODERATE confidence + trigger_pathway OUTCOME_DIVERGES_FROM_EXPECTATION -> HIGH': async () => {
    const result = computePriority({
      overallConfidence: 'MODERATE',
      costOfWaiting: 'manageable',
      reversibility: 'REVERSIBLE',
      timingSensitivity: 'NOT_TIME_SENSITIVE',
      severity: 'LOW',
      triggerPathway: 'OUTCOME_DIVERGES_FROM_EXPECTATION',
    });
    assert.strictEqual(result.priority, 'HIGH');
  },

  'MODERATE confidence + trigger_pathway REVERSIBLE_BECOMING_IRREVERSIBLE -> HIGH': async () => {
    const result = computePriority({
      overallConfidence: 'MODERATE',
      costOfWaiting: 'manageable',
      reversibility: 'REVERSIBLE',
      timingSensitivity: 'NOT_TIME_SENSITIVE',
      severity: 'LOW',
      triggerPathway: 'REVERSIBLE_BECOMING_IRREVERSIBLE',
    });
    assert.strictEqual(result.priority, 'HIGH');
  },

  'MODERATE confidence, no IMMEDIATE/HIGH condition, not partial -> MODERATE': async () => {
    const result = computePriority({
      overallConfidence: 'MODERATE',
      costOfWaiting: 'manageable',
      reversibility: 'REVERSIBLE',
      timingSensitivity: 'NOT_TIME_SENSITIVE',
      severity: 'LOW',
      partialContext: false,
    });
    assert.strictEqual(result.priority, 'MODERATE');
  },

  'LOW confidence, no IMMEDIATE/HIGH condition, not partial -> MODERATE': async () => {
    const result = computePriority({
      overallConfidence: 'LOW',
      costOfWaiting: 'manageable',
      reversibility: 'REVERSIBLE',
      timingSensitivity: 'NOT_TIME_SENSITIVE',
      severity: 'LOW',
      partialContext: false,
    });
    assert.strictEqual(result.priority, 'MODERATE');
  },

  'LOW confidence -> LOW is not reached when MODERATE-tier matches first (LOW confidence alone maps to MODERATE tier per spec)': async () => {
    const result = computePriority({ overallConfidence: 'LOW', partialContext: false });
    assert.strictEqual(result.priority, 'MODERATE');
  },

  'UNKNOWN confidence -> LOW': async () => {
    const result = computePriority({ overallConfidence: 'UNKNOWN', partialContext: false });
    assert.strictEqual(result.priority, 'LOW');
  },

  'partial_context true -> LOW regardless of confidence (ceiling)': async () => {
    const result = computePriority({
      overallConfidence: 'HIGH',
      costOfWaiting: 'manageable, no urgency',
      reversibility: 'REVERSIBLE',
      timingSensitivity: 'NOT_TIME_SENSITIVE',
      severity: 'LOW',
      partialContext: true,
    });
    assert.strictEqual(result.priority, 'LOW');
  },

  'partial_context true does NOT suppress an IMMEDIATE match (IMMEDIATE/HIGH rules run first, before the partial-context ceiling)': async () => {
    const result = computePriority({
      overallConfidence: 'HIGH',
      costOfWaiting: 'immediate action needed',
      reversibility: 'REVERSIBLE',
      timingSensitivity: 'NOT_TIME_SENSITIVE',
      severity: 'LOW',
      partialContext: true,
    });
    assert.strictEqual(result.priority, 'IMMEDIATE');
  },

  'missing/empty fields never throw and default to LOW': async () => {
    const result = computePriority({});
    assert.strictEqual(result.priority, 'LOW');
    assert.ok(result.priorityReason.length > 0);
  },

  'contributingFactors contains every field used in the decision': async () => {
    const result = computePriority({
      overallConfidence: 'HIGH',
      exposure: 'R500,000 programme exposure',
      costOfWaiting: 'immediate',
      severity: 'HIGH',
      reversibility: 'IRREVERSIBLE',
      timingSensitivity: 'IMMEDIATE',
      partialContext: false,
      triggerPathway: 'SIGNAL_TOUCHES_EXPOSURE',
      daysUntilReview: 5,
    });
    const cf = result.contributingFactors;
    assert.strictEqual(cf.exposure, 'R500,000 programme exposure');
    assert.strictEqual(cf.cost_of_waiting, 'immediate');
    assert.strictEqual(cf.severity, 'HIGH');
    assert.strictEqual(cf.reversibility, 'IRREVERSIBLE');
    assert.strictEqual(cf.timing_sensitivity, 'IMMEDIATE');
    assert.strictEqual(cf.overall_confidence, 'HIGH');
    assert.strictEqual(cf.partial_context, false);
    assert.strictEqual(cf.trigger_pathway, 'SIGNAL_TOUCHES_EXPOSURE');
    assert.strictEqual(cf.days_until_review, 5);
  },

  'priority is always one of the four permitted values, never anything else': async () => {
    const permitted = ['IMMEDIATE', 'HIGH', 'MODERATE', 'LOW'];
    const samples = [
      {},
      { overallConfidence: 'HIGH', costOfWaiting: 'immediate' },
      { overallConfidence: 'MODERATE', severity: 'CRITICAL' },
      { overallConfidence: 'LOW' },
      { overallConfidence: 'UNKNOWN', partialContext: true },
      { overallConfidence: 'bogus-value' },
    ];
    samples.forEach((s) => {
      const r = computePriority(s);
      assert.ok(permitted.includes(r.priority), `unexpected priority "${r.priority}" for input ${JSON.stringify(s)}`);
    });
  },
};
