'use strict';

// tests/tenant-scope.test.js — multi-tenant Chief of Staff: tenant
// isolation and cross-tenant-mode authorisation guarantees.
//
// These are the STEP 6 isolation checks:
//   1. a normal tenant user can never trigger cross-tenant mode, no matter
//      what the request body asks for;
//   2. an AUXEIRA_FOUNDER/SUPER_ADMIN in single-tenant mode is scoped to
//      exactly one tenant at a time;
//   3. an admin's "all tenants" mode is scoped to exactly the authorised
//      set (getAuthorisedTenants()), never a hardcoded or unfiltered list;
//   4. no cross-tenant data blending: getAllTenantsCorpusData and the
//      Advisor's cross-tenant prompt both keep each tenant's figures
//      strictly separate, and an inaccessible tenant fails soft without
//      touching any other tenant's entry.
//
// (Case 5 — the trace endpoint recording the tenant scope actually used —
// is exercised by tests/trace.test.js, which asserts against a real job's
// persisted tenant_scope column end to end.)

const assert = require('assert');
const { hasDatabase } = require('./helpers/env');
const { resolveTenantScope } = require('../api/routes/intelligence');
const { getAuthorisedTenants, isAdminRole } = require('../api/services/tenants');
const { getAllTenantsCorpusData } = require('../api/intelligence/live-data');
const { buildPrompt } = require('../api/intelligence/agents/advisor');

const SPECIALIST_OK = [{
  agent: 'evidence_analyst',
  status: 'ok',
  output: { confidence: 'MODERATE', findings: [], known: [], not_known: [], interpretation: [], risks: [], recommendations: [], sources: [] },
}];

