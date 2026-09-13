'use strict';

// api/intelligence/decision-assessment/strategic-analyst.js
//
// Decision Assessment -- Strategic Analyst, Economic/Actuarial Lens
// (Contract 3, agent 2 of 3). Same Prophet shape as evidence-analyst.js:
// single forced tool call, no retrieval, no tool-use rounds.
//
// Runs sequentially AFTER the Evidence Analyst (per the approved design):
// it receives the same deterministic facts (buildDecisionFacts, reused
// from ./evidence-analyst) plus the Evidence Analyst's already-validated
// output, and reasons from that -- it does not re-derive the evidence
// layer itself. If no valid Evidence Analyst output is supplied, this
// agent refuses to run at all (fails closed): a strategic reading with
// nothing underneath it is not a reading, it's a guess wearing a schema.
//
// Institutional memory and external intelligence are never read here,
// structurally, for the same reason as evidence-analyst.js -- both are
// reserved for the Advisor's synthesis layer.
//
// No fabricated numerical precision: validateStrategicAssessment() scans
// the free-text fields most likely to carry a fabricated figure (exposure,
// exposure_basis, cost_of_waiting, opportunity_cost) for currency- and
// percentage-shaped tokens, and fails closed if a currency figure doesn't
// match any real figure from the supplied context, or if a percentage
// figure appears at all (this codebase's context never supplies a
// probability, so any percentage is by construction invented). This is a
// deliberately narrow, mechanical guard -- it does not (and cannot) catch
// every form of overconfident language, only fabricated numeric claims.
//
// This agent's tool schema has no recommended_action and no priority
// field. That omission is the structural enforcement of "must not
// independently recommend a CEO action; must not assign final priority" --
// there is no field for the model to put either in, and
// assembleStrategicAssessment() only ever reads the fields named below.
//
// Validation order (deliberate, load-bearing -- same reasoning as
// evidence-analyst.js): validateStrategicAssessment() runs on the RAW
// tool-call input, BEFORE assembleStrategicAssessment() ever touches it.
// assemble() defaults several missing enums (severity, reversibility,
// timing_sensitivity, strategic_confidence) to the same 'UNKNOWN' value
// that also means "the model deliberately said it doesn't know" -- if
// validation ran on the assembled object, a genuinely missing field and a
// deliberate UNKNOWN would be indistinguishable. Validating the raw input
// first means a missing field fails closed, while an explicit 'UNKNOWN'
// the model actually returned passes. assemble() is only ever called after
// validation has already succeeded.
//
// Known test gap (technical debt, not fixed in this increment): Decision
// Assessment specialist network/API failure paths require integration
// testing before production activation. No Anthropic-call mocking exists
// in this codebase's test conventions -- current unit tests cover the
// deterministic prompt-building, assemble, and validate functions
// directly, plus the pre-flight fail-closed branches of
// runStrategicAnalystDecisionAgent that return before any network call is
// made.

const Anthropic = require('@anthropic-ai/sdk');
const { agentConfig } = require('../config');
const { CONFIDENCE_LEVELS, normaliseConfidence } = require('../confidence');
const { STRATEGIC_ANALYST_DECISION_CONTEXT } = require('./contexts');
const { buildDecisionFacts } = require('./evidence-analyst');

const client = new Anthropic();

const SEVERITY_LEVELS = ['CRITICAL', 'HIGH', 'MODERATE', 'LOW', 'UNKNOWN'];
const REVERSIBILITY_LEVELS = ['REVERSIBLE', 'PARTIALLY_REVERSIBLE', 'IRREVERSIBLE', 'UNKNOWN'];
const TIMING_LEVELS = ['IMMEDIATE', 'NEAR_TERM', 'NOT_TIME_SENSITIVE', 'UNKNOWN'];

