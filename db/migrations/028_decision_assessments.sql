-- db/migrations/028_decision_assessments.sql
--
-- AUXEIRA V1.3 Decision Intelligence -- Phase 3: Assessment output.
--
-- One row per assessment RUN, never overwritten (Contract 5). A
-- decision_event can accumulate multiple assessment rows over time
-- (reassessment); assessment_version distinguishes them and
-- decision_events.assessment_id always points at the current one. This
-- table has no UPDATE path in the application layer for any of the
-- analytical fields -- only INSERT. assessment_status exists to describe
-- the outcome of a run (pending/running/completed/failed), matching the
-- existing intelligence job status vocabulary used elsewhere in this
-- codebase, not to make a row mutable after the fact.
--
-- partial_context / partial_context_reason are dedicated, queryable
-- columns (not buried in provenance jsonb) so "assessed on incomplete
-- context" is an observable, filterable metric across tenants and
-- pathways -- e.g. the known Optima gap (Pathway 1 Half B:
-- optima.intelligence_records does not exist) -- never a silent success.

CREATE TABLE IF NOT EXISTS public.decision_assessments (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_event_id       UUID NOT NULL REFERENCES public.decision_events(id),
  tenant_id               VARCHAR(50) NOT NULL DEFAULT 'zenex',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  situation               TEXT NOT NULL,
  what_we_know            JSONB NOT NULL DEFAULT '[]',
  what_we_dont_know       JSONB NOT NULL DEFAULT '[]',
  exposure                TEXT,
  exposure_basis          TEXT,
  confidence              VARCHAR(10) CHECK (confidence IN (
                            'HIGH','MODERATE','LOW','UNKNOWN'
                          )),
  cost_of_waiting         TEXT,

  -- Each element: { option, benefit, risk, cost_of_waiting, reversibility,
  -- evidence_required, assessment } -- shape enforced at the application
  -- layer (Advisor's forced tool schema), not by a jsonb CHECK here.
  options                 JSONB NOT NULL DEFAULT '[]',

  recommended_action      TEXT,
  evidence_still_needed   JSONB NOT NULL DEFAULT '[]',

  -- Per-claim provenance (source type, record/document id, claim_type),
  -- same discipline as the existing Advisor sources[] shape.
  provenance              JSONB NOT NULL DEFAULT '{}',

  -- Mirrors decision_events.priority's own CHECK exactly. This is the
  -- value copied onto decision_events.priority by the orchestrator after
  -- a successful run -- never set independently of that copy.
  priority                VARCHAR(10) CHECK (priority IN (
                            'HIGH','MODERATE','LOW'
                          )),

  assessment_version      INTEGER NOT NULL DEFAULT 1,
  assessment_status       VARCHAR(10) NOT NULL DEFAULT 'pending'
                            CHECK (assessment_status IN (
                              'pending','running','completed','failed'
                            )),

  -- Set deterministically by the context-assembly step (never by the
  -- model) whenever any hydration source failed gracefully rather than
  -- being unavailable by design.
  partial_context         BOOLEAN NOT NULL DEFAULT FALSE,
  partial_context_reason  TEXT,

  -- Model/token/timing trace for this run (per-agent status, ms, usage),
  -- same audit intent as Prophet/Advisor's existing usage tracking.
  model_trace             JSONB NOT NULL DEFAULT '{}',

  UNIQUE (decision_event_id, assessment_version)
);

CREATE INDEX IF NOT EXISTS idx_decision_assessments_tenant_event
  ON public.decision_assessments (tenant_id, decision_event_id);
CREATE INDEX IF NOT EXISTS idx_decision_assessments_event_status
  ON public.decision_assessments (decision_event_id, assessment_status);
CREATE INDEX IF NOT EXISTS idx_decision_assessments_partial_context
  ON public.decision_assessments (tenant_id, partial_context) WHERE partial_context;
CREATE INDEX IF NOT EXISTS idx_decision_assessments_created_at
  ON public.decision_assessments (created_at DESC);
