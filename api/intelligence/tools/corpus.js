'use strict';

// api/intelligence/tools/corpus.js
// Retrieval implementations over the live Zenex corpus. Agents never talk to
// the database directly; they call these through the tool registry.
// All queries are parameterised and run through db.js, which sets the tenant
// search_path. Read-only.

const db = require('../../services/db');

const ZENEX_TENANT = { slug: 'zenex', db_schema: 'zenex' };

// Fields that carry actual extracted evidence, kept separate from pure
// classification metadata so an agent can tell them apart.
const EVIDENCE_FIELDS = [
  'methodology_description', 'evaluation_design',
  'key_finding_1', 'key_finding_2', 'key_finding_3',
  'effect_size_composite', 'effect_direction',
  'limitations', 'evidence_gap_1', 'evidence_gap_2',
  'null_findings_reported', 'sample_size_learners', 'sample_size_schools',
  'baseline_available', 'endline_available',
];

const METADATA_FIELDS = [
  'id', 'programme_name', 'canonical_programme_name',
  'document_type', 'secondary_document_type', 'eqs_scoring_pathway',
  'year', 'eqs_tier', 'eqs_composite', 'half_life_rating',
  'provinces', 'total_cost_rand', 'classified_at',
];

function shapeRecord(row) {
  if (!row) return null;
  const metadata = {};
  for (const f of METADATA_FIELDS) if (row[f] !== undefined) metadata[f] = row[f];
  const evidence = {};
  for (const f of EVIDENCE_FIELDS) if (row[f] !== undefined && row[f] !== null && row[f] !== '') evidence[f] = row[f];
  return {
    record_id: row.id,
    document_filename: row.filename || row.original_filename || null,
    document_id: row.document_id || null,
    programme: row.canonical_programme_name || row.programme_name || null,
    metadata,
    evidence,
    evidence_present: Object.keys(evidence).length > 0,
  };
}

async function corpusSearch({ query, limit = 8 }) {
  if (!query || String(query).trim().length < 2) {
    return { error: 'query must be at least 2 characters' };
  }
  const rows = await db.listRecords(ZENEX_TENANT, { q: String(query).trim() });
  const capped = Math.min(Number(limit) || 8, 15);
  return {
    query,
    match_count: rows.length,
    records: rows.slice(0, capped).map(shapeRecord),
  };
}

async function getProgrammeEvidence({ programme }) {
  if (!programme || String(programme).trim().length < 2) {
    return { error: 'programme must be at least 2 characters' };
  }
  const rows = await db.getProgrammeRecordsForTor(ZENEX_TENANT, String(programme).trim());
  return {
    programme,
    record_count: rows.length,
    records: rows.map(shapeRecord),
    note: rows.length === 0
      ? 'No active records matched this programme name. The evidence may not be in the corpus.'
      : undefined,
  };
}

async function getRecords({ ids }) {
  const list = Array.isArray(ids) ? ids.filter(Boolean).map(String) : [];
  if (list.length === 0) return { error: 'ids must be a non-empty array of record identifiers' };
  const rows = await db.getRecordsByIds(ZENEX_TENANT, list.slice(0, 20));
  return {
    requested: list.length,
    found: rows.length,
    records: rows.map(shapeRecord),
  };
}

async function listProgrammes() {
  const rows = await db.listRecords(ZENEX_TENANT, {});
  const byProgramme = new Map();
  for (const row of rows) {
    const name = row.canonical_programme_name || row.programme_name || 'Unknown';
    const entry = byProgramme.get(name) || {
      programme: name, records: 0, has_evaluation: false, latest_year: null, tiers: new Set(),
    };
    entry.records += 1;
    if (['IMPACT', 'PROCESS'].includes(row.eqs_scoring_pathway)) entry.has_evaluation = true;
    if (row.year && (!entry.latest_year || row.year > entry.latest_year)) entry.latest_year = row.year;
    if (row.eqs_tier) entry.tiers.add(row.eqs_tier);
    byProgramme.set(name, entry);
  }
  return {
    programme_count: byProgramme.size,
    programmes: [...byProgramme.values()]
      .map(e => ({ ...e, tiers: [...e.tiers] }))
      .sort((a, b) => a.programme.localeCompare(b.programme)),
  };
}

async function externalResearch({ query }) {
  return {
    implemented: false,
    query: query || null,
    note: 'External research is not wired in this version. Report that external research was unavailable and answer from the corpus and context only.',
  };
}

module.exports = {
  corpusSearch,
  getProgrammeEvidence,
  getRecords,
  listProgrammes,
  externalResearch,
};