const SUBMIT_STRATEGIC_ASSESSMENT_TOOL = {
  name: 'submit_strategic_assessment',
  description: 'Return the structured economic/actuarial assessment for this Decision Event. Call exactly once.',
  input_schema: {
    type: 'object',
    properties: {
      exposure: { type: 'string' },
      exposure_basis: {
        type: 'string',
        description: 'What this exposure claim rests on -- must trace to a fact or an Evidence Analyst finding, not an invented figure.',
      },
      severity: { type: 'string', enum: SEVERITY_LEVELS },
      uncertainty_factors: { type: 'array', items: { type: 'string' } },
      cost_of_waiting: { type: 'string' },
      reversibility: { type: 'string', enum: REVERSIBILITY_LEVELS },
      opportunity_cost: { type: 'string' },
      timing_sensitivity: { type: 'string', enum: TIMING_LEVELS },
      options: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            action: { type: 'string' },
            tradeoff: { type: 'string' },
            timeframe: { type: 'string' },
          },
          required: ['action', 'tradeoff', 'timeframe'],
        },
      },
      evidence_that_would_change_assessment: { type: 'array', items: { type: 'string' } },
      assumptions: { type: 'array', items: { type: 'string' } },
      strategic_confidence: { type: 'string', enum: CONFIDENCE_LEVELS },
      deviation_from_evidence: {
        type: 'string',
        description: 'Empty string if fully consistent with the Evidence Analyst findings. Otherwise, explain plainly what you departed from and why.',
      },
    },
    required: [
      'exposure', 'exposure_basis', 'severity', 'uncertainty_factors', 'cost_of_waiting',
      'reversibility', 'opportunity_cost', 'timing_sensitivity', 'options',
      'evidence_that_would_change_assessment', 'assumptions', 'strategic_confidence',
      'deviation_from_evidence',
    ],
  },
};

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// The only figures a strategic claim is allowed to cite: real total_cost_rand
// values actually present in the supplied programme records. Anything else
// showing up as a currency figure in the model's output is fabricated by
// construction.
function collectAllowedNumbers(context) {
  const nums = new Set();
  const programmes = (context && context.evidence && context.evidence.programmes) || [];
  programmes.forEach((p) => {
    if (p.total_cost_rand !== undefined && p.total_cost_rand !== null) {
      nums.add(String(p.total_cost_rand).replace(/[^0-9.]/g, ''));
    }
  });
  // The investment materiality threshold (R25,000,000) is a named constant
  // that appears in this Decision Event's narrative context (the
  // SIGNAL_TOUCHES_EXPOSURE pathway description) and which the model may
  // legitimately cite -- it is not a fabricated figure.
  nums.add('25000000');
  return nums;
}

function extractNumericClaims(text) {
  if (!text || typeof text !== 'string') return [];
  const matches = [];
  const currencyRe = /(?<![a-zA-Z])(?:R|\$)\s?[\d,]+(?:\.\d+)?/gi;
  const percentRe = /\b\d+(?:\.\d+)?\s?%/g;
  let m;
  while ((m = currencyRe.exec(text)) !== null) {
    const match = m[0];
    // Filter out fragments with fewer than 2 digits -- these are malformed
    // extraction artifacts (e.g. "r," from a truncated currency token),
    // not meaningful numeric claims.
    const digits = match.replace(/[^0-9]/g, '');
    if (digits.length < 2) continue;
    matches.push(match);
  }
  while ((m = percentRe.exec(text)) !== null) {
    const match = m[0];
    const digits = match.replace(/[^0-9]/g, '');
    if (digits.length < 2) continue;
    matches.push(match);
  }
  return matches;
}

