-- EQS v2.0 methodology support
-- Adds pathway tracking and version table

CREATE TABLE IF NOT EXISTS 
  zenex.methodology_versions (
  id UUID PRIMARY KEY 
    DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(50),
  version_label VARCHAR(20) NOT NULL,
  ratified_by UUID,
  ratified_at TIMESTAMPTZ,
  effective_from TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add pathway and version tracking 
-- to intelligence_records
ALTER TABLE zenex.intelligence_records
  ADD COLUMN IF NOT EXISTS 
    eqs_pathway VARCHAR(30)
    CHECK (eqs_pathway IN (
      'IMPACT_CAUSAL',
      'IMPACT_DESCRIPTIVE', 
      'PROCESS_IMPLEMENTATION',
      'FORMATIVE_BASELINE',
      'NOT_APPLICABLE'
    )),
  ADD COLUMN IF NOT EXISTS
    eqs_version VARCHAR(10) 
    DEFAULT 'v1.0',
  ADD COLUMN IF NOT EXISTS
    pathway_multiplier NUMERIC(4,2);

-- Insert EQS v1.0 as baseline version
INSERT INTO zenex.methodology_versions (
  tenant_id, version_label, notes,
  effective_from
) VALUES (
  'zenex', 'v1.0',
  'Original universal rubric. Rigour 35%, ' ||
  'Data Quality 20%, Transparency 15%, ' ||
  'Replicability 15%, Context Relevance 15%. ' ||
  'Research Studies excluded from scoring.',
  '2026-01-01T00:00:00Z'
) ON CONFLICT DO NOTHING;
