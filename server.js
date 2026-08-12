'use strict';
/**
 * EvidenceOS API Server
 * Multi-tenant Express bootstrap. Tenant is resolved from subdomain or
 * x-evidenceos-tenant for local development.
 */

require('dotenv').config();
const express = require('express');

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
const adminAskRoutes = require('./api/routes/admin-ask');
const strategicSynthesisRoutes = require('./api/routes/strategic-synthesis');
const synthesisRoutes = require('./api/routes/synthesis');
const torRoutes = require('./api/routes/tor');
const alertsRoutes = require('./api/routes/alerts');
const provenanceRoutes = require('./api/routes/provenance');
const statsRoutes = require('./api/routes/stats');
const financialRoutes = require('./api/routes/financial');
const workspaceRoutes = require('./api/routes/workspace');
const briefRoutes = require('./api/routes/brief');
const db = require('./api/services/db');
const localStore = require('./api/services/local-store');

const app = express();

const allowedOrigins = [
  'https://zenex.auxeira.com',
  'https://admin.auxeira.com',
  'http://localhost:5173',
  'http://localhost:3000',
  ...(process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(origin => origin.trim()).filter(Boolean) : []),
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  console.log('CORS origin received:', origin);
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (!origin) {
    res.setHeader('Access-Control-Allow-Origin', 'https://zenex.auxeira.com');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, x-evidenceos-tenant, x-evidenceos-role, x-evidenceos-user'
  );
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});
app.use(express.json({ limit: '10mb' }));

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
app.use('/api/admin-ask', authenticate(), adminAskRoutes);

app.use('/api', authenticate(), assertNoBoardAccess);
app.use('/api/stats', statsRoutes);
app.use('/api/records', recordsRoutes);
app.use('/api/classify', classifyRoutes);
app.use('/api/queue', queueRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/strategic-synthesis', strategicSynthesisRoutes);
app.use('/api/synthesis', synthesisRoutes);
app.use('/api/tor', torRoutes);
app.use('/api/alerts', alertsRoutes);
app.use('/api/provenance', provenanceRoutes);
app.use('/api/financial', financialRoutes);
app.use('/api/workspace', workspaceRoutes);
app.use('/api/brief', briefRoutes);
app.use('/api', knowledgeRoutes);

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
