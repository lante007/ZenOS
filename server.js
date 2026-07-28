'use strict';
/**
 * EvidenceOS API Server
 * Multi-tenant Express bootstrap. Tenant is resolved from subdomain or
 * x-evidenceos-tenant for local development.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const { tenantMiddleware } = require('./api/middleware/tenant');
const { authenticate } = require('./api/middleware/auth');
const { assertNoBoardAccess } = require('./api/middleware/permissions');
const recordsRoutes = require('./api/routes/records');
const classifyRoutes = require('./api/routes/classify');
const queueRoutes = require('./api/routes/queue');
const knowledgeRoutes = require('./api/routes/knowledge');
const reportsRoutes = require('./api/routes/reports');
const settingsRoutes = require('./api/routes/settings');
const auditRoutes = require('./api/routes/audit');
const adminRoutes = require('./api/routes/admin');
const strategicSynthesisRoutes = require('./api/routes/strategic-synthesis');
const synthesisRoutes = require('./api/routes/synthesis');
const alertsRoutes = require('./api/routes/alerts');
const db = require('./api/services/db');
const localStore = require('./api/services/local-store');

const app = express();

app.use(cors({
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true,
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'web')));

app.use(tenantMiddleware);

async function loadTenantRecordsAndQueue(tenant) {
  if (tenant?.is_admin_console) return { records: [], queue: [] };
  if (process.env.DATABASE_URL) {
    const [records, queue] = await Promise.all([
      db.listRecords(tenant, {}),
      db.listQueue(tenant),
    ]);
    return { records: records || [], queue: queue || [] };
  }
  return {
    records: localStore.listRecords(tenant),
    queue: localStore.listQueue(tenant),
  };
}

app.get('/api/health', async (req, res, next) => {
  try {
    const { records, queue } = await loadTenantRecordsAndQueue(req.tenant);
    res.json({
      status: 'ok',
      version: '1.0.0',
      tenant: req.tenant.slug,
      organisation: req.tenant.name,
      taxonomy_version: 'v2.1',
      storage: req.tenant.s3_vault_bucket || null,
      records: records.length,
      queue: queue.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

app.use('/api/admin', authenticate(), adminRoutes);

app.use('/api', authenticate(), assertNoBoardAccess);
app.use('/api/records', recordsRoutes);
app.use('/api/classify', classifyRoutes);
app.use('/api/queue', queueRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/strategic-synthesis', strategicSynthesisRoutes);
app.use('/api/synthesis', synthesisRoutes);
app.use('/api/alerts', alertsRoutes);
app.use('/api', knowledgeRoutes);

app.get('/api/stats', authenticate(), assertNoBoardAccess, async (req, res, next) => {
  try {
    const { records, queue } = await loadTenantRecordsAndQueue(req.tenant);
    const tierCounts = records.reduce((acc, record) => {
      const tier = record.confidence_tier || record.eqs_tier || 'N_A';
      acc[tier] = (acc[tier] || 0) + 1;
      return acc;
    }, {});

    res.json({
      tenant: req.tenant.slug,
      organisation: req.tenant.name,
      records: records.length,
      queue: queue.length,
      tier_counts: tierCounts,
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/exec-summary', authenticate(), assertNoBoardAccess, async (req, res, next) => {
  if (req.user.role !== 'CEO_EXEC' && req.user.role !== 'ORGANISATION_LEAD') {
    return res.status(403).json({ error: 'Executive view only' });
  }

  try {
    const { records, queue } = await loadTenantRecordsAndQueue(req.tenant);
    const tierOne = records.filter(r => (r.confidence_tier || r.eqs_tier) === 'TIER_1');
    res.json({
      tenant: req.tenant.slug,
      organisation: req.tenant.name,
      evidence_health_score: records.length ? Math.round((tierOne.length / records.length) * 100) : 0,
      tier_1_documents_this_week: tierOne.slice(0, 5).map(r => ({
        id: r.id || r.adei_record_id,
        programme_name: r.programme_name || r.programme,
        key_finding_1: r.key_finding_1,
      })),
      queue_items_pending: queue.length,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'web', 'index.html'));
});

app.use((err, req, res, _next) => {
  console.error(`[ERROR] ${req.method} ${req.path}: ${err.message}`);
  res.status(err.status || 500).json({ error: err.message });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n  EvidenceOS API`);
    console.log(`  http://localhost:${PORT}`);
    console.log(`  API: http://localhost:${PORT}/api/health\n`);
  });
}

module.exports = app;
