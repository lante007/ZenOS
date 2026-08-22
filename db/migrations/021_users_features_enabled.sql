-- EvidenceOS migration 021
-- Per-user feature flags for progressive zone access, independent of role.
-- Empty object ({}) or a missing key falls back to existing role-based
-- NAV_VISIBILITY checks; this column only ever narrows access further.

ALTER TABLE zenex.users
  ADD COLUMN IF NOT EXISTS features_enabled JSONB NOT NULL DEFAULT '{}';

COMMENT ON COLUMN zenex.users.features_enabled IS
  'Per-user feature flags for progressive access control. Keys map to platform zones. Empty object falls back to role-based access.';
