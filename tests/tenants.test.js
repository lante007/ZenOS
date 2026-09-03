'use strict';

// tests/tenants.test.js — C1: getFeatureFlag(tenantId, flagName).
//
// These tests exercise the FALLBACK_TENANTS path only (no DATABASE_URL
// required), since getTenantBySlug() falls back to the static config
// whenever getPool() returns null. That keeps this test runnable on a
// laptop with no database configured.

const assert = require('assert');
const { getFeatureFlag, FALLBACK_TENANTS } = require('../api/services/tenants');

module.exports = {
  'known flag OFF returns false': async () => {
    assert.strictEqual(FALLBACK_TENANTS.zenex.feature_flags.MEMORY_CONTEXT_ENABLED, false);
    const value = await getFeatureFlag('zenex', 'MEMORY_CONTEXT_ENABLED');
    assert.strictEqual(value, false);
  },

  'known flag ON returns true': async () => {
    const value = await getFeatureFlag('zenex', 'sroi_module');
    assert.strictEqual(value, true);
  },

  'unknown flag name returns false': async () => {
    const value = await getFeatureFlag('zenex', 'THIS_FLAG_DOES_NOT_EXIST');
    assert.strictEqual(value, false);
  },

  'unknown tenant returns false': async () => {
    const value = await getFeatureFlag('no-such-tenant', 'MEMORY_CONTEXT_ENABLED');
    assert.strictEqual(value, false);
  },

  'optima also defaults MEMORY_CONTEXT_ENABLED to false': async () => {
    assert.strictEqual(FALLBACK_TENANTS.optima.feature_flags.MEMORY_CONTEXT_ENABLED, false);
    const value = await getFeatureFlag('optima', 'MEMORY_CONTEXT_ENABLED');
    assert.strictEqual(value, false);
  },
};
