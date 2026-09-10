-- db/migrations/029_priority_records.sql
--
-- Phase 5: Decision Prioritisation. Adds public.priority_records, an
-- append-only table of Priority Records, one per completed Decision
-- Assessment. Priority is deliberately NOT a mutable attribute of
-- decision_events or decision_assessments -- both tables already carry a
-- nullable `priority` placeholder column (migrations 027 and 028
-- respectively), reserved in their own comments for "a future Phase 5
-- layer", but neither is written by this migration or by any Phase 5
-- code. Both remain permanently NULL/unused by design (Phase 5 design
-- decision, confirmed): a real derived-record model was chosen instead
-- of retrofitting those two placeholder columns, so this migration adds
-- a new table rather than altering 027 or 028.
--
-- One row per computed priority. A decision_event's CURRENT priority is
-- always the row where superseded_at IS NULL (enforced by the partial
-- unique index below, not just by application logic). When a new
-- assessment completes and a new Priority Record is computed, the prior
-- active record (if any) is superseded -- superseded_at/superseded_by
-- set -- never updated in place otherwise, and never deleted. All other
-- fields on a Priority Record are immutable from the moment of INSERT.

CREATE TABLE IF NOT EXISTS public.priority_records (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             VARCHAR(50) NOT NULL,

  decision_event_id     UUID NOT NULL REFERENCES public.decision_events(id),
  assessment_id         UUID NOT NULL REFERENCES public.decision_assessments(id),
  assessment_version    INTEGER NOT NULL,

  priority              VARCHAR(20) NOT NULL
                          CHECK (priority IN ('IMMEDIATE', 'HIGH', 'MODERATE', 'LOW')),
  priority_score        NUMERIC(5,2),
  priority_reason       TEXT NOT NULL,
  contributing_factors  JSONB NOT NULL DEFAULT '{}',
  rule_version          VARCHAR(20) NOT NULL DEFAULT 'v1.0',

  assigned_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The only two fields ever mutated after INSERT, and only once, when a
  -- newer Priority Record is created for the same decision_event_id (see
  -- api/intelligence/decision-prioritisation/orchestrator.js).
  superseded_at         TIMESTAMPTZ,
  superseded_by         UUID REFERENCES public.priority_records(id)
);

CREATE INDEX IF NOT EXISTS idx_priority_records_tenant_event
  ON public.priority_records (tenant_id, decision_event_id);

-- Enforces "at most one active (non-superseded) Priority Record per
-- decision_event_id" at the database level, not just in application
-- logic -- the same row-lock-plus-constraint belt-and-braces pattern
-- already used elsewhere in this schema. This is also what makes "the
-- current active priority for this event" a single indexed-equality
-- lookup (WHERE decision_event_id = $1 AND superseded_at IS NULL).
CREATE UNIQUE INDEX IF NOT EXISTS uq_priority_records_active_per_event
  ON public.priority_records (decision_event_id) WHERE superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_priority_records_assessment
  ON public.priority_records (assessment_id);
CREATE INDEX IF NOT EXISTS idx_priority_records_assigned_at
  ON public.priority_records (assigned_at DESC);
