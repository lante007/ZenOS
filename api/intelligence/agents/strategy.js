'use strict';

// api/intelligence/agents/strategy.js
const Anthropic = require('@anthropic-ai/sdk');
const { STRATEGIC_ANALYST_CONTEXT } = require('../contexts/strategy');

const client = new Anthropic();

async function runStrategyAgent(question, liveData) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 800,
    temperature: 0,
    system: STRATEGIC_ANALYST_CONTEXT,
    messages: [{ role: 'user', content: question }],
  });

  return {
    agent: 'strategic_analyst',
    output: response.content[0].text,
  };
}

module.exports = { runStrategyAgent };
