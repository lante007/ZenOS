-- EvidenceOS migration 022
-- Usage/audit log for Ask Zenex, TOR Generator and CEO Brief - records who
-- queried what, when, and how the response measured up, for admin
-- surveillance (Usage Surveillance admin page).

CREATE TABLE IF NOT EXISTS zenex.query_log (
  id SERIAL PRIMARY KEY,
  tenant_id VARCHAR(50),
  user_email VARCHAR(200),
  user_role VARCHAR(50),
  feature VARCHAR(50),
  query_text TEXT,
  response_length INTEGER,
  records_cited INTEGER,
  response_time_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_query_log_tenant ON zenex.query_log(tenant_id);
CREATE INDEX IF NOT EXISTS idx_query_log_created ON zenex.query_log(created_at);
