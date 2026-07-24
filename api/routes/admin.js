'use strict';

const express = require('express');
const { AdminResetUserPasswordCommand, CognitoIdentityProviderClient } = require('@aws-sdk/client-cognito-identity-provider');
const db = require('../services/db');
const { getTenantBySlug } = require('../services/tenants');

const router = express.Router();
const cognito = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1',
});

function requireFounder(req, res, next) {
  const email = req.user?.email || '';
  const allowed = process.env.FOUNDER_EMAIL || 'emmanuel@auxeira.com';
  if (email.toLowerCase() !== allowed.toLowerCase() && req.user?.role !== 'AUXEIRA_FOUNDER') {
    return res.status(403).json({ error: 'Founder console access only' });
  }
  next();
}

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

module.exports = router;
