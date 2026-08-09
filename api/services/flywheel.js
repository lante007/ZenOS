'use strict';

const { computePriorityScore, operationalPriorityScore } = require('./priority-score');

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
    `SELECT id, programme_name, eqs_tier, programme_area, total_cost_rand, year,
            nls_alignment, funrs_alignment, policy_alignment
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
      const priority = record.eqs_tier === 'TIER_1' ? 'HIGH' : 'MEDIUM';
      alerts.push({
        alert_type: 'AUDIENCE_GAP',
        title: `Knowledge gap: ${record.programme_name}`,
        body: `${record.programme_name} (${record.eqs_tier}) has no knowledge product for: ${missing.join(', ')}. ${missing.length} audience briefs pending generation.`,
        record_id: record.id,
        target_role: 'COMMUNICATIONS',
        priority,
        priority_score: computePriorityScore(record, { priority }),
      });
    }
  }
  return alerts;
}

async function detectCurrencyAlerts(tenant, pool) {
  const schema = schemaFor(tenant);
  const records = await pool.query(
    `SELECT id, programme_name, half_life_rating, year, policy_alignment,
            programme_area, total_cost_rand, nls_alignment, funrs_alignment
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
    priority_score: computePriorityScore(r, { priority: 'MEDIUM' }),
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
      // No records matched the "recent" filter above, so pull an unfiltered
      // programme profile (most recent year, total investment, policy signal)
      // to score priority against instead of a single record.
      const profile = await pool.query(
        `SELECT MAX(programme_area) AS programme_area,
                MAX(year) AS year,
                SUM(total_cost_rand) AS total_cost_rand,
                BOOL_OR(nls_alignment) AS nls_alignment,
                BOOL_OR(funrs_alignment) AS funrs_alignment,
                MAX(policy_alignment) AS policy_alignment
         FROM ${schema}.intelligence_records
         WHERE tenant_id = $1 AND programme_name = $2 AND record_status = 'ACTIVE'`,
        [tenant.slug, prog]
      );
      const priority = 'MEDIUM';
      alerts.push({
        alert_type: 'COMMISSIONING_GAP',
        title: `No recent impact evidence: ${prog}`,
        body: `${prog} has no impact evaluation in the archive dated 2021 or later. If this programme is still active, a new evaluation may be justified. Check the commissioning calendar.`,
        target_role: 'EVIDENCE_ANALYST',
        priority,
        priority_score: computePriorityScore(profile.rows[0] || {}, { priority }),
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
    // Operational alert, not tied to a single evidence record: strategic
    // alignment, investment magnitude and policy relevance don't apply, so
    // priority_score falls back to their neutral defaults and is driven by
    // severity alone.
    const priority = count >= 10 ? 'HIGH' : 'MEDIUM';
    return [{
      alert_type: 'QUEUE_BACKLOG',
      title: `${count} classification decisions pending`,
      body: `${count} expert review items have been waiting more than 5 days. Batch classification progress is blocked until these are resolved. Target: clear queue in next session.`,
      target_role: 'ORGANISATION_LEAD',
      priority,
      priority_score: operationalPriorityScore(priority),
    }];
  }
  return [];
}

async function detectEndlineGaps(tenant, pool) {
  const schema = schemaFor(tenant);
  const result = await pool.query(
    `SELECT id, programme_name, year, programme_area, total_cost_rand,
            nls_alignment, funrs_alignment, policy_alignment
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
    priority_score: computePriorityScore(r, { priority: 'HIGH' }),
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
    // Operational alert, not tied to a single evidence record - see note in
    // detectQueueBacklog above.
    const priority = 'HIGH';
    return [{
      alert_type: 'BOARD_PROXIMITY',
      title: 'Trustee Evidence Pack overdue',
      body: `No trustee evidence pack has been generated in ${daysSince === 999 ? 'this cycle' : `${daysSince} days`}. Generate the quarterly pack from the current corpus before the next board meeting.`,
      target_role: 'ORGANISATION_LEAD',
      priority,
      priority_score: operationalPriorityScore(priority),
    }];
  }
  return [];
}

async function insertAlertIfNew(tenant, pool, alert) {
  const schema = schemaFor(tenant);

  // Suppression rule: a dismissed alert for the same record + same alert
  // category (alert_type) stays suppressed for 90 days. A different
  // alert_type on the same record fires normally.
  if (alert.record_id) {
    const dismissed = await pool.query(
      `SELECT id
       FROM ${schema}.alerts
       WHERE tenant_id = $1
         AND alert_type = $2
         AND record_id = $3
         AND dismissed_at IS NOT NULL
         AND dismissed_at >= NOW() - INTERVAL '90 days'
       LIMIT 1`,
      [tenant.slug, alert.alert_type, alert.record_id]
    );
    if (dismissed.rows[0]) return null;
  }

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
       tenant_id, alert_type, title, body, record_id, target_role, priority, priority_score, expires_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      tenant.slug,
      alert.alert_type,
      alert.title,
      alert.body,
      alert.record_id || null,
      alert.target_role,
      alert.priority || 'MEDIUM',
      alert.priority_score ?? null,
      alert.expires_at || null,
    ]
  );
  return inserted.rows[0];
}

const DAILY_ALERT_CAP_PER_ROLE = 3;

async function countAlertsToday(tenant, pool, targetRole) {
  const schema = schemaFor(tenant);
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM ${schema}.alerts
     WHERE tenant_id = $1
       AND target_role = $2
       AND created_at >= date_trunc('day', NOW())`,
    [tenant.slug, targetRole]
  );
  return Number(result.rows[0].count);
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

  const candidates = batches.flat().sort(
    (a, b) => (b.priority_score ?? 0) - (a.priority_score ?? 0)
  );

  const roleCountsToday = {};
  const inserted = [];
  for (const alert of candidates) {
    const role = alert.target_role;
    if (roleCountsToday[role] === undefined) {
      roleCountsToday[role] = await countAlertsToday(tenant, pool, role);
    }
    if (roleCountsToday[role] >= DAILY_ALERT_CAP_PER_ROLE) continue;

    const row = await insertAlertIfNew(tenant, pool, alert);
    if (row) {
      inserted.push(row);
      roleCountsToday[role] += 1;
    }
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
