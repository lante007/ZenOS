'use strict';

// One-off validation script for Sector Peer persona deployment.
// Run on the server via SSM: node tests/_sector_peer_validation.js <recordId>

const db = require('../api/services/db');
const { getTenantBySlug } = require('../api/services/tenants');
const { generateKnowledgeProduct } = require('../src/claude-classifier');

async function main() {
  const recordId = process.argv[2] || 'ADEI-ZENEX-E08D28BD';
  const tenant = await getTenantBySlug('zenex');
  if (!tenant) throw new Error('zenex tenant not found');

  const record = await db.getRecord(tenant, recordId);
  if (!record) throw new Error(`Record ${recordId} not found`);

  console.error(`Record found: ${record.programme_name} (tier: ${record.confidence_tier || record.eqs_tier})`);

  const result = await generateKnowledgeProduct({
    record,
    audience: 'SECTOR_PEER',
    tenant,
    synthesisContext: '',
  });

  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch(err => {
  console.error('ERROR:', err.message);
  console.error(err.stack);
  process.exit(1);
});
