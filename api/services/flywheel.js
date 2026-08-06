'use strict';

function schemaFor(tenant) {
  const schema = tenant.db_schema || tenant.slug;
  if (!/^[a-z][a-z0-9_]*$/.test(schema || '')) {
    throw new Error(`Unsafe tenant schema: ${schema}`);
  }
  return schema;
}

async function detectAudienceGaps(tenant, pool) {
  const schema = schemaFor(tenant);
  const records = await pool.query(
    `SELECT id, programme_name, eqs_tier
     FROM ${schema}.intelligence_records
     WHERE tenant_id = $1
       AND eqs_tier IN ('TIER_1','TIER_2')
       AND record_status = 'ACTIVE'`,
    [tenant.slug]
  );
  const audiences = ['TRUSTEE','CEO','DBE_NATIONAL','PROVINCIAL_HOD','CO_FUNDER','SECTOR_PEER'];
  const alerts = [];
  for (const record of records.rows) {
    const kps = await pool.query(
      `SELECT audience FROM ${schema}.knowledge_products
       WHERE record_id = $1`,
      [record.id]
    );
    const covered = kps.rows.map(k => k.audience);
    const missing = audiences.filter(a => !covered.includes(a));
    if (missing.length > 0) {
      alerts.push({
        alert_type: 'AUDIENCE_GAP',
        title: `Knowledge gap: ${record.programme_name}`,
        body: `${record.programme_name} (${record.eqs_tier}) has no knowledge product for: ${missing.join(', ')}. ${missing.length} audience briefs pending generation.`,
        record_id: record.id,
        target_role: 'COMMUNICATIONS',
        priority: record.eqs_tier === 'TIER_1' ? 'HIGH' : 'MEDIUM',
      });
    }
  }
  return alerts;
}

async function detectCurrencyAlerts(tenant, pool) {
  const schema = schemaFor(tenant);
  const records = await pool.query(
    `SELECT id, programme_name, half_life_rating, year, policy_alignment
     FROM ${schema}.intelligence_records
     WHERE tenant_id = $1
       AND half_life_rating = 'AGING'
       AND record_status = 'ACTIVE'`,
    [tenant.slug]
  );
  return records.rows.map(r => ({
    alert_type: 'CURRENCY_ALERT',
    title: `Evidence aging: ${r.programme_name}`,
    body: `${r.programme_name} (${r.year}) is rated AGING. Policy context may have shifted since this evaluation was conducted. Consider whether findings remain current given NLS 2024-2030 and FUNRS 2025 benchmarks.`,
    record_id: r.id,
    target_role: 'ORGANISATION_LEAD',
    priority: 'MEDIUM',
  }));
}

async function detectCommissioningGaps(tenant, pool) {
  const schema = schemaFor(tenant);
  const programmes = [
    'Funda Wande',
    'Bala Wande',
    'NECT DIP',
    'GDE Grade R Maths and Language',
    'Senior Phase Mathematics Backlogs',
  ];
  const alerts = [];
  for (const prog of programmes) {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM ${schema}.intelligence_records
       WHERE tenant_id = $1
         AND programme_name = $2
         AND document_type = 'Impact Evaluation'
         AND year::int >= 2021
         AND record_status = 'ACTIVE'`,
      [tenant.slug, prog]
    );
    if (Number(result.rows[0].count) === 0) {
      alerts.push({
        alert_type: 'COMMISSIONING_GAP',
        title: `No recent impact evidence: ${prog}`,
        body: `${prog} has no impact evaluation in the archive dated 2021 or later. If this programme is still active, a new evaluation may be justified. Check the commissioning calendar.`,
        target_role: 'EVIDENCE_ANALYST',
        priority: 'MEDIUM',
      });
    }
  }
  return alerts;
}

async function detectQueueBacklog(tenant, pool) {
  const schema = schemaFor(tenant);
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM ${schema}.queue_items
     WHERE tenant_id = $1
       AND resolved_at IS NULL
       AND created_at < NOW() - INTERVAL '5 days'`,
    [tenant.slug]
  );
  const count = Number(result.rows[0].count);
  if (count >= 5) {
    return [{
      alert_type: 'QUEUE_BACKLOG',
      title: `${count} classification decisions pending`,
      body: `${count} expert review items have been waiting more than 5 days. Batch classification progress is blocked until these are resolved. Target: clear queue in next session.`,
      target_role: 'ORGANISATION_LEAD',
      priority: count >= 10 ? 'HIGH' : 'MEDIUM',
    }];
  }
  return [];
}

