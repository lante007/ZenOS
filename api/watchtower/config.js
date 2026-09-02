'use strict';

// api/watchtower/config.js — operational configuration for the Observation
// Worker. Environment-overridable; conservative defaults.

const n = (v, d) => {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? x : d;
};

module.exports = {
  // Worker is present but idle when disabled: pm2 keeps it up, it does nothing.
  enabled: process.env.WATCHTOWER_ENABLED !== 'false',
  pollIntervalMs: n(process.env.WATCHTOWER_POLL_INTERVAL_MS, 300000), // 5 min
  fetchTimeoutMs: n(process.env.WATCHTOWER_FETCH_TIMEOUT_MS, 15000),
  maxResponseBytes: n(process.env.WATCHTOWER_MAX_BYTES, 5 * 1024 * 1024), // 5 MB
  maxSourcesPerTick: n(process.env.WATCHTOWER_MAX_SOURCES_PER_TICK, 10),
  fetchRetries: n(process.env.WATCHTOWER_FETCH_RETRIES, 1),
  retryBackoffMs: n(process.env.WATCHTOWER_RETRY_BACKOFF_MS, 2000),
  respectRobots: process.env.WATCHTOWER_RESPECT_ROBOTS !== 'false',
  userAgent: process.env.WATCHTOWER_USER_AGENT || 'AuxeiraWatchtower/0.1 (+https://auxeira.com; observation worker)',
  shutdownGraceMs: n(process.env.WATCHTOWER_SHUTDOWN_GRACE_MS, 30000),
  s3Bucket: process.env.WATCHTOWER_S3_BUCKET || process.env.AWS_S3_BUCKET || 'auxeira-evidenceos-zenex',
  s3Prefix: 'watchtower/',
  normalisedExcerptChars: 500,
  snapshotStoreChars: n(process.env.WATCHTOWER_SNAPSHOT_MAX_CHARS, 2 * 1024 * 1024),
};
