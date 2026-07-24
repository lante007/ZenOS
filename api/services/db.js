'use strict';

const { Pool } = require('pg');

let pool;

function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
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
    const where = ['tenant_id = $1'];
    const params = [tenant.slug];

    if (filters.tier) {
      params.push(filters.tier);
      where.push(`eqs_tier = $${params.length}`);
    }
    if (filters.type) {
      params.push(filters.type);
      where.push(`document_type = $${params.length}`);
    }
    if (filters.phase) {
      params.push(filters.phase);
      where.push(`phase = $${params.length}`);
    }
    if (filters.q) {
      params.push(`%${filters.q}%`);
      where.push(`(filename ILIKE $${params.length} OR programme_name ILIKE $${params.length} OR document_type ILIKE $${params.length})`);
    }

    const res = await client.query(`
      SELECT r.*, d.filename, d.s3_key, d.mime_type, d.file_size_bytes
      FROM intelligence_records r
      LEFT JOIN documents d ON d.id = r.document_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.created_at DESC
      LIMIT 500
    `, params);
    return res.rows;
  });
}

async function getRecord(tenant, id) {
  return withTenant(tenant, async client => {
    const res = await client.query(`
      SELECT r.*, d.filename, d.s3_key, d.mime_type, d.file_size_bytes
      FROM intelligence_records r
      LEFT JOIN documents d ON d.id = r.document_id
      WHERE r.tenant_id = $1 AND r.id = $2
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

    await insertIngestionJob(tenant, documentId, record.api_usage, 'COMPLETE');

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

module.exports = {
  getPool,
  withTenant,
  listRecords,
  getRecord,
  createRecord,
  listQueue,
  resolveQueueItem,
  createKnowledgeProduct,
};
