'use strict';

// api/intelligence/agents/advisor.js
// Synthesis agent. Receives the structured outputs of the specialist agents
// (including any that failed) and is forced to return a structured synthesis
// via submit_synthesis. The structured result is rendered to executive
// markdown for the Console; the structure itself is kept for auditing.

const Anthropic = require('@anthropic-ai/sdk');
const { agentConfig } = require('../config');
const { ADVISOR_CONTEXT } = require('../contexts/advisor');
const { normaliseConfidence } = require('../confidence');
const { getFeatureFlag } = require('../../services/tenants');
const { buildMemoryContext, formatMemoryContext } = require('../../memory/context');

const client = new Anthropic();

const SUBMIT_SYNTHESIS_TOOL = {
  name: 'submit_synthesis',
  description: 'Return the final synthesis for Emmanuel. Call exactly once.',
  input_schema: {
    type: 'object',
    properties: {
      bottom_line: { type: 'string', description: 'The single most important thing. Two sentences maximum.' },
      what_we_know: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            point: { type: 'string' },
            basis: { type: 'string', description: 'Evidence, strategic context, or which agent established it.' },
          },
          required: ['point', 'basis'],
        },
      },
      what_we_do_not_know: { type: 'array', items: { type: 'string' } },
      what_this_means: { type: 'string' },
      risks: { type: 'array', items: { type: 'string' } },
      recommended_action: { type: 'string', description: 'One specific next step. Emmanuel decides.' },
      sources: {
        type: 'array',
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
      overall_confidence: { type: 'string', enum: ['HIGH', 'MODERATE', 'LOW', 'UNKNOWN'] },
    },
    required: ['bottom_line', 'what_we_know', 'what_we_do_not_know', 'what_this_means', 'risks', 'recommended_action', 'sources', 'overall_confidence'],
  },
};

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function renderAgentBlock(result) {
  const label = result.agent.replace(/_/g, ' ').toUpperCase();
  if (result.status !== 'ok' || !result.output) {
    return `${label}: FAILED (${result.error || 'no output'}). Treat this perspective as unavailable.`;
  }
  const o = result.output;
  const list = (title, items) => (items && items.length ? `${title}:\n- ${items.join('\n- ')}` : `${title}: none stated`);
  const sources = (o.sources || []).length
    ? o.sources.map(s => `  * ${s.claim} [${s.evidence_type}, ${s.confidence}${s.record_id ? `, ${s.record_id}` : ''}${s.document_filename ? `, ${s.document_filename}` : ''}]`).join('\n')
    : '  * none';
  return [
    `${label} (status ok, confidence ${o.confidence})`,
    list('Findings', o.findings),
    list('Known', o.known),
    list('Not known', o.not_known),
    list('Interpretation', o.interpretation),
    list('Risks', o.risks),
    list('Recommendations', o.recommendations),
    `Sources:\n${sources}`,
  ].join('\n');
}

function toMarkdown(s) {
  const lines = [];
  lines.push('## Bottom line', '', s.bottom_line || '_Not provided._', '');
  lines.push('## What we know', '');
  if (s.what_we_know && s.what_we_know.length) {
    for (const k of s.what_we_know) lines.push(`- ${k.point}${k.basis ? `  \n  _Basis: ${k.basis}_` : ''}`);
  } else lines.push('- _Nothing established with confidence._');
  lines.push('', '## What we do not know', '');
  if (s.what_we_do_not_know && s.what_we_do_not_know.length) {
    for (const g of s.what_we_do_not_know) lines.push(`- ${g}`);
  } else lines.push('- _No material gaps identified._');
  lines.push('', '## What this means', '', s.what_this_means || '_Not provided._', '');
  lines.push('## Risks', '');
  if (s.risks && s.risks.length) for (const r of s.risks) lines.push(`- ${r}`);
  else lines.push('- _None stated._');
  lines.push('', '## Recommended action', '', s.recommended_action || '_Not provided._', '');
  lines.push('## Sources, confidence and gaps', '');
  lines.push(`Overall confidence: **${s.overall_confidence || 'UNKNOWN'}**`, '');
  if (s.sources && s.sources.length) {
    for (const src of s.sources) {
      lines.push(`- ${src.claim} — _${src.evidence_type}, ${src.confidence}${src.record_id ? `, ${src.record_id}` : ''}${src.document_filename ? `, ${src.document_filename}` : ''}_`);
    }
  } else {
    lines.push('- _No document-level sources. This answer rests on aggregate context and interpretation._');
  }
  return lines.join('\n');
}

