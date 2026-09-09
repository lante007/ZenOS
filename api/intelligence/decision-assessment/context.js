'use strict';

// api/intelligence/decision-assessment/context.js
//
// AUXEIRA V1.3 Decision Intelligence -- Phase 3: deterministic context
// assembly for one decision_event.
//
// Contract 1 (Input): this module performs deterministic retrieval only,
// based on the id arrays already present in decision_event.inputs
// (signal_ids, decision_ids, outcome_ids, programme_record_ids). It never
// pre-fetches, never searches, never ranks. Institutional memory is
// assembled here strictly as CONTEXT -- it is kept in its own
// `institutionalMemory` field, separate from `evidence`, and is never
// merged into evidence or passed to agents labelled as evidence. External
// intelligence is only ever the QA-cleared subset (via
// scouts/context.js's buildExternalIntelligenceContext), consistent with
// the rest of the codebase -- this module never triggers a new Grok scan.
//
// partial_context semantics (per approved design, diverging deliberately
// from QUESTION-mode's Advisor, which treats missing memory/external-intel
// as a silent non-event): because a Decision Assessment is an actionable
// product (not a conversational answer), ANY of the following sets
// partialContext = true and appends a human-readable reason:
//   - a signal/decision/outcome/programme id that could not be resolved
//   - a schema-level failure hydrating programme records (e.g. the known
//     Optima gap: `optima.intelligence_records` does not exist)
//   - institutional memory lookup failing WHILE the feature flag is ON
//   - external intelligence lookup failing WHILE the feature flag is ON
// A feature flag that is simply OFF is NOT a gap -- it is intended
// configuration, not missing evidence. Partial hydration within a single
// id array is not a hard blocker: whatever resolves is still returned,
// and each unresolved id contributes its own gap reason.
//
// Entity-name extraction for the memory query uses a small, generic
// allowlist of keys (see ENTITY_NAME_KEYS below). This is a known,
// intentional simplification for V1.2 -- a future improvement would be
// per-pathway entity extraction tuned to each pathway's trigger_data
// shape, rather than one generic allowlist shared by all six pathways.

const { getSignalById } = require('../../memory/watchtower');
const { getDecision } = require('../../memory/decisions');
const { getOutcomeById } = require('../../memory/outcomes');
const { getTenantBySlug, getFeatureFlag } = require('../../services/tenants');
const { getPool } = require('../../services/db');
const { buildMemoryContext } = require('../../memory/context');
const { buildExternalIntelligenceContext } = require('../scouts/context');

function uniqueStrings(arr) {
  return [...new Set((arr || []).filter(Boolean).map(String))];
}

async function hydrateSignals(signalIds) {
  const ids = uniqueStrings(signalIds);
  if (!ids.length) return { signals: [], errors: [] };

  const settled = await Promise.allSettled(ids.map((id) => getSignalById(id)));
  const signals = [];
  const errors = [];

  settled.forEach((result, idx) => {
    const id = ids[idx];
    if (result.status === 'fulfilled' && result.value) {
      signals.push(result.value);
    } else if (result.status === 'fulfilled' && !result.value) {
      errors.push({ scope: 'signal', id, message: 'signal not found' });
    } else {
      errors.push({ scope: 'signal', id, message: result.reason && result.reason.message ? result.reason.message : String(result.reason) });
    }
  });

  return { signals, errors };
}

async function hydrateDecisions(tenantSlug, decisionIds) {
  const ids = uniqueStrings(decisionIds);
  if (!ids.length) return { decisions: [], errors: [] };

  const settled = await Promise.allSettled(ids.map((id) => getDecision(tenantSlug, id)));
  const decisions = [];
  const errors = [];

  settled.forEach((result, idx) => {
    const id = ids[idx];
    if (result.status === 'fulfilled' && result.value) {
      decisions.push(result.value);
    } else if (result.status === 'fulfilled' && !result.value) {
      errors.push({ scope: 'decision', id, message: 'decision not found' });
    } else {
      errors.push({ scope: 'decision', id, message: result.reason && result.reason.message ? result.reason.message : String(result.reason) });
    }
  });

  return { decisions, errors };
}

