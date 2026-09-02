'use strict';

// api/intelligence/agents/advisor.js
const Anthropic = require('@anthropic-ai/sdk');
const { ADVISOR_CONTEXT } = require('../contexts/advisor');

const client = new Anthropic();

async function runAdvisorAgent(question, agentOutputs) {
  const combinedInput = `
ORIGINAL QUESTION
${question}

EVIDENCE ANALYST OUTPUT
${agentOutputs.evidence}

STRATEGIC ANALYST OUTPUT
${agentOutputs.strategy}

Synthesise these into one clear, actionable response for Emmanuel.
`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    temperature: 0.2,
    system: ADVISOR_CONTEXT,
    messages: [{ role: 'user', content: combinedInput }],
  });

  return response.content[0].text;
}

module.exports = { runAdvisorAgent };
