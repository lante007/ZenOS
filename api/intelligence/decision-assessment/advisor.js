'use strict';

// api/intelligence/decision-assessment/advisor.js
//
// Decision Assessment -- Advisor (Contract 3, agent 3 of 3). Single
// forced-tool-call agent, same Prophet shape as evidence-analyst.js and
// strategic-analyst.js: no retrieval, no tool-use rounds.
//
// This is NOT api/intelligence/agents/advisor.js. That file is the
// QUESTION-mode synthesis agent and is never modified by this file, never
// imported by this file, and never given a mode branch for Decision
// Assessment. This module is a deliberately separate synthesis agent for
// one Decision Event, with its own config key, its own system prompt (in
// ./contexts, built from the same shared blocks the QUESTION-mode Advisor
// uses), and its own forced tool schema. The two must be able to change
// independently without ever affecting one another.
//
// FAIL CLOSED (Q1): this agent runs only when BOTH the Evidence Analyst
// and the Strategic Analyst returned status 'ok' with a validated,
// well-shaped output. Unlike strategic-analyst.js (which is handed the
// Evidence Analyst's already-unwrapped output object and shape-checks it
// directly), this agent is deliberately handed the full result envelopes
// from runEvidenceAnalystDecisionAgent / runStrategicAnalystDecisionAgent
// (i.e. objects carrying their own `status` and `error`), because Q1's
// contract is written in terms of specialist status, not just specialist
// output shape: on failure, this agent must preserve which specialist
// failed and why, not fabricate a generic error. If either failed, this
// agent does not run at all -- no Anthropic call is made -- and a
// structured failure is returned describing exactly which upstream agent
// failed.
//
// Institutional memory and external intelligence: unlike the two
// specialists (which never read either, structurally -- see their file
// headers), this agent DOES read context.institutionalMemory and
// context.externalIntelligence when present, because Contract 3 reserves
// both explicitly for the Advisor's synthesis layer. They are rendered
// into the prompt as clearly labelled CONTEXT blocks (reusing the exact
// formatMemoryContext / formatExternalIntelligenceContext helpers
// QUESTION-mode's Advisor already uses, so the labelling discipline is
// identical), and are never permitted to feed what_the_evidence_
// establishes[] -- see the provenance boundary below.
//
// PROVENANCE BOUNDARY (Q3): every item in what_the_evidence_establishes[]
// must cite a source_type/source_id pair that was already present in
// evidenceOutput.established_findings -- not context.evidence (which may
// contain records the Evidence Analyst chose not to establish anything
// from), and never institutional memory or external intelligence.
// buildProvenanceIndexFromEvidenceOutput() builds that narrower set from
// the Evidence Analyst's OWN output, deliberately narrower than
// evidence-analyst.js's buildProvenanceIndex(context) (which indexes the
// whole supplied context) -- this agent cannot promote raw context to
// evidence, it can only restate what the Evidence Analyst already
// established. validateDecisionAssessment() fails closed on any citation
// outside that set.
//
// CONFIDENCE CEILING (Q7) and PARTIAL CONTEXT CEILING (Q2): both are
// enforced in validateDecisionAssessment()/assembleDecisionAssessment(),
// not by prompt instruction alone (the prompt also states both rules, but
// a model instruction is not a control). overall_confidence's rank may
// never be stronger than the weaker of evidence_confidence and
// strategic_confidence (Q7), and may never be HIGH at all when
// context.partialContext is true (Q2), regardless of how confident either
// specialist was. computeConfidenceCeiling() derives the single strongest
// permissible overall_confidence value from both rules at once.
//
// RECOMMENDATION BOUNDARY (Q5): recommended_action need not be literally
// identical to one of the Strategic Analyst's options[].action values --
// the Advisor may synthesise -- but if it is not a reasonable match to any
// supplied option, deviation_note must be non-empty explaining the
// departure. recommendationMatchesASuppliedOption() is a deliberately
// narrow, mechanical string-containment check (same "narrow, mechanical
// guard" philosophy as strategic-analyst.js's numeric-fabrication check,
// not an attempt at semantic judgement). Grounding against fabricated
// numeric claims reuses strategic-analyst.js's own
// collectAllowedNumbers()/extractNumericClaims() rather than duplicating
// that logic, applied here to this agent's own free-text fields
// (situation, strategic_assessment, recommended_action, deviation_note):
// any percentage is fabricated by construction (this codebase never
// supplies a probability), and any currency figure must match a real
// figure already present in the supplied context.
//
// NO PRIORITY (Q6): the forced tool schema below has no priority field,
// and assembleDecisionAssessment() only ever reads the named fields below
// -- a priority value can never reach the returned assessment even if a
// tool-call response tries to smuggle one in, and this agent never reads
// or writes decision_event.priority. Priority is a subsequent Decision
// Prioritisation layer's responsibility, not this agent's.
//
// APPEND-ONLY (Q4): this module has no notion of an assessment id or
// version and performs no persistence -- it returns one assessment for
// one call. Versioning and append-only storage are the caller's
// responsibility (the eventual decision_assessments write path), not
// this agent's.
//
// Validation order (deliberate, load-bearing -- same reasoning as the two
// specialists): validateDecisionAssessment() runs on the RAW tool-call
// input, BEFORE assembleDecisionAssessment() ever touches it. assemble()
// defaults overall_confidence to 'UNKNOWN' on a missing value, the same
// value used for genuine model uncertainty -- validating the raw input
// first means a genuinely missing field fails closed, while an explicit
// 'UNKNOWN' the model actually returned passes.
//
// Known test gap (technical debt, not fixed in this increment, same as
// both specialists): no Anthropic-call mocking exists in this codebase's
// test conventions. Focused tests here cover prompt-building, provenance
// indexing, the confidence-ceiling calculation, assemble, validate, and
// the pre-flight fail-closed branches that return before any network call
// is made. The live-call path itself is not exercised by this suite.

