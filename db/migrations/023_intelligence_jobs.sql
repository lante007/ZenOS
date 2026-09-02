-- Intelligence Console asynchronous job log.
-- Also created lazily at runtime by api/intelligence/jobs.js, so applying this
-- migration is optional for function; it exists so the schema is tracked.

CREATE TABLE IF NOT EXISTS public.intelligence_jobs (
  id                UUID PRIMARY KEY,
  question          TEXT,
  user_email        TEXT,
  user_role         TEXT,
  status            TEXT,               -- queued | running | completed | failed
  degraded          BOOLEAN DEFAULT false,
  agents            JSONB,              -- per-agent status, timing, tools, tokens
  telemetry         JSONB,              -- orchestration telemetry
  answer            TEXT,               -- rendered advisor markdown
  answer_structured JSONB,              -- structured synthesis
  error             TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  completed_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS intelligence_jobs_created_at_idx
  ON public.intelligence_jobs (created_at DESC);
