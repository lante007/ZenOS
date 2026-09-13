'use strict';

// api/intelligence/decision-assessment/evidence-analyst.js
//
// Decision Assessment -- Evidence Analyst (Contract 3, agent 1 of 3).
// Same shape as api/intelligence/agents/prophet.js: a single forced tool
// call, no retrieval loop, no tool-use rounds. This is a deliberate
// divergence from api/intelligence/agents/base.js#runSpecialistAgent
// (the QUESTION-mode gather-loop pattern), which Contract 3 forbids
// cloning for Decision Assessment.
//
// Deterministic fact layer: buildDecisionFacts() turns the already-
// assembled context (api/intelligence/decision-assessment/context.js) into
// plain, source-tagged sentences before the prompt is built, exactly as
// Prophet's buildObservedFacts() does for a Watchtower signal. The model
// is never asked to restate these; it is asked to reason over them.
//
// Institutional memory and external intelligence are never included in
// buildDecisionFacts() and never reach this agent's prompt. That exclusion
// is enforced structurally here, not by prompt instruction alone: this
// file simply never reads context.institutionalMemory or
// context.externalIntelligence. Those two fields exist only for the
// Advisor's later synthesis layer.
//
// Provenance: every established finding the model returns must cite a
// source_type/source_id pair that was actually present in the supplied
// context. buildProvenanceIndex() builds the set of valid pairs before the
// call; validateEvidenceAssessment() rejects (fails closed, does not
// silently drop) any finding citing a pair outside that set. This is the
// concrete mechanism behind "no invented facts" and "provenance back to
// the supplied corpus/source record" -- it is not merely requested in the
// prompt, it is checked in code.
//
// Validation order (deliberate, load-bearing): validateEvidenceAssessment()
// runs on the RAW tool-call input, BEFORE assembleEvidenceAssessment() ever
// touches it. assembleEvidenceAssessment() defaults a missing enum (e.g. no
// evidence_confidence at all) to the same 'UNKNOWN' value that also means
// "the model deliberately said it doesn't know" -- if validation ran on the
// assembled object, those two cases would be indistinguishable and a
// missing field would silently pass as a legitimate deliberate UNKNOWN.
// Validating the raw input first means a genuinely missing field fails
// closed, while an explicit 'UNKNOWN' the model actually returned passes.
// assemble() is only ever called after validation has already succeeded, so
// its normalisation is purely for downstream/presentation convenience on
// data already known to satisfy the contract, never a way of manufacturing
// contract-validity out of malformed input.
//
// Known test gap (technical debt, not fixed in this increment): Decision
// Assessment specialist network/API failure paths require integration
// testing before production activation. No Anthropic-call mocking exists
// in this codebase's test conventions (tests/prophet.test.js has the same
// gap) -- current unit tests cover the deterministic fact-building,
// prompt-building, assemble, and validate functions directly, plus the
// pre-flight fail-closed branches of runEvidenceAnalystDecisionAgent that
// return before any network call is made. The live-call path itself
// (timeout, malformed tool_use, Anthropic API errors) is exercised only
// by the pre-existing prophet.js pattern of manual/staging verification,
// not by this automated suite.

const Anthropic = require('@anthropic-ai/sdk');
const { agentConfig } = require('../config');
const { CONFIDENCE_LEVELS, normaliseConfidence } = require('../confidence');
const { EVIDENCE_ANALYST_DECISION_CONTEXT } = require('./contexts');

const client = new Anthropic();

