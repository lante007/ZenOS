'use strict';

// api/intelligence/agents/base.js
// Shared runner for specialist agents. A specialist runs a bounded, planned
// tool-use gather loop (parallel calls per round, equivalent calls
// de-duplicated, an explicit stop-when-sufficient instruction), then is
// forced to return a structured analysis via the submit_analysis tool.
// Returns a rich result: status, timing, token usage, rounds and the tool
// calls it made, so orchestration and observability never have to guess.

const Anthropic = require('@anthropic-ai/sdk');
const { agentConfig } = require('../config');
const { getToolSpecs, runTool } = require('../tools');
const { STRUCTURED_OUTPUT_RULES } = require('../contexts/shared');
const { normaliseConfidence } = require('../confidence');

const client = new Anthropic();

function gatherRules(maxRounds) {
  return `
RETRIEVAL DISCIPLINE
Plan before you retrieve. In your first turn, request every retrieval you can
foresee needing, batched into that one turn so the calls run in parallel.
Prefer get_programme_evidence and list_programmes over many narrow
corpus_search calls. Do not repeat a search you have already run: equivalent
repeats are rejected and waste a round. As soon as the retrieved evidence is
sufficient to answer the question, or you have established that the evidence
is not in the corpus, stop calling tools. You have at most ${maxRounds}
retrieval rounds.`;
}

