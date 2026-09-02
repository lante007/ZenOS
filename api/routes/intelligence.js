'use strict';

// api/routes/intelligence.js
// Intelligence Console orchestrator. One question in, one structured
// response out. The orchestrator classifies the question, injects the
// matching specialist context, and calls the model once more to answer.
// Admin console only. Never mounted for Zenex tenant users.

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { requireRoles } = require('../middleware/permissions');
const { getPool } = require('../services/db');
const {
  CLASSIFIER,
  CONTEXT_MAP,
  CONTEXT_LABELS,
  DEFAULT_CONTEXT,
} = require('../intelligence/contexts');
const { buildLiveContext, LIVE_CONTEXT_KEYS } = require('../intelligence/live-data');

const router = express.Router();
const anthropic = new Anthropic();

const MODEL = 'claude-sonnet-4-6';

function textFromMessage(message) {
  return (message.content || [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim();
}

// The classifier is instructed to return bare JSON, but defend against a
// stray sentence or a markdown fence wrapping the object.
function parseContextKey(raw) {
  if (!raw) return DEFAULT_CONTEXT;
  const match = raw.match(/\{[^{}]*"context"[^{}]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (CONTEXT_MAP[parsed.context]) return parsed.context;
    } catch {
      // fall through to keyword scan
    }
  }
  const hit = Object.keys(CONTEXT_MAP).find(key => raw.includes(key));
  return hit || DEFAULT_CONTEXT;
}

router.post('/ask',
  requireRoles('SUPER_ADMIN', 'AUXEIRA_FOUNDER'),
  async (req, res, next) => {
    try {
      const { question } = req.body || {};
      if (!question || typeof question !== 'string' || question.trim().length < 3) {
        return res.status(400).json({ error: 'Question required' });
      }
      const trimmed = question.trim();

      // Step 1: classify.
      let contextKey = DEFAULT_CONTEXT;
      try {
        const classification = await anthropic.messages.create({
          model: MODEL,
          max_tokens: 64,
          temperature: 0,
          system: CLASSIFIER,
          messages: [{ role: 'user', content: trimmed }],
        });
        contextKey = parseContextKey(textFromMessage(classification));
      } catch (classifyErr) {
        console.error('Intelligence Console classification failed, defaulting to chief_of_staff:', classifyErr.message);
      }

      // Assemble the specialist context. Chief of Staff and Evidence Analyst
      // get request-time live corpus data appended here, before the answering
      // call, patterned on how admin-ask.js builds its system prompt. The
      // classifier step above is untouched.
      let systemPrompt = CONTEXT_MAP[contextKey] || CONTEXT_MAP[DEFAULT_CONTEXT];
      let liveContext = null;
      if (LIVE_CONTEXT_KEYS.includes(contextKey)) {
        const pool = getPool();
        if (!pool) {
          systemPrompt = `${systemPrompt}\n\nLIVE CORPUS DATA\nDatabase is not configured for this request. Rely on the static baseline figures above and state that live figures were unavailable.`;
        } else {
          try {
            const live = await buildLiveContext(contextKey, pool);
            if (live) {
              systemPrompt = `${systemPrompt}\n\n${live.text}`;
              liveContext = { injected_at: live.injected_at, values: live.values };
            }
          } catch (liveErr) {
            console.error('Intelligence Console live data injection failed:', liveErr.message);
            systemPrompt = `${systemPrompt}\n\nLIVE CORPUS DATA\nLive data injection failed for this request. Rely on the static baseline figures above and state that live figures were unavailable.`;
          }
        }
      }

      // Step 2: answer with the specialist context.
      const message = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 1500,
        temperature: 0.2,
        system: systemPrompt,
        messages: [{ role: 'user', content: trimmed }],
      });

      return res.json({
        success: true,
        question: trimmed,
        answer: textFromMessage(message),
        context: contextKey,
        context_label: CONTEXT_LABELS[contextKey] || contextKey,
        live_context: liveContext,
        generated_at: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  });

module.exports = router;
