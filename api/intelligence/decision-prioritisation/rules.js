'use strict';

// api/intelligence/decision-prioritisation/rules.js
//
// Phase 5: Decision Prioritisation -- V1.0 rules. Pure, deterministic,
// synchronous. No I/O, no LLM call, no database access -- this module
// takes plain derived-assessment fields in and returns a priority
// decision out. Versioned independently of the persistence layer
// (api/intelligence/decision-prioritisation/orchestrator.js) via
// RULE_VERSION, so a future v1.1/v2.0 rule set can replace
// computePriority() without touching how a Priority Record is stored.
//
// Field provenance (Phase 5 design, confirmed):
//   - exposure, costOfWaiting, severity, reversibility, timingSensitivity
//     all come from strategic_output.output -- the Strategic Analyst
//     (Contract 3, agent 2) owns the economic/actuarial reading of a
//     Decision Event; see api/intelligence/decision-assessment/
//     strategic-analyst.js's submit_strategic_assessment tool schema.
//   - overallConfidence comes from advisor_output.output.overall_confidence
//     only -- the Advisor (Contract 3, agent 3) owns the final,
//     ceiling-enforced synthesised confidence; see advisor.js. The
//     Advisor's schema has no exposure/cost_of_waiting/severity/
//     reversibility/timing_sensitivity field at all, so those five are
//     never read from advisor_output.
//   - partialContext comes from decision_assessments.partial_context.
//   - triggerPathway comes from decision_events.trigger_pathway.
//   - daysUntilReview comes from decision_events.trigger_data
//     .days_until_review (may be absent -- treated as "does not match"
//     rather than thrown on).
//
// Every helper below normalises defensively (missing/malformed input
// never throws; it just fails to match a rule, falling through toward
// the LOW default) -- same defensive-normalisation posture as
// api/intelligence/confidence.js#normaliseConfidence.
//
// SPEC-TO-ENUM MAPPING (Phase 5 design, confirmed, audit trail):
// The original Phase 5 rule spec was written against a conceptual model
// of reversibility/timing_sensitivity/severity BEFORE the Strategic
// Analyst's actual tool-schema enums were defined (strategic-analyst.js
// REVERSIBILITY_LEVELS / TIMING_LEVELS / SEVERITY_LEVELS). Four of the
// spec's literal value names do not exist verbatim in those enums; each
// is mapped below to the closest real enum value(s), confirmed as
// correct and adopted as official V1.0 behaviour:
//   1. reversibility "LOW or IRREVERSIBLE" (IMMEDIATE rule) -->
//      PARTIALLY_REVERSIBLE or IRREVERSIBLE. PARTIALLY_REVERSIBLE is a
//      decision becoming harder to reverse -- exactly what the IMMEDIATE
//      rule is designed to catch; IRREVERSIBLE is the hardest case. Both
//      trigger IMMEDIATE. See reversibilityIsLowOrIrreversible().
//   2. timing_sensitivity "HIGH" (IMMEDIATE rule) --> IMMEDIATE.
//      Semantically correct, not circular: the Strategic Analyst's
//      IMMEDIATE timing assessment means "this window is closing now",
//      exactly when the CEO surface should show IMMEDIATE priority. See
//      timingSensitivityIsHigh().
//   3. timing_sensitivity "MODERATE or HIGH" (HIGH rule) --> NEAR_TERM or
//      IMMEDIATE. NEAR_TERM means the window is approaching but not yet
//      critical -- warrants HIGH attention within the current review
//      cycle, precisely what HIGH priority means. See
//      timingSensitivityIsModerateOrHigh().
//   4. severity "HIGH" (HIGH rule) --> HIGH or CRITICAL. CRITICAL is
//      strictly more severe than HIGH (SEVERITY_LEVELS: CRITICAL, HIGH,
//      MODERATE, LOW, UNKNOWN) -- if HIGH severity warrants HIGH
//      priority, CRITICAL certainly does too. The spec said "HIGH"
//      without knowing the enum would include CRITICAL above it. See
//      severityIsHigh().

const RULE_VERSION = 'v1.0';

const IMMEDIATE_COST_OF_WAITING_RE = /\b(immediate|critical)\b/i;

function norm(value) {
  return String(value || '').trim().toUpperCase();
}

function isHighOrModerateConfidence(overallConfidence) {
  const c = norm(overallConfidence);
  return c === 'HIGH' || c === 'MODERATE';
}

function isLowOrModerateConfidence(overallConfidence) {
  const c = norm(overallConfidence);
  return c === 'LOW' || c === 'MODERATE';
}

function isLowOrUnknownConfidence(overallConfidence) {
  const c = norm(overallConfidence);
  return c === 'LOW' || c === 'UNKNOWN' || c === '';
}

function costOfWaitingIsImmediateOrCritical(costOfWaiting) {
  return IMMEDIATE_COST_OF_WAITING_RE.test(String(costOfWaiting || ''));
}

function reversibilityIsLowOrIrreversible(reversibility) {
  const r = norm(reversibility);
  // Strategic Analyst's own enum (strategic-analyst.js REVERSIBILITY_LEVELS)
  // is REVERSIBLE | PARTIALLY_REVERSIBLE | IRREVERSIBLE | UNKNOWN -- there
  // is no literal "LOW" value in that enum. Phase 5's rule text says
  // "reversibility is 'LOW' or 'IRREVERSIBLE'" -- PARTIALLY_REVERSIBLE is
  // treated as the "LOW (reversibility)" case referred to there, since it
  // is the only intermediate value the Strategic Analyst can actually
  // produce between fully REVERSIBLE and IRREVERSIBLE.
  return r === 'LOW' || r === 'IRREVERSIBLE' || r === 'PARTIALLY_REVERSIBLE';
}

