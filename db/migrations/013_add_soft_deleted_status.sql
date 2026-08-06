-- EvidenceOS migration 013
-- Add SOFT_DELETED as a valid record_status.
-- Prior to this migration the CHECK constraint only permitted
-- ACTIVE, SUPERSEDED, PENDING_REVIEW; every record_status != 'SOFT_DELETED'
-- filter elsewhere in the codebase was a silent no-op because the value
-- could never exist. This migration makes the quarantine workflow
-- (Phase B1) legal against the schema.

ALTER TABLE zenex.intelligence_records
  DROP CONSTRAINT intelligence_records_record_status_check;

ALTER TABLE zenex.intelligence_records
  ADD CONSTRAINT intelligence_records_record_status_check
  CHECK (record_status = ANY (ARRAY[
    'ACTIVE',
    'SUPERSEDED',
    'PENDING_REVIEW',
    'SOFT_DELETED'
  ]::character varying[]));
