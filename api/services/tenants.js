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
    feature_flags: { federated_network: false, sroi_module: true, synthesis: true, portfolio_optimizer: true },
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
    feature_flags: { federated_network: false, sroi_module: true, synthesis: true, portfolio_optimizer: true },
    is_active: true,
  },
};

let pool;
function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL });
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

module.exports = { getTenantBySlug, listTenants, FALLBACK_TENANTS };