// Assembles the user-message content sent to the Advisor. Kept separate
// from runAdvisorAgent (and exported) so its output can be asserted against
// directly in tests without a live Anthropic call.
//
// Increment 3, C2: institutional memory context is additive and flag-gated
// per tenant. When MEMORY_CONTEXT_ENABLED is false for the tenant (the
// default set in C1), the block below never runs and this function's
// output is byte-identical to the pre-C1/C2 prompt. A memory-context
// lookup failure while the flag is on must never block or alter the rest
// of the prompt: it is caught and the section is simply omitted.
async function buildPrompt(question, specialistResults, meta = {}) {
  const anyOk = specialistResults.some(r => r.status === 'ok' && r.output);

  const lines = [
    'ORIGINAL QUESTION', question, '',
    'SPECIALIST AGENT OUTPUTS', '',
    specialistResults.map(renderAgentBlock).join('\n\n---\n\n'),
    '',
    anyOk
      ? 'Synthesise these into one response by calling submit_synthesis. Keep evidence and interpretation separate. Note explicitly where an agent failed.'
      : 'Every specialist agent failed. Call submit_synthesis with overall_confidence UNKNOWN, state plainly that no specialist analysis is available, and recommend re-running the query.',
  ];

  const tenantId = meta.tenantId || 'zenex';
  let memoryEnabled = false;
  try {
    memoryEnabled = await getFeatureFlag(tenantId, 'MEMORY_CONTEXT_ENABLED');
  } catch {
    memoryEnabled = false; // fail closed: a flag lookup error must never change agent behaviour
  }

  if (memoryEnabled) {
    try {
      const ctx = await buildMemoryContext({ tenantId, query: question });
      const block = formatMemoryContext(ctx);
      if (block) lines.push('', 'MEMORY CONTEXT (flag-gated)', '', block);
    } catch (err) {
      console.warn(`[advisor] memory context unavailable for tenant ${tenantId}: ${err.message}`);
    }
  }

  return lines.join('\n');
}

async function runAdvisorAgent(question, specialistResults, meta = {}) {
  const cfg = agentConfig('advisor');
  const startedAt = Date.now();
  const usage = { input_tokens: 0, output_tokens: 0 };

  const work = (async () => {
    const combined = await buildPrompt(question, specialistResults, meta);

    const resp = await client.messages.create({
      model: cfg.model,
      max_tokens: cfg.max_tokens,
      temperature: cfg.temperature,
      system: ADVISOR_CONTEXT,
      tools: [SUBMIT_SYNTHESIS_TOOL],
      tool_choice: { type: 'tool', name: 'submit_synthesis' },
      messages: [{ role: 'user', content: combined }],
    });
    usage.input_tokens += resp.usage?.input_tokens || 0;
    usage.output_tokens += resp.usage?.output_tokens || 0;

    const toolUse = (resp.content || []).find(b => b.type === 'tool_use' && b.name === 'submit_synthesis');
    if (!toolUse) throw new Error('Advisor did not return a structured synthesis');

    const input = toolUse.input || {};
    const structured = {
      bottom_line: input.bottom_line || '',
      what_we_know: Array.isArray(input.what_we_know) ? input.what_we_know : [],
      what_we_do_not_know: Array.isArray(input.what_we_do_not_know) ? input.what_we_do_not_know : [],
      what_this_means: input.what_this_means || '',
      risks: Array.isArray(input.risks) ? input.risks : [],
      recommended_action: input.recommended_action || '',
      sources: Array.isArray(input.sources) ? input.sources.map(s => ({ ...s, confidence: normaliseConfidence(s.confidence) })) : [],
      overall_confidence: normaliseConfidence(input.overall_confidence),
    };
    return structured;
  })();

  try {
    const structured = await withTimeout(work, cfg.timeout_ms, 'advisor');
    return {
      agent: 'advisor',
      status: 'ok',
      execution_ms: Date.now() - startedAt,
      model: cfg.model,
      usage,
      output: structured,
      markdown: toMarkdown(structured),
      error: null,
    };
  } catch (err) {
    return {
      agent: 'advisor',
      status: 'failed',
      execution_ms: Date.now() - startedAt,
      model: cfg.model,
      usage,
      output: null,
      markdown: null,
      error: err.message,
    };
  }
}

module.exports = { runAdvisorAgent, buildPrompt };
