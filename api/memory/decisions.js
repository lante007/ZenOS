'use strict';

// api/memory/decisions.js
// Structured decision memory. A decision carries revisit_conditions. When a
// new signal matches those conditions the system SURFACES A REVIEW
// RECOMMENDATION and links the signal to the decision. It never silently
// changes a decision.

const { q, resolveTenant, clampLimit } = require('./util');

function rowToDecision(r) {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    decision: r.decision,
    rationale: r.rationale,
    evidence_used: r.evidence_used,
    alternatives: r.alternatives,
    owner: r.owner,
    decision_date: r.decision_date,
    confidence: r.confidence,
    expected_outcome: r.expected_outcome,
    review_date: r.review_date,
    revisit_conditions: r.revisit_conditions || [],
    status: r.status,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

async function createDecision(tenantSlug, d) {
  const tenant = await resolveTenant(tenantSlug);
  if (!d || !d.decision) throw Object.assign(new Error('decision text is required'), { status: 400 });
  const res = await q(`
    INSERT INTO public.decisions
      (tenant_id, decision, rationale, evidence_used, alternatives, owner, decision_date,
       confidence, expected_outcome, review_date, revisit_conditions, status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,'MODERATE'),$9,$10,COALESCE($11,'[]'::jsonb),'ACTIVE')
    RETURNING *
  `, [
    tenant, d.decision, d.rationale || null,
    d.evidence_used ? JSON.stringify(d.evidence_used) : null,
    d.alternatives ? JSON.stringify(d.alternatives) : null,
    d.owner || null, d.decision_date || null,
    d.confidence || null, d.expected_outcome || null, d.review_date || null,
    d.revisit_conditions ? JSON.stringify(d.revisit_conditions) : null,
  ]);
  return rowToDecision(res.rows[0]);
}

async function getDecision(tenantSlug, id) {
  const tenant = await resolveTenant(tenantSlug);
  const res = await q('SELECT * FROM public.decisions WHERE id = $1 AND tenant_id = $2', [id, tenant]);
  return res.rows[0] ? rowToDecision(res.rows[0]) : null;
}

async function listDecisions(tenantSlug, { statuses, limit } = {}) {
  const tenant = await resolveTenant(tenantSlug);
  const where = ['tenant_id = $1'];
  const params = [tenant];
  if (Array.isArray(statuses) && statuses.length) {
    params.push(statuses);
    where.push(`status = ANY($${params.length})`);
  }
  params.push(clampLimit(limit));
  const res = await q(
    `SELECT * FROM public.decisions WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT $${params.length}`,
    params,
  );
  return res.rows.map(rowToDecision);
}

function tokenise(s) {
  return String(s || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];
}

// Given a signal ({ title, summary, change_description, entities }), find
// decisions whose revisit_conditions overlap. Returns [{ decision, matched:
// [{condition, hits}] }]. Pure read — mutates nothing.
async function matchDecisionsForSignal(tenantSlug, signal) {
  const tenant = await resolveTenant(tenantSlug);
  const rows = (await q(
    `SELECT * FROM public.decisions WHERE tenant_id = $1 AND status IN ('ACTIVE','DORMANT','REVIEW_RECOMMENDED')`,
    [tenant],
  )).rows.map(rowToDecision);

  const signalTokens = new Set([
    ...tokenise(signal.title), ...tokenise(signal.summary), ...tokenise(signal.change_description),
  ]);
  const signalEntities = new Set((signal.entities || []).map(e => String(e.name || e).toLowerCase()));

  const matches = [];
  for (const d of rows) {
    const conditionHits = [];
    for (const cond of (d.revisit_conditions || [])) {
      const kw = (cond.keywords || []).map(k => String(k).toLowerCase());
      const ents = (cond.entities || []).map(e => String(e).toLowerCase());
      const kwHit = kw.filter(k => tokenise(k).every(t => signalTokens.has(t)) && kw.length > 0);
      const entHit = ents.filter(e => signalEntities.has(e));
      if (kwHit.length || entHit.length) {
        conditionHits.push({ condition: cond.description || null, keyword_hits: kwHit, entity_hits: entHit });
      }
    }
    // Also a loose textual overlap with the decision itself.
    const decisionTokens = new Set(tokenise(`${d.decision} ${d.rationale} ${d.expected_outcome}`));
    const looseOverlap = [...signalTokens].filter(t => decisionTokens.has(t)).length;
    if (conditionHits.length || looseOverlap >= 3) {
      matches.push({
        decision: d,
        matched_conditions: conditionHits,
        loose_overlap: looseOverlap,
        strength: conditionHits.length ? 'CONDITION_MATCH' : 'TEXTUAL_OVERLAP',
      });
    }
  }
  matches.sort((a, b) => (b.matched_conditions.length - a.matched_conditions.length) || (b.loose_overlap - a.loose_overlap));
  return matches;
}

// Records that a decision should be reviewed because of a signal. Moves the
// decision to REVIEW_RECOMMENDED (reversible) and writes a memory_link. Does
// NOT alter the decision content or outcome.
async function recommendReview(tenantSlug, decisionId, signalId, note) {
  const tenant = await resolveTenant(tenantSlug);
  const dec = await q(
    `UPDATE public.decisions SET status = CASE WHEN status = 'CLOSED' THEN status ELSE 'REVIEW_RECOMMENDED' END, updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [decisionId, tenant],
  );
  if (!dec.rows[0]) return null;
  if (signalId) {
    await q(`
      INSERT INTO public.memory_links (tenant_id, from_type, from_id, to_type, to_id, relation, evidence)
      VALUES ($1,'signal',$2,'decision',$3,'SIGNAL_MAY_AFFECT_DECISION',$4)
      ON CONFLICT (tenant_id, from_type, from_id, to_type, to_id, relation) DO UPDATE SET evidence = EXCLUDED.evidence
    `, [tenant, signalId, decisionId, JSON.stringify({ note: note || null, recommended_at: new Date().toISOString() })]);
  }
  return { decision: rowToDecision(dec.rows[0]), review_recommended: true };
}

module.exports = {
  createDecision, getDecision, listDecisions,
  matchDecisionsForSignal, recommendReview, rowToDecision,
};
