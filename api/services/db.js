'use strict';

const { Pool } = require('pg');

let pool;

// Phase B6: defensive truncation for VARCHAR columns. B4's Pass 1/Pass 2
// prompts ask for free-text descriptions on several fields the old
// single-pass prompt constrained to short enums (e.g. evaluation_subtype
// was sized for values like "RCT" / "Mixed methods" - VARCHAR(100) - but
// now regularly receives full-sentence descriptions that overflow it).
function truncate(value, maxLen) {
  if (value == null) return null;
  if (typeof value !== 'string') return value;
  return value.length > maxLen ? value.substring(0, maxLen) : value;
}

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

function asUuidOrNull(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || '') ? value : null;
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
        d.rights_status AS doc_rights_status,
        d.extraction_quality
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

async function getRecordsByIds(tenant, ids) {
  return withTenant(tenant, async client => {
    const res = await client.query(`
      SELECT r.*, d.filename, d.s3_key,
        d.mime_type, d.file_size_bytes,
        d.rights_status AS doc_rights_status
      FROM intelligence_records r
      LEFT JOIN documents d ON d.id = r.document_id
      WHERE r.id = ANY($1)
        AND r.tenant_id = $2
        AND r.record_status = 'ACTIVE'
      ORDER BY r.classified_at DESC NULLS LAST
    `, [ids, tenant.slug]);
    return res.rows;
  });
}

async function getProgrammeRecordsForTor(tenant, programmeName) {
  return withTenant(tenant, async client => {
    const res = await client.query(`
      SELECT
        ir.id,
        ir.programme_name,
        ir.canonical_programme_name,
        ir.programme_area,
        ir.year,
        ir.document_type,
        ir.eqs_tier,
        ir.eqs_composite,
        ir.evaluation_design,
        ir.key_finding_1,
        ir.key_finding_2,
        ir.key_finding_3,
        ir.effect_size_composite,
        ir.limitations,
        ir.sample_size_learners,
        ir.sample_size_schools,
        ir.provinces,
        ir.total_cost_rand,
        ir.responsible_pm,
        ir.nls_alignment,
        ir.funrs_alignment,
        ir.baseline_available,
        ir.endline_available,
        ir.record_series,
        d.filename AS original_filename
      FROM intelligence_records ir
      LEFT JOIN documents d ON d.id = ir.document_id
      WHERE ir.tenant_id = $1
        AND ir.record_status = 'ACTIVE'
        AND LOWER(COALESCE(ir.canonical_programme_name, ir.programme_name, '')) LIKE '%' || LOWER($2) || '%'
      ORDER BY ir.year ASC
    `, [tenant.slug, programmeName]);
    return res.rows;
  });
}

async function saveTorDocument(tenant, data) {
  return withTenant(tenant, async client => {
    const res = await client.query(`
      INSERT INTO tor_documents (
        tenant_id, programme_name, tor_text, total_investment,
        evaluation_count, gap_type, years_without_endline,
        status, s3_key, generated_by, generated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
    `, [
      tenant.slug,
      data.programme_name,
      data.tor_text,
      data.total_investment || null,
      data.evaluation_count || null,
      data.gap_type || null,
      data.years_without_endline || null,
      data.status || 'DRAFT',
      data.s3_key || null,
      asUuidOrNull(data.generated_by),
      data.generated_at || new Date().toISOString(),
    ]);
    return res.rows[0];
  });
}

async function getLatestStrategicIntelligence(tenant, programmeName) {
  return withTenant(tenant, async client => {
    const res = await client.query(`
      SELECT * FROM strategic_intelligence
      WHERE tenant_id = $1 AND programme_name = $2
      ORDER BY generated_at DESC
      LIMIT 1
    `, [tenant.slug, programmeName]);
    return res.rows[0] || null;
  });
}

async function saveStrategicIntelligence(tenant, data) {
  return withTenant(tenant, async client => {
    const res = await client.query(`
      INSERT INTO strategic_intelligence (
        tenant_id, programme_name, opportunities, model_used, generated_by, generated_at
      ) VALUES ($1,$2,$3,$4,$5,NOW())
      RETURNING *
    `, [
      tenant.slug,
      data.programme_name,
      JSON.stringify(data.opportunities),
      data.model_used || 'claude-sonnet-4-6',
      asUuidOrNull(data.generated_by),
    ]);
    return res.rows[0];
  });
}

