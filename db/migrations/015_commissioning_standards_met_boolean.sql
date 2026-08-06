-- EvidenceOS migration 015
-- The Phase B4 Pass 2 classifier schema asks Claude for a boolean
-- commissioning_standards_met ("true | false | null"), conflicting with
-- the existing INTEGER (0..9 count) column of the same name.
--
-- A straight ALTER COLUMN ... TYPE BOOLEAN with a 1/0 CASE mapping would
-- destroy the existing data: 70 of 77 records have real 0-9 count values
-- (currently ranging 3-8), none are exactly 0 or 1, so every populated
-- value would become NULL. Instead: preserve the historical count under
-- a new name, and add a fresh boolean column for the two-pass classifier
-- to write into going forward.

ALTER TABLE zenex.intelligence_records
  RENAME COLUMN commissioning_standards_met TO commissioning_standards_count;

ALTER TABLE zenex.intelligence_records
  ADD COLUMN IF NOT EXISTS commissioning_standards_met BOOLEAN;