module.exports = {
  'resolveTenantScope: a user with no authorised tenant gets null, never inferred cross-tenant mode': async () => {
    const user = { role: 'ORGANISATION_LEAD', tenant_id: null };
    const scope = await resolveTenantScope(user, { tenantMode: 'all' });
    assert.strictEqual(scope, null);
  },

  "resolveTenantScope: a non-admin user is forced into their own tenant, even if the body asks for 'all' or a different tenant": async () => {
    const user = { role: 'ORGANISATION_LEAD', tenant_id: 'zenex' };
    const scope = await resolveTenantScope(user, { tenantMode: 'all', tenantId: 'optima' });
    assert.strictEqual(scope.mode, 'tenant');
    assert.strictEqual(scope.tenant_id, 'zenex');
    assert.strictEqual(scope.tenant_ids, null);
    assert.strictEqual(scope.tenants.length, 1);
    assert.strictEqual(scope.tenants[0].slug, 'zenex');
  },

  'resolveTenantScope: a non-admin user with no request body still resolves to their own tenant': async () => {
    const user = { role: 'ORGANISATION_LEAD', tenant_id: 'zenex' };
    const scope = await resolveTenantScope(user, {});
    assert.strictEqual(scope.mode, 'tenant');
    assert.strictEqual(scope.tenant_id, 'zenex');
  },

  "resolveTenantScope: an admin's tenantMode 'all' is scoped to exactly getAuthorisedTenants(), never an unfiltered/hardcoded list": async () => {
    const user = { role: 'AUXEIRA_FOUNDER' };
    const [scope, authorised] = await Promise.all([
      resolveTenantScope(user, { tenantMode: 'all' }),
      getAuthorisedTenants(user),
    ]);
    assert.strictEqual(scope.mode, 'all');
    assert.strictEqual(scope.tenant_id, null);
    const expectedSlugs = authorised.map(t => t.slug).sort();
    assert.deepStrictEqual([...scope.tenant_ids].sort(), expectedSlugs);
    assert.deepStrictEqual(scope.tenants.map(t => t.slug).sort(), expectedSlugs);
  },

  "resolveTenantScope: an admin's single-tenant request only honours a tenantId inside their authorised set": async () => {
    const user = { role: 'SUPER_ADMIN' };
    const scopeKnown = await resolveTenantScope(user, { tenantId: 'optima' });
    assert.strictEqual(scopeKnown.mode, 'tenant');
    assert.strictEqual(scopeKnown.tenant_id, 'optima');

    const scopeUnknown = await resolveTenantScope(user, { tenantId: 'not-a-real-tenant-xyz' });
    assert.strictEqual(scopeUnknown.mode, 'tenant');
    assert.strictEqual(scopeUnknown.tenant_id, 'zenex', 'an unrecognised tenantId must fall back to the unchanged V1/V1.1 default, never be trusted as-is');
  },

  "resolveTenantScope: an admin's request with nothing supplied defaults to 'zenex', matching unchanged V1/V1.1 behaviour": async () => {
    const user = { role: 'AUXEIRA_FOUNDER' };
    const scope = await resolveTenantScope(user, {});
    assert.strictEqual(scope.mode, 'tenant');
    assert.strictEqual(scope.tenant_id, 'zenex');
  },

  'resolveTenantScope: isAdminRole is exactly AUXEIRA_FOUNDER and SUPER_ADMIN, nothing else': async () => {
    assert.strictEqual(isAdminRole('AUXEIRA_FOUNDER'), true);
    assert.strictEqual(isAdminRole('SUPER_ADMIN'), true);
    assert.strictEqual(isAdminRole('ORGANISATION_LEAD'), false);
    assert.strictEqual(isAdminRole(undefined), false);
    assert.strictEqual(isAdminRole(''), false);
  },

  'isolation: an inactive tenant never appears in an admin\'s authorised set or "all tenants" scope': async () => {
    if (!hasDatabase()) return 'SKIP';
    const { getPool } = require('../api/services/db');
    const pool = getPool();
    const stamp = Date.now();
    const inactiveSlug = `zztest${stamp}`.slice(0, 20);
    await pool.query(
      `INSERT INTO master.tenants (slug, name, subdomain, db_schema, is_active, feature_flags)
       VALUES ($1, $2, $3, $1, false, '{}'::jsonb)`,
      [inactiveSlug, `Inactive Test Tenant ${stamp}`, `${inactiveSlug}.test.auxeira.com`],
    );
    try {
      const user = { role: 'AUXEIRA_FOUNDER' };
      const authorised = await getAuthorisedTenants(user);
      assert.ok(!authorised.some(t => t.slug === inactiveSlug), 'an inactive tenant must never be authorised');

      const scope = await resolveTenantScope(user, { tenantMode: 'all' });
      assert.ok(!scope.tenant_ids.includes(inactiveSlug), 'an inactive tenant must never appear in cross-tenant scope');
    } finally {
      await pool.query('DELETE FROM master.tenants WHERE slug = $1', [inactiveSlug]);
    }
  },

  "isolation: getAllTenantsCorpusData never blends figures — each tenant's entry is independent, and an inaccessible tenant fails soft without touching any other entry": async () => {
    if (!hasDatabase()) return 'SKIP';
    const { getPool } = require('../api/services/db');
    const pool = getPool();
    const ghostSlug = `zzghost${Date.now()}`.slice(0, 20);

    const entries = await getAllTenantsCorpusData(pool, [
      { slug: 'zenex', name: 'Zenex Foundation' },
      { slug: ghostSlug, name: 'Ghost Tenant' },
    ]);

    assert.strictEqual(entries.length, 2);
    const [zenexEntry, ghostEntry] = entries;

    assert.strictEqual(zenexEntry.tenant_id, 'zenex');
    assert.ok(!zenexEntry.error, 'zenex is a real, accessible schema and must not report an error');
    assert.strictEqual(typeof zenexEntry.document_count, 'number');
    assert.strictEqual(typeof zenexEntry.evaluation_count, 'number');
    assert.strictEqual(typeof zenexEntry.programme_count, 'number');

    assert.strictEqual(ghostEntry.tenant_id, ghostSlug);
    assert.ok(ghostEntry.error, 'a tenant with no provisioned schema must fail soft with an error field');
    assert.strictEqual(ghostEntry.document_count, undefined, 'a failed tenant entry must carry no borrowed/blended figures from another tenant');
    assert.strictEqual(ghostEntry.corpus_health, undefined);
  },

  "isolation: the Advisor's cross-tenant prompt never runs the single-tenant memory-context path and labels every tenant explicitly": async () => {
    const allTenantsData = [
      {
        tenant_id: 'zenex', tenant_name: 'Zenex Foundation', corpus_health: 'healthy',
        document_count: 42, evaluation_count: 12, programme_count: 5, completeness: 80,
        evidence_quality: 3.8, last_ingestion: '2026-01-01T00:00:00.000Z', pipeline_status: 'clear',
        intelligence_signals: 3, relevant_alerts: 0,
      },
      { tenant_id: 'optima', tenant_name: 'Optima', error: 'Tenant corpus not accessible' },
    ];

    const prompt = await buildPrompt(
      'Which tenant needs attention this week?',
      SPECIALIST_OK,
      { tenantScope: { mode: 'all' }, allTenantsData },
    );

    assert.ok(prompt.includes('CROSS-TENANT INTELLIGENCE SUMMARY'), 'expected the cross-tenant summary block header');
    assert.ok(prompt.includes('Zenex Foundation (zenex)'), 'expected zenex to be named explicitly with its own figures');
    assert.ok(prompt.includes('Optima (optima): UNAVAILABLE'), 'expected the inaccessible tenant to be named as unavailable, not silently dropped or merged');
    assert.ok(prompt.includes('documents=42'), "expected zenex's own document count to appear unmodified");
    assert.ok(!prompt.includes('MEMORY CONTEXT (flag-gated)'), 'the single-tenant memory-context path must never run in cross-tenant mode');
    assert.ok(/never combine.*blend|otherwise blend/i.test(prompt), 'expected an explicit instruction never to blend tenant figures');
  },

  "isolation: a tenantScope with mode 'tenant' (not 'all') never triggers the cross-tenant branch, even when present": async () => {
    const prompt = await buildPrompt(
      'What should we prioritise?',
      SPECIALIST_OK,
      { tenantScope: { mode: 'tenant', tenant_id: 'zenex' }, tenantId: 'zenex' },
    );
    assert.ok(!prompt.includes('CROSS-TENANT INTELLIGENCE SUMMARY'));
    assert.ok(!prompt.includes('CROSS-TENANT MODE'));
  },
};
