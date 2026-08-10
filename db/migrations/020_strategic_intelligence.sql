-- Strategic intelligence (external, web-search-derived) opportunities per programme.
-- Run after 019_tor_documents.sql

CREATE TABLE IF NOT EXISTS zenex.strategic_intelligence (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        VARCHAR(50) DEFAULT 'zenex',
  programme_name   TEXT NOT NULL,
  opportunities    JSONB NOT NULL,
  model_used       VARCHAR(50),
  generated_by     UUID,
  generated_at     TIMESTAMPTZ DEFAULT NOW(),
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_strategic_intelligence_tenant_programme
  ON zenex.strategic_intelligence (tenant_id, programme_name, generated_at DESC);

CREATE TABLE IF NOT EXISTS zenex.strategic_intelligence_dismissals (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   VARCHAR(50) DEFAULT 'zenex',
  strategic_intelligence_id   UUID REFERENCES zenex.strategic_intelligence(id) ON DELETE CASCADE,
  opportunity_type            VARCHAR(30) NOT NULL,
  opportunity_title           TEXT,
  dismissed_by                UUID,
  dismissed_at                TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_si_dismissals_si_id
  ON zenex.strategic_intelligence_dismissals (strategic_intelligence_id);
