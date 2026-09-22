'use strict';
require('dotenv').config();
const { getTenantBySlug } = require('../api/services/tenants');
const db = require('../api/services/db');

async function main() {
  const tenant = await getTenantBySlug('zenex');
  const tier1 = await db.listRecords(tenant, { tier: 'TIER_1' });
  const tier2 = await db.listRecords(tenant, { tier: 'TIER_2' });
  const rows = [...tier1, ...tier2]
    .slice(0, 5)
    .map(r => ({ id: r.id, programme_name: r.programme_name, eqs_tier: r.eqs_tier }));
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