async function listStrategicIntelligenceDismissals(tenant, strategicIntelligenceId) {
  return withTenant(tenant, async client => {
    const res = await client.query(`
      SELECT opportunity_type
      FROM strategic_intelligence_dismissals
      WHERE tenant_id = $1 AND strategic_intelligence_id = $2
    `, [tenant.slug, strategicIntelligenceId]);
    return res.rows;
  });
}

async function dismissStrategicIntelligenceOpportunity(tenant, strategicIntelligenceId, opportunityType, opportunityTitle, userId) {
  return withTenant(tenant, async client => {
    const res = await client.query(`
      INSERT INTO strategic_intelligence_dismissals (
        tenant_id, strategic_intelligence_id, opportunity_type, opportunity_title, dismissed_by
      ) VALUES ($1,$2,$3,$4,$5)
      RETURNING *
    `, [tenant.slug, strategicIntelligenceId, opportunityType, opportunityTitle || null, asUuidOrNull(userId)]);
    return res.rows[0];
  });
}

async function saveSynthesis(tenant, data) {
  return withTenant(tenant, async client => {
    const res = await client.query(`
      INSERT INTO syntheses (
        tenant_id, title, record_ids,
        record_count, findings, evidence_gaps,
        leverage_points, cross_patterns,
        status, generated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
        'DRAFT', NOW())
      RETURNING *
    `, [
      tenant.slug,
      data.title,
      data.record_ids,
      data.record_count,
      JSON.stringify(data.findings),
      JSON.stringify(data.evidence_gaps),
      JSON.stringify(data.leverage_points),
      JSON.stringify(data.cross_patterns),
    ]);
    return res.rows[0];
  });
}

async function getSynthesis(tenant, id) {
  return withTenant(tenant, async client => {
    const res = await client.query(`
      SELECT *
      FROM syntheses
      WHERE id = $1
        AND tenant_id = $2
    `, [id, tenant.slug]);
    return res.rows[0] || null;
  });
}

async function listSyntheses(tenant) {
  return withTenant(tenant, async client => {
    const res = await client.query(`
      SELECT id, title, record_count,
        record_ids, status, generated_at,
        confirmed_at
      FROM syntheses
      WHERE tenant_id = $1
        AND status != 'ARCHIVED'
      ORDER BY generated_at DESC
      LIMIT 50
    `, [tenant.slug]);
    return res.rows;
  });
}

