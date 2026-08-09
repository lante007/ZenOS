-- EvidenceOS migration 017
-- Evidence Intelligence Workspace: Optimy pre-fill support.
-- optimy_project_id links a record to a grant record in Optimy.
-- optimy_field_values holds whatever field:value pairs Optimy has supplied
-- for that project, keyed by intelligence_records column name, so the
-- Corpus Health workspace can offer them as suggested pre-fills for missing
-- fields without fabricating values for records Optimy has no data for.

ALTER TABLE zenex.intelligence_records
  ADD COLUMN IF NOT EXISTS optimy_project_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS optimy_field_values JSONB DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_intelligence_records_optimy_project
  ON zenex.intelligence_records(optimy_project_id)
  WHERE optimy_project_id IS NOT NULL;