function buildStrategicAnalystPrompt(context, facts, evidenceOutput) {
  const findings = evidenceOutput.established_findings || [];
  const findingsText = findings.length
    ? findings.map((f) => `- ${f.finding} [${f.source_type}:${f.source_id}]`).join('\n')
    : '(none established)';
  const limitationsText = (evidenceOutput.evidence_limitations || []).length
    ? evidenceOutput.evidence_limitations.map((l) => `- ${l}`).join('\n')
    : '(none noted)';
  const gapsText = (evidenceOutput.evidence_gaps || []).length
    ? evidenceOutput.evidence_gaps.map((g) => `- ${g}`).join('\n')
    : '(none noted)';

  return [
    'DECISION EVENT CONTEXT (already assembled; treat as fact)',
    facts.map((f) => `- ${f}`).join('\n'),
    '',
    'EVIDENCE ANALYST FINDINGS (already established -- reason from these; do not re-derive or silently contradict them)',
    'Established findings:',
    findingsText,
    'Evidence limitations:',
    limitationsText,
    'Evidence gaps:',
    gapsText,
    `Evidence Analyst overall confidence: ${evidenceOutput.evidence_confidence}`,
    '',
    'Call submit_strategic_assessment with your economic/actuarial reading of this decision event: exposure, exposure basis, severity, uncertainty factors, cost of waiting, reversibility, opportunity cost, timing sensitivity, options (each with its own tradeoff and timeframe), and what additional evidence would materially change this assessment. Do not invent monetary values, probabilities, or expected values that are not already present above. Do not recommend a specific CEO action and do not assign a priority level -- that is not your role.',
  ].join('\n');
}

// Strips XML-style tool-call artifacts that have been observed leaking into
// free-text string fields (e.g. "</exposure>", '<parameter name="...">').
// This is a narrow, mechanical cleanup -- it does not attempt to recover or
// reformat any content described by the leaked tag, it only removes the tag
// syntax itself and trims the result.
function stripXmlArtifacts(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/<\/[a-zA-Z0-9_]+>/g, '')
    .replace(/<parameter\s+name="[^"]*">/g, '')
    .replace(/<[^>]*>/g, '')
    .trim();
}

// Field-by-field reconstruction only -- no recommended_action or priority
// field exists in the schema above, and none is ever read here even if a
// tool-call response tries to smuggle one in.
function assembleStrategicAssessment(input = {}) {
  // Default secondary fields if the model omitted them or returned an
  // invalid shape (claude-sonnet-5 with thin context reliably omits arrays
  // and enums rather than returning explicit defaults). exposure and
  // severity are deliberately NOT defaulted here -- absence of either is a
  // genuine quality failure, checked against raw input before this
  // function is ever called (see runStrategicAnalystDecisionAgent).
  const normalised = {
    ...input,
    uncertainty_factors: Array.isArray(input.uncertainty_factors) ? input.uncertainty_factors : [],
    options: Array.isArray(input.options) ? input.options : [],
    evidence_that_would_change_assessment: Array.isArray(input.evidence_that_would_change_assessment)
      ? input.evidence_that_would_change_assessment
      : [],
    assumptions: Array.isArray(input.assumptions) ? input.assumptions : [],
    reversibility: REVERSIBILITY_LEVELS.includes(input.reversibility) ? input.reversibility : 'UNKNOWN',
    timing_sensitivity: TIMING_LEVELS.includes(input.timing_sensitivity) ? input.timing_sensitivity : 'UNKNOWN',
    opportunity_cost: typeof input.opportunity_cost === 'string' ? input.opportunity_cost : '',
    strategic_confidence: CONFIDENCE_LEVELS.includes(input.strategic_confidence) ? input.strategic_confidence : 'UNKNOWN',
    deviation_from_evidence: typeof input.deviation_from_evidence === 'string' ? input.deviation_from_evidence : '',
    exposure_basis: typeof input.exposure_basis === 'string' ? input.exposure_basis : '',
    cost_of_waiting: typeof input.cost_of_waiting === 'string' ? input.cost_of_waiting : '',
  };

  const options = normalised.options.map((o) => ({
    action: (o && o.action) || '',
    tradeoff: (o && o.tradeoff) || '',
    timeframe: (o && o.timeframe) || '',
  }));

  return {
    exposure: stripXmlArtifacts(normalised.exposure) || '',
    exposure_basis: stripXmlArtifacts(normalised.exposure_basis),
    severity: normalised.severity,
    uncertainty_factors: normalised.uncertainty_factors.slice(),
    cost_of_waiting: stripXmlArtifacts(normalised.cost_of_waiting),
    reversibility: normalised.reversibility,
    opportunity_cost: stripXmlArtifacts(normalised.opportunity_cost),
    timing_sensitivity: normalised.timing_sensitivity,
    options,
    evidence_that_would_change_assessment: normalised.evidence_that_would_change_assessment.slice(),
    assumptions: normalised.assumptions.slice(),
    strategic_confidence: normalised.strategic_confidence,
    deviation_from_evidence: stripXmlArtifacts(normalised.deviation_from_evidence),
  };
}

