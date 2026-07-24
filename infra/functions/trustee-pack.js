'use strict';

/**
 * EvidenceOS Trustee Evidence Pack generator.
 *
 * Generates a quarterly PDF from the live tenant RDS corpus, uploads it to:
 *   exports/reports/trustee-pack-{date}.pdf
 * and returns a 24-hour presigned S3 download URL.
 */

const PDFDocument = require('pdfkit');
const { Pool } = require('pg');
const { GetObjectCommand, PutObjectCommand, S3Client } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const REGION = process.env.AWS_REGION || 'us-east-1';
const SIGNED_URL_EXPIRES_SECONDS = 24 * 60 * 60;

let pool;

function getPool() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
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

function assertSchema(schema) {
  if (!/^[a-z][a-z0-9_]*$/.test(schema || '')) {
    throw new Error(`Unsafe tenant schema: ${schema}`);
  }
}

function reportDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function asNumber(value) {
  if (value == null || value === '') return 0;
  return Number(value);
}

function formatTier(tier) {
  return String(tier || 'N_A').replace('TIER_', 'Tier ').replace('N_A', 'Not scored');
}

function addSectionTitle(doc, title) {
  doc.moveDown(1.1);
  doc.fillColor('#311F47').fontSize(16).font('Helvetica-Bold').text(title);
  doc.moveDown(0.35);
  doc.strokeColor('#EF7218').lineWidth(1).moveTo(doc.x, doc.y).lineTo(552, doc.y).stroke();
  doc.moveDown(0.7);
}

function addWrappedItem(doc, title, body) {
  doc.fillColor('#0A1628').fontSize(10).font('Helvetica-Bold').text(title, { continued: false });
  if (body) {
    doc.fillColor('#334155').fontSize(9).font('Helvetica').text(body, {
      width: 500,
      lineGap: 2,
    });
  }
  doc.moveDown(0.55);
}

function addPageIfNeeded(doc, minY = 690) {
  if (doc.y > minY) doc.addPage();
}

async function pdfToBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

async function loadTrusteePackData(tenant) {
  const schema = tenant.db_schema || tenant.slug;
  assertSchema(schema);

  const client = await getPool().connect();
  try {
    const tenantRes = await client.query(
      'SELECT slug, name, s3_vault_bucket, db_schema FROM master.tenants WHERE slug = $1 AND is_active = true',
      [tenant.slug],
    );
    const tenantRow = tenantRes.rows[0] || tenant;

    const summaryRes = await client.query(`
      SELECT
        COUNT(*)::int AS total_records,
        COUNT(*) FILTER (WHERE eqs_tier = 'TIER_1')::int AS tier_1,
        COUNT(*) FILTER (WHERE eqs_tier = 'TIER_2')::int AS tier_2,
        COUNT(*) FILTER (WHERE eqs_tier = 'TIER_3')::int AS tier_3,
        COUNT(*) FILTER (WHERE eqs_tier = 'EXCLUDED')::int AS excluded,
        COUNT(*) FILTER (WHERE eqs_tier = 'N_A')::int AS not_scored
      FROM ${schema}.intelligence_records
      WHERE tenant_id = $1 AND record_status = 'ACTIVE'
    `, [tenant.slug]);

    const topTierOneRes = await client.query(`
      SELECT id, programme_name, key_finding_1, eqs_composite, evidence_capital_score
      FROM ${schema}.intelligence_records
      WHERE tenant_id = $1 AND record_status = 'ACTIVE' AND eqs_tier = 'TIER_1'
      ORDER BY eqs_composite DESC NULLS LAST, evidence_capital_score DESC NULLS LAST, created_at DESC
      LIMIT 5
    `, [tenant.slug]);

    const decisionCapitalRes = await client.query(`
      SELECT
        d.id,
        d.tier,
        d.description,
        d.decision_maker,
        d.organisation,
        d.financial_value_rand,
        d.learners_affected,
        d.reach_description,
        r.programme_name
      FROM ${schema}.decision_capital_instances d
      LEFT JOIN ${schema}.intelligence_records r ON r.id = d.record_id
      WHERE d.tenant_id = $1
      ORDER BY d.created_at DESC
      LIMIT 10
    `, [tenant.slug]);

    const summary = summaryRes.rows[0];
    const total = summary.total_records;
    const evidenceHealthScore = total ? Math.round((summary.tier_1 / total) * 100) : 0;

    return {
      tenant: tenantRow,
      generatedAt: new Date().toISOString(),
      evidenceHealthScore,
      tierDistribution: {
        TIER_1: summary.tier_1,
        TIER_2: summary.tier_2,
        TIER_3: summary.tier_3,
        EXCLUDED: summary.excluded,
        N_A: summary.not_scored,
      },
      topTierOneFindings: topTierOneRes.rows,
      decisionCapital: decisionCapitalRes.rows,
    };
  } finally {
    client.release();
  }
}

