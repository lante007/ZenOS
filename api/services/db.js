'use strict';

const { Pool } = require('pg');

let pool;

function shouldUseSsl(connectionString) {
  if (process.env.PGSSLMODE === 'disable') return false;
  if (process.env.PGSSLMODE === 'require' || process.env.DATABASE_SSL === 'true') return true;
  return /\.rds\.amazonaws\.com(?::|\/|$)/.test(connectionString || '');
}

function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    pool = new Pool({
      connectionString,
      ssl: shouldUseSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
      connectionTimeoutMillis: Number(process.env.PG_CONNECTION_TIMEOUT_MS || 5000),
      query_timeout: Number(process.env.PG_QUERY_TIMEOUT_MS || 10000),
    });
  }
  return pool;
}

function assertSchema(schema) {
  if (!/^[a-z][a-z0-9_]*$/.test(schema || '')) {
    throw new Error(`Unsafe tenant schema: ${schema}`);
  }
}

function schemaFor(tenant) {
  const schema = tenant.db_schema || tenant.slug;
  assertSchema(schema);
  return schema;
}

async function withTenant(tenant, fn) {
  const db = getPool();
  if (!db) return null;
  const client = await db.connect();
  const schema = schemaFor(tenant);

  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO ${schema}, public`);
    const result = await fn(client, schema);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function listRecords(tenant, filters = {}) {
  return withTenant(tenant, async client => {
    const where = ['r.tenant_id = $1', "r.record_status = 'ACTIVE'"];
    const params = [tenant.slug];

    if (filters.tier && filters.tier !== 'all') {
      params.push(filters.tier);
      where.push(`r.eqs_tier = $${params.length}`);
    }
    if (filters.type && filters.type !== 'all') {
      params.push(filters.type);
      where.push(`r.document_type = $${params.length}`);
    }
    if (filters.phase && filters.phase !== 'all') {
      params.push(filters.phase);
      where.push(`r.phase = $${params.length}`);
    }
    if (filters.q) {
      params.push(`%${filters.q}%`);
      where.push(`(d.filename ILIKE $${params.length} OR r.programme_name ILIKE $${params.length} OR r.document_type ILIKE $${params.length})`);
    }

    const res = await client.query(`
      SELECT r.*, d.filename, d.s3_key,
        d.mime_type, d.file_size_bytes,
        d.rights_status AS doc_rights_status
      FROM intelligence_records r
      LEFT JOIN documents d ON d.id = r.document_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.classified_at DESC NULLS LAST
      LIMIT 500
    `, params);
    return res.rows;
  });
}

async function getRecord(tenant, id) {
  return withTenant(tenant, async client => {
    const res = await client.query(`
      SELECT r.*, d.filename, d.s3_key,
        d.mime_type, d.file_size_bytes,
        d.rights_status AS doc_rights_status
      FROM intelligence_records r
      LEFT JOIN documents d ON d.id = r.document_id
      WHERE r.tenant_id = $1
        AND r.record_status = 'ACTIVE'
        AND r.id = $2
      LIMIT 1
    `, [tenant.slug, id]);
    return res.rows[0] || null;
  });
}

async function insertIngestionJob(tenant, documentId, usage, status = 'COMPLETE') {
  return withTenant(tenant, async client => {
    await client.query(`
      INSERT INTO ingestion_jobs (
        tenant_id, document_id, status, pipeline_step, step_detail,
        claude_input_tokens, claude_output_tokens, claude_input_words,
        claude_output_words, claude_latency_ms,
        started_at, completed_at
      ) VALUES ($1,$2,$3,8,'Classification completed',$4,$5,$6,$7,$8,NOW(),NOW())
    `, [
      tenant.slug,
      documentId || null,
      status,
      usage?.input_tokens || null,
      usage?.output_tokens || null,
      usage?.input_words || null,
      usage?.output_words || null,
      usage?.latency_ms || null,
    ]);
  });
}

async function createRecord(tenant, record, document = {}) {
  return withTenant(tenant, async client => {
    let documentId = document.id || null;

    if (!documentId && document.s3_key) {
      const docRes = await client.query(`
        INSERT INTO documents (
          tenant_id, s3_key, filename, mime_type, file_size_bytes, file_hash,
          upload_source, rights_status, extraction_quality, ingestion_status, ingested_at
        ) VALUES ($1,$2,$3,$4,$5,$6,'S3',$7,$8,'COMPLETE',NOW())
        ON CONFLICT (file_hash) DO UPDATE
          SET ingestion_status = 'COMPLETE', ingested_at = NOW()
        RETURNING id
      `, [
        tenant.slug,
        document.s3_key,
        document.filename,
        document.mime_type,
        document.file_size_bytes || null,
        document.file_hash || null,
        record.rights_status || 'CLEAR',
        record.extraction_quality || 'GOOD',
      ]);
      documentId = docRes.rows[0]?.id || null;
    }

    const dims = record.dimensions || {};
    await client.query(`
      INSERT INTO intelligence_records (
        id, tenant_id, document_id, document_type, evaluation_subtype, programme_name,
        phase, year, provinces, sample_size_learners, sample_size_schools,
        has_control_group, methodology_description, key_finding_1, key_finding_2,
        key_finding_3, null_findings_reported, cost_data_present,
        theory_of_change_explicit, external_evaluator, fidelity_reported,
        dosage_documented, publication_status, policy_relevance_score,
        strategic_value_score, nls_alignment, funrs_alignment, dbe_adoption_status,
        audience_relevance, evidence_gap_1, evidence_gap_2,
        commissioning_standards_met, eqs_composite, eqs_tier,
        dim_methodological_rigour, dim_data_quality, dim_transparency,
        dim_replicability, dim_context_relevance, half_life_rating,
        evidence_capital_score, policy_relevance_weight, sroi_eligible,
        board_citable, classified_by, classification_confidence,
        taxonomy_version, scoring_logic_version, record_status
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
        $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,
        $38,$39,$40,$41,$42,$43,$44,$45,$46,$47,$48,$49
      )
      ON CONFLICT (id) DO UPDATE SET updated_at = NOW()
    `, [
      record.id,
      tenant.slug,
      documentId,
      record.document_type,
      record.evaluation_subtype,
      record.programme_name,
      record.phase,
      record.year,
      record.provinces || [],
      record.sample_size_learners || null,
      record.sample_size_schools || null,
      record.has_control_group,
      record.methodology_description,
      record.key_finding_1,
      record.key_finding_2,
      record.key_finding_3,
      record.null_findings_reported,
      record.cost_data_present || 'ABSENT',
      record.theory_of_change_explicit,
      record.external_evaluator,
      record.fidelity_reported,
      record.dosage_documented,
      record.publication_status,
      record.policy_relevance_score || null,
      record.strategic_value_score || null,
      record.nls_alignment,
      record.funrs_alignment,
      record.dbe_adoption_status || 'UNKNOWN',
      record.audience_relevance || [],
      record.evidence_gap_1,
      record.evidence_gap_2,
      record.commissioning_standards_met || null,
      record.eqs_composite,
      record.confidence_tier || record.eqs_tier || 'N_A',
      dims.methodological_rigour || null,
      dims.data_quality || null,
      dims.transparency || null,
      dims.replicability || null,
      dims.context_relevance || null,
      record.half_life_rating,
      record.evidence_capital_score,
      record.policy_relevance_weight || null,
      record.sroi_eligible || false,
      record.board_citable || false,
      'CLAUDE_SONNET',
      record.classification_confidence || record.confidence_scores || {},
      record.taxonomy_version || 'v2.1',
      record.scoring_logic_version || 'v0.2',
      record.status === 'PENDING_REVIEW' ? 'PENDING_REVIEW' : 'ACTIVE',
    ]);

    await client.query(`
      INSERT INTO ingestion_jobs (
        tenant_id, document_id, status, pipeline_step, step_detail,
        claude_input_tokens, claude_output_tokens, claude_input_words,
        claude_output_words, claude_latency_ms,
        started_at, completed_at
      ) VALUES ($1,$2,'COMPLETE',8,'Classification completed',$3,$4,$5,$6,$7,NOW(),NOW())
    `, [
      tenant.slug,
      documentId || null,
      record.api_usage?.input_tokens || null,
      record.api_usage?.output_tokens || null,
      record.api_usage?.input_words || null,
      record.api_usage?.output_words || null,
      record.api_usage?.latency_ms || null,
    ]);

    for (const item of record.fatima_queue || []) {
      await client.query(`
        INSERT INTO queue_items (
          tenant_id, record_id, document_id, field_name, claude_value,
          claude_confidence, system_recommendation, question
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `, [
        tenant.slug,
        record.id,
        documentId,
        item.field,
        item.claudeValue == null ? null : String(item.claudeValue),
        item.claudeConf || null,
        item.systemRecommendation == null ? null : String(item.systemRecommendation),
        `Please confirm or override ${item.field}.`,
      ]);
    }

    return record;
  });
}

async function listQueue(tenant) {
  return withTenant(tenant, async client => {
    const res = await client.query(`
      SELECT q.*, r.programme_name, d.filename AS document
      FROM queue_items q
      LEFT JOIN intelligence_records r ON r.id = q.record_id
      LEFT JOIN documents d ON d.id = q.document_id
      WHERE q.tenant_id = $1 AND q.resolved_at IS NULL
      ORDER BY q.created_at DESC
      LIMIT 100
    `, [tenant.slug]);
    return res.rows;
  });
}

async function resolveQueueItem(tenant, id, value, reviewerId, isOverride) {
  return withTenant(tenant, async client => {
    const res = await client.query(`
      UPDATE queue_items
      SET resolved_value = $1, reviewer_id = $2, is_override = $3, resolved_at = NOW()
      WHERE tenant_id = $4 AND id = $5
      RETURNING *
    `, [value, reviewerId || null, isOverride === true, tenant.slug, id]);
    return res.rows[0] || null;
  });
}

async function createKnowledgeProduct(tenant, payload) {
  return withTenant(tenant, async client => {
    const res = await client.query(`
      INSERT INTO knowledge_products (
        tenant_id, record_id, audience, content, word_count, model_used, generated_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *
    `, [
      tenant.slug,
      payload.record_id,
      payload.audience,
      payload.content,
      payload.word_count,
      payload.model_used || 'claude-sonnet-4-6',
      payload.generated_by || null,
    ]);
    return res.rows[0];
  });
}

async function listUsers(tenant) {
  return withTenant(tenant, async client => {
    const res = await client.query(`
      SELECT id, email, full_name, role, last_login_at, is_active
      FROM users
      WHERE tenant_id = $1
      ORDER BY full_name NULLS LAST, email
    `, [tenant.slug]);
    return res.rows;
  });
}

async function createUser(tenant, user) {
  return withTenant(tenant, async client => {
    const existing = await client.query(`
      SELECT id
      FROM users
      WHERE tenant_id = $1 AND lower(email) = lower($2)
      LIMIT 1
    `, [tenant.slug, user.email]);

    if (existing.rows[0]) {
      const res = await client.query(`
        UPDATE users
        SET full_name = $1, role = $2, cognito_sub = COALESCE($3, cognito_sub), is_active = true
        WHERE id = $4 AND tenant_id = $5
        RETURNING id, email, full_name, role, last_login_at, is_active
      `, [
        user.full_name,
        user.role,
        user.cognito_sub || null,
        existing.rows[0].id,
        tenant.slug,
      ]);
      return res.rows[0];
    }

    const res = await client.query(`
      INSERT INTO users (tenant_id, cognito_sub, email, full_name, role, is_active)
      VALUES ($1,$2,$3,$4,$5,true)
      RETURNING id, email, full_name, role, last_login_at, is_active
    `, [
      tenant.slug,
      user.cognito_sub || null,
      user.email.toLowerCase(),
      user.full_name,
      user.role,
    ]);
    return res.rows[0];
  });
}

async function updateUser(tenant, id, changes) {
  return withTenant(tenant, async client => {
    const fields = [];
    const params = [];

    if (Object.prototype.hasOwnProperty.call(changes, 'role')) {
      params.push(changes.role);
      fields.push(`role = $${params.length}`);
    }
    if (Object.prototype.hasOwnProperty.call(changes, 'is_active')) {
      params.push(changes.is_active === true);
      fields.push(`is_active = $${params.length}`);
    }

    if (!fields.length) throw new Error('No supported user fields supplied');

    params.push(tenant.slug, id);
    const res = await client.query(`
      UPDATE users
      SET ${fields.join(', ')}
      WHERE tenant_id = $${params.length - 1} AND id = $${params.length}
      RETURNING id, email, full_name, role, last_login_at, is_active
    `, params);
    return res.rows[0] || null;
  });
}

async function createAuditLog(tenant, eventType, detail = {}, userId = null) {
  return withTenant(tenant, async client => {
    await client.query(`
      INSERT INTO audit_log (event_type, user_id, tenant_id, detail)
      VALUES ($1,$2,$3,$4)
    `, [
      eventType,
      userId,
      tenant.slug,
      JSON.stringify(detail || {}),
    ]);
  });
}

async function listAlerts(tenant, role) {
  return withTenant(tenant, async client => {
    const res = await client.query(`
      SELECT *
      FROM alerts
      WHERE target_role = $1
        AND (expires_at IS NULL OR expires_at > NOW())
        AND is_read = false
        AND tenant_id = $2
      ORDER BY
        CASE priority
          WHEN 'HIGH' THEN 1
          WHEN 'MEDIUM' THEN 2
          ELSE 3
        END,
        created_at DESC
      LIMIT 20
    `, [role, tenant.slug]);
    return res.rows;
  });
}

async function markAlertRead(tenant, id) {
  return withTenant(tenant, async client => {
    const res = await client.query(`
      UPDATE alerts
      SET is_read = true
      WHERE id = $1 AND tenant_id = $2
      RETURNING *
    `, [id, tenant.slug]);
    return res.rows[0] || null;
  });
}

async function masterTenants() {
  const db = getPool();
  if (!db) return [];
  const res = await db.query('SELECT * FROM master.tenants ORDER BY slug');
  return res.rows;
}

async function tenantCounts(row) {
  const db = getPool();
  if (!db) return { users: 0, documents: 0, records: 0, monthly_input_tokens: 0, monthly_output_tokens: 0 };
  const schema = row.db_schema || row.slug;
  assertSchema(schema);
  try {
    const res = await db.query(`
      SELECT
        (SELECT COUNT(*)::int FROM ${schema}.users) AS users,
        (SELECT COUNT(*)::int FROM ${schema}.documents) AS documents,
        (SELECT COUNT(*)::int FROM ${schema}.intelligence_records) AS records,
        (SELECT COALESCE(SUM(claude_input_tokens), 0)::int FROM ${schema}.ingestion_jobs WHERE created_at >= date_trunc('month', NOW())) AS monthly_input_tokens,
        (SELECT COALESCE(SUM(claude_output_tokens), 0)::int FROM ${schema}.ingestion_jobs WHERE created_at >= date_trunc('month', NOW())) AS monthly_output_tokens
    `);
    return res.rows[0];
  } catch {
    return { users: 0, documents: 0, records: 0, monthly_input_tokens: 0, monthly_output_tokens: 0 };
  }
}

async function adminDashboard() {
  const db = getPool();
  if (!db) {
    return {
      active_tenants: 0,
      documents_classified: 0,
      total_users: 0,
      anthropic_spend_month: 0,
    };
  }

  const res = await db.query(`
    SELECT
      (SELECT COUNT(*)::int FROM master.tenants WHERE is_active = true) AS active_tenants,
      (
        SELECT COUNT(*)::int
        FROM zenex.intelligence_records
        WHERE record_status = 'ACTIVE'
      ) AS documents_classified,
      (
        SELECT COUNT(*)::int
        FROM zenex.users
        WHERE is_active = true
      ) AS total_users,
      (
        SELECT COALESCE(
          SUM(claude_input_tokens + claude_output_tokens) * 0.000003, 0
        )::numeric(10,4)
        FROM zenex.ingestion_jobs
        WHERE created_at >= date_trunc('month', NOW())
      ) AS anthropic_spend_month
  `);

  return {
    active_tenants: res.rows[0].active_tenants,
    documents_classified: res.rows[0].documents_classified,
    total_users: res.rows[0].total_users,
    anthropic_spend_month: Number(res.rows[0].anthropic_spend_month),
  };
}

async function adminTenantSummaries() {
  const db = getPool();
  if (!db) return [];
  const res = await db.query(`
    SELECT
      t.slug,
      t.name,
      t.is_active,
      (SELECT COUNT(*)::int FROM zenex.users) AS users,
      (
        SELECT COUNT(*)::int
        FROM zenex.intelligence_records
      ) AS documents
    FROM master.tenants t
    WHERE t.slug = 'zenex'
  `);

  return res.rows.map(row => ({
    slug: row.slug,
    name: row.name,
    status: row.is_active === false ? 'Suspended' : 'Active',
    users: row.users,
    documents: row.documents,
  }));
}

async function suspendTenant(slug) {
  const db = getPool();
  if (!db) return null;
  const res = await db.query(`
    UPDATE master.tenants
    SET is_active = false
    WHERE slug = $1
    RETURNING slug, name, is_active
  `, [slug]);
  return res.rows[0] || null;
}

module.exports = {
  getPool,
  withTenant,
  listRecords,
  getRecord,
  createRecord,
  listQueue,
  resolveQueueItem,
  createKnowledgeProduct,
  listUsers,
  createUser,
  updateUser,
  createAuditLog,
  listAlerts,
  markAlertRead,
  adminDashboard,
  adminTenantSummaries,
  suspendTenant,
};
