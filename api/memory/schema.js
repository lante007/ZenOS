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

    // Increment 3, C5: revisions to an outcome are new rows, never edits to
    // an existing one. original_outcome_id links a revision back to the
    // outcome it revises; NULL means the row is an original record.
    await pool.query(`ALTER TABLE public.intelligence_outcomes ADD COLUMN IF NOT EXISTS original_outcome_id UUID REFERENCES public.intelligence_outcomes(id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS outcomes_original_idx ON public.intelligence_outcomes (original_outcome_id)`);

    // Append-only at the database level, not just by omission of an update
    // route: normal UPDATE/DELETE on this table is rejected outright. The
    // one escape hatch is a session-local setting a normal application
    // connection never sets, so it is not reachable through the API; it
    // exists only so an isolated test run can remove the disposable rows it
    // creates against a shared database (see tests/outcomes.test.js).
    await pool.query(`
      CREATE OR REPLACE FUNCTION public.intelligence_outcomes_append_only()
      RETURNS TRIGGER AS $$
      BEGIN
        IF current_setting('app.allow_outcome_mutation', true) = 'true' THEN
          RETURN COALESCE(NEW, OLD);
        END IF;
        RAISE EXCEPTION 'public.intelligence_outcomes is append-only: % is not permitted', TG_OP;
      END;
      $$ LANGUAGE plpgsql
    `);
    await pool.query(`DROP TRIGGER IF EXISTS intelligence_outcomes_no_update ON public.intelligence_outcomes`);
    await pool.query(`
      CREATE TRIGGER intelligence_outcomes_no_update
      BEFORE UPDATE ON public.intelligence_outcomes
      FOR EACH ROW EXECUTE FUNCTION public.intelligence_outcomes_append_only()
    `);
    await pool.query(`DROP TRIGGER IF EXISTS intelligence_outcomes_no_delete ON public.intelligence_outcomes`);
    await pool.query(`
      CREATE TRIGGER intelligence_outcomes_no_delete
      BEFORE DELETE ON public.intelligence_outcomes
      FOR EACH ROW EXECUTE FUNCTION public.intelligence_outcomes_append_only()
    `);

    return true;
  })().catch(err => {
    ready = null;
    throw err;
  });
  return ready;
}

module.exports = { ensureV11Schema };
