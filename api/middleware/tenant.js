'use strict';

const { getTenantBySlug } = require('../services/tenants');

function slugFromHost(hostname) {
  const host = (hostname || '').split(':')[0].toLowerCase();
  if (!host || host === 'localhost' || host === '127.0.0.1') {
    return process.env.EVIDENCEOS_TENANT || process.env.TENANT || 'zenex';
  }
  if (host === 'admin.auxeira.com') return 'admin';
  const [subdomain] = host.split('.');
  return subdomain || 'zenex';
}

async function tenantMiddleware(req, res, next) {
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const slug = req.headers['x-evidenceos-tenant'] || slugFromHost(host);

    if (slug === 'admin') {
      let adminPoolId = process.env.ADMIN_COGNITO_POOL_ID || process.env.EVIDENCEOS_ADMIN_POOL_ID || null;
      if (!adminPoolId) {
        try {
          adminPoolId = require('../../infra/outputs.json').admin_cognito_pool_id;
        } catch {
          adminPoolId = null;
        }
      }
      req.tenant = {
        slug: 'admin',
        name: 'Auxeira Founder Console',
        is_admin_console: true,
        cognito_pool_id: adminPoolId,
      };
      return next();
    }

    const tenant = await getTenantBySlug(slug);
    if (!tenant || !tenant.is_active) {
      return res.status(404).json({ error: 'Tenant not found or inactive' });
    }

    req.tenant = tenant;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { tenantMiddleware, slugFromHost };
