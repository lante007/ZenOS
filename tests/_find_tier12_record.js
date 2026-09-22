'use strict';
require('dotenv').config();
const { getTenantBySlug } = require('../api/services/tenants');
const { Pool } = require('pg');

function shouldUseSsl(connectionString) {
  if (process.env.PGSSLMODE === 'disable') return false;
  if (process.env.PGSSLMODE === 'require' || process.env.DATABASE_SSL === 'true') return true;
  return /\.rds\.amazonaws\.com(?::|\/|$)/.test(connectionString || '');
}

async function main() {
  const tenant = await getTenantBySlug('zenex');
  const connectionString = process.env.DATABASE_URL;
  const pool = new Pool({
    connectionString,
    ssl: shouldUseSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
  });
  const res = await pool.query(
    `SELECT id, programme_name, confidence_tier FROM ${tenant.db_schema}.records WHERE confidence_tier IN ('TIER_1','TIER_2') ORDER BY created_at DESC LIMIT 5`
  );
  console.log(JSON.stringify(res.rows, null, 2));
  process.exit(0);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
