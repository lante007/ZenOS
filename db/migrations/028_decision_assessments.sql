-- db/migrations/028_decision_assessments.sql
--
-- AUXEIRA V1.3 Decision Intelligence -- Phase 4: Assessment persistence.
--
-- Revised prior to first application (never applied in any environment --
-- see the Phase 4 design report) to align exactly with the frozen
-- Decision Assessment specialist/Advisor contract (evidence-analyst.js,
-- strategic-analyst.js, advisor.js) and the approved Phase 4 lifecycle,
-- rather than the earlier placeholder shape written before that contract
-- was finalised. In particular, relative to the prior draft of this same
-- (still unapplied) file:
--   - assessment_status is renamed to status, and its vocabulary changed
--     from pending/running/completed/failed to
--     pending/assessing/assessed/failed, matching the approved Phase 4
--     4-state lifecycle exactly. This is this table's OWN CHECK,
--     independent of decision_events.status -- migration 027's status
--     vocabulary is unchanged by this file (Phase 4 hard invariant #12).
--   - the flattened Advisor-shaped columns (situation, what_we_know,
--     exposure, options, recommended_action, evidence_still_needed) are
--     replaced by three JSONB envelope columns (evidence_output,
--     strategic_output, advisor_output) that store each frozen agent's
--     full result envelope verbatim -- {agent, status, execution_ms,
--     model, usage, decision_event_id, output, error} -- so this table
--     never re-encodes a shape owned by those modules and can absorb a
--     future field they add without another migration.
--   - confidence (singular) is replaced by three columns
--     (evidence_confidence, strategic_confidence, overall_confidence) so
--     each specialist's own confidence is independently queryable, not
--     just the Advisor's final synthesised value.
--   - partial_context_reason (TEXT, singular) is replaced by
--     partial_context_reasons (JSONB array), matching
--     context.js#buildDecisionAssessmentContext's actual
--     partialContextReasons return field (plural, an array of strings),
--     not a single reason string.
--   - failure_reason (TEXT) is added: populated only when status='failed'
--     (fail-closed specialist error, validation error, timeout, or stale
--     recovery), left NULL otherwise. A failed row is never deleted or
--     overwritten again after this write -- see Phase 4 design,
--     "failure is immutable history".
--   - trigger_mode ('manual'|'auto') and requested_by are added so every
--     row records how, and (for manual) by whom, it was created -- the
--     Phase 4 observability requirement.
--   - started_at / completed_at are added, mirroring
--     public.intelligence_jobs' own started_at/completed_at columns
--     exactly, used for the same stale-recovery-on-read purpose (see
--     decision-assessment/orchestrator.js).
--   - updated_at is added, for parity with decision_events.updated_at.
--   - priority is UNCHANGED here: still a nullable placeholder, still
--     never written by any Phase 4 code. Reserved for a future Phase 5
--     Prioritisation layer only (Phase 4 design, "no priority").
--
-- One row per assessment ATTEMPT. A decision_event can accumulate
-- multiple assessment rows over time (reassessment); assessment_version
-- distinguishes them and decision_events.assessment_id always points at
-- the latest attempt, including a failed one (Phase 4 design addendum).
-- This table has no UPDATE path in the application layer once a row
-- reaches assessed/failed -- only the pending -> assessing ->
-- {assessed|failed} transitions of that SAME row are ever written
-- (Phase 4 hard invariant #11: historical rows are never modified or
-- deleted).

CREATE TABLE IF NOT EXISTS public.decision_assessments (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_event_id       UUID NOT NULL REFERENCES public.decision_events(id),
  tenant_id               VARCHAR(50) NOT NULL DEFAULT 'zenex',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at              TIMESTAMPTZ,
  completed_at            TIMESTAMPTZ,

  assessment_version      INTEGER NOT NULL DEFAULT 1,
  status                  VARCHAR(10) NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','assessing','assessed','failed')),

  -- How this attempt was created and, for a manual trigger, by whom.
  -- requested_by is NULL for trigger_mode='auto'.
  trigger_mode            VARCHAR(10) NOT NULL DEFAULT 'manual'
                            CHECK (trigger_mode IN ('manual','auto')),
  requested_by            VARCHAR(255),

  -- Full result envelopes from the frozen specialist/Advisor pipeline,
  -- stored verbatim -- {agent, status, execution_ms, model, usage,
  -- decision_event_id, output, error}. NULL until that stage has run;
  -- advisor_output stays NULL forever if either specialist failed
  -- (fail-closed -- the Advisor never runs in that case).
  evidence_output         JSONB,
  strategic_output        JSONB,
  advisor_output          JSONB,

  evidence_confidence     VARCHAR(10) CHECK (evidence_confidence IN ('HIGH','MODERATE','LOW','UNKNOWN')),
  strategic_confidence    VARCHAR(10) CHECK (strategic_confidence IN ('HIGH','MODERATE','LOW','UNKNOWN')),
  overall_confidence      VARCHAR(10) CHECK (overall_confidence IN ('HIGH','MODERATE','LOW','UNKNOWN')),

  -- Set deterministically by context.js (never by a model) whenever any
  -- hydration source failed gracefully rather than being unavailable by
  -- design. Plural/array, matching context.js's own
  -- partialContextReasons[] field exactly (see file header above).
  partial_context         BOOLEAN NOT NULL DEFAULT FALSE,
  partial_context_reasons JSONB NOT NULL DEFAULT '[]',

  -- Populated only when status='failed'. Never set or cleared any other
  -- way (see file header, "failure is immutable history").
  failure_reason          TEXT,

  -- Mirrors decision_events.priority's own CHECK exactly. Nullable
  -- placeholder: no Phase 4 code path writes this column. Reserved for a
  -- future Phase 5 Prioritisation layer only.
  priority                VARCHAR(10) CHECK (priority IN ('HIGH','MODERATE','LOW')),

  UNIQUE (decision_event_id, assessment_version)
);

CREATE INDEX IF NOT EXISTS idx_decision_assessments_tenant_event
  ON public.decision_assessments (tenant_id, decision_event_id);
CREATE INDEX IF NOT EXISTS idx_decision_assessments_event_status
  ON public.decision_assessments (decision_event_id, status);
CREATE INDEX IF NOT EXISTS idx_decision_assessments_partial_context
  ON public.decision_assessments (tenant_id, partial_context) WHERE partial_context;
CREATE INDEX IF NOT EXISTS idx_decision_assessments_created_at
  ON public.decision_assessments (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_decision_assessments_status_started
  ON public.decision_assessments (status, started_at) WHERE status IN ('pending','assessing');
