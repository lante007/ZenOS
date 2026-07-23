'use strict';

const jwt = require('jsonwebtoken');
const jwksRsa = require('jwks-rsa');

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

function toUser(payload, tenantSlug) {
  const role = payload['custom:role'] || payload.role || 'EVIDENCE_ANALYST';
  return {
    sub: payload.sub,
    email: payload.email,
    role,
    tenant_id: payload['custom:tenant_id'] || payload['custom:tenant'] || tenantSlug,
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

      if (!req.tenant?.cognito_pool_id) {
        if (process.env.NODE_ENV === 'production') {
          return res.status(500).json({ error: 'Tenant auth is not configured' });
        }
        const decoded = jwt.decode(token) || {};
        req.user = toUser(decoded, req.tenant?.slug);
        return next();
      }

      const issuer = `https://cognito-idp.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${req.tenant.cognito_pool_id}`;
      const payload = await new Promise((resolve, reject) => {
        jwt.verify(token, signingKeyFor(req.tenant), { issuer }, (err, verified) => {
          if (err) reject(err);
          else resolve(verified);
        });
      });

      req.user = toUser(payload, req.tenant.slug);
      if (req.user.tenant_id !== req.tenant.slug) {
        return res.status(403).json({ error: 'Token tenant does not match request tenant' });
      }
      next();
    } catch (err) {
      res.status(401).json({ error: 'Invalid authentication token' });
    }
  };
}

module.exports = { authenticate };
