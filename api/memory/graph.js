'use strict';

// api/memory/graph.js
// Intelligence Graph foundation. Relational link table, not a graph database.
// The goal at this stage is connectivity between tenant, organisation,
// person, funder, programme, evidence, evaluation, policy, decision, signal,
// risk, opportunity and research_question - so relevant context can be walked
// one or two hops from a starting node. Tenant-scoped.

const { q, resolveTenant, clampLimit } = require('./util');

const ENTITY_TYPES = ['organisation', 'person', 'funder', 'programme', 'policy', 'evidence', 'evaluation', 'decision', 'signal', 'risk', 'opportunity', 'research_question', 'tenant'];
const NODE_TYPES = ['memory', 'decision', 'signal', 'entity', 'outcome', 'job'];

async function upsertEntity(e) {
  if (!e || !e.entity_type || !e.name) throw Object.assign(new Error('entity_type and name are required'), { status: 400 });
  if (!ENTITY_TYPES.includes(e.entity_type)) throw Object.assign(new Error(`invalid entity_type`), { status: 400 });
  const tenant = e.tenant_id ? await resolveTenant(e.tenant_id) : null;
  const key = (e.canonical_key || e.name).toLowerCase();
  const res = await q(`
    INSERT INTO public.entities (tenant_id, entity_type, name, canonical_key, attributes)
    VALUES ($1,$2,$3,$4,COALESCE($5,'{}'::jsonb))
    ON CONFLICT (COALESCE(tenant_id,'*'), entity_type, COALESCE(canonical_key, lower(name)))
    DO UPDATE SET name = EXCLUDED.name, attributes = public.entities.attributes || EXCLUDED.attributes, updated_at = NOW()
    RETURNING *
  `, [tenant, e.entity_type, e.name, key, e.attributes ? JSON.stringify(e.attributes) : null]);
  return res.rows[0];
}

async function link(tenantSlug, { from_type, from_id, to_type, to_id, relation, weight, evidence }) {
  const tenant = await resolveTenant(tenantSlug);
  if (!NODE_TYPES.includes(from_type) || !NODE_TYPES.includes(to_type)) {
    throw Object.assign(new Error(`from_type/to_type must be one of: ${NODE_TYPES.join(', ')}`), { status: 400 });
  }
  if (!from_id || !to_id || !relation) throw Object.assign(new Error('from_id, to_id and relation are required'), { status: 400 });
  const res = await q(`
    INSERT INTO public.memory_links (tenant_id, from_type, from_id, to_type, to_id, relation, weight, evidence)
    VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,1.0),$8)
    ON CONFLICT (tenant_id, from_type, from_id, to_type, to_id, relation)
    DO UPDATE SET weight = EXCLUDED.weight, evidence = EXCLUDED.evidence
    RETURNING *
  `, [tenant, from_type, from_id, to_type, to_id, relation, weight ?? null, evidence ? JSON.stringify(evidence) : null]);
  return res.rows[0];
}

// One-hop neighbourhood of a node, both directions. Tenant-scoped.
async function neighbours(tenantSlug, nodeType, nodeId, { limit } = {}) {
  const tenant = await resolveTenant(tenantSlug);
  const res = await q(`
    SELECT * FROM public.memory_links
    WHERE tenant_id = $1
      AND ((from_type = $2 AND from_id = $3) OR (to_type = $2 AND to_id = $3))
    ORDER BY weight DESC, created_at DESC
    LIMIT $4
  `, [tenant, nodeType, nodeId, clampLimit(limit, 50, 200)]);
  return res.rows;
}

module.exports = { upsertEntity, link, neighbours, ENTITY_TYPES, NODE_TYPES };