const SUBMIT_ANALYSIS_TOOL = {
  name: 'submit_analysis',
  description: 'Return your final structured analysis. Call this exactly once when your analysis is complete.',
  input_schema: {
    type: 'object',
    properties: {
      findings: { type: 'array', items: { type: 'string' }, description: 'What the analysis establishes, each a complete sentence.' },
      known: { type: 'array', items: { type: 'string' }, description: 'Points directly supported by retrieved evidence or provided context.' },
      not_known: { type: 'array', items: { type: 'string' }, description: 'Material gaps: evidence not retrieved, context silent.' },
      interpretation: { type: 'array', items: { type: 'string' }, description: 'Reasoning from the available information, labelled as inference.' },
      risks: { type: 'array', items: { type: 'string' } },
      recommendations: { type: 'array', items: { type: 'string' }, description: 'Proposed actions. Empty for the Evidence Analyst.' },
      sources: {
        type: 'array',
        description: 'One entry per retrieved record or document behind a KNOWN point.',
        items: {
          type: 'object',
          properties: {
            claim: { type: 'string' },
            record_id: { type: 'string' },
            document_id: { type: 'string' },
            document_filename: { type: 'string' },
            evidence_type: { type: 'string', enum: ['extracted_finding', 'metadata', 'aggregate', 'external', 'none'] },
            confidence: { type: 'string', enum: ['HIGH', 'MODERATE', 'LOW', 'UNKNOWN'] },
          },
          required: ['claim', 'evidence_type', 'confidence'],
        },
      },
      confidence: { type: 'string', enum: ['HIGH', 'MODERATE', 'LOW', 'UNKNOWN'], description: 'Overall confidence, reflecting evidence availability.' },
    },
    required: ['findings', 'known', 'not_known', 'interpretation', 'risks', 'recommendations', 'sources', 'confidence'],
  },
};

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function textOf(message) {
  return (message.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
}

function addUsage(acc, usage) {
  if (!usage) return acc;
  acc.input_tokens += usage.input_tokens || 0;
  acc.output_tokens += usage.output_tokens || 0;
  return acc;
}

function summariseResult(result) {
  if (result.error) return result.error;
  if (result.deduped) return 'deduped';
  if (result.records) return `records=${result.records.length}`;
  if (result.record_count != null) return `records=${result.record_count}`;
  if (result.match_count != null) return `matches=${result.match_count}`;
  if (result.programme_count != null) return `programmes=${result.programme_count}`;
  return 'ok';
}

function normaliseStructured(input, raw) {
  const arr = v => (Array.isArray(v) ? v.filter(x => x != null) : []);
  const out = {
    findings: arr(input.findings),
    known: arr(input.known),
    not_known: arr(input.not_known),
    interpretation: arr(input.interpretation),
    risks: arr(input.risks),
    recommendations: arr(input.recommendations),
    sources: arr(input.sources).map(s => ({
      claim: s.claim || '',
      record_id: s.record_id || null,
      document_id: s.document_id || null,
      document_filename: s.document_filename || null,
      evidence_type: s.evidence_type || 'none',
      confidence: normaliseConfidence(s.confidence),
    })),
    confidence: normaliseConfidence(input.confidence),
  };
  if (raw) out._raw_text = raw;
  return out;
}

async function runSpecialistAgent({ role, question, systemPrompt, userContext }) {
  const cfg = agentConfig(role);
  const startedAt = Date.now();
  const usage = { input_tokens: 0, output_tokens: 0 };
  const toolCalls = [];
  let rounds = 0;

  const work = (async () => {
    const messages = [{
      role: 'user',
      content: `${userContext ? `${userContext}\n\n` : ''}QUESTION\n${question}`,
    }];

    const toolSpecs = getToolSpecs(cfg.allowed_tools);
    const gatherSystem = `${systemPrompt}\n${gatherRules(cfg.max_tool_rounds)}`;
    const seen = new Set();

    // Gather phase: bounded, parallel, de-duplicated tool-use loop.
    for (; rounds < cfg.max_tool_rounds && toolSpecs.length > 0; rounds += 1) {
      const resp = await client.messages.create({
        model: cfg.model,
        max_tokens: 1024,
        temperature: cfg.temperature,
        system: gatherSystem,
        tools: toolSpecs,
        messages,
      });
      addUsage(usage, resp.usage);
      messages.push({ role: 'assistant', content: resp.content });
      if (resp.stop_reason !== 'tool_use') break;

      const blocks = resp.content.filter(b => b.type === 'tool_use');
      const executed = await Promise.all(blocks.map(async block => {
        const key = `${block.name}:${JSON.stringify(block.input || {})}`.toLowerCase();
        if (seen.has(key)) {
          return { block, result: { deduped: true, note: 'Equivalent retrieval already performed this session. Reuse the earlier result; do not repeat.' }, ms: 0, cached: true };
        }
        seen.add(key);
        const t0 = Date.now();
        const result = await runTool(block.name, block.input);
        return { block, result, ms: Date.now() - t0, cached: false };
      }));

      const toolResults = [];
      for (const { block, result, ms, cached } of executed) {
        toolCalls.push({ tool: block.name, input: block.input, ok: !result.error, cached, ms, summary: summariseResult(result) });
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result).slice(0, 12000) });
      }
      messages.push({ role: 'user', content: toolResults });
    }

    // Structured phase: force submit_analysis.
    const finalResp = await client.messages.create({
      model: cfg.model,
      max_tokens: cfg.max_tokens,
      temperature: cfg.temperature,
      system: `${systemPrompt}\n${STRUCTURED_OUTPUT_RULES}`,
      tools: [SUBMIT_ANALYSIS_TOOL],
      tool_choice: { type: 'tool', name: 'submit_analysis' },
      messages: [...messages, { role: 'user', content: STRUCTURED_OUTPUT_RULES }],
    });
    addUsage(usage, finalResp.usage);

    const toolUse = (finalResp.content || []).find(b => b.type === 'tool_use' && b.name === 'submit_analysis');
    if (!toolUse) {
      return normaliseStructured({}, textOf(finalResp) || 'Agent did not return a structured analysis.');
    }
    return normaliseStructured(toolUse.input, null);
  })();

  try {
    const output = await withTimeout(work, cfg.timeout_ms, `agent ${role}`);
    return {
      agent: role, status: 'ok', execution_ms: Date.now() - startedAt,
      model: cfg.model, usage, rounds, tool_calls: toolCalls, output, error: null,
    };
  } catch (err) {
    return {
      agent: role, status: 'failed', execution_ms: Date.now() - startedAt,
      model: cfg.model, usage, rounds, tool_calls: toolCalls, output: null, error: err.message,
    };
  }
}

module.exports = { runSpecialistAgent, SUBMIT_ANALYSIS_TOOL };
