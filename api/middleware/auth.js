'use strict';

const jwt = require('jsonwebtoken');
const jwksRsa = require('jwks-rsa');
const { getPool } = require('../services/db');

const cache = new Map();

function isDevAuthAllowed() {
  return process.env.AUTH_DISABLED === 'true' || process.env.NODE_ENV !== 'production';
}

function getBearerToken(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function getJwksClient(tenant) {
  const region = process.env.AWS_REGION || 'us-east-1';
  const key = `${region}:${tenant.cognito_pool_id}`;
  if (!cache.has(key)) {
    cache.set(key, jwksRsa({
      jwksUri: `https://cognito-idp.${region}.amazonaws.com/${tenant.cognito_pool_id}/.well-known/jwks.json`,
      cache: true,
      rateLimit: true,
    }));
  }
  return cache.get(key);
}

function signingKeyFor(tenant) {
  const client = getJwksClient(tenant);
  return (header, callback) => {
    client.getSigningKey(header.kid, (err, key) => {
      if (err) return callback(err);
      callback(null, key.getPublicKey());
    });
  };
}

function getCandidatePools(req) {
  const pools = [
    req.tenant?.cognito_pool_id,
    process.env.COGNITO_USER_POOL_ID || process.env.ZENEX_COGNITO_POOL_ID || 'us-east-1_a4QBPMV0D',
    process.env.ADMIN_COGNITO_POOL_ID || process.env.EVIDENCEOS_ADMIN_POOL_ID || 'us-east-1_RR62sMTY0',
  ];
  return [...new Set(pools.filter(Boolean))];
}

function verifyWithPool(token, poolId) {
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
  const tenant = { cognito_pool_id: poolId };
  const issuer = `https://cognito-idp.${region}.amazonaws.com/${poolId}`;
  return new Promise((resolve, reject) => {
    jwt.verify(token, signingKeyFor(tenant), { issuer }, (err, verified) => {
      if (err) reject(err);
      else resolve(verified);
    });
  });
}

function normaliseRole(role, isAdminConsole) {
  if (!isAdminConsole) return role || 'EVIDENCE_ANALYST';
  const value = String(role || '').toUpperCase();
  if (['SUPERADMIN', 'SUPER_ADMIN', 'ADMIN'].includes(value)) return 'SUPER_ADMIN';
  if (['FOUNDER', 'AUXEIRA_FOUNDER'].includes(value)) return 'AUXEIRA_FOUNDER';
  return value || 'SUPER_ADMIN';
}

function toUser(payload, tenantSlug, options = {}) {
  const rawRole = payload['custom:role'] || payload['custom:custom:role'] || payload.role;
  const role = normaliseRole(rawRole, options.isAdminConsole);
  const tenantId = options.isAdminConsole
    ? 'admin'
    : payload['custom:tenant_id'] || payload['custom:custom:tenant_id'] || payload['custom:tenant'] || tenantSlug;
  return {
    sub: payload.sub,
    email: payload.email,
    role,
    tenant_id: tenantId,
    name: payload.name || [payload.given_name, payload.family_name].filter(Boolean).join(' '),
  };
}

function authenticate(options = {}) {
  return async function authMiddleware(req, res, next) {
    try {
      const token = getBearerToken(req);
      if (!token) {
        if (options.optional) return next();
        if (isDevAuthAllowed()) {
          req.user = {
            sub: 'local-dev-user',
            email: req.headers['x-evidenceos-user'] || 'fatima@zenex.org.za',
            role: req.headers['x-evidenceos-role'] || 'ORGANISATION_LEAD',
            tenant_id: req.tenant?.slug || 'zenex',
            name: 'Local Dev User',
          };
          return next();
        }
        return res.status(401).json({ error: 'Authentication required' });
      }

      const pools = getCandidatePools(req);
      if (!pools.length) {
        return res.status(500).json({ error: 'Tenant auth is not configured' });
      }

      let payload = null;
      let lastAuthError = null;
      for (const poolId of pools) {
        try {
          payload = await verifyWithPool(token, poolId);
          break;
        } catch (err) {
          lastAuthError = err;
        }
      }

      if (!payload) {
        return res.status(401).json({
          error: 'Invalid authentication token',
          detail: process.env.NODE_ENV === 'production' ? undefined : lastAuthError?.message,
        });
      }

      req.user = toUser(payload, req.tenant.slug, {
        isAdminConsole: Boolean(req.tenant?.is_admin_console),
      });
      if (req.user.tenant_id !== req.tenant.slug) {
        return res.status(403).json({ error: 'Token tenant does not match request tenant' });
      }

      try {
        const pool = getPool();
        if (pool) {
          await pool.query(`
            UPDATE zenex.users
            SET last_login_at = NOW()
            WHERE tenant_id = $1
            AND email = $2
          `, [req.user.tenant_id, req.user.email]);
        }
      } catch {
        // A failed last_login_at write should never block the request.
      }

      next();
    } catch (err) {
      res.status(401).json({ error: 'Invalid authentication token' });
    }
  };
}

module.exports = { authenticate };