async function confirmSynthesis(tenant, id, userId) {
  return withTenant(tenant, async client => {
    const confirmedBy = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId || '')
      ? userId
      : null;
    const res = await client.query(`
      UPDATE syntheses
      SET status = 'CONFIRMED',
        confirmed_by = $3,
        confirmed_at = NOW()
      WHERE id = $1
        AND tenant_id = $2
      RETURNING *
    `, [id, tenant.slug, confirmedBy]);
    return res.rows[0];
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

    // Phase B6: field-array pattern rather than ~80 hand-maintained
    // positional $N placeholders, which would be very easy to silently
    // misalign. Includes both the columns explicitly requested for this
    // phase (validation_flags, extraction_pass, canonical_programme_name,
    // secondary_document_type, baseline_year, endline_year, record_series,
    // districts/grades, subject_area, commissioning_standards_met [new
    // boolean], programme_family_id, manually_confirmed) AND a further
    // ~20 pre-existing schema columns (evaluation_design, comparison_group,
    // limitations, etc.) discovered while implementing this: they were
    // never wired into this INSERT at all, even before B4, so the old
    // single-pass classifier's occasional output for them was always
    // discarded. Leaving them out now would defeat the actual point of
    // this phase, since B4's Pass 1/Pass 2 produce real values for nearly
    // all of them - most notably evaluation_design, the field whose
    // permanent nullness was Phase A's headline finding.
    const fields = [
      ['id', truncate(record.id, 50)],
      ['tenant_id', truncate(tenant.slug, 50)],
      ['document_id', documentId],
      ['document_type', truncate(record.document_type, 50)],
      ['evaluation_subtype', truncate(record.evaluation_subtype, 100)],
      ['programme_name', truncate(record.programme_name, 200)],
      ['phase', truncate(record.phase, 100)],
      ['year', record.year],
      ['provinces', record.provinces || []],
      ['sample_size_learners', record.sample_size_learners || null],
      ['sample_size_schools', record.sample_size_schools || null],
      ['has_control_group', record.has_control_group],
      ['methodology_description', record.methodology_description],
      ['key_finding_1', record.key_finding_1],
      ['key_finding_2', record.key_finding_2],
      ['key_finding_3', record.key_finding_3],
      ['null_findings_reported', record.null_findings_reported],
      ['cost_data_present', truncate(record.cost_data_present || 'ABSENT', 20)],
      ['theory_of_change_explicit', record.theory_of_change_explicit],
      ['external_evaluator', record.external_evaluator],
      ['fidelity_reported', record.fidelity_reported],
      ['dosage_documented', record.dosage_documented],
      ['publication_status', truncate(record.publication_status, 30)],
      ['policy_relevance_score', record.policy_relevance_score || null],
      ['strategic_value_score', record.strategic_value_score || null],
      ['nls_alignment', record.nls_alignment],
      ['funrs_alignment', record.funrs_alignment],
      ['dbe_adoption_status', truncate(record.dbe_adoption_status || 'UNKNOWN', 20)],
      ['audience_relevance', record.audience_relevance || []],
      ['evidence_gap_1', record.evidence_gap_1],
      ['evidence_gap_2', record.evidence_gap_2],
      // Legacy 0-9 count: the two-pass classifier no longer produces this,
      // only the new boolean commissioning_standards_met below. Previously
      // (B1) this was incorrectly bound to record.commissioning_standards_met,
      // which after B4 holds a boolean, not a count - would have thrown a
      // type error against this INTEGER column.
      ['commissioning_standards_count', null],
      ['eqs_composite', record.eqs_composite],
      ['eqs_tier', truncate(record.confidence_tier || record.eqs_tier || 'N_A', 20)],
      ['dim_methodological_rigour', dims.methodological_rigour || null],
      ['dim_data_quality', dims.data_quality || null],
      ['dim_transparency', dims.transparency || null],
      ['dim_replicability', dims.replicability || null],
      ['dim_context_relevance', dims.context_relevance || null],
      ['half_life_rating', truncate(record.half_life_rating, 20)],
      ['evidence_capital_score', record.evidence_capital_score],
      ['policy_relevance_weight', record.policy_relevance_weight || null],
      ['sroi_eligible', record.sroi_eligible || false],
      ['board_citable', record.board_citable || false],
      ['classified_by', truncate(record.classified_by || 'claude-sonnet-4-6', 50)],
      ['classification_confidence', record.classification_confidence || record.confidence_scores || {}],
      ['taxonomy_version', truncate(record.taxonomy_version || 'v2.1', 10)],
      ['scoring_logic_version', truncate(record.scoring_logic_version || record.eqs_version || 'v0.2', 10)],
      ['eqs_pathway', truncate(record.eqs_pathway, 30)],
      ['eqs_version', truncate(record.eqs_version || (record.eqs_pathway ? 'v2.0' : 'v1.0'), 10)],
      ['pathway_multiplier', record.pathway_multiplier == null ? null : record.pathway_multiplier],
      ['eqs_scoring_pathway', truncate(record.eqs_scoring_pathway, 20)],
      ['record_status', truncate(record.status === 'PENDING_REVIEW' ? 'PENDING_REVIEW' : 'ACTIVE', 20)],
      // Pre-existing columns, never previously wired into this INSERT
      ['evaluation_design', truncate(record.evaluation_design, 100)],
      ['unit_of_analysis', truncate(record.unit_of_analysis, 100)],
      ['district', record.districts || []],
      ['subject_area', truncate(record.subject_area, 100)],
      ['population_served', record.population_served || null],
      ['record_series', truncate(record.record_series, 50)],
      ['implementing_organisation_name', truncate(record.implementing_organisation_name, 200)],
      ['classified_at', record.classified_at || null],
      ['comparison_group', record.comparison_group || null],
      // data_sources is TEXT (singular); Pass 2 produces an array
      ['data_sources', (record.data_sources || []).length ? record.data_sources.join('; ') : null],
      ['baseline_available', record.baseline_available],
      ['endline_available', record.endline_available],
      ['non_significant_variables', record.non_significant_variables || null],
      ['effect_direction', truncate(record.effect_direction, 20)],
      ['effect_size_composite', record.effect_size_composite || null],
      ['cost_data_source', truncate(record.cost_data_source, 100)],
      ['replication_conditions', record.replication_conditions || null],
      ['limitations', record.limitations || null],
      ['equity_considerations', record.equity_considerations || null],
      ['funder_names', record.funder_names || []],
      // New B2/B4 columns
      // JSON.stringify explicitly: pg serialises bare JS arrays using
      // Postgres array-literal syntax (correct for native ARRAY columns,
      // wrong for JSONB - an empty array becomes the string '{}', which
      // jsonb then parses as an empty OBJECT, and a populated array of
      // flag objects would come out corrupted, not just cosmetically off.
      ['validation_flags', JSON.stringify(record.validation_flags || [])],
      ['extraction_pass', record.extraction_pass || 1],
      ['canonical_programme_name', truncate(record.canonical_programme_name, 300)],
      ['secondary_document_type', truncate(record.secondary_document_type, 100)],
      ['baseline_year', record.baseline_year || null],
      ['endline_year', record.endline_year || null],
      // grade is VARCHAR (singular); Pass 1 produces a grades array
      ['grade', truncate((record.grades || []).length ? record.grades.join(', ') : null, 50)],
      ['commissioning_standards_met', typeof record.commissioning_standards_met === 'boolean' ? record.commissioning_standards_met : null],
      ['programme_family_id', truncate(record.programme_family_id, 100)],
      ['manually_confirmed', false],
    ];

    const columnNames = fields.map(([name]) => name).join(', ');
    const placeholders = fields.map((_, i) => `$${i + 1}`).join(', ');
    const values = fields.map(([, value]) => value);

    await client.query(`
      INSERT INTO intelligence_records (${columnNames})
      VALUES (${placeholders})
      ON CONFLICT (id) DO UPDATE SET updated_at = NOW()
    `, values);

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
      WHERE q.tenant_id = $1
        AND q.resolved_at IS NULL
        AND (r.record_status IS NULL OR r.record_status <> 'SOFT_DELETED')
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
    const generatedBy = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.generated_by || '')
      ? payload.generated_by
      : null;
    const res = await client.query(`
      INSERT INTO knowledge_products (
        tenant_id, record_id, audience, content, word_count, model_used, generated_by, generated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
    `, [
      tenant.slug,
      payload.record_id,
      payload.audience,
      payload.content,
      payload.word_count,
      payload.model_used || 'claude-sonnet-4-6',
      generatedBy,
      payload.generated_at || new Date().toISOString(),
    ]);
    return res.rows[0];
  });
}

async function saveProvenance(tenant, data) {
  return withTenant(tenant, async client => {
    const res = await client.query(`
      INSERT INTO provenance_records (
        tenant_id, synthesis_id,
        source_record_ids, audience,
        brief_content, generated_at,
        model_used, word_count
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING id
    `, [
      tenant.slug,
      data.synthesis_id || null,
      data.source_record_ids,
      data.audience,
      data.brief_content,
      data.generated_at,
      data.model_used,
      data.word_count,
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
        priority_score DESC NULLS LAST,
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
      SET is_read = true, dismissed_at = NOW()
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
        (SELECT COUNT(*)::int FROM ${schema}.intelligence_records WHERE record_status = 'ACTIVE') AS records,
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
        WHERE record_status = 'ACTIVE'
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
  getRecordsByIds,
  getProgrammeRecordsForTor,
  saveTorDocument,
  getLatestStrategicIntelligence,
  saveStrategicIntelligence,
  listStrategicIntelligenceDismissals,
  dismissStrategicIntelligenceOpportunity,
  saveSynthesis,
  getSynthesis,
  listSyntheses,
  confirmSynthesis,
  createRecord,
  listQueue,
  resolveQueueItem,
  createKnowledgeProduct,
  saveProvenance,
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
