'use strict';

// api/intelligence/agents/prophet.js
// C4: Prophet agent. Takes one Watchtower signal (row from
// api/memory/watchtower.js#getSignalById, joined with its source) and
// produces a structured forward-looking assessment via a single forced
// tool call -- the same call shape as the Advisor (see
// api/intelligence/agents/advisor.js), not a new multi-agent pipeline.
//
// observed_facts is never asked of the model: buildObservedFacts() derives
// it directly and deterministically from the signal row before the prompt
// is built, so Prophet cannot rewrite what Watchtower actually observed.
// The model only supplies interpretations, assumptions, scenarios, an
// overall confidence, and recommendations. assembleAssessment() then
// rebuilds the final object field-by-field from the tool call's input,
// which is also what guarantees no autonomous-action field can ever reach
// the returned assessment: only the six named fields are ever copied
// across, regardless of what the model's tool call contains.

const Anthropic = require('@anthropic-ai/sdk');
const { agentConfig } = require('../config');
const { PROPHET_CONTEXT } = require('../contexts/prophet');
const { normaliseConfidence } = require('../confidence');
const { validateProphetAssessment } = require('../../memory/prophet-contract');

const client = new Anthropic();

const SUBMIT_PROPHET_ASSESSMENT_TOOL = {
  name: 'submit_prophet_assessment',
  description: 'Return the structured forward assessment for this signal. Call exactly once.',
  input_schema: {
    type: 'object',
    properties: {
      interpretations: { type: 'array', items: { type: 'string' } },
      assumptions: { type: 'array', items: { type: 'string' } },
      scenarios: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            confidence: { type: 'string', enum: ['HIGH', 'MODERATE', 'LOW', 'UNKNOWN'] },
            rests_on_assumptions: { type: 'array', items: { type: 'string' } },
          },
          required: ['description', 'confidence', 'rests_on_assumptions'],
        },
      },
      confidence: {
        type: 'string',
        enum: ['HIGH', 'MODERATE', 'LOW', 'UNKNOWN'],
        description: 'Overall confidence in this assessment as a whole, independent of any single scenario.',
      },
      recommendations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            action: { type: 'string' },
            consequential: { type: 'boolean', description: 'True if acting on this would be hard to reverse or materially affects strategy, spend, or a relationship.' },
            requires_approval: { type: 'boolean' },
          },
          required: ['action', 'consequential', 'requires_approval'],
        },
      },
    },
    required: ['interpretations', 'assumptions', 'scenarios', 'confidence', 'recommendations'],
  },
};

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// The observed_fact layer. Deterministic, no LLM involved: this is exactly
// what Watchtower recorded, restated as plain sentences.
function buildObservedFacts(signal) {
  if (!signal) return [];
  const facts = [];
  const when = signal.observed_at ? new Date(signal.observed_at).toISOString() : 'an unspecified time';
  facts.push(`Source "${signal.source_name}" (${signal.source_kind}, ${signal.source_url}) produced a Watchtower signal observed at ${when}.`);
  if (signal.title) facts.push(`Signal title: ${signal.title}`);
  if (signal.change_description) facts.push(`Change description: ${signal.change_description}`);
  if (signal.summary) facts.push(`Summary: ${signal.summary}`);
  facts.push(`Novelty: ${signal.novelty || 'NEW'}. Watchtower-assigned signal confidence: ${signal.confidence || 'MODERATE'}. Source credibility: ${signal.source_credibility || 'MODERATE'}.`);
  return facts;
}

// The user-message content sent to Prophet. Exported and kept separate from
// runProphetAgent so it can be asserted against directly without a live
// Anthropic call.
function buildProphetPrompt(signal) {
  const facts = buildObservedFacts(signal);
  return [
    'WATCHTOWER SIGNAL (observed fact -- already true, not yours to question)',
    facts.map(f => `- ${f}`).join('\n'),
    '',
    'Call submit_prophet_assessment with your interpretation of this signal: assumptions it depends on, forward scenarios, an overall confidence, and recommendations. Do not restate the observed fact above as your own output.',
  ].join('\n');
}

