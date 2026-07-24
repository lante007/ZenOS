'use strict';

/**
 * EvidenceOS CEO weekly summary Lambda.
 *
 * EventBridge schedule:
 *   cron(0 5 ? * MON *)  // Monday 07:00 SAST, expressed in UTC
 *
 * Required environment:
 *   DATABASE_URL       PostgreSQL connection string
 *   SES_FROM_EMAIL     Verified SES sender address, e.g. EvidenceOS <no-reply@auxeira.com>
 *   AWS_REGION         Defaults to us-east-1
 *
 * Optional environment:
 *   TENANT             Defaults to zenex
 *   SUMMARY_URL_BASE   Defaults to https://{tenant}.auxeira.com
 */

const { Pool } = require('pg');
const {
  CreateTemplateCommand,
  SendTemplatedEmailCommand,
  SESClient,
  UpdateTemplateCommand,
} = require('@aws-sdk/client-ses');

const REGION = process.env.AWS_REGION || 'us-east-1';
const TEMPLATE_NAME = 'EvidenceOSWeeklyCeoSummary';
const SCHEDULE_EXPRESSION = 'cron(0 5 ? * MON *)';

let pool;

function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSLMODE === 'disable' ? undefined : { rejectUnauthorized: false },
      connectionTimeoutMillis: Number(process.env.PG_CONNECTION_TIMEOUT_MS || 5000),
      query_timeout: Number(process.env.PG_QUERY_TIMEOUT_MS || 10000),
      max: 2,
    });
  }
  return pool;
}

function assertTenantSlug(slug) {
  if (!/^[a-z][a-z0-9_]*$/.test(slug || '')) {
    throw new Error(`Unsafe tenant slug: ${slug}`);
  }
}

function htmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderList(items, emptyText) {
  if (!items.length) return `<li>${htmlEscape(emptyText)}</li>`;
  return items.map(item => `<li>${htmlEscape(item)}</li>`).join('');
}

function templateDefinition() {
  return {
    TemplateName: TEMPLATE_NAME,
    SubjectPart: '{{organisation}} weekly evidence summary',
    TextPart: [
      '{{organisation}} weekly evidence summary',
      '',
      'Evidence Health Score: {{evidenceHealthScore}}/100',
      '{{scoreInterpretation}}',
      '',
      'New Tier 1 records this week:',
      '{{tierOneText}}',
      '',
      'Pending queue items: {{queueItemCount}}',
      '',
      'Commissioning priority:',
      '{{commissioningPriority}}',
      '',
      'Executive view: {{executiveUrl}}',
    ].join('\n'),
    HtmlPart: [
      '<!doctype html>',
      '<html>',
      '<body style="margin:0;background:#f5f2ee;color:#0a1628;font-family:Arial,sans-serif;">',
      '<div style="max-width:680px;margin:0 auto;padding:28px;">',
      '<p style="margin:0 0 8px;color:#EF7218;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700;">EvidenceOS weekly summary</p>',
      '<h1 style="margin:0 0 18px;font-size:30px;line-height:1.1;color:#311F47;">{{organisation}}</h1>',
      '<div style="padding:20px;border:1px solid #e3d8cf;background:#fff;">',
      '<p style="margin:0;color:#7b6f84;font-size:12px;text-transform:uppercase;letter-spacing:1.5px;font-weight:700;">Evidence Health Score</p>',
      '<div style="font-size:64px;line-height:1;color:#EF7218;font-weight:800;">{{evidenceHealthScore}}</div>',
      '<p style="margin:8px 0 0;color:#311F47;">{{scoreInterpretation}}</p>',
      '</div>',
      '<h2 style="margin:24px 0 8px;color:#311F47;font-size:18px;">New Tier 1 records this week</h2>',
      '<ul style="margin:0;padding-left:20px;">{{{tierOneHtml}}}</ul>',
      '<h2 style="margin:24px 0 8px;color:#311F47;font-size:18px;">Review queue</h2>',
      '<p style="margin:0;">{{queueItemCount}} item(s) pending Organisation Lead review.</p>',
      '<h2 style="margin:24px 0 8px;color:#311F47;font-size:18px;">Commissioning priority</h2>',
      '<p style="margin:0;">{{commissioningPriority}}</p>',
      '<p style="margin:28px 0 0;"><a href="{{executiveUrl}}" style="display:inline-block;background:#EF7218;color:#fff;text-decoration:none;padding:12px 18px;border-radius:4px;font-weight:700;">Open executive view</a></p>',
      '</div>',
      '</body>',
      '</html>',
    ].join(''),
  };
}

async function ensureSesTemplate(ses) {
  const Template = templateDefinition();
  try {
    await ses.send(new CreateTemplateCommand({ Template }));
    return 'created';
  } catch (err) {
    if (err.name !== 'AlreadyExists' && err.name !== 'AlreadyExistsException') throw err;
    await ses.send(new UpdateTemplateCommand({ Template }));
    return 'updated';
  }
}

function scoreInterpretation(score) {
  if (score >= 75) return 'Strong evidence base with leadership-ready Tier 1 assets.';
  if (score >= 50) return 'Useful evidence base with targeted gaps and review items to resolve.';
  if (score > 0) return 'Evidence base needs strengthening before major external use.';
  return 'No scored evidence records are currently available.';
}

