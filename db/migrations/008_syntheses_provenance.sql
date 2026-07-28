-- EvidenceOS migration 008
-- Syntheses and Provenance tables
-- Run after 007_knowledge_products_generated_at.sql

CREATE TABLE IF NOT EXISTS zenex.syntheses (
  id UUID PRIMARY KEY 
    DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(50) DEFAULT 'zenex',
  title TEXT,
  record_ids TEXT[] NOT NULL,
  record_count INTEGER,
  findings JSONB,
  evidence_gaps JSONB,
  leverage_points JSONB,
  cross_patterns JSONB,
  generated_by UUID,
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  confirmed_by UUID,
  confirmed_at TIMESTAMPTZ,
  status VARCHAR(20) DEFAULT 'DRAFT'
    CHECK (status IN (
      'DRAFT','CONFIRMED','ARCHIVED'
    )),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS 
  zenex.provenance_records (
  id UUID PRIMARY KEY 
    DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(50) DEFAULT 'zenex',
  synthesis_id UUID REFERENCES 
    zenex.syntheses(id) ON DELETE SET NULL,
  source_record_ids TEXT[],
  audience VARCHAR(50),
  brief_content TEXT,
  generated_at TIMESTAMPTZ,
  generated_by UUID,
  model_used VARCHAR(50),
  word_count INTEGER,
  download_log JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
