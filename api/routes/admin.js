'use strict';

const express = require('express');
const { AdminResetUserPasswordCommand, CognitoIdentityProviderClient } = require('@aws-sdk/client-cognito-identity-provider');
const db = require('../services/db');
const { getTenantBySlug } = require('../services/tenants');
const { requireRoles } = require('../middleware/permissions');
const { runFlywheel } = require('../services/flywheel');

const router = express.Router();
const cognito = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1',
});

function requireFounder(req, res, next) {
  const email = (req.user?.email || '').toLowerCase();
  const allowed = (process.env.FOUNDER_EMAILS || process.env.FOUNDER_EMAIL || 'emmanuel@auxeira.com,lante007@gmail.com')
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean);
  if (!allowed.includes(email) && req.user?.role !== 'AUXEIRA_FOUNDER') {
    return res.status(403).json({ error: 'Founder console access only' });
  }
  next();
}

router.post('/flywheel/run', requireRoles('ORGANISATION_LEAD'), async (req, res, next) => {
  try {
    const pool = db.getPool();
    if (!pool) return res.status(503).json({ error: 'Database is not configured' });
    const alerts = await runFlywheel(req.tenant, pool);
    res.json({
      success: true,
      inserted: alerts.length,
      alerts,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/tenants', requireFounder, async (_req, res, next) => {
  try {
    res.json(await db.adminTenantSummaries());
  } catch (err) {
    next(err);
  }
});

router.get('/dashboard', requireFounder, async (_req, res, next) => {
  try {
    res.json(await db.adminDashboard());
  } catch (err) {
    next(err);
  }
});

router.get('/platform', requireFounder, async (_req, res, next) => {
  try {
    res.json(await db.adminDashboard());
  } catch (err) {
    next(err);
  }
});

router.get('/tenants/:slug/records', requireFounder, async (req, res, next) => {
  try {
    const tenant = await getTenantBySlug(req.params.slug);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    const records = await db.listRecords(tenant, {});
    res.json(records);
  } catch (err) {
    next(err);
  }
});

router.post('/support/reset-password', requireFounder, async (req, res, next) => {
  const tenantSlug = req.body.tenant || req.body.tenant_slug;
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!tenantSlug || !email) return res.status(400).json({ error: 'tenant and email are required' });

  try {
    const tenant = await getTenantBySlug(tenantSlug);
    if (!tenant?.cognito_pool_id) return res.status(404).json({ error: 'Tenant Cognito pool not found' });
    await cognito.send(new AdminResetUserPasswordCommand({
      UserPoolId: tenant.cognito_pool_id,
      Username: email,
    }));
    await db.createAuditLog(tenant, 'password_reset', { email }, req.user.email || req.user.sub);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.post('/support/suspend-tenant', requireFounder, async (req, res, next) => {
  const tenantSlug = req.body.tenant || req.body.tenant_slug;
  if (!tenantSlug) return res.status(400).json({ error: 'tenant is required' });

  try {
    const before = await getTenantBySlug(tenantSlug);
    const suspended = await db.suspendTenant(tenantSlug);
    if (!suspended) return res.status(404).json({ error: 'Tenant not found' });
    if (before) {
      await db.createAuditLog(before, 'tenant_suspended', {
        tenant: tenantSlug,
      }, req.user.email || req.user.sub);
    }
    res.json({ success: true, tenant: suspended });
  } catch (err) {
    next(err);
  }
});

router.get('/health', requireFounder, async (_req, res) => {
  res.json({
    status: 'ok',
    console: 'admin.auxeira.com',
    timestamp: new Date().toISOString(),
  });
});

function assertSchema(schema) {
  if (!/^[a-z][a-z0-9_]*$/.test(schema || '')) {
    throw new Error(`Unsafe tenant schema: ${schema}`);
  }
}

// zenex.query_log does not exist yet - usage tracking has never been
// instrumented in the tenant-facing ASK_ZENEX/TOR/CEO-brief code paths.
// Returns an empty shell (not a 500) until that table exists, so this
// endpoint activates automatically once logging is added rather than
// needing a second deploy.
router.get('/usage', requireFounder, async (req, res) => {
  try {
    const pool = db.getPool();

    const tableCheck = await pool.query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'zenex' AND table_name = 'query_log'
    `);
    if (tableCheck.rows.length === 0) {
      return res.json({
        recent_activity: [],
        feature_summary: [],
        top_queries: [],
        gap_signals: [],
        note: 'zenex.query_log does not exist yet - usage tracking has not been instrumented.',
      });
    }

    const queryLog = await pool.query(`
      SELECT
        ql.tenant_id, ql.user_email, ql.user_role, ql.feature, ql.query_text,
        ql.response_length, ql.records_cited, ql.response_time_ms, ql.created_at
      FROM zenex.query_log ql
      ORDER BY ql.created_at DESC
      LIMIT 200
    `);

    const featureSummary = await pool.query(`
      SELECT
        tenant_id, feature,
        COUNT(*) as usage_count,
        COUNT(DISTINCT user_email) as unique_users,
        AVG(response_time_ms) as avg_response_ms,
        MAX(created_at) as last_used
      FROM zenex.query_log
      GROUP BY tenant_id, feature
      ORDER BY usage_count DESC
    `);

    const topQueries = await pool.query(`
      SELECT user_email, user_role, feature, query_text, created_at
      FROM zenex.query_log
      WHERE feature = 'ASK_ZENEX'
      ORDER BY created_at DESC
      LIMIT 50
    `);

    const gapSignals = await pool.query(`
      SELECT query_text, user_email, created_at
      FROM zenex.query_log
      WHERE feature = 'ASK_ZENEX'
      AND response_length < 200
      ORDER BY created_at DESC
      LIMIT 20
    `);

    res.json({
      recent_activity: queryLog.rows,
      feature_summary: featureSummary.rows,
      top_queries: topQueries.rows,
      gap_signals: gapSignals.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/corpus-health', requireFounder, async (req, res) => {
  try {
    const pool = db.getPool();
    const tenants = await pool.query(`
      SELECT slug, name FROM master.tenants WHERE is_active = true
    `);

    const health = [];
    for (const tenant of tenants.rows) {
      try {
        assertSchema(tenant.slug);
        const schema = tenant.slug;

        const stats = await pool.query(`
          SELECT
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE eqs_tier = 'TIER_1') as tier1,
            COUNT(*) FILTER (WHERE eqs_tier = 'TIER_2') as tier2,
            COUNT(*) FILTER (WHERE eqs_tier = 'TIER_3') as tier3,
            ROUND(AVG(eqs_composite)::numeric, 2) as avg_eqs,
            COUNT(*) FILTER (WHERE total_cost_rand IS NULL) as missing_grant,
            COUNT(*) FILTER (WHERE responsible_pm IS NULL) as missing_pm,
            COUNT(*) FILTER (WHERE provinces = '{}' OR provinces IS NULL) as missing_province,
            MAX(created_at) as last_classified
          FROM ${schema}.intelligence_records
          WHERE record_status = 'ACTIVE'
        `);

        const gaps = await pool.query(`
          SELECT COUNT(*) as gap_count
          FROM ${schema}.intelligence_records
          WHERE record_status = 'ACTIVE'
          AND endline_available = false
          AND baseline_available = true
        `);

        health.push({
          tenant: tenant.slug,
          name: tenant.name,
          ...stats.rows[0],
          evidence_gaps: gaps.rows[0].gap_count,
        });
      } catch (tenantErr) {
        health.push({ tenant: tenant.slug, error: tenantErr.message });
      }
    }

    res.json({ tenants: health });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/system-health', requireFounder, async (req, res) => {
  try {
    const pool = db.getPool();
    const dbCheck = await pool.query('SELECT NOW() as db_time');

    const uptime = process.uptime();
    const mem = process.memoryUsage();

    const tenantCount = await pool.query(`
      SELECT COUNT(*) as count FROM master.tenants WHERE is_active = true
    `);
    const tenants = await pool.query(`
      SELECT slug FROM master.tenants WHERE is_active = true
    `);

    let totalRecords = 0;
    for (const t of tenants.rows) {
      try {
        assertSchema(t.slug);
        const r = await pool.query(`
          SELECT COUNT(*) as count
          FROM ${t.slug}.intelligence_records
          WHERE record_status = 'ACTIVE'
        `);
        totalRecords += parseInt(r.rows[0].count, 10);
      } catch {
        // Skip a tenant whose schema is missing/unsafe rather than fail the whole check.
      }
    }

    res.json({
      status: 'healthy',
      db_time: dbCheck.rows[0].db_time,
      server_uptime_seconds: Math.round(uptime),
      memory_mb: {
        used: Math.round(mem.heapUsed / 1024 / 1024),
        total: Math.round(mem.heapTotal / 1024 / 1024),
      },
      active_tenants: parseInt(tenantCount.rows[0].count, 10),
      total_active_records: totalRecords,
      node_version: process.version,
      checked_at: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ status: 'degraded', error: err.message });
  }
});

module.exports = router;