async function hydrateOutcomes(tenantSlug, outcomeIds) {
  const ids = uniqueStrings(outcomeIds);
  if (!ids.length) return { outcomes: [], errors: [] };

  const settled = await Promise.allSettled(ids.map((id) => getOutcomeById(tenantSlug, id)));
  const outcomes = [];
  const errors = [];

  settled.forEach((result, idx) => {
    const id = ids[idx];
    if (result.status === 'fulfilled' && result.value) {
      outcomes.push(result.value);
    } else if (result.status === 'fulfilled' && !result.value) {
      errors.push({ scope: 'outcome', id, message: 'outcome not found' });
    } else {
      errors.push({ scope: 'outcome', id, message: result.reason && result.reason.message ? result.reason.message : String(result.reason) });
    }
  });

  return { outcomes, errors };
}

// Identifier-safety guard for schema-qualified queries. Mirrors the local
// assertSchema() in decision-events/pathways/signal-touches-exposure.js
// exactly, on purpose -- see hydrateProgrammes() below for why.
function assertSchema(schema) {
  const isSafe = /^[a-z][a-z0-9_]*$/.test(schema || '');
  if (isSafe === false) {
    throw new Error(`Unsafe tenant schema: ${schema}`);
  }
  return schema;
}

// Mirrors pathway 1's Half B exactly: a direct, schema-qualified query
// against `${schema}.intelligence_records`. This is deliberately NOT
// services/db.js's getRecordsByIds()/withTenant(), which assumes a single
// shared `public.intelligence_records` table with a `tenant_id` column --
// a different tenancy model that would not reproduce the actual observed
// Optima failure (`relation "optima.intelligence_records" does not
// exist`, a schema-level failure, not a missing-rows-in-a-shared-table
// failure).
async function hydrateProgrammes(tenantSlug, programmeRecordIds) {
  const ids = uniqueStrings(programmeRecordIds);
  if (!ids.length) return { programmes: [], errors: [] };

  const pool = getPool();
  if (!pool) {
    return { programmes: [], errors: [{ scope: 'programme', message: 'Database is not configured' }] };
  }

  try {
    const tenant = await getTenantBySlug(tenantSlug);
    const schema = assertSchema((tenant && tenant.db_schema) || tenantSlug);

    const res = await pool.query(
      `SELECT id, programme_name, canonical_programme_name, total_cost_rand,
              programme_area, year, evidence_gap_1, evidence_gap_2
         FROM ${schema}.intelligence_records
        WHERE id = ANY($1)`,
      [ids],
    );

    const foundIds = new Set(res.rows.map((r) => String(r.id)));
    const errors = ids
      .filter((id) => !foundIds.has(id))
      .map((id) => ({ scope: 'programme', id, message: 'programme record not found' }));

    return { programmes: res.rows, errors };
  } catch (err) {
    return {
      programmes: [],
      errors: [{ scope: 'programme', message: `${tenantSlug}.intelligence_records unavailable -- ${err.message}` }],
    };
  }
}

function deriveEvidenceGaps(programmes) {
  const gaps = [];
  (programmes || []).forEach((p) => {
    if (p.evidence_gap_1) gaps.push(p.evidence_gap_1);
    if (p.evidence_gap_2) gaps.push(p.evidence_gap_2);
  });
  return uniqueStrings(gaps);
}

// Known simplification for V1.2: one generic allowlist shared across all
// six pathways. Future improvement point: per-pathway entity extraction
// tuned to each pathway's own trigger_data shape.
const ENTITY_NAME_KEYS = ['programme_name', 'canonical_programme_name', 'decision', 'title'];

function extractEntityNames(node, out = []) {
  if (!node || typeof node !== 'object') return out;

  if (Array.isArray(node)) {
    node.forEach((item) => extractEntityNames(item, out));
    return out;
  }

  Object.keys(node).forEach((key) => {
    const value = node[key];
    if (ENTITY_NAME_KEYS.includes(key) && typeof value === 'string' && value.trim()) {
      out.push(value.trim());
    } else if (value && typeof value === 'object') {
      extractEntityNames(value, out);
    }
  });

  return out;
}