// Rebuilds the final six-field assessment field-by-field from the tool
// call's raw input plus the deterministic observed_facts. Nothing from
// `input` is ever spread or copied wholesale: only the named sub-fields
// listed below are read, so an unexpected key in a tool response (e.g. an
// autonomous-action flag no schema here defines) can never reach the
// returned assessment.
function assembleAssessment(observedFacts, input = {}) {
  const scenarios = Array.isArray(input.scenarios)
    ? input.scenarios.map(s => ({
        description: (s && s.description) || '',
        confidence: normaliseConfidence(s && s.confidence),
        rests_on_assumptions: Array.isArray(s && s.rests_on_assumptions) ? s.rests_on_assumptions : [],
      }))
    : [];

  const recommendations = Array.isArray(input.recommendations)
    ? input.recommendations.map(r => {
        const consequential = Boolean(r && r.consequential);
        return {
          action: (r && r.action) || '',
          consequential,
          // A consequential recommendation always requires approval,
          // regardless of what the model set: this is enforced here, not
          // merely requested in the prompt.
          requires_approval: consequential ? true : Boolean(r && r.requires_approval),
        };
      })
    : [];

  return {
    observed_facts: Array.isArray(observedFacts) ? observedFacts : [],
    interpretations: Array.isArray(input.interpretations) ? input.interpretations : [],
    assumptions: Array.isArray(input.assumptions) ? input.assumptions : [],
    scenarios,
    confidence: normaliseConfidence(input.confidence),
    recommendations,
  };
}

async function runProphetAgent(signal) {
  const cfg = agentConfig('prophet');
  const startedAt = Date.now();
  const usage = { input_tokens: 0, output_tokens: 0 };

  if (!signal || !signal.id) {
    return { agent: 'prophet', status: 'failed', execution_ms: 0, model: cfg.model, usage, signal_id: signal && signal.id, output: null, error: 'A signal is required' };
  }

  const observedFacts = buildObservedFacts(signal);

  const work = (async () => {
    const prompt = buildProphetPrompt(signal);

    const resp = await client.messages.create({
      model: cfg.model,
      max_tokens: cfg.max_tokens,
      system: PROPHET_CONTEXT,
      tools: [SUBMIT_PROPHET_ASSESSMENT_TOOL],
      tool_choice: { type: 'tool', name: 'submit_prophet_assessment' },
      messages: [{ role: 'user', content: prompt }],
    });
    usage.input_tokens += resp.usage?.input_tokens || 0;
    usage.output_tokens += resp.usage?.output_tokens || 0;

    const toolUse = (resp.content || []).find(b => b.type === 'tool_use' && b.name === 'submit_prophet_assessment');
    if (!toolUse) throw new Error('Prophet did not return a structured assessment');

    const assessment = assembleAssessment(observedFacts, toolUse.input || {});
    const errors = validateProphetAssessment(assessment);
    if (errors.length) throw new Error(`Prophet assessment failed shape validation: ${errors.join('; ')}`);
    return assessment;
  })();

  try {
    const assessment = await withTimeout(work, cfg.timeout_ms, 'prophet');
    return {
      agent: 'prophet',
      status: 'ok',
      execution_ms: Date.now() - startedAt,
      model: cfg.model,
      usage,
      signal_id: signal.id,
      output: assessment,
      error: null,
    };
  } catch (err) {
    return {
      agent: 'prophet',
      status: 'failed',
      execution_ms: Date.now() - startedAt,
      model: cfg.model,
      usage,
      signal_id: signal.id,
      output: null,
      error: err.message,
    };
  }
}

module.exports = { runProphetAgent, buildObservedFacts, buildProphetPrompt, assembleAssessment };