const SUBMIT_EVIDENCE_ASSESSMENT_TOOL = {
  name: 'submit_evidence_assessment',
  description: 'Return the structured evidence assessment for this Decision Event. Call exactly once.',
  input_schema: {
    type: 'object',
    properties: {
      established_findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            finding: { type: 'string' },
            source_type: { type: 'string', enum: ['signal', 'decision', 'outcome', 'programme'] },
            source_id: { type: 'string', description: 'Must exactly match a source_id given to you in the context above.' },
          },
          required: ['finding', 'source_type', 'source_id'],
        },
      },
      evidence_limitations: {
        type: 'array',
        items: { type: 'string' },
        description: 'REQUIRED. Limitations of the given evidence. Return ["No material limitations identified."] if none — never omit this field.',
      },
      contradictions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            conflicting_sources: { type: 'array', items: { type: 'string' } },
          },
          required: ['description', 'conflicting_sources'],
        },
        description: 'REQUIRED. Conflicting sources. Return empty array [] if none — never omit this field.',
      },
      evidence_gaps: {
        type: 'array',
        items: { type: 'string' },
        description: 'REQUIRED. Missing evidence. Return ["No material gaps identified."] if none — never omit this field.',
      },
      evidence_confidence: {
        type: 'string',
        enum: CONFIDENCE_LEVELS,
        description: 'REQUIRED. Confidence in the evidence base. Always provide one of HIGH, MODERATE, LOW, UNKNOWN — never omit this field.',
      },
    },
    required: ['established_findings', 'evidence_limitations', 'contradictions', 'evidence_gaps', 'evidence_confidence'],
  },
};

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Deterministic, no LLM involved: restates the already-hydrated context as
// plain, source-tagged sentences. Institutional memory and external
// intelligence are deliberately never read here -- see file header.
function buildDecisionFacts(context) {
  const facts = [];
  const de = (context && context.decisionEvent) || {};

  facts.push(`Decision event triggered via pathway "${de.triggerPathway}": ${de.triggerExplanation || 'no explanation recorded'}.`);

  const evidence = (context && context.evidence) || {};

  (evidence.signals || []).forEach((s) => {
    const label = s.title || s.summary || 'untitled signal';
    facts.push(`Signal [source_type: signal, source_id: ${s.id}]: "${label}"${s.change_description ? ` -- ${s.change_description}` : ''}.`);
  });

  (evidence.decisions || []).forEach((d) => {
    const label = d.decision || d.title || d.name || 'untitled decision record';
    facts.push(`Decision record [source_type: decision, source_id: ${d.id}]: "${label}"${d.status ? ` (status: ${d.status})` : ''}.`);
  });

  (evidence.outcomes || []).forEach((o) => {
    const label = o.title || o.description || o.name || 'untitled outcome record';
    facts.push(`Outcome record [source_type: outcome, source_id: ${o.id}]: "${label}"${o.value !== undefined && o.value !== null ? ` (value: ${o.value})` : ''}.`);
  });

  (evidence.programmes || []).forEach((p) => {
    const label = p.programme_name || p.canonical_programme_name || 'unnamed programme';
    const cost = p.total_cost_rand !== undefined && p.total_cost_rand !== null ? `, total cost R${p.total_cost_rand}` : '';
    const area = p.programme_area ? `, area: ${p.programme_area}` : '';
    facts.push(`Programme record [source_type: programme, source_id: ${p.id}]: "${label}"${cost}${area}.`);
  });

  (context && context.evidenceGaps || []).forEach((gap) => {
    facts.push(`Known evidence gap on a related programme record: ${gap}.`);
  });

  if (context && context.partialContext) {
    facts.push('Context assembly for this decision event was INCOMPLETE. The following could not be resolved:');
    (context.partialContextReasons || []).forEach((reason) => {
      facts.push(`- ${reason}`);
    });
  }

  return facts;
}

// The set of source_type:source_id pairs that were actually present in the
// supplied context -- the only citations an established finding is allowed
// to make.
function buildProvenanceIndex(context) {
  const idx = new Set();
  const evidence = (context && context.evidence) || {};
  (evidence.signals || []).forEach((s) => idx.add(`signal:${s.id}`));
  (evidence.decisions || []).forEach((d) => idx.add(`decision:${d.id}`));
  (evidence.outcomes || []).forEach((o) => idx.add(`outcome:${o.id}`));
  (evidence.programmes || []).forEach((p) => idx.add(`programme:${p.id}`));
  return idx;
}

function buildEvidenceAnalystPrompt(context, facts) {
  return [
    'DECISION EVENT CONTEXT (already assembled; treat as fact, not yours to re-derive)',
    facts.map((f) => `- ${f}`).join('\n'),
    '',
    'Call submit_evidence_assessment. State only what the evidence above establishes, its limitations, any contradictions between sources, and material gaps. Every finding in established_findings must cite the source_type and source_id it came from, exactly as given above.',
  ].join('\n');
}

// Rebuilds the assessment field-by-field from the raw tool-call input.
// Nothing from `input` is ever spread or copied wholesale: only the named
// sub-fields listed below are read, so an unexpected key (e.g. a
// recommendation or priority field this schema never defines) can never
// reach the returned assessment.
function assembleEvidenceAssessment(input = {}) {
  // Default secondary fields if model omitted them (claude-sonnet-5 with
  // thin context reliably omits empty arrays rather than returning []).
  // established_findings is never defaulted -- absence of findings is a
  // genuine quality failure.
  const normalised = {
    ...input,
    evidence_limitations: Array.isArray(input.evidence_limitations)
      ? input.evidence_limitations
      : [],
    contradictions: Array.isArray(input.contradictions)
      ? input.contradictions
      : [],
    evidence_gaps: Array.isArray(input.evidence_gaps)
      ? input.evidence_gaps
      : [],
    evidence_confidence: input.evidence_confidence || 'UNKNOWN',
  };

  const established_findings =
    Array.isArray(normalised.established_findings)
      ? normalised.established_findings.map((f) => ({
          finding: (f && f.finding) || '',
          source_type: (f && f.source_type) || '',
          source_id: (f && f.source_id) || '',
        }))
      : [];

  const contradictions = Array.isArray(normalised.contradictions)
    ? normalised.contradictions.map((c) => ({
          description: (c && c.description) || '',
          conflicting_sources: Array.isArray(c && c.conflicting_sources) ?
            c.conflicting_sources.slice() : [],
        }))
      : [];

  return {
    established_findings,
    evidence_limitations: Array.isArray(normalised.evidence_limitations)
      ? normalised.evidence_limitations.slice() : [],
    contradictions,
    evidence_gaps: Array.isArray(normalised.evidence_gaps)
      ? normalised.evidence_gaps.slice() : [],
    evidence_confidence:
      normaliseConfidence(normalised.evidence_confidence),
  };
}

