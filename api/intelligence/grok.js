'use strict';

// api/intelligence/grok.js
// Thin client for the Grok (xAI) API. Grok is infrastructure only: a raw
// external-intelligence/ideation source. It has no authority over anything
// EvidenceOS treats as verified -- every item this client returns must pass
// through api/intelligence/qa-gate.js before it can be persisted or surfaced.
// Never throws for a network/API error: callers get { ok:false, error }.
//
// The API key is retrieved from AWS Secrets Manager only (evidenceos/grok-api-key,
// us-east-1) -- never from an environment variable, per directive.

const crypto = require('crypto');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const secrets = new SecretsManagerClient({ region });

const GROK_SECRET_ID = 'evidenceos/grok-api-key';
const GROK_API_BASE = process.env.GROK_API_BASE || 'https://api.x.ai/v1';
const GROK_MODEL = process.env.GROK_MODEL || 'grok-2-latest';
const GROK_TIMEOUT_MS = Number(process.env.GROK_TIMEOUT_MS || 30000);
const KEY_CACHE_TTL_MS = 15 * 60 * 1000;

let cachedKey = null;
let cachedKeyAt = 0;

// Retrieves the Grok API key from AWS Secrets Manager. Never reads
// GROK_API_KEY or any other environment variable for the key itself.
// Throws if the secret is missing or unreadable -- callers must treat that
// as "the scout is unavailable", never as "no key needed".
async function getGrokApiKey() {
  const now = Date.now();
  if (cachedKey && now - cachedKeyAt < KEY_CACHE_TTL_MS) return cachedKey;
  const out = await secrets.send(new GetSecretValueCommand({ SecretId: GROK_SECRET_ID }));
  const raw = out.SecretString;
  if (!raw) throw new Error(`Secret ${GROK_SECRET_ID} has no SecretString`);
  let key = raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') key = parsed.api_key || parsed.GROK_API_KEY || parsed.key || raw;
  } catch {
    // secret is a bare string, not JSON -- use as-is
  }
  if (!key || typeof key !== 'string') throw new Error(`Secret ${GROK_SECRET_ID} did not contain a usable API key`);
  cachedKey = key;
  cachedKeyAt = now;
  return cachedKey;
}

function promptHash(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

// Low-level chat call. Never throws: returns { ok, content, error, model,
// usage, prompt_hash }. A timeout, network failure, non-2xx response, or
// malformed body are all reported the same way, matching the house pattern
// in api/watchtower/fetcher.js.
async function grokChat({ system, prompt, temperature = 0.3, maxTokens = 2000 }) {
  const hash = promptHash(`${system || ''}\n---\n${prompt || ''}`);
  let apiKey;
  try {
    apiKey = await getGrokApiKey();
  } catch (err) {
    return { ok: false, error: `Grok API key unavailable: ${err.message}`, content: null, model: GROK_MODEL, usage: null, prompt_hash: hash };
  }

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  try {
    const res = await fetch(`${GROK_API_BASE}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(GROK_TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: GROK_MODEL,
        messages,
        temperature,
        max_tokens: maxTokens,
      }),
    });

    const bodyText = await res.text();
    if (!res.ok) {
      return { ok: false, error: `Grok API HTTP ${res.status}: ${bodyText.slice(0, 500)}`, content: null, model: GROK_MODEL, usage: null, prompt_hash: hash };
    }

    let parsed;
    try {
      parsed = JSON.parse(bodyText);
    } catch (err) {
      return { ok: false, error: `Grok API returned non-JSON body: ${err.message}`, content: null, model: GROK_MODEL, usage: null, prompt_hash: hash };
    }

    const content = parsed?.choices?.[0]?.message?.content || null;
    const usage = parsed?.usage || null;
    if (!content) {
      return { ok: false, error: 'Grok API returned no message content', content: null, model: GROK_MODEL, usage, prompt_hash: hash };
    }

    return { ok: true, error: null, content, model: parsed.model || GROK_MODEL, usage, prompt_hash: hash };
  } catch (err) {
    const msg = err.name === 'TimeoutError' ? `Grok API timed out after ${GROK_TIMEOUT_MS} ms` : err.message;
    return { ok: false, error: msg, content: null, model: GROK_MODEL, usage: null, prompt_hash: hash };
  }
}

// Strips markdown code fences and extracts the first top-level JSON array
// from a model's text response. Returns [] (never throws) if nothing
// parseable is found -- callers must treat an empty array as "no items",
// not as an error; grokChat's own { ok:false } is the error signal.
function parseJsonArray(text) {
  if (!text || typeof text !== 'string') return [];
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const EXTERNAL_CATEGORIES = ['funding', 'competitor', 'regulatory', 'market', 'partnership', 'other'];

// Asks Grok to search the web and extract candidate external-intelligence
// claims as a JSON array. This is raw, unverified model output: the caller
// (api/intelligence/scouts/external.js) must run every item through the QA
// gate before anything is persisted. Never throws.
async function grokWebSearch({ query, category, limit = 5 }) {
  const cat = EXTERNAL_CATEGORIES.includes(category) ? category : 'other';
  const system = 'You are a web research assistant. Search for real, current, verifiable information. ' +
    'Respond with ONLY a JSON array, no prose, no markdown fences.';
  const prompt = [
    `Research query: ${query}`,
    `Category: ${cat}`,
    `Return up to ${limit} distinct items as a JSON array. Each item must be an object with exactly these fields:`,
    '- "claim": a specific, concrete assertion (string)',
    '- "source_url": the real URL you found this at (string, must be a plausible real URL)',
    '- "category": one of funding, competitor, regulatory, market, partnership, other',
    'Only include items with a real, checkable source_url. If you cannot find real sources, return an empty array [].',
  ].join('\n');

  const result = await grokChat({ system, prompt, temperature: 0.2, maxTokens: 2000 });
  if (!result.ok) return { ok: false, error: result.error, items: [], model: result.model, prompt_hash: result.prompt_hash };

  const items = parseJsonArray(result.content);
  return { ok: true, error: null, items, model: result.model, prompt_hash: result.prompt_hash };
}

// Asks Grok to generate innovation candidates (speculative ideas) grounded
// in a supplied context. Same never-throws contract as grokWebSearch. The
// caller (api/intelligence/scouts/innovation.js) is responsible for the
// speculative labelling and the QA gate pass.
async function grokIdeation({ context, constraints, limit = 5 }) {
  const system = 'You are an ideation assistant generating speculative hypotheses, not facts. ' +
    'Respond with ONLY a JSON array, no prose, no markdown fences.';
  const prompt = [
    `Context: ${context}`,
    constraints ? `Constraints: ${constraints}` : null,
    `Generate up to ${limit} distinct speculative ideas as a JSON array. Each item must be an object with exactly these fields:`,
    '- "idea": a specific, concrete hypothesis (string)',
    '- "rationale": why this idea is plausible given the context (string)',
    'These are hypotheses, not verified facts or sourced findings. Do not phrase any idea as if it is already proven or documented.',
  ].filter(Boolean).join('\n');

  const result = await grokChat({ system, prompt, temperature: 0.7, maxTokens: 2000 });
  if (!result.ok) return { ok: false, error: result.error, items: [], model: result.model, prompt_hash: result.prompt_hash };

  const items = parseJsonArray(result.content);
  return { ok: true, error: null, items, model: result.model, prompt_hash: result.prompt_hash };
}

module.exports = {
  getGrokApiKey,
  grokChat,
  grokWebSearch,
  grokIdeation,
  parseJsonArray,
  promptHash,
  EXTERNAL_CATEGORIES,
  GROK_MODEL,
};
