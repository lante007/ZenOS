-- EvidenceOS learning flywheel alerts.

CREATE TABLE IF NOT EXISTS zenex.alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(50) DEFAULT 'zenex',
  alert_type VARCHAR(50) NOT NULL
    CHECK (alert_type IN (
      'AUDIENCE_GAP',
      'CURRENCY_ALERT',
      'COMMISSIONING_GAP',
      'QUEUE_BACKLOG',
      'BOARD_PROXIMITY',
      'ENDLINE_GAP',
      'POLICY_WINDOW'
    )),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  record_id VARCHAR(50) REFERENCES zenex.intelligence_records(id) ON DELETE SET NULL,
  target_role VARCHAR(30) NOT NULL,
  priority VARCHAR(10) DEFAULT 'MEDIUM'
    CHECK (priority IN ('HIGH','MEDIUM','LOW')),
  is_read BOOLEAN DEFAULT false,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alerts_unread_role
  ON zenex.alerts(tenant_id, target_role, is_read, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_alerts_record_type
  ON zenex.alerts(tenant_id, record_id, alert_type, created_at DESC);