function buildMemoryQuery(decisionEvent) {
  const entities = extractEntityNames(decisionEvent.trigger_data);
  return [decisionEvent.trigger_explanation || '', ...entities].join(' ').trim();
}

async function hydrateInstitutionalMemory(tenantId, decisionEvent) {
  let flagOn = false;
  try {
    flagOn = await getFeatureFlag(tenantId, 'MEMORY_CONTEXT_ENABLED');
  } catch (err) {
    return { memory: null, errors: [{ scope: 'institutional_memory', message: err.message }] };
  }

  if (!flagOn) {
    return { memory: null, errors: [] };
  }

  try {
    const query = buildMemoryQuery(decisionEvent);
    const memory = await buildMemoryContext({ tenantId, query });
    return { memory, errors: [] };
  } catch (err) {
    return { memory: null, errors: [{ scope: 'institutional_memory', message: err.message }] };
  }
}

async function hydrateExternalIntelligence(tenantId) {
  let flagOn = false;
  try {
    flagOn = await getFeatureFlag(tenantId, 'EXTERNAL_INTELLIGENCE_ENABLED');
  } catch (err) {
    return { externalIntelligence: null, errors: [{ scope: 'external_intelligence', message: err.message }] };
  }

  if (!flagOn) {
    return { externalIntelligence: null, errors: [] };
  }

  try {
    const externalIntelligence = await buildExternalIntelligenceContext({ tenantId });
    return { externalIntelligence, errors: [] };
  } catch (err) {
    return { externalIntelligence: null, errors: [{ scope: 'external_intelligence', message: err.message }] };
  }
}

function humanReadable(err) {
  const scope = err.scope.replace(/_/g, ' ');
  const idPart = err.id ? ` (${err.id})` : '';
  return `${scope}${idPart}: ${err.message}`;
}

async function buildDecisionAssessmentContext(decisionEvent) {
  const tenantSlug = decisionEvent.tenant_id;
  const inputs = decisionEvent.inputs || {};

  const [signalsResult, decisionsResult, outcomesResult, programmesResult, memoryResult, externalIntelResult] =
    await Promise.all([
      hydrateSignals(inputs.signal_ids),
      hydrateDecisions(tenantSlug, inputs.decision_ids),
      hydrateOutcomes(tenantSlug, inputs.outcome_ids),
      hydrateProgrammes(tenantSlug, inputs.programme_record_ids),
      hydrateInstitutionalMemory(tenantSlug, decisionEvent),
      hydrateExternalIntelligence(tenantSlug),
    ]);

  const allErrors = [
    ...signalsResult.errors,
    ...decisionsResult.errors,
    ...outcomesResult.errors,
    ...programmesResult.errors,
    ...memoryResult.errors,
    ...externalIntelResult.errors,
  ];

  return {
    decisionEvent: {
      id: decisionEvent.id,
      tenantId: tenantSlug,
      triggerPathway: decisionEvent.trigger_pathway,
      triggerExplanation: decisionEvent.trigger_explanation,
      triggerData: decisionEvent.trigger_data,
      inputs,
      status: decisionEvent.status,
    },
    evidence: {
      signals: signalsResult.signals,
      decisions: decisionsResult.decisions,
      outcomes: outcomesResult.outcomes,
      programmes: programmesResult.programmes,
    },
    evidenceGaps: deriveEvidenceGaps(programmesResult.programmes),
    institutionalMemory: memoryResult.memory,
    externalIntelligence: externalIntelResult.externalIntelligence,
    partialContext: allErrors.length > 0,
    partialContextReasons: allErrors.map(humanReadable),
  };
}

module.exports = {
  buildDecisionAssessmentContext,
  hydrateSignals,
  hydrateDecisions,
  hydrateOutcomes,
  hydrateProgrammes,
  deriveEvidenceGaps,
  extractEntityNames,
  buildMemoryQuery,
};
