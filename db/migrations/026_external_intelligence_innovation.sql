-- db/migrations/026_external_intelligence_innovation.sql
-- Grok-powered External Intelligence Scout + Innovation Scout, gated behind
-- Claude QA review (api/intelligence/qa-gate.js). Executed idempotently by
-- api/intelligence/scouts/schema.js, the same lazy-ensure pattern as
-- migration 024 (api/memory/schema.js).
--
-- Every row is tenant-scoped (tenant_id NOT NULL); there is no global/shared
-- row in either table. qa_status has no PENDING state at the database level:
-- a row can only be inserted with a terminal QA status, because the store
-- layer (api/intelligence/scouts/store.js) only ever inserts post-QA.
--
-- qa_status, qa_notes and provenance_chain are immutable after insertion
-- (enforced by the enforce_qa_immutability trigger below). A correction is a
-- new row referencing the original via original_item_id; the original is
-- then updated (the only mutation the trigger allows) to set superseded_by.

CREATE TABLE IF NOT EXISTS external_intelligence (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  category            TEXT NOT NULL,
  claim               TEXT NOT NULL,
  source_url          TEXT NOT NULL,
  claim_type          TEXT NOT NULL DEFAULT 'signal' CHECK (claim_type = 'signal'),
  qa_status           TEXT NOT NULL CHECK (qa_status IN ('VERIFIED','QUALIFIED','NEEDS_REVIEW','REJECTED')),
  qa_notes            TEXT,
  provenance_chain    JSONB NOT NULL,
  query_context       TEXT,
  original_item_id    BIGINT REFERENCES external_intelligence(id),
  superseded_by       BIGINT REFERENCES external_intelligence(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  qa_completed_at     TIMESTAMPTZ,
  CONSTRAINT ei_provenance_min_stages CHECK (jsonb_array_length(provenance_chain) >= 3)
);

CREATE INDEX IF NOT EXISTS idx_ei_tenant_status ON external_intelligence (tenant_id, qa_status);
CREATE INDEX IF NOT EXISTS idx_ei_tenant_created ON external_intelligence (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ei_tenant_category ON external_intelligence (tenant_id, category);

CREATE TABLE IF NOT EXISTS innovation_candidates (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  idea                TEXT NOT NULL,
  rationale           TEXT NOT NULL,
  context_summary     TEXT NOT NULL,
  speculative         BOOLEAN NOT NULL DEFAULT TRUE CHECK (speculative = TRUE),
  claim_type          TEXT NOT NULL DEFAULT 'signal' CHECK (claim_type = 'signal'),
  qa_status           TEXT NOT NULL CHECK (qa_status IN ('SPECULATIVE','NEEDS_REVIEW','REJECTED')),
  qa_notes            TEXT,
  decision_status     TEXT NOT NULL DEFAULT 'unreviewed' CHECK (decision_status IN ('unreviewed','exploring','accepted','rejected','deferred')),
  decision_notes      TEXT,
  decision_by         TEXT,
  decision_at         TIMESTAMPTZ,
  provenance_chain    JSONB NOT NULL,
  context_hash        TEXT NOT NULL,
  original_item_id    BIGINT REFERENCES innovation_candidates(id),
  superseded_by       BIGINT REFERENCES innovation_candidates(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  qa_completed_at     TIMESTAMPTZ,
  CONSTRAINT ic_provenance_min_stages CHECK (jsonb_array_length(provenance_chain) >= 3)
);

CREATE INDEX IF NOT EXISTS idx_ic_tenant_status ON innovation_candidates (tenant_id, qa_status);
CREATE INDEX IF NOT EXISTS idx_ic_tenant_decision ON innovation_candidates (tenant_id, decision_status);
CREATE INDEX IF NOT EXISTS idx_ic_tenant_created ON innovation_candidates (tenant_id, created_at DESC);

-- QA fields are the gate's permanent, one-time verdict: qa_status, qa_notes
-- and provenance_chain may never be edited after insertion, on either
-- table. superseded_by (both tables) and decision_status/decision_notes/
-- decision_by/decision_at (innovation_candidates only) are explicitly NOT
-- checked here and remain freely updatable.
CREATE OR REPLACE FUNCTION enforce_qa_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.qa_status IS DISTINCT FROM OLD.qa_status
     OR NEW.qa_notes IS DISTINCT FROM OLD.qa_notes
     OR NEW.provenance_chain IS DISTINCT FROM OLD.provenance_chain THEN
    RAISE EXCEPTION 'QA fields are immutable after insertion. Record a new item rather than modifying an existing one.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ei_qa_immutable ON external_intelligence;
CREATE TRIGGER ei_qa_immutable
  BEFORE UPDATE ON external_intelligence
  FOR EACH ROW EXECUTE FUNCTION enforce_qa_immutability();

DROP TRIGGER IF EXISTS ic_qa_immutable ON innovation_candidates;
CREATE TRIGGER ic_qa_immutable
  BEFORE UPDATE ON innovation_candidates
  FOR EACH ROW EXECUTE FUNCTION enforce_qa_immutability();