// Inline shape + fabricated-numeric-precision validation (Q3: extract to a
// shared contract module in the same commit as the Advisor tool schema).
// Fails closed on any violation.
function validateStrategicAssessment(assessment, allowedNumbers) {
  const errors = [];
  if (!assessment || typeof assessment !== 'object') return ['assessment must be an object'];

  if (!assessment.exposure) errors.push('exposure required');
  if (assessment.exposure_basis === undefined || assessment.exposure_basis === null) errors.push('exposure_basis required');
  if (!SEVERITY_LEVELS.includes(assessment.severity)) errors.push(`severity must be one of ${SEVERITY_LEVELS.join('|')}`);
  if (!Array.isArray(assessment.uncertainty_factors)) errors.push('uncertainty_factors[] required');
  if (assessment.cost_of_waiting === undefined || assessment.cost_of_waiting === null) errors.push('cost_of_waiting required');
  if (!REVERSIBILITY_LEVELS.includes(assessment.reversibility)) errors.push(`reversibility must be one of ${REVERSIBILITY_LEVELS.join('|')}`);
  if (assessment.opportunity_cost === undefined || assessment.opportunity_cost === null) errors.push('opportunity_cost required');
  if (!TIMING_LEVELS.includes(assessment.timing_sensitivity)) errors.push(`timing_sensitivity must be one of ${TIMING_LEVELS.join('|')}`);

  if (!Array.isArray(assessment.options)) {
    errors.push('options[] required');
  } else {
    assessment.options.forEach((o, i) => {
      if (!o.action) errors.push(`options[${i}].action required`);
      if (!o.tradeoff) errors.push(`options[${i}].tradeoff required`);
      if (!o.timeframe) errors.push(`options[${i}].timeframe required`);
    });
  }

  if (!Array.isArray(assessment.evidence_that_would_change_assessment)) {
    errors.push('evidence_that_would_change_assessment[] required');
  }
  if (!Array.isArray(assessment.assumptions)) errors.push('assumptions[] required');
  if (!CONFIDENCE_LEVELS.includes(assessment.strategic_confidence)) {
    errors.push(`strategic_confidence must be one of ${CONFIDENCE_LEVELS.join('|')}`);
  }
  if (typeof assessment.deviation_from_evidence !== 'string') {
    errors.push('deviation_from_evidence must be a string (use "" if none)');
  }

  const fieldsToScan = ['exposure', 'exposure_basis', 'cost_of_waiting', 'opportunity_cost'];
  fieldsToScan.forEach((field) => {
    const claims = extractNumericClaims(assessment[field]);
    claims.forEach((claim) => {
      const trimmed = claim.trim();
      if (/%$/.test(trimmed)) {
        errors.push(`${field} contains a fabricated percentage/probability figure ("${trimmed}") -- no probability figure exists anywhere in the supplied context`);
        return;
      }
      const normalised = trimmed.replace(/[^0-9.]/g, '');
      if (!allowedNumbers || !allowedNumbers.has(normalised)) {
        errors.push(`${field} contains a numeric figure ("${trimmed}") that does not match any figure present in the supplied context -- fabricated precision is not permitted`);
      }
    });
  });

  return errors;
}

