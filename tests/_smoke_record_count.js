'use strict';
require('dotenv').config();
const { getTenantBySlug } = require('../api/services/tenants');
const db = require('../api/services/db');

async function main() {
  const tenant = await getTenantBySlug('zenex');
  const rows = await db.listRecords(tenant, {});
  console.log(JSON.stringify({ active_record_count: rows.length }, null, 2));
  process.exit(0);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
