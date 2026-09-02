'use strict';

// api/memory/util.js — shared helpers for the V1.1 memory / watchtower layer.

const { getPool } = require('../services/db');
const { ensureV11Schema } = require('./schema');

let tenantCache = null;
let tenantCacheAt = 0;
const TENANT_TTL = 60000;

// Resolve and validate a tenant slug. Every tenant-scoped call goes through
// this so an unknown or unsafe slug can never reach a query.
async function resolveTenant(slug) {
  const s = String(slug || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]*$/.test(s)) throw Object.assign(new Error(`Invalid tenant slug: ${slug}`), { status: 400 });
  const now = Date.now();
  if (!tenantCache || now - tenantCacheAt > TENANT_TTL) {
    const pool = getPool();
    if (pool) {
      try {
        const res = await pool.query('SELECT slug FROM master.tenants WHERE is_active = true');
        tenantCache = new Set(res.rows.map(r => r.slug));
        tenantCacheAt = now;
      } catch {
        tenantCache = new Set(['zenex', 'optima']);
      }
    } else {
      tenantCache = new Set(['zenex', 'optima']);
    }
  }
  if (!tenantCache.has(s)) throw Object.assign(new Error(`Unknown tenant: ${s}`), { status: 404 });
  return s;
}

async function q(text, params) {
  await ensureV11Schema();
  const pool = getPool();
  if (!pool) throw new Error('Database is not configured');
  return pool.query(text, params);
}

function clampLimit(n, def = 25, max = 200) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return def;
  return Math.min(Math.floor(v), max);
}

module.exports = { resolveTenant, q, clampLimit };
