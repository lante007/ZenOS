'use strict';

// tests/helpers/env.js — small shared helpers so individual test files stay
// readable. Tests that need PostgreSQL or AWS (S3) skip themselves cleanly
// when the environment does not provide them, rather than failing the suite
// in a laptop/CI environment that has neither configured.

function hasDatabase() {
  return Boolean(process.env.DATABASE_URL);
}

function hasAws() {
  // The AWS SDK v3 resolves credentials from many places (env vars, shared
  // config file, EC2/ECS instance role). We cannot cheaply verify a real
  // credential chain here, so this is a best-effort environment check; S3
  // tests must still handle a real credentials error by skipping.
  return Boolean(
    process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || process.env.AWS_EXECUTION_ENV
    || process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE
  );
}

module.exports = { hasDatabase, hasAws };