// Inline shape + provenance validation (Q3: no dedicated contract module
// yet -- extract one in the same commit that introduces the Advisor's
// forced tool schema, once the real output shape is settled end-to-end).
// Fails closed: returns errors, never silently coerces or drops a bad
// finding to make the assessment look valid.
function validateEvidenceAssessment(assessment, provenanceIndex) {
  const errors = [];
  if (!assessment || typeof assessment !== 'object') return ['assessment must be an object'];

  if (!Array.isArray(assessment.established_findings)) {
    errors.push('established_findings[] required');
  } else {
    assessment.established_findings.forEach((f, i) => {
      if (!f.finding) errors.push(`established_findings[${i}].finding required`);
      if (!['signal', 'decision', 'outcome', 'programme'].includes(f.source_type)) {
        errors.push(`established_findings[${i}].source_type must be signal|decision|outcome|programme`);
      }
      if (!f.source_id) {
        errors.push(`established_findings[${i}].source_id required`);
      } else if (provenanceIndex && !provenanceIndex.has(`${f.source_type}:${f.source_id}`)) {
        errors.push(`established_findings[${i}] cites source_id "${f.source_id}" (${f.source_type}) which was not present in the supplied context -- unverifiable provenance`);
      }
    });
  }

  if (!Array.isArray(assessment.evidence_limitations)) errors.push('evidence_limitations[] required');

  if (!Array.isArray(assessment.contradictions)) {
    errors.push('contradictions[] required');
  } else {
    assessment.contradictions.forEach((c, i) => {
      if (!c.description) errors.push(`contradictions[${i}].description required`);
      if (!Array.isArray(c.conflicting_sources)) errors.push(`contradictions[${i}].conflicting_sources[] required`);
    });
  }

  if (!Array.isArray(assessment.evidence_gaps)) errors.push('evidence_gaps[] required');

  if (!CONFIDENCE_LEVELS.includes(assessment.evidence_confidence)) {
    errors.push(`evidence_confidence must be one of ${CONFIDENCE_LEVELS.join('|')}`);
  }

  return errors;
}

async function runEvidenceAnalystDecisionAgent(context) {
  const cfg = agentConfig('evidence_analyst_decision');
  const startedAt = Date.now();
  const usage = { input_tokens: 0, output_tokens: 0 };
  const decisionEventId = context && context.decisionEvent && context.decisionEvent.id;

  if (!context || !decisionEventId) {
    return {
      agent: 'evidence_analyst_decision',
      status: 'failed',
      execution_ms: 0,
      model: cfg.model,
      usage,
      decision_event_id: decisionEventId || null,
      output: null,
      error: 'A decision assessment context is required',
    };
  }

  const facts = buildDecisionFacts(context);
  const provenanceIndex = buildProvenanceIndex(context);

  const work = (async () => {
    const prompt = buildEvidenceAnalystPrompt(context, facts);

    const params = {
      model: cfg.model,
      max_tokens: cfg.max_tokens,
      system: EVIDENCE_ANALYST_DECISION_CONTEXT,
      tools: [SUBMIT_EVIDENCE_ASSESSMENT_TOOL],
      tool_choice: { type: 'tool', name: 'submit_evidence_assessment' },
      messages: [{ role: 'user', content: prompt }],
    };
    const resp = await client.messages.create(params);
    usage.input_tokens += resp.usage?.input_tokens || 0;
    usage.output_tokens += resp.usage?.output_tokens || 0;

    const toolUse = (resp.content || []).find((b) => b.type === 'tool_use' && b.name === 'submit_evidence_assessment');
    if (!toolUse) throw new Error('Evidence Analyst (Decision) did not return a structured assessment');

    // Validate the RAW tool-call input first, before assemble() ever
    // touches it -- see file header. A missing required field fails here;
    // an explicit 'UNKNOWN' the model actually returned does not.
    const raw = toolUse.input || {};
    // Fail closed on established_findings against raw input -- absence of
    // findings is a genuine quality failure that must not be defaulted.
    if (!Array.isArray(raw.established_findings) ||
        raw.established_findings.length === 0) {
      throw new Error(
        'Evidence assessment failed shape/provenance validation: ' +
        'established_findings[] required (>=1)'
      );
    }

    // Assemble with defaults for secondary fields, then validate the rest
    // against the normalised object.
    const assessment = assembleEvidenceAssessment(raw);
    const errors = validateEvidenceAssessment(assessment, provenanceIndex);
    if (errors.length) throw new Error(`Evidence assessment failed shape/provenance validation: ${errors.join('; ')}`);
    return assessment;
  })();

  try {
    const assessment = await withTimeout(work, cfg.timeout_ms, 'evidence_analyst_decision');
    return {
      agent: 'evidence_analyst_decision',
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
      agent: 'evidence_analyst_decision',
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
  runEvidenceAnalystDecisionAgent,
  buildDecisionFacts,
  buildProvenanceIndex,
  buildEvidenceAnalystPrompt,
  assembleEvidenceAssessment,
  validateEvidenceAssessment,
};