async function detectEndlineGaps(tenant, pool) {
  const schema = schemaFor(tenant);
  const result = await pool.query(
    `SELECT id, programme_name, year
     FROM ${schema}.intelligence_records
     WHERE tenant_id = $1
       AND document_type = 'Impact Evaluation'
       AND endline_available = false
       AND record_status = 'ACTIVE'`,
    [tenant.slug]
  );
  return result.rows.map(r => ({
    alert_type: 'ENDLINE_GAP',
    title: `No endline: ${r.programme_name}`,
    body: `${r.programme_name} (${r.year}) has no endline evaluation in the archive. The evidence chain is incomplete. Request the endline from the implementing organisation or recommission if not completed.`,
    record_id: r.id,
    target_role: 'EVIDENCE_ANALYST',
    priority: 'HIGH',
  }));
}

async function detectBoardProximity(tenant, pool) {
  const schema = schemaFor(tenant);
  const result = await pool.query(
    `SELECT MAX(created_at) AS last_pack
     FROM ${schema}.knowledge_products
     WHERE tenant_id = $1
       AND audience = 'TRUSTEE'`,
    [tenant.slug]
  );
  const lastPack = result.rows[0].last_pack;
  const daysSince = lastPack
    ? Math.floor((Date.now() - new Date(lastPack)) / (1000 * 60 * 60 * 24))
    : 999;
  if (daysSince > 85) {
    return [{
      alert_type: 'BOARD_PROXIMITY',
      title: 'Trustee Evidence Pack overdue',
      body: `No trustee evidence pack has been generated in ${daysSince === 999 ? 'this cycle' : `${daysSince} days`}. Generate the quarterly pack from the current corpus before the next board meeting.`,
      target_role: 'ORGANISATION_LEAD',
      priority: 'HIGH',
    }];
  }
  return [];
}

async function insertAlertIfNew(tenant, pool, alert) {
  const schema = schemaFor(tenant);
  const existing = await pool.query(
    `SELECT id
     FROM ${schema}.alerts
     WHERE tenant_id = $1
       AND alert_type = $2
       AND target_role = $3
       AND title = $4
       AND COALESCE(record_id, '') = COALESCE($5, '')
       AND created_at >= NOW() - INTERVAL '7 days'
     LIMIT 1`,
    [tenant.slug, alert.alert_type, alert.target_role, alert.title, alert.record_id || null]
  );
  if (existing.rows[0]) return null;

  const inserted = await pool.query(
    `INSERT INTO ${schema}.alerts (
       tenant_id, alert_type, title, body, record_id, target_role, priority, expires_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      tenant.slug,
      alert.alert_type,
      alert.title,
      alert.body,
      alert.record_id || null,
      alert.target_role,
      alert.priority || 'MEDIUM',
      alert.expires_at || null,
    ]
  );
  return inserted.rows[0];
}

async function runFlywheel(tenant, pool) {
  const batches = await Promise.all([
    detectAudienceGaps(tenant, pool),
    detectCurrencyAlerts(tenant, pool),
    detectCommissioningGaps(tenant, pool),
    detectQueueBacklog(tenant, pool),
    detectEndlineGaps(tenant, pool),
    detectBoardProximity(tenant, pool),
  ]);

  const inserted = [];
  for (const alert of batches.flat()) {
    const row = await insertAlertIfNew(tenant, pool, alert);
    if (row) inserted.push(row);
  }
  return inserted;
}

module.exports = {
  detectAudienceGaps,
  detectCurrencyAlerts,
  detectCommissioningGaps,
  detectQueueBacklog,
  detectEndlineGaps,
  detectBoardProximity,
  runFlywheel,
};
