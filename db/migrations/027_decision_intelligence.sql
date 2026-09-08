-- db/migrations/027_decision_intelligence.sql -- corrected: public schema,
-- not zenex, to match the tenancy pattern used by every other table this
-- feature reads (public.decisions, public.wt_signals, external_intelligence,
-- public.intelligence_outcomes), all of which are public + tenant_id, not
-- schema-per-tenant.

DROP TABLE IF EXISTS zenex.decision_events;

CREATE TABLE IF NOT EXISTS public.decision_events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             VARCHAR(50) NOT NULL DEFAULT 'zenex',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  trigger_pathway       VARCHAR(50) NOT NULL CHECK (trigger_pathway IN (
                          'SIGNAL_TOUCHES_EXPOSURE',
                          'DECISION_DEADLINE_APPROACHING',
                          'OUTCOME_DIVERGES_FROM_EXPECTATION',
                          'SIGNAL_CONVERGENCE',
                          'OPPORTUNITY_WINDOW_CLOSING',
                          'REVERSIBLE_BECOMING_IRREVERSIBLE'
                        )),
  trigger_explanation   TEXT NOT NULL,
  trigger_data          JSONB NOT NULL DEFAULT '{}',
  fingerprint           TEXT NOT NULL,

  status                VARCHAR(20) NOT NULL DEFAULT 'new'
                          CHECK (status IN ('new','under_assessment','assessed','dismissed','acted_on')),
  priority              VARCHAR(10) CHECK (priority IN ('HIGH','MODERATE','LOW')),

  inputs                JSONB NOT NULL DEFAULT '{}',
  assessment_id         UUID,

  dismissed_by          VARCHAR(255),
  dismissed_at          TIMESTAMPTZ,
  dismissed_reason      TEXT,

  UNIQUE (tenant_id, trigger_pathway, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_decision_events_tenant_status
  ON public.decision_events (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_decision_events_tenant_priority
  ON public.decision_events (tenant_id, priority) WHERE priority IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_decision_events_created_at
  ON public.decision_events (created_at DESC);
