-- EvidenceOS migration 016
-- Add SUB_REPORT to the record_series CHECK constraint (migration 011).
-- The B7 parent-child linking proposal script introduced a SUB_REPORT
-- category for component/sub-report documents (distinct from baseline/
-- midline/endline/follow_up/standalone), but the constraint was never
-- extended - discovered when the B7 linking UPDATE for the MLIP family
-- failed partway through on the first SUB_REPORT-tagged record.

ALTER TABLE zenex.intelligence_records
  DROP CONSTRAINT IF EXISTS intelligence_records_record_series_check;

ALTER TABLE zenex.intelligence_records
  ADD CONSTRAINT intelligence_records_record_series_check
  CHECK (record_series IN (
    'BASELINE',
    'MIDLINE',
    'ENDLINE',
    'FOLLOW_UP',
    'STANDALONE',
    'SUB_REPORT'
  ));
