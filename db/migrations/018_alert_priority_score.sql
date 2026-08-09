-- EvidenceOS migration 018
-- Learning Flywheel priority scoring: weighted priority_score (0-100) drives
-- CRITICAL/IMPORTANT/INFORMATIONAL tiering and top-N ordering on the dashboard.
-- dismissed_at backs the 90-day same-record/same-category suppression rule.

ALTER TABLE zenex.alerts
  ADD COLUMN IF NOT EXISTS priority_score NUMERIC,
  ADD COLUMN IF NOT EXISTS dismissed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_alerts_priority_score
  ON zenex.alerts(tenant_id, target_role, is_read, priority_score DESC);

CREATE INDEX IF NOT EXISTS idx_alerts_suppression
  ON zenex.alerts(tenant_id, record_id, alert_type, dismissed_at);
