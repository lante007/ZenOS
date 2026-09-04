'use strict';

const { Pool } = require('pg');

const FALLBACK_TENANTS = {
  zenex: {
    slug: 'zenex',
    name: 'Zenex Foundation',
    subdomain: 'zenex.auxeira.com',
    primary_colour: '#EF7218',
    secondary_colour: '#311F47',
    s3_vault_bucket: 'auxeira-evidenceos-zenex',
    s3_web_bucket: 'auxeira-web-zenex',
    db_schema: 'zenex',
    organisation_type: 'FUNDER',
    feature_flags: {
      federated_network: false, sroi_module: true, synthesis: true, portfolio_optimizer: true,
      // Increment 3, C1: gates buildMemoryContext() injection into the
      // Advisor. Off by default; no behaviour change until C2 turns it on
      // per tenant.
      MEMORY_CONTEXT_ENABLED: false,
    },
    is_active: true,
  },
  optima: {
    slug: 'optima',
    name: 'Optima',
    subdomain: 'optima.auxeira.com',
    primary_colour: '#00B4D8',
    secondary_colour: '#0A1628',
    s3_vault_bucket: 'auxeira-evidenceos-optima',
    s3_web_bucket: 'auxeira-web-optima',
    db_schema: 'optima',
    organisation_type: 'FUNDER',
    feature_flags: {
      federated_network: false, sroi_module: true, synthesis: true, portfolio_optimizer: true,
      MEMORY_CONTEXT_ENABLED: false,
    },
    is_active: true,
  },
};

let pool;

function shouldUseSsl(connectionString) {
  if (process.env.PGSSLMODE === 'disable') return false;
  if (process.env.PGSSLMODE === 'require' || process.env.DATABASE_SSL === 'true') return true;
  return /\.rds\.amazonaws\.com(?::|\/|$)/.test(connectionString || '');
}

function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    pool = new Pool({
      connectionString,
      ssl: shouldUseSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
      connectionTimeoutMillis: Number(process.env.PG_CONNECTION_TIMEOUT_MS || 5000),
      query_timeout: Number(process.env.PG_QUERY_TIMEOUT_MS || 10000),
    });
  }
  return pool;
}

function normalizeTenant(row) {
  return {
    slug: row.slug,
    name: row.name,
    subdomain: row.subdomain,
    primary_colour: row.primary_colour || row.primary_color,
    secondary_colour: row.secondary_colour || row.secondary_color,
    s3_vault_bucket: row.s3_vault_bucket || row.s3_bucket,
    s3_web_bucket: row.s3_web_bucket,
    cognito_pool_id: row.cognito_pool_id,
    cognito_client_id: row.cognito_client_id,
    db_schema: row.db_schema || row.slug,
    organisation_type: row.organisation_type || 'FUNDER',
    sqs_queue_url: row.sqs_queue_url,
    feature_flags: row.feature_flags || {},
    is_active: row.is_active !== false,
  };
}

async function getTenantBySlug(slug) {
  const safeSlug = (slug || 'zenex').toLowerCase();
  const db = getPool();
  if (db) {
    try {
      const res = await db.query('SELECT * FROM master.tenants WHERE slug = $1 AND is_active = true', [safeSlug]);
      if (res.rows[0]) return normalizeTenant(res.rows[0]);
    } catch (err) {
      if (process.env.NODE_ENV === 'production') throw err;
      console.warn(`[TENANT] Falling back to static tenant config: ${err.message}`);
    }
  }
  return FALLBACK_TENANTS[safeSlug] ? normalizeTenant(FALLBACK_TENANTS[safeSlug]) : null;
}

async function listTenants() {
  const db = getPool();
  if (db) {
    try {
      const res = await db.query('SELECT * FROM master.tenants ORDER BY slug');
      return res.rows.map(normalizeTenant);
    } catch (err) {
      if (process.env.NODE_ENV === 'production') throw err;
      console.warn(`[TENANT] Falling back to static tenant list: ${err.message}`);
    }
  }
  return Object.values(FALLBACK_TENANTS).map(normalizeTenant);
}

// Feature flags live on each tenant's feature_flags object (DB column when
// the database is reachable, FALLBACK_TENANTS otherwise — see
// getTenantBySlug). Unknown tenants and unknown flag names both resolve to
// false so a typo'd flag name fails closed rather than throwing.
async function getFeatureFlag(tenantId, flagName) {
  const tenant = await getTenantBySlug(tenantId);
  if (!tenant || !tenant.feature_flags) return false;
  return tenant.feature_flags[flagName] === true;
}

// Admin-console roles with platform-wide reach. There is no per-admin
// tenant-delegation table in this system: this mirrors the existing
// precedent already established by api/routes/admin-ask.js and the
// /admin/corpus-health route, both of which loop over every active tenant
// for any founder/super-admin caller.
const ADMIN_ROLES = new Set(['AUXEIRA_FOUNDER', 'SUPER_ADMIN']);

function isAdminRole(role) {
  return !!role && ADMIN_ROLES.has(role);
}

// Authorised tenant scope for a given authenticated user. This is the sole
// place that decides which tenants a request is allowed to touch — callers
// must use this instead of trusting anything supplied by the browser.
//
// - AUXEIRA_FOUNDER / SUPER_ADMIN: authorised for every active tenant in the
//   registry (platform-wide admin model, matching existing precedent).
// - Every other role: authorised for exactly one tenant — their own, taken
//   from `user.tenant_id` as already set by the auth middleware from the
//   verified session, never from the request body/query.
//
// Returns an array of normalised tenant objects ({ slug, name, ... }), never
// bare tenant ID strings, so callers always have a name to show without a
// second lookup and can never accidentally forge an entry.
async function getAuthorisedTenants(user) {
  const role = user && user.role;
  if (isAdminRole(role)) {
    const all = await listTenants();
    return all.filter(t => t.is_active !== false);
  }
  const ownSlug = user && user.tenant_id;
  if (!ownSlug || ownSlug === 'admin') return [];
  const own = await getTenantBySlug(ownSlug);
  return own ? [own] : [];
}

module.exports = {
  getTenantBySlug,
  listTenants,
  getFeatureFlag,
  getAuthorisedTenants,
  isAdminRole,
  FALLBACK_TENANTS,
};
