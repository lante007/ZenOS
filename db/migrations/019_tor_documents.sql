-- Terms of Reference documents generated for evaluation commissioning gaps.
-- Run after 018_alert_priority_score.sql

CREATE TABLE IF NOT EXISTS zenex.tor_documents (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              VARCHAR(50) DEFAULT 'zenex',
  programme_name         TEXT NOT NULL,
  tor_text               TEXT NOT NULL,
  total_investment       NUMERIC,
  evaluation_count       INTEGER,
  gap_type               VARCHAR(50),
  years_without_endline  INTEGER,
  status                 VARCHAR(20) DEFAULT 'DRAFT'
                         CHECK (status IN ('DRAFT', 'PENDING_REVIEW', 'APPROVED')),
  s3_key                 TEXT,
  generated_by           UUID,
  generated_at           TIMESTAMPTZ DEFAULT NOW(),
  reviewed_at            TIMESTAMPTZ,
  created_at             TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tor_documents_tenant_status
  ON zenex.tor_documents (tenant_id, status);