function renderTrusteePackPdf(data) {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 42,
    info: {
      Title: `${data.tenant.name} Trustee Evidence Pack`,
      Author: 'Auxeira EvidenceOS',
      Subject: 'Quarterly trustee evidence summary',
    },
  });

  doc.rect(0, 0, doc.page.width, 98).fill('#311F47');
  doc.fillColor('#EF7218').fontSize(10).font('Helvetica-Bold').text('AUXEIRA EVIDENCEOS', 42, 30, {
    characterSpacing: 1.5,
  });
  doc.fillColor('#FFFFFF').fontSize(28).font('Helvetica-Bold').text('Trustee Evidence Pack', 42, 48);
  doc.fillColor('#F5F2EE').fontSize(11).font('Helvetica').text(data.tenant.name, 42, 78);

  doc.y = 124;
  doc.fillColor('#64748B').fontSize(9).text(`Generated ${new Date(data.generatedAt).toLocaleDateString('en-ZA')}`);
  doc.moveDown(1);

  doc.fillColor('#311F47').fontSize(13).font('Helvetica-Bold').text('Evidence Health Score');
  doc.fillColor('#EF7218').fontSize(54).font('Helvetica-Bold').text(String(data.evidenceHealthScore), { continued: true });
  doc.fillColor('#64748B').fontSize(16).text('/100');
  doc.fillColor('#334155').fontSize(10).font('Helvetica').text(
    'Share of active corpus currently classified as Tier 1 evidence.',
    { width: 480 },
  );

  addSectionTitle(doc, 'Tier Distribution');
  const tiers = [
    ['Tier 1', data.tierDistribution.TIER_1],
    ['Tier 2', data.tierDistribution.TIER_2],
    ['Tier 3', data.tierDistribution.TIER_3],
    ['Excluded', data.tierDistribution.EXCLUDED],
    ['Not scored', data.tierDistribution.N_A],
  ];
  for (const [label, count] of tiers) {
    doc.fillColor('#0A1628').fontSize(10).font('Helvetica-Bold').text(label, { continued: true, width: 120 });
    doc.fillColor('#334155').font('Helvetica').text(String(count));
  }

  addSectionTitle(doc, 'Top 5 Tier 1 Findings');
  if (!data.topTierOneFindings.length) {
    doc.fillColor('#334155').fontSize(10).font('Helvetica').text('No Tier 1 findings are currently available.');
  } else {
    data.topTierOneFindings.forEach((record, index) => {
      addPageIfNeeded(doc);
      addWrappedItem(
        doc,
        `${index + 1}. ${record.programme_name || record.id} (${formatTier('TIER_1')} · EQS ${record.eqs_composite || 'N/A'})`,
        record.key_finding_1,
      );
    });
  }

  addSectionTitle(doc, 'Decision Capital Register');
  if (!data.decisionCapital.length) {
    doc.fillColor('#334155').fontSize(10).font('Helvetica').text(
      'No confirmed Decision Capital instances have been registered for this quarter.',
      { width: 500 },
    );
  } else {
    data.decisionCapital.forEach((item, index) => {
      addPageIfNeeded(doc);
      const reach = [
        item.financial_value_rand ? `R${Number(item.financial_value_rand).toLocaleString('en-ZA')}` : null,
        item.learners_affected ? `${Number(item.learners_affected).toLocaleString('en-ZA')} learners` : null,
        item.reach_description,
      ].filter(Boolean).join(' · ');
      addWrappedItem(
        doc,
        `${index + 1}. ${item.programme_name || item.organisation || 'Decision Capital instance'} (${formatTier(item.tier)})`,
        [item.description, item.decision_maker ? `Decision maker: ${item.decision_maker}` : null, reach].filter(Boolean).join('\n'),
      );
    });
  }

  doc.moveDown(1.5);
  doc.fillColor('#64748B').fontSize(8).font('Helvetica').text(
    'Generated by Auxeira EvidenceOS. Trustee packs are distributed outside EvidenceOS through existing board communication channels.',
    { width: 500 },
  );

  return pdfToBuffer(doc);
}

async function uploadTrusteePack({ tenant, pdfBuffer, date = reportDate() }) {
  const bucket = tenant.s3_vault_bucket || `auxeira-evidenceos-${tenant.slug}`;
  const key = `exports/reports/trustee-pack-${date}.pdf`;
  const s3 = new S3Client({ region: REGION });

  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: pdfBuffer,
    ContentType: 'application/pdf',
    ServerSideEncryption: 'AES256',
    Metadata: {
      tenant: tenant.slug,
      report_type: 'trustee-pack',
      generated_at: new Date().toISOString(),
    },
  }));

  const downloadUrl = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentType: 'application/pdf',
      ResponseContentDisposition: `attachment; filename="trustee-pack-${date}.pdf"`,
    }),
    { expiresIn: SIGNED_URL_EXPIRES_SECONDS },
  );

  return {
    bucket,
    key,
    download_url: downloadUrl,
    expires_in_seconds: SIGNED_URL_EXPIRES_SECONDS,
  };
}

async function generateTrusteePack({ tenant, date = reportDate() }) {
  const data = await loadTrusteePackData(tenant);
  const pdfBuffer = await renderTrusteePackPdf(data);
  const upload = await uploadTrusteePack({ tenant: data.tenant, pdfBuffer, date });

  return {
    tenant: data.tenant.slug,
    organisation: data.tenant.name,
    evidence_health_score: data.evidenceHealthScore,
    tier_distribution: data.tierDistribution,
    top_tier_1_findings: data.topTierOneFindings.length,
    decision_capital_items: data.decisionCapital.length,
    generated_at: data.generatedAt,
    ...upload,
  };
}

async function handler(event = {}) {
  const tenant = event.tenant || {
    slug: process.env.TENANT || 'zenex',
    db_schema: process.env.DB_SCHEMA || process.env.TENANT || 'zenex',
    s3_vault_bucket: process.env.S3_VAULT_BUCKET,
  };

  return generateTrusteePack({
    tenant,
    date: event.date || reportDate(),
  });
}

module.exports = {
  SIGNED_URL_EXPIRES_SECONDS,
  generateTrusteePack,
  handler,
  loadTrusteePackData,
  renderTrusteePackPdf,
  reportDate,
};