async function runStrategicAnalystDecisionAgent(context, evidenceOutput) {
  const cfg = agentConfig('strategic_analyst_decision');
  const startedAt = Date.now();
  const usage = { input_tokens: 0, output_tokens: 0 };
  const decisionEventId = context && context.decisionEvent && context.decisionEvent.id;

  if (!context || !decisionEventId) {
    return {
      agent: 'strategic_analyst_decision',
      status: 'failed',
      execution_ms: 0,
      model: cfg.model,
      usage,
      decision_event_id: decisionEventId || null,
      output: null,
      error: 'A decision assessment context is required',
    };
  }

  if (!evidenceOutput || !Array.isArray(evidenceOutput.established_findings) || !CONFIDENCE_LEVELS.includes(evidenceOutput.evidence_confidence)) {
    return {
      agent: 'strategic_analyst_decision',
      status: 'failed',
      execution_ms: 0,
      model: cfg.model,
      usage,
      decision_event_id: decisionEventId,
      output: null,
      error: 'A valid Evidence Analyst output is required before the Strategic Analyst can run',
    };
  }

  const facts = buildDecisionFacts(context);
  const allowedNumbers = collectAllowedNumbers(context);

  const work = (async () => {
    const prompt = buildStrategicAnalystPrompt(context, facts, evidenceOutput);

    const params = {
      model: cfg.model,
      max_tokens: cfg.max_tokens,
      system: STRATEGIC_ANALYST_DECISION_CONTEXT,
      tools: [SUBMIT_STRATEGIC_ASSESSMENT_TOOL],
      tool_choice: { type: 'tool', name: 'submit_strategic_assessment' },
      messages: [{ role: 'user', content: prompt }],
    };
    const resp = await client.messages.create(params);
    usage.input_tokens += resp.usage?.input_tokens || 0;
    usage.output_tokens += resp.usage?.output_tokens || 0;

    const toolUse = (resp.content || []).find((b) => b.type === 'tool_use' && b.name === 'submit_strategic_assessment');
    if (!toolUse) throw new Error('Strategic Analyst (Decision) did not return a structured assessment');

    // Validate the RAW tool-call input first, before assemble() ever
    // touches it -- see file header. A missing required field fails here;
    // an explicit 'UNKNOWN' the model actually returned does not.
    const raw = toolUse.input || {};
    // Fail closed on exposure and severity against raw input -- these two
    // fields are never defaulted; absence of either is a genuine quality
    // failure, not a secondary omission.
    if (!raw.exposure || typeof raw.exposure !== 'string') {
      throw new Error('Strategic assessment failed shape/precision validation: exposure required');
    }
    if (!SEVERITY_LEVELS.includes(raw.severity)) {
      throw new Error(`Strategic assessment failed shape/precision validation: severity must be one of ${SEVERITY_LEVELS.join('|')}`);
    }

    // Assemble with defaults/sanitisation for secondary fields, then
    // validate the rest (including numeric-precision scanning) against the
    // normalised, sanitised object.
    const assessment = assembleStrategicAssessment(raw);
    const errors = validateStrategicAssessment(assessment, allowedNumbers);
    if (errors.length) throw new Error(`Strategic assessment failed shape/precision validation: ${errors.join('; ')}`);
    return assessment;
  })();

  try {
    const assessment = await withTimeout(work, cfg.timeout_ms, 'strategic_analyst_decision');
    return {
      agent: 'strategic_analyst_decision',
      status: 'ok',
      execution_ms: Date.now() - startedAt,
      model: cfg.model,
      usage,
      decision_event_id: decisionEventId,
      output: assessment,
      error: null,
    };
  } catch (err) {
    return {
      agent: 'strategic_analyst_decision',
      status: 'failed',
      execution_ms: Date.now() - startedAt,
      model: cfg.model,
      usage,
      decision_event_id: decisionEventId,
      output: null,
      error: err.message,
    };
  }
}

module.exports = {
  runStrategicAnalystDecisionAgent,
  collectAllowedNumbers,
  extractNumericClaims,
  buildStrategicAnalystPrompt,
  assembleStrategicAssessment,
  validateStrategicAssessment,
};
