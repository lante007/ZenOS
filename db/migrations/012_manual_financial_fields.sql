-- EvidenceOS migration 012
-- Manual financial data fields for classified records

ALTER TABLE zenex.intelligence_records
  ADD COLUMN IF NOT EXISTS total_cost_rand BIGINT,
  ADD COLUMN IF NOT EXISTS cost_per_learner NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS financial_year VARCHAR(10),
  ADD COLUMN IF NOT EXISTS cost_notes TEXT;
