'use strict';

// api/intelligence/tools/index.js
// Tool registry for the Intelligence Console. The orchestrator hands an agent
// the subset of tools its config allows; the agent decides when to call them.
// Adding a tool here (spec + handler) makes it available to any agent without
// touching the agents or the route.

const corpus = require('./corpus');

const TOOL_DEFINITIONS = [
  {
    name: 'corpus_search',
    description:
      'Full-text style search over the live Zenex evidence corpus by keyword or phrase. '
      + 'Matches document filename, programme name and document type. Returns classified '
      + 'records with their metadata and any extracted evidence fields. Use this first when '
      + 'a question mentions a topic, programme, intervention or finding.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword or phrase, for example "BTT" or "early grade reading".' },
        limit: { type: 'integer', description: 'Max records to return (default 8, cap 15).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_programme_evidence',
    description:
      'Retrieve every active record for a named programme, with the full evidence set: '
      + 'key findings, effect sizes, evaluation design, sample sizes, limitations. Use when '
      + 'the question is about a specific programme and you need its document-level evidence.',
    input_schema: {
      type: 'object',
      properties: {
        programme: { type: 'string', description: 'Programme name or a distinctive fragment of it.' },
      },
      required: ['programme'],
    },
  },
  {
    name: 'get_records',
    description: 'Fetch specific records by their identifiers (as returned by corpus_search or get_programme_evidence).',
    input_schema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'Record identifiers.' },
      },
      required: ['ids'],
    },
  },
  {
    name: 'list_programmes',
    description:
      'List every programme in the corpus with its record count, whether it has any Impact or '
      + 'Process evaluation on file, latest year and EQS tiers present. Use for coverage questions.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'external_research',
    description:
      'Look up information outside the Zenex corpus. NOT IMPLEMENTED in this version: calling it '
      + 'returns an unavailable notice. Call it only to confirm that external research is not possible, '
      + 'then proceed from corpus and context.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
];

const HANDLERS = {
  corpus_search: corpus.corpusSearch,
  get_programme_evidence: corpus.getProgrammeEvidence,
  get_records: corpus.getRecords,
  list_programmes: corpus.listProgrammes,
  external_research: corpus.externalResearch,
};

function getToolSpecs(allowedNames) {
  const allow = new Set(allowedNames || []);
  return TOOL_DEFINITIONS.filter(t => allow.has(t.name));
}

async function runTool(name, input) {
  const handler = HANDLERS[name];
  if (!handler) return { error: `Unknown tool: ${name}` };
  try {
    const result = await handler(input || {});
    return result == null ? { error: 'Tool returned no result' } : result;
  } catch (err) {
    return { error: `Tool ${name} failed: ${err.message}` };
  }
}

module.exports = { TOOL_DEFINITIONS, getToolSpecs, runTool };
