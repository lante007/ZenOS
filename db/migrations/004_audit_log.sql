CREATE TABLE IF NOT EXISTS zenex.audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type  VARCHAR(80) NOT NULL,
  user_id     TEXT,
  tenant_id   VARCHAR(50) NOT NULL DEFAULT 'zenex',
  detail      JSONB DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_event
  ON zenex.audit_log(event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_tenant
  ON zenex.audit_log(tenant_id, created_at DESC);
