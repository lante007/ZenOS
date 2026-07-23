-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
-- EvidenceOS Master Schema
-- Creates the platform-level tenants table
-- Run once against the evidenceos database
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CREATE SCHEMA IF NOT EXISTS master;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS master.tenants (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                VARCHAR(50) UNIQUE NOT NULL,
  name                VARCHAR(200) NOT NULL,
  subdomain           VARCHAR(100) UNIQUE NOT NULL,
  logo_s3_key         TEXT,
  primary_colour      VARCHAR(7) DEFAULT '#00B4D8',
  secondary_colour    VARCHAR(7) DEFAULT '#0A1628',
  s3_vault_bucket     VARCHAR(100),
  s3_web_bucket       VARCHAR(100),
  cognito_pool_id     VARCHAR(100),
  cognito_client_id   VARCHAR(100),
  db_schema           VARCHAR(50),
  sqs_queue_url       TEXT,
  tier                VARCHAR(20) DEFAULT 'STARTER'
                      CHECK (tier IN ('STARTER','PROFESSIONAL','ENTERPRISE','FEDERATED')),
  feature_flags       JSONB DEFAULT '{}',
  max_documents       INTEGER DEFAULT 50,
  max_users           INTEGER DEFAULT 5,
  ceo_email           VARCHAR(200),
  is_active           BOOLEAN DEFAULT true,
  trial_ends_at       TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Insert Zenex Foundation as first tenant
INSERT INTO master.tenants (
  slug, name, subdomain,
  primary_colour, secondary_colour,
  s3_vault_bucket, s3_web_bucket,
  db_schema, tier, max_documents, max_users,
  ceo_email,
  feature_flags
) VALUES (
  'zenex',
  'Zenex Foundation',
  'zenex.auxeira.com',
  '#EF7218', '#311F47',
  'auxeira-evidenceos-zenex',
  'auxeira-web-zenex',
  'zenex',
  'PROFESSIONAL', 200, 10,
  'sibongile@zenex.org.za',
  '{"federated_network": false, "sroi_module": true, "synthesis": true, "portfolio_optimizer": true}'
) ON CONFLICT (slug) DO NOTHING;

-- Insert Optima as second tenant
INSERT INTO master.tenants (
  slug, name, subdomain,
  primary_colour, secondary_colour,
  s3_vault_bucket, s3_web_bucket,
  db_schema, tier, max_documents, max_users,
  feature_flags
) VALUES (
  'optima',
  'Optima',
  'optima.auxeira.com',
  '#00B4D8', '#0A1628',
  'auxeira-evidenceos-optima',
  'auxeira-web-optima',
  'optima',
  'PROFESSIONAL', 200, 10,
  '{"federated_network": false, "sroi_module": true, "synthesis": true, "portfolio_optimizer": true}'
) ON CONFLICT (slug) DO NOTHING;

SELECT 'Master schema created.' AS status;
SELECT slug, name, subdomain, tier FROM master.tenants;
