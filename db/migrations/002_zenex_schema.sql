-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
-- EvidenceOS Zenex Tenant Schema
-- ADEI Taxonomy v2.1 — all 55 fields
-- Run after 001_master_schema.sql
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CREATE SCHEMA IF NOT EXISTS zenex;

-- ── DOCUMENTS ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS zenex.documents (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           VARCHAR(50) DEFAULT 'zenex',
  s3_key              TEXT NOT NULL,
  filename            TEXT NOT NULL,
  mime_type           VARCHAR(100),
  file_size_bytes     BIGINT,
  file_hash           VARCHAR(64) UNIQUE,
  upload_source       VARCHAR(20) DEFAULT 'UPLOAD'
                      CHECK (upload_source IN ('S3','UPLOAD','DRIVE')),
  rights_status       VARCHAR(20) DEFAULT 'CLEAR'
                      CHECK (rights_status IN ('CLEAR','RESTRICTED','CONFIDENTIAL','DO_NOT_CITE')),
  extraction_quality  VARCHAR(20)
                      CHECK (extraction_quality IN ('GOOD','ADEQUATE','LOW','FAILED')),
  ingestion_status    VARCHAR(20) DEFAULT 'PENDING'
                      CHECK (ingestion_status IN ('PENDING','PROCESSING','COMPLETE','FAILED','SOFT_DELETED')),
  ingested_by         UUID,
  ingested_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ── INTELLIGENCE RECORDS (55-field ADEI Taxonomy v2.1) ─
CREATE TABLE IF NOT EXISTS zenex.intelligence_records (
  id                          VARCHAR(50) PRIMARY KEY,
  tenant_id                   VARCHAR(50) DEFAULT 'zenex',
  document_id                 UUID REFERENCES zenex.documents(id),

  -- L1: Administrative (9 fields)
  document_type               VARCHAR(50),
  evaluation_subtype          VARCHAR(100),
  programme_name              VARCHAR(200),
  phase                       VARCHAR(100),
  year                        VARCHAR(4),
  fiscal_year                 VARCHAR(10),
  funder_names                TEXT[],
  co_funder_documented        BOOLEAN,
  rights_status               VARCHAR(20),

  -- L2: Evidence (25 fields)
  provinces                   TEXT[],
  sample_size_learners        INTEGER,
  sample_size_schools         INTEGER,
  has_control_group           BOOLEAN,
  methodology_description     TEXT,
  key_finding_1               TEXT,
  key_finding_2               TEXT,
  key_finding_3               TEXT,
  null_findings_reported      BOOLEAN,
  cost_data_present           VARCHAR(20)
                              CHECK (cost_data_present IN ('AUDITED','PROXY','ABSENT')),
  theory_of_change_explicit   BOOLEAN,
  external_evaluator          BOOLEAN,
  fidelity_reported           BOOLEAN,
  dosage_documented           BOOLEAN,
  publication_status          VARCHAR(30),
  policy_relevance_score      INTEGER CHECK (policy_relevance_score BETWEEN 1 AND 5),
  strategic_value_score       INTEGER CHECK (strategic_value_score BETWEEN 1 AND 5),
  nls_alignment               BOOLEAN,
  funrs_alignment             BOOLEAN,
  dbe_adoption_status         VARCHAR(20)
                              CHECK (dbe_adoption_status IN ('ADOPTED','PILOTED','REFERENCED','NONE','UNKNOWN')),
  audience_relevance          TEXT[],
  evidence_gap_1              TEXT,
  evidence_gap_2              TEXT,
  commissioning_standards_met INTEGER CHECK (commissioning_standards_met BETWEEN 0 AND 9),

  -- L3: Intelligence (21 fields)
  eqs_composite               NUMERIC(4,2),
  eqs_tier                    VARCHAR(20)
                              CHECK (eqs_tier IN ('TIER_1','TIER_2','TIER_3','EXCLUDED','N_A')),
  dim_methodological_rigour   NUMERIC(4,2),
  dim_data_quality            NUMERIC(4,2),
  dim_transparency            NUMERIC(4,2),
  dim_replicability           NUMERIC(4,2),
  dim_context_relevance       NUMERIC(4,2),
  half_life_rating            VARCHAR(20)
                              CHECK (half_life_rating IN ('CURRENT','AGING','HISTORICAL','UNKNOWN')),
  evidence_capital_score      NUMERIC(6,3),
  policy_relevance_weight     NUMERIC(4,2),
  decision_capital_tier       VARCHAR(10),
  decision_capital_description TEXT,
  decision_capital_reach      TEXT,
  assumption_challenged       BOOLEAN DEFAULT false,
  finding_type                VARCHAR(50),
  evidence_contradiction_flag BOOLEAN DEFAULT false,
  per_finding_confidence_flag BOOLEAN DEFAULT false,
  decision_context_note       TEXT,
  commissioning_guidance_flag BOOLEAN DEFAULT false,
  sroi_eligible               BOOLEAN DEFAULT false,
  board_citable               BOOLEAN DEFAULT false,

  -- Metadata
  classified_by               VARCHAR(50),
  classification_confidence   JSONB,
  taxonomy_version            VARCHAR(10) DEFAULT 'v2.1',
  scoring_logic_version       VARCHAR(10) DEFAULT 'v0.2',
  fatima_reviewed_at          TIMESTAMPTZ,
  fatima_reviewed_by          UUID,
  record_status               VARCHAR(20) DEFAULT 'ACTIVE'
                              CHECK (record_status IN ('ACTIVE','SUPERSEDED','PENDING_REVIEW')),
  created_at                  TIMESTAMPTZ DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ DEFAULT NOW()
);

-- ── QUEUE ITEMS ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS zenex.queue_items (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             VARCHAR(50) DEFAULT 'zenex',
  record_id             VARCHAR(50) REFERENCES zenex.intelligence_records(id),
  document_id           UUID REFERENCES zenex.documents(id),
  field_name            VARCHAR(100) NOT NULL,
  claude_value          TEXT,
  claude_confidence     NUMERIC(4,3),
  bedrock_value         TEXT,
  bedrock_confidence    NUMERIC(4,3),
  system_recommendation TEXT,
  question              TEXT,
  alternatives          TEXT[],
  reviewer_id           UUID,
  resolved_value        TEXT,
  is_override           BOOLEAN DEFAULT false,
  resolved_at           TIMESTAMPTZ,
  resolution_tier       INTEGER DEFAULT 3,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

-- ── KNOWLEDGE PRODUCTS ────────────────────────────────
CREATE TABLE IF NOT EXISTS zenex.knowledge_products (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       VARCHAR(50) DEFAULT 'zenex',
  record_id       VARCHAR(50) REFERENCES zenex.intelligence_records(id),
  audience        VARCHAR(50)
                  CHECK (audience IN ('TRUSTEE','CEO','DBE_NATIONAL','PROVINCIAL_HOD','CO_FUNDER','SECTOR_PEER')),
  content         TEXT,
  word_count      INTEGER,
  model_used      VARCHAR(50),
  generated_by    UUID,
  approved_by     UUID,
  approved_at     TIMESTAMPTZ,
  published_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── DECISION CAPITAL ──────────────────────────────────
CREATE TABLE IF NOT EXISTS zenex.decision_capital_instances (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             VARCHAR(50) DEFAULT 'zenex',
  record_id             VARCHAR(50) REFERENCES zenex.intelligence_records(id),
  tier                  VARCHAR(10) CHECK (tier IN ('TIER_1','TIER_2','TIER_3')),
  description           TEXT,
  decision_maker        VARCHAR(200),
  organisation          VARCHAR(200),
  financial_value_rand  BIGINT,
  learners_affected     INTEGER,
  reach_description     TEXT,
  documented_evidence   TEXT,
  confirmed_by          UUID,
  confirmed_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

-- ── USERS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS zenex.users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       VARCHAR(50) DEFAULT 'zenex',
  cognito_sub     VARCHAR(200) UNIQUE,
  email           VARCHAR(200) NOT NULL,
  full_name       VARCHAR(200),
  role            VARCHAR(30) DEFAULT 'EVIDENCE_ANALYST'
                  CHECK (role IN (
                    'ORGANISATION_LEAD',
                    'EVIDENCE_ANALYST',
                    'COMMUNICATIONS',
                    'CEO_EXEC'
                  )),
  last_login_at   TIMESTAMPTZ,
  is_active       BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── INGESTION JOBS ────────────────────────────────────
CREATE TABLE IF NOT EXISTS zenex.ingestion_jobs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             VARCHAR(50) DEFAULT 'zenex',
  document_id           UUID REFERENCES zenex.documents(id),
  batch_id              VARCHAR(100),
  status                VARCHAR(20) DEFAULT 'QUEUED'
                        CHECK (status IN ('QUEUED','PROCESSING','COMPLETE','FAILED')),
  pipeline_step         INTEGER,
  step_detail           TEXT,
  claude_input_tokens   INTEGER,
  claude_output_tokens  INTEGER,
  claude_latency_ms     INTEGER,
  error_message         TEXT,
  started_at            TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

-- ── INDEXES ───────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_records_tier
  ON zenex.intelligence_records(eqs_tier);
CREATE INDEX IF NOT EXISTS idx_records_programme
  ON zenex.intelligence_records(programme_name);
CREATE INDEX IF NOT EXISTS idx_records_phase
  ON zenex.intelligence_records(phase);
CREATE INDEX IF NOT EXISTS idx_records_status
  ON zenex.intelligence_records(record_status);
CREATE INDEX IF NOT EXISTS idx_queue_resolved
  ON zenex.queue_items(resolved_at);
CREATE INDEX IF NOT EXISTS idx_jobs_status
  ON zenex.ingestion_jobs(status);

SELECT 'Zenex schema created.' AS status;
SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'zenex'
  ORDER BY table_name;
