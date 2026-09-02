'use strict';

// api/memory/schema.js
// Lazily ensures the V1.1 foundation tables exist. Executes migration
// 024 verbatim (idempotent: every statement is CREATE ... IF NOT EXISTS), so
// deploying does not require a separate migration step. Memoised.

const fs = require('fs');
const path = require('path');
const { getPool } = require('../services/db');

const MIGRATION = path.join(__dirname, '..', '..', 'db', 'migrations', '024_v11_memory_watchtower.sql');

let ready = null;

async function ensureV11Schema() {
  if (ready) return ready;
  ready = (async () => {
    const pool = getPool();
    if (!pool) throw new Error('Database is not configured; V1.1 memory requires PostgreSQL.');
    const sql = fs.readFileSync(MIGRATION, 'utf8');
    await pool.query(sql);
    // Additive columns introduced after migration 024 (Increment 2).
    await pool.query(`ALTER TABLE public.wt_observations ADD COLUMN IF NOT EXISTS raw_s3_key TEXT`);
    return true;
  })().catch(err => {
    ready = null;
    throw err;
  });
  return ready;
}

module.exports = { ensureV11Schema };
