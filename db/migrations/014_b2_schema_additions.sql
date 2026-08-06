-- EvidenceOS migration 014
-- Phase B2: add 11 new columns identified as genuinely missing during the
-- B2 pre-flight schema comparison, plus convert effect_size_composite from
-- NUMERIC to TEXT so it can hold descriptive values (e.g. "0.3 SD improvement")
-- as required by the Phase B4 two-pass classifier spec.

ALTER TABLE zenex.intelligence_records
  ADD COLUMN IF NOT EXISTS secondary_document_type VARCHAR(100),
  ADD COLUMN IF NOT EXISTS baseline_year INTEGER,
  ADD COLUMN IF NOT EXISTS endline_year INTEGER,
  ADD COLUMN IF NOT EXISTS validation_flags JSONB DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS extraction_pass INTEGER DEFAULT 1,
  ADD COLUMN IF NOT EXISTS canonical_programme_name VARCHAR(300),
  ADD COLUMN IF NOT EXISTS programme_family_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS manually_confirmed BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS manually_confirmed_by VARCHAR(200),
  ADD COLUMN IF NOT EXISTS manually_confirmed_at TIMESTAMPTZ;

ALTER TABLE zenex.intelligence_records
  ALTER COLUMN effect_size_composite TYPE TEXT
  USING effect_size_composite::TEXT;
