'use strict';

// api/watchtower/seed-sources.js
// The first three Watchtower sources, one per class, all public and
// fetchable without authentication, paywalls or CAPTCHAs. robots.txt checked
// 2026-09-02: none disallow the fetched path for User-agent: *.
// Registered as GLOBAL sources (tenant_id NULL): they describe the ecosystem
// around every tenant, not one tenant's private material.

const wt = require('../memory/watchtower');

const SEED_SOURCES = [
  {
    name: 'Department of Basic Education (national)',
    source_type: 'government',
    url: 'https://www.education.gov.za/',
    crawl_frequency: 'daily',
    credibility: 'HIGH',
    config: { class: 'dbe_policy', note: 'DBE homepage: media releases, announcements, strategy links.' },
  },
  {
    name: 'DG Murray Trust',
    source_type: 'funder',
    url: 'https://dgmt.co.za/',
    crawl_frequency: 'daily',
    credibility: 'HIGH',
    config: { class: 'comparable_funder', note: 'SA education/development funder: strategy and programme announcements.' },
  },
  {
    name: 'RESEP (Research on Socio-Economic Policy, Stellenbosch)',
    source_type: 'research',
    url: 'https://resep.sun.ac.za/',
    crawl_frequency: 'daily',
    credibility: 'HIGH',
    config: { class: 'research_evidence', note: 'Regular SA education research and evaluation output.' },
  },
];

async function ensureSeedSources() {
  const out = [];
  for (const s of SEED_SOURCES) {
    out.push(await wt.registerSource(s)); // upsert on (scope, url)
  }
  return out;
}

module.exports = { SEED_SOURCES, ensureSeedSources };

if (require.main === module) {
  require('dotenv').config();
  ensureSeedSources()
    .then(rows => { console.log(JSON.stringify(rows.map(r => ({ id: r.id, name: r.name, url: r.url })), null, 2)); process.exit(0); })
    .catch(e => { console.error(e); process.exit(1); });
}