function timingSensitivityIsHigh(timingSensitivity) {
  // Strategic Analyst's own enum (TIMING_LEVELS) is IMMEDIATE | NEAR_TERM |
  // NOT_TIME_SENSITIVE | UNKNOWN -- there is no literal "HIGH" value.
  // IMMEDIATE is treated as the "HIGH (timing_sensitivity)" case Phase 5's
  // rule text refers to.
  return norm(timingSensitivity) === 'IMMEDIATE';
}

function timingSensitivityIsModerateOrHigh(timingSensitivity) {
  const t = norm(timingSensitivity);
  // NEAR_TERM is treated as the "MODERATE" case referred to in the HIGH
  // rule (see timingSensitivityIsHigh's comment for the enum mapping).
  return t === 'IMMEDIATE' || t === 'NEAR_TERM';
}

function severityIsHigh(severity) {
  // Strategic Analyst's own enum (SEVERITY_LEVELS) also includes CRITICAL
  // above HIGH -- CRITICAL is treated as satisfying "severity is HIGH"
  // (it is strictly more severe than HIGH, never less).
  const s = norm(severity);
  return s === 'HIGH' || s === 'CRITICAL';
}

function daysUntilReviewUnder(days, threshold) {
  const n = Number(days);
  return Number.isFinite(n) && n < threshold;
}

function buildContributingFactors(fields) {
  return {
    exposure: fields.exposure || null,
    cost_of_waiting: fields.costOfWaiting || null,
    severity: fields.severity || null,
    reversibility: fields.reversibility || null,
    timing_sensitivity: fields.timingSensitivity || null,
    overall_confidence: fields.overallConfidence || null,
    partial_context: Boolean(fields.partialContext),
    trigger_pathway: fields.triggerPathway || null,
    days_until_review: fields.daysUntilReview === undefined || fields.daysUntilReview === null
      ? null
      : fields.daysUntilReview,
  };
}

// Priority derivation, V1.0 -- rules applied in order, first match wins.
// See file header for field provenance. Never throws; a completely empty
// `fields` object falls through to the LOW default.
function computePriority(fields = {}) {
  const {
    overallConfidence,
    exposure,
    costOfWaiting,
    severity,
    reversibility,
    timingSensitivity,
    partialContext,
    triggerPathway,
    daysUntilReview,
  } = fields;

  const contributingFactors = buildContributingFactors(fields);
  const highOrModerate = isHighOrModerateConfidence(overallConfidence);

  if (highOrModerate) {
    const reasons = [];
    if (costOfWaitingIsImmediateOrCritical(costOfWaiting)) {
      reasons.push(`cost_of_waiting signals urgency ("${costOfWaiting}")`);
    }
    if (reversibilityIsLowOrIrreversible(reversibility)) {
      reasons.push(`reversibility is "${reversibility}"`);
    }
    if (timingSensitivityIsHigh(timingSensitivity)) {
      reasons.push(`timing_sensitivity is "${timingSensitivity}"`);
    }
    if (triggerPathway === 'DECISION_DEADLINE_APPROACHING' && daysUntilReviewUnder(daysUntilReview, 7)) {
      reasons.push(`trigger_pathway is DECISION_DEADLINE_APPROACHING with ${daysUntilReview} day(s) until review`);
    }
    if (reasons.length) {
      return {
        priority: 'IMMEDIATE',
        priorityReason: `Confidence is ${norm(overallConfidence)} and ${reasons.join('; ')}.`,
        contributingFactors,
      };
    }
  }

  if (highOrModerate) {
    const reasons = [];
    if (severityIsHigh(severity)) {
      reasons.push(`severity is "${severity}"`);
    }
    if (timingSensitivityIsModerateOrHigh(timingSensitivity)) {
      reasons.push(`timing_sensitivity is "${timingSensitivity}"`);
    }
    if (triggerPathway === 'OUTCOME_DIVERGES_FROM_EXPECTATION') {
      reasons.push('trigger_pathway is OUTCOME_DIVERGES_FROM_EXPECTATION');
    }
    if (triggerPathway === 'REVERSIBLE_BECOMING_IRREVERSIBLE') {
      reasons.push('trigger_pathway is REVERSIBLE_BECOMING_IRREVERSIBLE');
    }
    if (reasons.length) {
      return {
        priority: 'HIGH',
        priorityReason: `Confidence is ${norm(overallConfidence)} and ${reasons.join('; ')}.`,
        contributingFactors,
      };
    }
  }

  if (isLowOrModerateConfidence(overallConfidence) && !partialContext) {
    return {
      priority: 'MODERATE',
      priorityReason: `Confidence is ${norm(overallConfidence)}, no IMMEDIATE/HIGH condition matched, and context was not partial.`,
      contributingFactors,
    };
  }

  if (isLowOrUnknownConfidence(overallConfidence) || partialContext) {
    return {
      priority: 'LOW',
      priorityReason: partialContext
        ? 'Context was partial, capping priority at LOW.'
        : `Confidence is ${norm(overallConfidence) || 'UNKNOWN'} and no higher-priority condition matched.`,
      contributingFactors,
    };
  }

  return {
    priority: 'LOW',
    priorityReason: 'No prioritisation rule matched; defaulted to LOW.',
    contributingFactors,
  };
}

module.exports = { RULE_VERSION, computePriority };
