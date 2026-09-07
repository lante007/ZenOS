'use strict';

// api/intelligence/scouts/schema.js
// Lazily ensures the external_intelligence / innovation_candidates tables
// exist. Executes migration 026 verbatim (idempotent: every statement is
// CREATE ... IF NOT EXISTS / CREATE OR REPLACE), so deploying does not
// require a separate migration step. Memoised, matching the exact pattern
// in api/memory/schema.js#ensureV11Schema.

const fs = require('fs');
const path = require('path');
const { getPool } = require('../../services/db');

const MIGRATION = path.join(__dirname, '..', '..', '..', 'db', 'migrations', '026_external_intelligence_innovation.sql');

let ready = null;

async function ensureScoutSchema() {
  if (ready) return ready;
  ready = (async () => {
    const pool = getPool();
    if (!pool) throw new Error('Database is not configured; scouts require PostgreSQL.');
    const sql = fs.readFileSync(MIGRATION, 'utf8');
    await pool.query(sql);
    return true;
  })().catch(err => {
    ready = null;
    throw err;
  });
  return ready;
}

module.exports = { ensureScoutSchema };
