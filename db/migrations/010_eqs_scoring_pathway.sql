-- EQS v2.0 simple scoring pathway support
-- Adds the ratified three-pathway label used for Library and detail display.

ALTER TABLE zenex.intelligence_records
ADD COLUMN IF NOT EXISTS
  eqs_scoring_pathway VARCHAR(20)
  CHECK (eqs_scoring_pathway IN (
    'IMPACT','PROCESS','RESEARCH'
  ));
