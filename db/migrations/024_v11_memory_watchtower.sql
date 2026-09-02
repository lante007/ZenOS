-- Auxeira V1.1 foundations: persistent memory, decisions, outcomes, the
-- Watchtower source/observation/signal model, a generic link table (graph
-- foundation) and an entity table.
--
-- Also created lazily at runtime by api/memory/schema.js, so applying this
-- migration is optional for function; it exists so the schema is tracked.
--
-- Isolation model: global observation MATERIAL (wt_sources with NULL
-- tenant_id, wt_observations, wt_signals) is stored once and shared. Every
-- tenant-specific row (memories, decisions, intelligence_outcomes,
-- memory_links, tenant_signal_relevance, tenant entities) carries a NOT NULL
-- tenant_id and every query must filter on it.

-- ── MEMORIES ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.memories (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          TEXT NOT NULL,
  memory_type        TEXT NOT NULL,            -- DECISION | CONTEXT | RELATIONSHIP | FACT | LESSON | SIGNAL_INTERPRETATION | PRODUCT_MEMORY
  title              TEXT NOT NULL,
  content            TEXT,
  structured_payload JSONB,
  source_type        TEXT,                     -- manual | intelligence_job | observation | decision | feedback | import
  source_id          TEXT,
  evidence_type      TEXT DEFAULT 'none'       -- extracted_finding | metadata | aggregate | external | observation | none
                     CHECK (evidence_type IN ('extracted_finding','metadata','aggregate','external','observation','none')),
  confidence         TEXT DEFAULT 'MODERATE'
                     CHECK (confidence IN ('HIGH','MODERATE','LOW','UNKNOWN')),
  status             TEXT NOT NULL DEFAULT 'ACTIVE'
                     CHECK (status IN ('ACTIVE','DORMANT','HISTORICAL','REACTIVATED')),
  relevance_score    NUMERIC,
  observed_at        TIMESTAMPTZ,
  last_accessed_at   TIMESTAMPTZ,
  reactivated_at     TIMESTAMPTZ,
  expires_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  search_tsv         TSVECTOR GENERATED ALWAYS AS (
                       to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,''))
                     ) STORED
);
CREATE INDEX IF NOT EXISTS memories_tenant_status_idx ON public.memories (tenant_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS memories_tenant_type_idx   ON public.memories (tenant_id, memory_type);
CREATE INDEX IF NOT EXISTS memories_search_idx        ON public.memories USING GIN (search_tsv);

-- ── DECISIONS ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.decisions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          TEXT NOT NULL,
  decision           TEXT NOT NULL,
  rationale          TEXT,
  evidence_used      JSONB,
  alternatives       JSONB,
  owner              TEXT,
  decision_date      DATE,
  confidence         TEXT DEFAULT 'MODERATE'
                     CHECK (confidence IN ('HIGH','MODERATE','LOW','UNKNOWN')),
  expected_outcome   TEXT,
  review_date        DATE,
  revisit_conditions JSONB DEFAULT '[]',       -- [{ description, keywords:[], entities:[] }]
  status             TEXT NOT NULL DEFAULT 'ACTIVE'
                     CHECK (status IN ('ACTIVE','DORMANT','REVIEW_RECOMMENDED','SUPERSEDED','CLOSED')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  search_tsv         TSVECTOR GENERATED ALWAYS AS (
                       to_tsvector('english', coalesce(decision,'') || ' ' || coalesce(rationale,'') || ' ' || coalesce(expected_outcome,''))
                     ) STORED
);
CREATE INDEX IF NOT EXISTS decisions_tenant_status_idx ON public.decisions (tenant_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS decisions_search_idx        ON public.decisions USING GIN (search_tsv);

-- ── INTELLIGENCE OUTCOMES (feedback loop) ─────────────
CREATE TABLE IF NOT EXISTS public.intelligence_outcomes (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             TEXT NOT NULL,
  job_id                UUID,                  -- -> public.intelligence_jobs.id
  decision_id           UUID,                  -- -> public.decisions.id (optional)
  recommendation_summary TEXT,
  decision_taken        TEXT,
  outcome_status        TEXT NOT NULL
                        CHECK (outcome_status IN ('acted_on','dismissed','pending','succeeded','failed','partial')),
  outcome_description   TEXT,
  signal_proved_reliable BOOLEAN,
  recorded_by           TEXT,
  recorded_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes                 TEXT
);
CREATE INDEX IF NOT EXISTS outcomes_tenant_idx ON public.intelligence_outcomes (tenant_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS outcomes_job_idx    ON public.intelligence_outcomes (job_id);

-- ── ENTITIES (graph nodes) ────────────────────────────
CREATE TABLE IF NOT EXISTS public.entities (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT,                          -- NULL = globally known entity
  entity_type   TEXT NOT NULL,                 -- organisation | person | funder | programme | policy | evidence | evaluation | decision | signal | risk | opportunity | research_question | tenant
  name          TEXT NOT NULL,
  canonical_key TEXT,
  attributes    JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS entities_scope_key_idx ON public.entities (COALESCE(tenant_id,'*'), entity_type, COALESCE(canonical_key, lower(name)));

-- ── MEMORY LINKS (generic relationships / graph edges) ─
CREATE TABLE IF NOT EXISTS public.memory_links (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  TEXT NOT NULL,
  from_type  TEXT NOT NULL,                    -- memory | decision | signal | entity | outcome | job
  from_id    UUID NOT NULL,
  to_type    TEXT NOT NULL,
  to_id      UUID NOT NULL,
  relation   TEXT NOT NULL,                    -- SIGNAL_MAY_AFFECT_DECISION | MEMORY_SUPPORTS_DECISION | SIGNAL_MENTIONS_ENTITY | DECISION_ABOUT_ENTITY | MEMORY_DERIVED_FROM_SIGNAL | OUTCOME_OF_JOB ...
  weight     NUMERIC DEFAULT 1.0,
  evidence   JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS memory_links_tenant_from_idx ON public.memory_links (tenant_id, from_type, from_id);
CREATE INDEX IF NOT EXISTS memory_links_tenant_to_idx   ON public.memory_links (tenant_id, to_type, to_id);
CREATE UNIQUE INDEX IF NOT EXISTS memory_links_unique_idx ON public.memory_links (tenant_id, from_type, from_id, to_type, to_id, relation);

-- ── WATCHTOWER: SOURCES ───────────────────────────────
CREATE TABLE IF NOT EXISTS public.wt_sources (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT,                        -- NULL = global source, reusable across tenants
  name            TEXT NOT NULL,
  source_type     TEXT NOT NULL,               -- government | policy | research | organisation | funder | news | social | dataset | rss | api | custom
  url             TEXT NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  crawl_frequency TEXT NOT NULL DEFAULT 'weekly', -- hourly | daily | weekly | monthly
  credibility     TEXT DEFAULT 'MODERATE'
                  CHECK (credibility IN ('HIGH','MODERATE','LOW')),
  config          JSONB DEFAULT '{}',          -- fetch/normalise hints: selector, rss:true, api headers ref, etc.
  last_crawled_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS wt_sources_scope_url_idx ON public.wt_sources (COALESCE(tenant_id,'*'), url);
CREATE INDEX IF NOT EXISTS wt_sources_due_idx ON public.wt_sources (enabled, last_crawled_at);

-- ── WATCHTOWER: OBSERVATIONS (one row per fetch) ──────
CREATE TABLE IF NOT EXISTS public.wt_observations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id             UUID NOT NULL REFERENCES public.wt_sources(id) ON DELETE CASCADE,
  observed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at          TIMESTAMPTZ,
  http_status           INTEGER,
  content_fingerprint   TEXT,                  -- sha256 of normalised content
  content_bytes         INTEGER,
  s3_bucket             TEXT,                  -- immutable snapshot location
  s3_key                TEXT,
  normalised_excerpt    TEXT,                  -- first N chars of normalised text, for quick display
  changed               BOOLEAN NOT NULL DEFAULT false,
  previous_observation_id UUID,
  error                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS wt_observations_source_idx ON public.wt_observations (source_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS wt_observations_fp_idx     ON public.wt_observations (source_id, content_fingerprint);

-- ── WATCHTOWER: SIGNALS (a detected change) ───────────
CREATE TABLE IF NOT EXISTS public.wt_signals (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id          UUID NOT NULL REFERENCES public.wt_sources(id) ON DELETE CASCADE,
  observation_id     UUID REFERENCES public.wt_observations(id) ON DELETE SET NULL,
  observed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at       TIMESTAMPTZ,
  title              TEXT,
  summary            TEXT,
  signal_type        TEXT,                     -- policy_change | funding_change | publication | market_move | org_change | dataset_update | other
  change_description TEXT,
  novelty            TEXT DEFAULT 'NEW'
                     CHECK (novelty IN ('NEW','CHANGED','RECURRING')),
  relevance          TEXT,                     -- global first-pass hint; per-tenant relevance lives in tenant_signal_relevance
  confidence         TEXT DEFAULT 'MODERATE'   -- SIGNAL confidence, deliberately distinct from evidence confidence
                     CHECK (confidence IN ('HIGH','MODERATE','LOW','UNKNOWN')),
  entities           JSONB DEFAULT '[]',
  content_fingerprint TEXT,
  raw                JSONB,
  status             TEXT NOT NULL DEFAULT 'NEW'
                     CHECK (status IN ('NEW','TRIAGED','LINKED','DISMISSED')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS wt_signals_dedup_idx ON public.wt_signals (source_id, content_fingerprint);
CREATE INDEX IF NOT EXISTS wt_signals_recent_idx ON public.wt_signals (created_at DESC);

-- ── TENANT SIGNAL RELEVANCE (per-tenant interpretation) ─
CREATE TABLE IF NOT EXISTS public.tenant_signal_relevance (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         TEXT NOT NULL,
  signal_id         UUID NOT NULL REFERENCES public.wt_signals(id) ON DELETE CASCADE,
  relevance_score   NUMERIC,
  interpretation    TEXT,
  linked_decision_ids UUID[] DEFAULT '{}',
  linked_memory_ids   UUID[] DEFAULT '{}',
  status            TEXT NOT NULL DEFAULT 'NEW'
                    CHECK (status IN ('NEW','REVIEWED','ACTIONED','DISMISSED')),
  reviewed_by       TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS tsr_unique_idx ON public.tenant_signal_relevance (tenant_id, signal_id);
