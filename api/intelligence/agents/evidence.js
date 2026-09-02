'use strict';

// api/intelligence/agents/evidence.js
const Anthropic = require('@anthropic-ai/sdk');
const { EVIDENCE_ANALYST_CONTEXT } = require('../contexts/evidence');

const client = new Anthropic();

async function runEvidenceAgent(question, liveData) {
  const liveDataBlock = liveData ? `
LIVE CORPUS DATA (injected at runtime)
Records: ${liveData.records}
Average EQS: ${liveData.avg_eqs}
Data completeness: ${liveData.completeness}%
Financial Capital: R${liveData.financial_capital} (from ${liveData.financial_source_count} documents — incomplete, do not cite externally)
EROI: ${liveData.eroi} (Decision Capital N/A — structurally incomplete)
Records pending expert review: ${liveData.pending_review}
Records with critical missing fields: ${liveData.missing_fields}
Last ingestion: ${liveData.last_ingestion}
EQS by pathway: Impact ${liveData.eqs_impact}, Process ${liveData.eqs_process}, Research ${liveData.eqs_research}
Records rated AGEING: ${liveData.ageing_count}
` : '';

  const systemPrompt = EVIDENCE_ANALYST_CONTEXT + liveDataBlock;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 800,
    temperature: 0,
    system: systemPrompt,
    messages: [{ role: 'user', content: question }],
  });

  return {
    agent: 'evidence_analyst',
    output: response.content[0].text,
  };
}

module.exports = { runEvidenceAgent };
