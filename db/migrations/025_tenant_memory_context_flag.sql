-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
-- Increment 3, C1/C2: MEMORY_CONTEXT_ENABLED tenant feature flag
--
-- Backfills the flag onto existing master.tenants rows so the database is
-- consistent with api/services/tenants.js's FALLBACK_TENANTS config. Purely
-- additive and idempotent (only touches rows that don't already have the
-- key); defaults to false, so this is not a behaviour change on its own —
-- api/services/tenants.js#getFeatureFlag already defaults an absent key to
-- false. Safe to run more than once.
--
-- No automated migration runner exists in this repo (see setup.sh); this
-- was applied manually, the same way migrations 001-023 were.
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

UPDATE master.tenants
SET feature_flags = feature_flags || '{"MEMORY_CONTEXT_ENABLED": false}'::jsonb
WHERE slug IN ('zenex', 'optima')
  AND NOT (feature_flags ? 'MEMORY_CONTEXT_ENABLED');

SELECT slug, feature_flags FROM master.tenants ORDER BY slug;
