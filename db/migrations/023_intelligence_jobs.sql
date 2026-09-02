-- Intelligence Console asynchronous job store (authoritative).
-- Also created / migrated lazily at runtime by api/intelligence/jobs.js, so
-- applying this migration is optional for function; it exists so the schema
-- is tracked in version control.

CREATE TABLE IF NOT EXISTS public.intelligence_jobs (
  id                UUID PRIMARY KEY,
  status            TEXT,                -- queued | running | completed | failed
  question          TEXT,
  user_email        TEXT,
  user_role         TEXT,
  agents            JSONB,               -- per-agent status, timing, rounds, tools, tokens
  agent_results     JSONB,               -- full structured output per agent
  model_calls       INTEGER,
  telemetry         JSONB,               -- orchestration telemetry
  degraded          BOOLEAN DEFAULT false,
  error             TEXT,
  answer            TEXT,                -- rendered advisor markdown
  answer_structured JSONB,               -- structured synthesis
  live_data         JSONB,              -- corpus snapshot used for the run
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ
);

-- Idempotent upgrades for a table created by an earlier build.
ALTER TABLE public.intelligence_jobs ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE public.intelligence_jobs ADD COLUMN IF NOT EXISTS agent_results JSONB;
ALTER TABLE public.intelligence_jobs ADD COLUMN IF NOT EXISTS model_calls INTEGER;
ALTER TABLE public.intelligence_jobs ADD COLUMN IF NOT EXISTS live_data JSONB;

CREATE INDEX IF NOT EXISTS intelligence_jobs_created_at_idx
  ON public.intelligence_jobs (created_at DESC);
