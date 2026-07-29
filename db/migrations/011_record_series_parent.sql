-- EvidenceOS migration 011
-- Parent record and record series support for linked evaluation records

ALTER TABLE zenex.intelligence_records
  ADD COLUMN IF NOT EXISTS
    parent_record_id VARCHAR(50) REFERENCES
    zenex.intelligence_records(id)
    ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS
    record_series VARCHAR(50)
    CHECK (record_series IN (
      'BASELINE','MIDLINE','ENDLINE',
      'FOLLOW_UP','STANDALONE'
    ));
