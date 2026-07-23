'use strict';

const fs = require('fs');
const path = require('path');

const BASE_OUTPUT_DIR = path.resolve('./output');

function tenantDir(tenant) {
  const dir = path.join(BASE_OUTPUT_DIR, tenant.slug || 'zenex');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function recordFiles(tenant) {
  const dir = tenantDir(tenant);
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json') && !f.startsWith('batch') && f !== 'queue.json' && f !== 'knowledge-products.json')
    .map(f => path.join(dir, f));
}

function listRecords(tenant, filters = {}) {
  let records = recordFiles(tenant).map(file => readJson(file, null)).filter(Boolean);
  if (filters.tier) records = records.filter(r => (r.confidence_tier || r.eqs_tier) === filters.tier);
  if (filters.type) records = records.filter(r => r.document_type === filters.type);
  if (filters.phase) records = records.filter(r => r.phase === filters.phase);
  if (filters.q) {
    const q = filters.q.toLowerCase();
    records = records.filter(r => [
      r.filename,
      r.programme_name,
      r.programme,
      r.phase,
      r.document_type,
    ].filter(Boolean).join(' ').toLowerCase().includes(q));
  }
  return records;
}

function getRecord(tenant, id) {
  return listRecords(tenant).find(r => r.id === id || r.adei_record_id === id) || null;
}

function saveRecord(tenant, record) {
  const id = record.adei_record_id || record.id;
  fs.writeFileSync(path.join(tenantDir(tenant), `${id}.json`), JSON.stringify(record, null, 2));
  return record;
}

function queueFile(tenant) {
  return path.join(tenantDir(tenant), 'queue.json');
}

function listQueue(tenant) {
  return readJson(queueFile(tenant), []);
}

function saveQueue(tenant, queue) {
  fs.writeFileSync(queueFile(tenant), JSON.stringify(queue, null, 2));
}

function addQueueItems(tenant, record, items) {
  if (!items.length) return;
  const queue = listQueue(tenant);
  for (const item of items) {
    queue.push({
      id: `Q-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
      tenant_id: tenant.slug,
      document: record.filename,
      record_id: record.id,
      field: item.field,
      field_name: item.field,
      question: `Please confirm or override ${item.field}.`,
      recommendation: item.systemRecommendation,
      claude_value: item.claudeValue,
      confidence: item.claudeConf,
      claude_confidence: item.claudeConf,
      created_at: new Date().toISOString(),
    });
  }
  saveQueue(tenant, queue);
}

function resolveQueueItem(tenant, id, value, reviewer, isOverride) {
  const queue = listQueue(tenant);
  const idx = queue.findIndex(q => q.id === id);
  if (idx === -1) return null;
  const resolved = queue.splice(idx, 1)[0];
  resolved.resolved_value = value || resolved.recommendation;
  resolved.resolved_by = reviewer || 'system';
  resolved.is_override = isOverride === true;
  resolved.resolved_at = new Date().toISOString();

  const record = getRecord(tenant, resolved.record_id);
  if (record) {
    record[resolved.field || resolved.field_name] = resolved.resolved_value;
    record.fatima_reviewed_at = resolved.resolved_at;
    saveRecord(tenant, record);
  }

  saveQueue(tenant, queue);
  return resolved;
}

function saveKnowledgeProduct(tenant, product) {
  const file = path.join(tenantDir(tenant), 'knowledge-products.json');
  const products = readJson(file, []);
  products.push(product);
  fs.writeFileSync(file, JSON.stringify(products, null, 2));
  return product;
}

module.exports = {
  tenantDir,
  listRecords,
  getRecord,
  saveRecord,
  listQueue,
  addQueueItems,
  resolveQueueItem,
  saveKnowledgeProduct,
};