const Anthropic = require('@anthropic-ai/sdk');
const { agentConfig } = require('../config');
const { CONFIDENCE_LEVELS, normaliseConfidence } = require('../confidence');
const { ADVISOR_DECISION_CONTEXT } = require('./contexts');
const { buildDecisionFacts } = require('./evidence-analyst');
const { collectAllowedNumbers, extractNumericClaims } = require('./strategic-analyst');
const { formatMemoryContext } = require('../../memory/context');
const { formatExternalIntelligenceContext } = require('../scouts/context');

const client = new Anthropic();

// Same enum evidence-analyst.js's schema/validation use, kept local here
// (that file exports no named constant for it) so this agent's own
// provenance validation stays self-contained.
const SOURCE_TYPES = ['signal', 'decision', 'outcome', 'programme'];

const SUBMIT_DECISION_ASSESSMENT_TOOL = {
  name: 'submit_decision_assessment',
  description: 'Return the final synthesised assessment for this Decision Event. Call exactly once.',
  input_schema: {
    type: 'object',
    properties: {
      situation: { type: 'string', description: 'Plain statement of what is being decided and why it matters, grounded in the evidence and strategic assessment above.' },
      what_the_evidence_establishes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            point: { type: 'string' },
            source_type: { type: 'string', enum: ['signal', 'decision', 'outcome', 'programme'] },
            source_id: { type: 'string', description: 'Must exactly match a source_id the Evidence Analyst already cited above. Never cite institutional memory, external intelligence, or a record the Evidence Analyst did not establish a finding from.' },
          },
          required: ['point', 'source_type', 'source_id'],
        },
      },
      what_we_do_not_know: { type: 'array', items: { type: 'string' } },
      strategic_assessment: { type: 'string', description: 'Brief synthesis of the Strategic Analyst\'s exposure, severity, reversibility and timing reading. Do not invent figures beyond what the Strategic Analyst already stated.' },
      recommended_action: { type: 'string', description: 'One specific next step. May synthesise across the Strategic Analyst\'s options rather than repeat one verbatim, but must be grounded in the evidence and assessment above.' },
      deviation_note: { type: 'string', description: 'Empty string if recommended_action matches one of the Strategic Analyst\'s supplied options. Otherwise, explain plainly what you departed from and why.' },
      evidence_still_needed: { type: 'array', items: { type: 'string' } },
      overall_confidence: {
        type: 'string',
        enum: CONFIDENCE_LEVELS,
        description: 'May never exceed the weaker of the Evidence Analyst\'s and Strategic Analyst\'s confidence, and may never be HIGH if the supplied context was flagged partial.',
      },
    },
    required: [
      'situation', 'what_the_evidence_establishes', 'what_we_do_not_know', 'strategic_assessment',
      'recommended_action', 'deviation_note', 'evidence_still_needed', 'overall_confidence',
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

// Narrower, deliberately, than evidence-analyst.js's buildProvenanceIndex():
// only what the Evidence Analyst actually established, never the whole
// supplied context. See file header, "PROVENANCE BOUNDARY".
function buildProvenanceIndexFromEvidenceOutput(evidenceOutput) {
  const idx = new Set();
  const findings = (evidenceOutput && evidenceOutput.established_findings) || [];
  findings.forEach((f) => {
    if (f && f.source_type && f.source_id) idx.add(`${f.source_type}:${f.source_id}`);
  });
  return idx;
}

function confidenceRank(level) {
  const idx = CONFIDENCE_LEVELS.indexOf(level);
  return idx === -1 ? CONFIDENCE_LEVELS.length - 1 : idx;
}

// Derives the single strongest permissible overall_confidence value from
// both Q7 (confidence ceiling) and Q2 (partial context ceiling) at once.
// Lower CONFIDENCE_LEVELS index is stronger; the returned value is the
// strongest value overall_confidence is still allowed to be.
function computeConfidenceCeiling(evidenceConfidence, strategicConfidence, partialContext) {
  const weakestSpecialistIdx = Math.max(confidenceRank(evidenceConfidence), confidenceRank(strategicConfidence));
  const partialContextFloorIdx = partialContext ? confidenceRank('MODERATE') : 0;
  const ceilingIdx = Math.max(weakestSpecialistIdx, partialContextFloorIdx);
  return CONFIDENCE_LEVELS[ceilingIdx];
}

// Deliberately narrow, mechanical string-containment check -- not semantic
// judgement. Mirrors the "narrow, mechanical guard" philosophy of
// strategic-analyst.js's numeric-fabrication check. See file header,
// "RECOMMENDATION BOUNDARY".
function recommendationMatchesASuppliedOption(recommendedAction, options) {
  const normalise = (s) => String(s || '').trim().toLowerCase();
  const rec = normalise(recommendedAction);
  if (!rec) return false;
  return (options || []).some((o) => {
    const action = normalise(o && o.action);
    if (!action) return false;
    return rec === action || rec.includes(action) || action.includes(rec);
  });
}

function checkFailClosed(evidenceResult, strategicResult) {
  if (!evidenceResult || evidenceResult.status !== 'ok' || !evidenceResult.output
    || !Array.isArray(evidenceResult.output.established_findings)
    || !CONFIDENCE_LEVELS.includes(evidenceResult.output.evidence_confidence)) {
    return `Evidence Analyst (Decision) did not return a valid ok result: ${(evidenceResult && evidenceResult.error) || 'no valid output'}`;
  }
  if (!strategicResult || strategicResult.status !== 'ok' || !strategicResult.output
    || !Array.isArray(strategicResult.output.options)
    || !CONFIDENCE_LEVELS.includes(strategicResult.output.strategic_confidence)) {
    return `Strategic Analyst (Decision) did not return a valid ok result: ${(strategicResult && strategicResult.error) || 'no valid output'}`;
  }
  return null;
}

function buildAdvisorDecisionPrompt(context, facts, evidenceOutput, strategicOutput) {
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
  const optionsText = (strategicOutput.options || []).length
    ? strategicOutput.options.map((o) => `- ${o.action} -- tradeoff: ${o.tradeoff} (timeframe: ${o.timeframe})`).join('\n')
    : '(none supplied)';

  const lines = [
    'DECISION EVENT CONTEXT (already assembled; treat as fact)',
    facts.map((f) => `- ${f}`).join('\n'),
    '',
    'EVIDENCE ANALYST FINDINGS (already established and validated)',
    'Established findings (cite ONLY these source_type:source_id pairs in what_the_evidence_establishes):',
    findingsText,
    'Evidence limitations:',
    limitationsText,
    'Evidence gaps:',
    gapsText,
    `Evidence Analyst confidence: ${evidenceOutput.evidence_confidence}`,
    '',
    'STRATEGIC ANALYST ASSESSMENT (already established and validated)',
    `Exposure: ${strategicOutput.exposure} (basis: ${strategicOutput.exposure_basis})`,
    `Severity: ${strategicOutput.severity}`,
    `Reversibility: ${strategicOutput.reversibility}`,
    `Timing sensitivity: ${strategicOutput.timing_sensitivity}`,
    `Cost of waiting: ${strategicOutput.cost_of_waiting}`,
    `Opportunity cost: ${strategicOutput.opportunity_cost}`,
    'Options considered:',
    optionsText,
    strategicOutput.deviation_from_evidence ? `Strategic Analyst noted a deviation from the evidence: ${strategicOutput.deviation_from_evidence}` : '',
    `Strategic Analyst confidence: ${strategicOutput.strategic_confidence}`,
  ];

  const memoryBlock = formatMemoryContext(context && context.institutionalMemory);
  if (memoryBlock) lines.push('', memoryBlock, '', 'The block above is CONTEXT ONLY. It is never evidence and must never appear in what_the_evidence_establishes[].');

  const externalBlock = formatExternalIntelligenceContext(context && context.externalIntelligence);
  if (externalBlock) lines.push('', externalBlock, '', 'The block above is CONTEXT ONLY. It is never evidence and must never appear in what_the_evidence_establishes[].');

  lines.push(
    '',
    'Call submit_decision_assessment. Every item in what_the_evidence_establishes must cite one of the exact source_type:source_id pairs listed above under Evidence Analyst findings -- nothing from context, institutional memory, or external intelligence. recommended_action may synthesise across the options above rather than repeat one verbatim, but if it is not a reasonable match to any of them, deviation_note must explain why. Do not assign a priority level -- that is not your role. overall_confidence may not exceed the weaker of the two specialist confidences above, and may not be HIGH if the context was flagged partial.',
  );

  return lines.filter((l) => l !== '').join('\n');
}

// Field-by-field reconstruction only, mirroring both specialists: nothing
// from `input` is ever spread or copied wholesale, so an unexpected key
// (e.g. a priority field this schema never defines) can never reach the
// returned assessment. See file header, "NO PRIORITY".
function assembleDecisionAssessment(input = {}) {
  const what_the_evidence_establishes = Array.isArray(input.what_the_evidence_establishes)
    ? input.what_the_evidence_establishes.map((e) => ({
        point: (e && e.point) || '',
        source_type: (e && e.source_type) || '',
        source_id: (e && e.source_id) || '',
      }))
    : [];

  return {
    situation: input.situation || '',
    what_the_evidence_establishes,
    what_we_do_not_know: Array.isArray(input.what_we_do_not_know) ? input.what_we_do_not_know.slice() : [],
    strategic_assessment: input.strategic_assessment || '',
    recommended_action: input.recommended_action || '',
    deviation_note: typeof input.deviation_note === 'string' ? input.deviation_note : '',
    evidence_still_needed: Array.isArray(input.evidence_still_needed) ? input.evidence_still_needed.slice() : [],
    overall_confidence: normaliseConfidence(input.overall_confidence),
  };
}

// Inline shape + provenance + confidence-ceiling + recommendation-boundary
// validation (same Q3-in-code convention as both specialists: no
// dedicated contract module yet). Fails closed on any violation, never
// silently coerces or drops a bad item to make the assessment look valid.
function validateDecisionAssessment(assessment, opts = {}) {
  const { provenanceIndex, evidenceConfidence, strategicConfidence, partialContext, strategicOptions, allowedNumbers } = opts;
  const errors = [];
  if (!assessment || typeof assessment !== 'object') return ['assessment must be an object'];

  if (!assessment.situation) errors.push('situation required');

  if (!Array.isArray(assessment.what_the_evidence_establishes)) {
    errors.push('what_the_evidence_establishes[] required');
  } else {
    assessment.what_the_evidence_establishes.forEach((e, i) => {
      if (!e.point) errors.push(`what_the_evidence_establishes[${i}].point required`);
      if (!SOURCE_TYPES.includes(e.source_type)) {
        errors.push(`what_the_evidence_establishes[${i}].source_type must be ${SOURCE_TYPES.join('|')}`);
      }
      if (!e.source_id) {
        errors.push(`what_the_evidence_establishes[${i}].source_id required`);
      } else if (provenanceIndex && !provenanceIndex.has(`${e.source_type}:${e.source_id}`)) {
        errors.push(`what_the_evidence_establishes[${i}] cites source_id "${e.source_id}" (${e.source_type}) which the Evidence Analyst did not establish -- unverifiable provenance`);
      }
    });
  }

  if (!Array.isArray(assessment.what_we_do_not_know)) errors.push('what_we_do_not_know[] required');
  if (!assessment.strategic_assessment) errors.push('strategic_assessment required');
  if (!assessment.recommended_action) errors.push('recommended_action required');
  if (typeof assessment.deviation_note !== 'string') errors.push('deviation_note must be a string (use "" if none)');
  if (!Array.isArray(assessment.evidence_still_needed)) errors.push('evidence_still_needed[] required');

  if (!CONFIDENCE_LEVELS.includes(assessment.overall_confidence)) {
    errors.push(`overall_confidence must be one of ${CONFIDENCE_LEVELS.join('|')}`);
  } else if (evidenceConfidence && strategicConfidence) {
    const ceiling = computeConfidenceCeiling(evidenceConfidence, strategicConfidence, Boolean(partialContext));
    if (confidenceRank(assessment.overall_confidence) < confidenceRank(ceiling)) {
      errors.push(`overall_confidence "${assessment.overall_confidence}" exceeds the permitted ceiling "${ceiling}" (weaker of evidence/strategic confidence${partialContext ? ', capped further by partial context' : ''})`);
    }
  }

  // Nothing to deviate from if the Strategic Analyst supplied no options at
  // all -- the boundary is about departing from a real supplied option, not
  // about penalising an empty options[] the Advisor had no control over.
  if (assessment.recommended_action && !assessment.deviation_note
    && Array.isArray(strategicOptions) && strategicOptions.length > 0
    && !recommendationMatchesASuppliedOption(assessment.recommended_action, strategicOptions)) {
    errors.push('deviation_note required when recommended_action departs from the Strategic Analyst\'s supplied options');
  }

  const fieldsToScan = ['situation', 'strategic_assessment', 'recommended_action', 'deviation_note'];
  fieldsToScan.forEach((field) => {
    extractNumericClaims(assessment[field]).forEach((claim) => {
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

async function runAdvisorDecisionAgent(context, evidenceResult, strategicResult) {
  const cfg = agentConfig('advisor_decision');
  const startedAt = Date.now();
  const usage = { input_tokens: 0, output_tokens: 0 };
  const decisionEventId = context && context.decisionEvent && context.decisionEvent.id;

  if (!context || !decisionEventId) {
    return {
      agent: 'advisor_decision',
      status: 'failed',
      execution_ms: 0,
      model: cfg.model,
      usage,
      decision_event_id: decisionEventId || null,
      output: null,
      error: 'A decision assessment context is required',
    };
  }

  // FAIL CLOSED (Q1): both specialists must have returned status 'ok' with
  // a validated output before this agent runs at all. No Anthropic call is
  // made otherwise, and the specific upstream failure is preserved.
  const failClosedReason = checkFailClosed(evidenceResult, strategicResult);
  if (failClosedReason) {
    return {
      agent: 'advisor_decision',
      status: 'failed',
      execution_ms: 0,
      model: cfg.model,
      usage,
      decision_event_id: decisionEventId,
      output: null,
      error: failClosedReason,
    };
  }

  const evidenceOutput = evidenceResult.output;
  const strategicOutput = strategicResult.output;
  const facts = buildDecisionFacts(context);
  const provenanceIndex = buildProvenanceIndexFromEvidenceOutput(evidenceOutput);
  const allowedNumbers = collectAllowedNumbers(context);
  const partialContext = Boolean(context.partialContext);

  const work = (async () => {
    const prompt = buildAdvisorDecisionPrompt(context, facts, evidenceOutput, strategicOutput);

    const params = {
      model: cfg.model,
      max_tokens: cfg.max_tokens,
      system: ADVISOR_DECISION_CONTEXT,
      tools: [SUBMIT_DECISION_ASSESSMENT_TOOL],
      tool_choice: { type: 'tool', name: 'submit_decision_assessment' },
      messages: [{ role: 'user', content: prompt }],
    };
    const resp = await client.messages.create(params);
    usage.input_tokens += resp.usage?.input_tokens || 0;
    usage.output_tokens += resp.usage?.output_tokens || 0;

    const toolUse = (resp.content || []).find((b) => b.type === 'tool_use' && b.name === 'submit_decision_assessment');
    if (!toolUse) throw new Error('Advisor (Decision) did not return a structured assessment');

    // Validate the RAW tool-call input first, before assemble() ever
    // touches it -- see file header. A missing required field fails here;
    // an explicit 'UNKNOWN' the model actually returned does not.
    const raw = toolUse.input || {};
    // Fail closed on raw input for fields whose absence is a genuine
    // quality failure -- these are never defaulted. Secondary fields
    // (deviation_note, evidence_still_needed, overall_confidence) are
    // safely defaulted by assembleDecisionAssessment and validated only
    // after assembly.
    if (!raw.situation || typeof raw.situation !== 'string') {
      throw new Error('Decision assessment failed shape/provenance/confidence validation: situation required');
    }
    if (!Array.isArray(raw.what_the_evidence_establishes)) {
      throw new Error('Decision assessment failed shape/provenance/confidence validation: what_the_evidence_establishes[] required');
    }
    if (!Array.isArray(raw.what_we_do_not_know)) {
      throw new Error('Decision assessment failed shape/provenance/confidence validation: what_we_do_not_know[] required');
    }
    if (!raw.strategic_assessment || typeof raw.strategic_assessment !== 'string') {
      throw new Error('Decision assessment failed shape/provenance/confidence validation: strategic_assessment required');
    }
    if (!raw.recommended_action || typeof raw.recommended_action !== 'string') {
      throw new Error('Decision assessment failed shape/provenance/confidence validation: recommended_action required');
    }

    const assessment = assembleDecisionAssessment(raw);
    const errors = validateDecisionAssessment(assessment, {
      provenanceIndex,
      evidenceConfidence: evidenceOutput.evidence_confidence,
      strategicConfidence: strategicOutput.strategic_confidence,
      partialContext,
      strategicOptions: strategicOutput.options,
      allowedNumbers,
    });
    if (errors.length) throw new Error(`Decision assessment failed shape/provenance/confidence validation: ${errors.join('; ')}`);
    return assessment;
  })();

  try {
    const assessment = await withTimeout(work, cfg.timeout_ms, 'advisor_decision');
    return {
      agent: 'advisor_decision',
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
      agent: 'advisor_decision',
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
  runAdvisorDecisionAgent,
  checkFailClosed,
  buildProvenanceIndexFromEvidenceOutput,
  computeConfidenceCeiling,
  recommendationMatchesASuppliedOption,
  buildAdvisorDecisionPrompt,
  assembleDecisionAssessment,
  validateDecisionAssessment,
};

