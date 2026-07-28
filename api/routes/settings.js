'use strict';

const crypto = require('crypto');
const express = require('express');
const {
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  CognitoIdentityProviderClient,
} = require('@aws-sdk/client-cognito-identity-provider');
const { SendEmailCommand, SESClient } = require('@aws-sdk/client-ses');
const { GetSecretValueCommand, SecretsManagerClient } = require('@aws-sdk/client-secrets-manager');
const db = require('../services/db');
const { requireRoles } = require('../middleware/permissions');

const router = express.Router();
const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const cognito = new CognitoIdentityProviderClient({ region });
const ses = new SESClient({ region });
const secrets = new SecretsManagerClient({ region });
const allowedDomainCache = new Map();

const INVITABLE_ROLES = new Set(['EVIDENCE_ANALYST', 'COMMUNICATIONS', 'CEO_EXEC']);

function generateTemporaryPassword() {
  return `Temp-${crypto.randomBytes(6).toString('base64url')}Aa1`;
}

async function allowedDomainsForTenant(tenant) {
  const secretId = process.env.ALLOWED_DOMAINS_SECRET || `evidenceos/${tenant.slug}/allowed_domains`;
  if (allowedDomainCache.has(secretId)) return allowedDomainCache.get(secretId);

  try {
    const out = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }));
    const parsed = JSON.parse(out.SecretString || '[]');
    const domains = Array.isArray(parsed) ? parsed : [];
    allowedDomainCache.set(secretId, domains.map(domain => String(domain).toLowerCase()));
    return allowedDomainCache.get(secretId);
  } catch (err) {
    const fallback = (process.env.ALLOWED_DOMAINS || 'zenexfoundation.org.za')
      .split(',')
      .map(domain => domain.trim().toLowerCase())
      .filter(Boolean);
    allowedDomainCache.set(secretId, fallback);
    return fallback;
  }
}

async function assertAllowedEmail(tenant, email) {
  const domain = String(email || '').split('@')[1]?.toLowerCase();
  const allowed = await allowedDomainsForTenant(tenant);
  if (!domain || !allowed.includes(domain)) {
    const err = new Error('Email domain not authorised for this organisation.');
    err.status = 400;
    throw err;
  }
}

function loginUrlForTenant(tenant) {
  if (process.env.ZENEX_LOGIN_URL) return process.env.ZENEX_LOGIN_URL;
  return `https://${tenant.subdomain || 'zenex.auxeira.com'}/login`;
}

function uuidOrNull(value) {
  const str = String(value || '');
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str)
    ? str
    : null;
}

async function sendWelcomeEmail({ tenant, email, fullName, temporaryPassword }) {
  const from = process.env.SES_FROM_EMAIL || process.env.CEO_SUMMARY_FROM || 'emmanuel@auxeira.com';
  await ses.send(new SendEmailCommand({
    Source: from,
    Destination: { ToAddresses: [email] },
    Message: {
      Subject: { Data: `Welcome to ${tenant.name} EvidenceOS` },
      Body: {
        Text: {
          Data: [
            `Hello ${fullName || email},`,
            '',
            `You have been invited to ${tenant.name} EvidenceOS.`,
            `Login URL: ${loginUrlForTenant(tenant)}`,
            `Temporary password: ${temporaryPassword}`,
            '',
            'You will be asked to set your own password the first time you sign in.',
          ].join('\n'),
        },
      },
    },
  }));
}

router.use(requireRoles('ORGANISATION_LEAD'));

router.post('/ratify-eqs-v2', async (req, res, next) => {
  try {
    const pool = db.getPool();
    const schema = req.tenant.db_schema || req.tenant.slug || 'zenex';
    const ratifiedBy = uuidOrNull(req.user?.sub);
    const result = await pool.query(
      `INSERT INTO ${schema}.methodology_versions (
         tenant_id, version_label, ratified_by,
         ratified_at, effective_from, notes
       ) VALUES (
         $1, 'v2.0', $2, NOW(), NOW(),
         'EQS v2.0 pathway methodology. ' ||
         'Three pathways: Impact Causal (x1.00), ' ||
         'Impact Descriptive (x0.85), ' ||
         'Process/Implementation (x0.75), ' ||
         'Formative/Baseline (x0.60). ' ||
         'Equal dimension weights 20% each. ' ||
         'Research Studies now scored via ' ||
         'Formative pathway.'
       )
       RETURNING version_label, ratified_at`,
      [req.tenant.slug, ratifiedBy]
    );

    res.json({
      success: true,
      version: result.rows[0].version_label,
      ratified_at: result.rows[0].ratified_at,
      message: 'EQS v2.0 is now active for all new classifications. Existing records retain v1.0 scores.',
    });
  } catch (err) {
    next(err);
  }
});

router.get('/users', async (req, res, next) => {
  try {
    res.json(await db.listUsers(req.tenant));
  } catch (err) {
    next(err);
  }
});

router.post('/users/invite', async (req, res, next) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const fullName = String(req.body.full_name || '').trim();
  const role = String(req.body.role || '').trim();

  if (!email || !fullName || !role) {
    return res.status(400).json({ error: 'email, full_name and role are required' });
  }
  if (!INVITABLE_ROLES.has(role)) {
    return res.status(400).json({ error: 'Role cannot be invited from Settings' });
  }

  try {
    await assertAllowedEmail(req.tenant, email);
    const temporaryPassword = generateTemporaryPassword();
    const userPoolId = req.tenant.cognito_pool_id || process.env.ZENEX_COGNITO_POOL_ID;
    if (!userPoolId) return res.status(500).json({ error: 'Tenant Cognito pool is not configured' });

    const created = await cognito.send(new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: email,
      TemporaryPassword: temporaryPassword,
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'name', Value: fullName },
      ],
    }));

    const cognitoSub = created.User?.Attributes?.find(attr => attr.Name === 'sub')?.Value || null;
    const user = await db.createUser(req.tenant, {
      email,
      full_name: fullName,
      role,
      cognito_sub: cognitoSub,
    });

    await sendWelcomeEmail({ tenant: req.tenant, email, fullName, temporaryPassword });
    await db.createAuditLog(req.tenant, 'user_invited', {
      email,
      role,
      invited_user_id: user.id,
    }, req.user.email || req.user.sub);

    res.status(201).json({ user, email });
  } catch (err) {
    next(err);
  }
});

router.patch('/users/:id', async (req, res, next) => {
  const changes = {};
  if (Object.prototype.hasOwnProperty.call(req.body, 'role')) {
    if (!INVITABLE_ROLES.has(req.body.role) && req.body.role !== 'ORGANISATION_LEAD') {
      return res.status(400).json({ error: 'Unsupported role' });
    }
    changes.role = req.body.role;
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'is_active')) {
    changes.is_active = req.body.is_active === true;
  }

  try {
    const updated = await db.updateUser(req.tenant, req.params.id, changes);
    if (!updated) return res.status(404).json({ error: 'User not found' });

    if (changes.is_active === false) {
      const userPoolId = req.tenant.cognito_pool_id || process.env.ZENEX_COGNITO_POOL_ID;
      if (userPoolId) {
        await cognito.send(new AdminDisableUserCommand({
          UserPoolId: userPoolId,
          Username: updated.email,
        }));
      }
      await db.createAuditLog(req.tenant, 'user_deactivated', {
        email: updated.email,
        user_id: updated.id,
      }, req.user.email || req.user.sub);
    } else if (changes.role) {
      await db.createAuditLog(req.tenant, 'role_changed', {
        email: updated.email,
        user_id: updated.id,
        role: changes.role,
      }, req.user.email || req.user.sub);
    }

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
