'use strict';

// api/watchtower/fetcher.js
// Reliable, bounded source fetching. Deterministic: no LLM, no code execution,
// external bytes are treated purely as data. Returns a plain result object;
// never throws for an HTTP or network error (those become { ok:false, error }).

const cfg = require('./config');

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Minimal robots.txt check for the User-agent: * group. Conservative: on any
// parse/fetch problem it allows (we already restrict to public pages and set
// a descriptive UA), but an explicit Disallow that matches is honoured.
async function isDisallowedByRobots(targetUrl) {
  if (!cfg.respectRobots) return false;
  try {
    const u = new URL(targetUrl);
    const robotsUrl = `${u.origin}/robots.txt`;
    const res = await fetch(robotsUrl, { signal: AbortSignal.timeout(8000), headers: { 'user-agent': cfg.userAgent } });
    if (!res.ok) return false;
    const text = (await res.text()).slice(0, 100000);
    const lines = text.split(/\r?\n/).map(l => l.replace(/#.*$/, '').trim());
    let inStar = false;
    const disallows = [];
    for (const line of lines) {
      const m = line.match(/^(user-agent|disallow|allow)\s*:\s*(.*)$/i);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const val = m[2].trim();
      if (key === 'user-agent') inStar = val === '*';
      else if (inStar && key === 'disallow' && val) disallows.push(val);
    }
    const path = u.pathname || '/';
    return disallows.some(d => path.startsWith(d));
  } catch {
    return false;
  }
}

async function readCapped(res, maxBytes) {
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    return { text: buf.slice(0, maxBytes).toString('utf8'), bytes: buf.length, truncated: buf.length > maxBytes };
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total <= maxBytes) chunks.push(Buffer.from(value));
    else { truncated = true; try { await reader.cancel(); } catch { /* ignore */ } break; }
  }
  return { text: Buffer.concat(chunks).toString('utf8'), bytes: total, truncated };
}

async function fetchOnce(url) {
  const controller = AbortSignal.timeout(cfg.fetchTimeoutMs);
  const res = await fetch(url, {
    redirect: 'follow',
    signal: controller,
    headers: {
      'user-agent': cfg.userAgent,
      accept: 'text/html,application/xhtml+xml,application/xml,application/json,application/rss+xml,text/plain;q=0.9,*/*;q=0.5',
    },
  });
  const { text, bytes, truncated } = await readCapped(res, cfg.maxResponseBytes);
  return {
    http_status: res.status,
    ok: res.ok,
    content_type: (res.headers.get('content-type') || '').split(';')[0].trim() || 'application/octet-stream',
    published_at: res.headers.get('last-modified') ? new Date(res.headers.get('last-modified')).toISOString() : null,
    body: text,
    bytes,
    truncated,
  };
}

// Returns { ok, http_status, content_type, published_at, body, bytes, truncated, error }
async function fetchSource(source) {
  const url = source.url;
  if (await isDisallowedByRobots(url)) {
    return { ok: false, http_status: null, error: 'blocked by robots.txt', body: null, bytes: 0 };
  }

  let lastErr = null;
  for (let attempt = 0; attempt <= cfg.fetchRetries; attempt += 1) {
    try {
      const r = await fetchOnce(url);
      if (r.ok) return { ...r, error: null };
      if (!RETRYABLE_STATUS.has(r.http_status) || attempt === cfg.fetchRetries) {
        return { ...r, ok: false, error: `HTTP ${r.http_status}` };
      }
      lastErr = `HTTP ${r.http_status}`;
    } catch (e) {
      lastErr = e.name === 'TimeoutError' ? `timeout after ${cfg.fetchTimeoutMs} ms` : e.message;
      if (attempt === cfg.fetchRetries) break;
    }
    await sleep(cfg.retryBackoffMs * (attempt + 1));
  }
  return { ok: false, http_status: null, content_type: null, published_at: null, body: null, bytes: 0, error: lastErr || 'fetch failed' };
}

module.exports = { fetchSource, isDisallowedByRobots };