async function loadSummaryData(tenantSlug) {
  assertTenantSlug(tenantSlug);
  const client = await getPool().connect();

  try {
    const tenantRes = await client.query(
      'SELECT slug, name, db_schema, ceo_email FROM master.tenants WHERE slug = $1 AND is_active = true',
      [tenantSlug],
    );
    const tenant = tenantRes.rows[0];
    if (!tenant) throw new Error(`Active tenant not found: ${tenantSlug}`);
    if (!tenant.ceo_email) throw new Error(`CEO email is not configured for tenant: ${tenantSlug}`);

    const schema = tenant.db_schema || tenant.slug;
    assertTenantSlug(schema);

    const summaryRes = await client.query(`
      SELECT
        COUNT(*)::int AS total_records,
        COUNT(*) FILTER (WHERE eqs_tier = 'TIER_1')::int AS tier_one_records
      FROM ${schema}.intelligence_records
      WHERE tenant_id = $1 AND record_status = 'ACTIVE'
    `, [tenant.slug]);

    const tierOneRes = await client.query(`
      SELECT id, programme_name, key_finding_1
      FROM ${schema}.intelligence_records
      WHERE tenant_id = $1
        AND record_status = 'ACTIVE'
        AND eqs_tier = 'TIER_1'
        AND created_at >= NOW() - INTERVAL '7 days'
      ORDER BY created_at DESC
      LIMIT 5
    `, [tenant.slug]);

    const queueRes = await client.query(`
      SELECT COUNT(*)::int AS queue_count
      FROM ${schema}.queue_items
      WHERE tenant_id = $1 AND resolved_at IS NULL
    `, [tenant.slug]);

    const gapRes = await client.query(`
      SELECT COALESCE(NULLIF(evidence_gap_1, ''), NULLIF(evidence_gap_2, '')) AS gap
      FROM ${schema}.intelligence_records
      WHERE tenant_id = $1
        AND record_status = 'ACTIVE'
        AND (NULLIF(evidence_gap_1, '') IS NOT NULL OR NULLIF(evidence_gap_2, '') IS NOT NULL)
      ORDER BY
        CASE WHEN eqs_tier = 'TIER_1' THEN 0 WHEN eqs_tier = 'TIER_2' THEN 1 ELSE 2 END,
        created_at DESC
      LIMIT 1
    `, [tenant.slug]);

    const total = summaryRes.rows[0].total_records;
    const tierOne = summaryRes.rows[0].tier_one_records;
    const evidenceHealthScore = total ? Math.round((tierOne / total) * 100) : 0;
    const executiveUrlBase = process.env.SUMMARY_URL_BASE || `https://${tenant.slug}.auxeira.com`;

    const tierOneRecords = tierOneRes.rows.map(row => ({
      id: row.id,
      programme_name: row.programme_name || 'Unassigned programme',
      key_finding_1: row.key_finding_1 || 'No primary finding captured.',
    }));

    return {
      tenant,
      evidenceHealthScore,
      scoreInterpretation: scoreInterpretation(evidenceHealthScore),
      tierOneRecords,
      queueItemCount: queueRes.rows[0].queue_count,
      commissioningPriority: gapRes.rows[0]?.gap || 'Commission one outcome-linked endline study for the highest-priority current evidence gap.',
      executiveUrl: `${executiveUrlBase}/exec`,
    };
  } finally {
    client.release();
  }
}

function templateData(summary) {
  const tierOneLines = summary.tierOneRecords.map(record => (
    `${record.programme_name}: ${record.key_finding_1}`
  ));
  const tierOneHtml = renderList(tierOneLines, 'No new Tier 1 records were classified this week.');
  const tierOneText = tierOneLines.length
    ? tierOneLines.map(line => `- ${line}`).join('\n')
    : '- No new Tier 1 records were classified this week.';

  return {
    organisation: summary.tenant.name,
    evidenceHealthScore: String(summary.evidenceHealthScore),
    scoreInterpretation: summary.scoreInterpretation,
    tierOneText,
    tierOneHtml,
    queueItemCount: String(summary.queueItemCount),
    commissioningPriority: summary.commissioningPriority,
    executiveUrl: summary.executiveUrl,
  };
}

async function sendWeeklySummary(summary) {
  const source = process.env.SES_FROM_EMAIL;
  if (!source) throw new Error('SES_FROM_EMAIL is required');

  const ses = new SESClient({ region: REGION });
  const templateStatus = await ensureSesTemplate(ses);
  const data = templateData(summary);

  const result = await ses.send(new SendTemplatedEmailCommand({
    Source: source,
    Destination: { ToAddresses: [summary.tenant.ceo_email] },
    Template: TEMPLATE_NAME,
    TemplateData: JSON.stringify(data),
  }));

  return {
    messageId: result.MessageId,
    templateStatus,
    destination: summary.tenant.ceo_email,
  };
}

async function handler(event = {}) {
  const tenantSlug = event.tenant || process.env.TENANT || 'zenex';
  const summary = await loadSummaryData(tenantSlug);
  const sent = await sendWeeklySummary(summary);

  return {
    ok: true,
    schedule: SCHEDULE_EXPRESSION,
    tenant: summary.tenant.slug,
    evidenceHealthScore: summary.evidenceHealthScore,
    tierOneRecordsThisWeek: summary.tierOneRecords.length,
    queueItemCount: summary.queueItemCount,
    commissioningPriority: summary.commissioningPriority,
    ...sent,
  };
}

module.exports = {
  SCHEDULE_EXPRESSION,
  handler,
  loadSummaryData,
  templateData,
};
