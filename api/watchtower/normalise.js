'use strict';

// api/watchtower/normalise.js
// Deterministic normalisation of fetched bytes into a stable text
// representation for fingerprinting and change detection. No semantic
// extraction, no LLM. Same input -> same output.

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'",
  '&nbsp;': ' ', '&mdash;': '-', '&ndash;': '-', '&hellip;': '...', '&rsquo;': "'", '&lsquo;': "'",
  '&rdquo;': '"', '&ldquo;': '"',
};

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ' '; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ' '; } })
    .replace(/&[a-z]+;/gi, m => ENTITIES[m.toLowerCase()] ?? ' ');
}

function collapse(s) {
  return s.replace(/ /g, ' ').replace(/[ \t\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function stripHtml(html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? collapse(decodeEntities(titleMatch[1].replace(/<[^>]+>/g, ' '))).slice(0, 300) : null;
  let text = html
    // remove non-content elements entirely
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<template[\s\S]*?<\/template>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // ASP.NET viewstate / CSRF hidden fields are pure transport noise
    .replace(/<input[^>]*type=["']hidden["'][^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  text = collapse(decodeEntities(text));
  return { title, text };
}

function stableJson(str) {
  const sortKeys = v => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
      return Object.keys(v).sort().reduce((acc, k) => { acc[k] = sortKeys(v[k]); return acc; }, {});
    }
    return v;
  };
  try {
    return JSON.stringify(sortKeys(JSON.parse(str)));
  } catch {
    return collapse(str);
  }
}

// Returns { text, title }
function normalise(body, contentType) {
  const b = String(body || '');
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('json')) return { text: stableJson(b), title: null };
  if (ct.includes('html') || ct.includes('xhtml')) return stripHtml(b);
  if (ct.includes('xml') || ct.includes('rss') || ct.includes('atom')) {
    return { title: null, text: collapse(decodeEntities(b.replace(/<[^>]+>/g, ' '))) };
  }
  // plain text / unknown
  return { text: collapse(b), title: null };
}

module.exports = { normalise };
