'use strict';
/**
 * ADEI Claude Classifier (Phase B4 rebuild)
 * Two-pass architecture:
 *   Pass 1 - structural extraction (all documents)
 *   Pass 2 - methodological extraction (Impact/Process Evaluation only)
 *   Pass 3 - deterministic validation layer over the combined output
 */

const Anthropic = require('@anthropic-ai/sdk');
const { getPool } = require('../api/services/db');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// claude-sonnet-5 uses extended thinking by default, which prepends a
// `thinking` content block before the `text` block. content[0] is not
// reliably the answer, so find the first text block explicitly.
// (Same convention as api/routes/synthesis.js.)
function extractText(content) {
  const block = (content || []).find(b => b.type === 'text');
  return block?.text || '';
}

// Retained for backward compatibility with callers still using the legacy
// five-way pathway (eqs-scorer.js has its own independent implementation).
function detectEQSPathway(documentType, evaluationSubtype) {
  const dt = (documentType || '').toLowerCase();
  const es = (evaluationSubtype || '').toLowerCase();

  if (dt.includes('impact')) {
    if (es.includes('rct') || es.includes('randomis') || es.includes('quasi')) {
      return { pathway: 'IMPACT_CAUSAL', multiplier: 1.00, label: 'Impact evaluation (causal design)' };
    }
    return { pathway: 'IMPACT_DESCRIPTIVE', multiplier: 0.85, label: 'Impact evaluation (descriptive design)' };
  }
  if (dt.includes('process') || dt.includes('implementation')) {
    return { pathway: 'PROCESS_IMPLEMENTATION', multiplier: 0.75, label: 'Process or implementation evaluation' };
  }
  if (dt.includes('research') || dt.includes('formative') || dt.includes('baseline') || dt.includes('landscape') || dt.includes('literature')) {
    return { pathway: 'FORMATIVE_BASELINE', multiplier: 0.60, label: 'Formative, baseline, or landscape study' };
  }
  return { pathway: 'NOT_APPLICABLE', multiplier: null, label: 'No EQS pathway applicable' };
}

/**
 * Structured excerpt budget (~10000 chars), replacing the old pure
 * head+tail slice. Fixes the B3-flagged truncation bug: tables/notes
 * appended after the body by text-extractor.js were falling entirely
 * outside a pure head(8000)+tail(2000) window for large documents.
 *   - first 4000 chars: intro/abstract
 *   - middle 2000 chars: methods/findings sample
 *   - tables/notes 2000 chars (or a second body sample if none exist)
 *   - last 2000 chars: conclusions
 * Expects the FULL cleaned extracted text, not a pre-truncated slice.
 */
function buildStructuredExcerpt(text) {
  if (text.length <= 10000) return text;

  const tablesIdx = text.indexOf('--- TABLES ---');
  const notesIdx = tablesIdx === -1 ? text.search(/\[NOTES:/) : -1;
  const specialIdx = tablesIdx !== -1 ? tablesIdx : notesIdx;

  const intro = text.substring(0, 4000);
  const conclusion = text.substring(text.length - 2000);

  const bodyEnd = specialIdx !== -1 ? specialIdx : text.length - 2000;
  const middleStart = Math.max(4000, Math.floor(bodyEnd / 2) - 1000);
  const middle = text.substring(middleStart, middleStart + 2000);

  let special;
  let specialLabel;
  if (specialIdx !== -1) {
    special = text.substring(specialIdx, specialIdx + 2000);
    specialLabel = 'TABLES/NOTES SAMPLE';
  } else {
    const secondStart = Math.max(middleStart + 2000, Math.floor(bodyEnd * 0.75));
    special = text.substring(secondStart, secondStart + 2000);
    specialLabel = 'ADDITIONAL SAMPLE';
  }

  return [
    intro,
    '\n\n[...METHODS/FINDINGS SAMPLE...]\n\n',
    middle,
    `\n\n[...${specialLabel}...]\n\n`,
    special,
    '\n\n[...CONCLUSION...]\n\n',
    conclusion,
  ].join('');
}

function parseJsonResponse(rawContent) {
  const clean = rawContent.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  try {
    return JSON.parse(clean);
  } catch (err) {
    throw new Error(`Claude returned invalid JSON: ${err.message}\nRaw: ${rawContent.substring(0, 200)}`);
  }
}

function usageFrom(message, prompt, rawContent, startTime) {
  return {
    model: 'claude-sonnet-4-6',
    input_tokens: message.usage.input_tokens,
    output_tokens: message.usage.output_tokens,
    input_words: prompt.split(/\s+/).filter(Boolean).length,
    output_words: rawContent.split(/\s+/).filter(Boolean).length,
    latency_ms: Date.now() - startTime,
    bedrock_agent: false,
  };
}

// ─── Pass 1: Structural Extraction ─────────────────────────────────────

const PASS1_SYSTEM_PROMPT = `You are an expert evaluator of South African education research documents. Extract structured metadata from the document provided. Return ONLY valid JSON exactly matching the schema below. Never fabricate data. If a field cannot be found explicitly in the document, return null for that field. Do not infer or guess.`;

const PASS1_SCHEMA = `{
  "document_type": "Impact Evaluation | Process Evaluation | Research Study | Literature Review | Annual Report | Budget Document",
  "secondary_document_type": "Same enum values as document_type, or null. INSTRUCTION: If this document explicitly conducts BOTH an impact evaluation AND a process evaluation, set document_type to the dominant methodology and set secondary_document_type to the other. Never create a value outside this enum.",
  "evaluation_subtype": "string describing the evaluation approach",
  "programme_name": "exact name as stated in the document",
  "canonical_programme_name": "normalised programme name without acronyms, abbreviations, or year suffixes",
  "phase": "ECD | Foundation Phase | Intermediate Phase | Senior Phase | FET | System-Wide | Cross-Phase",
  "year": "integer: year evaluation was completed",
  "baseline_year": "integer or null",
  "endline_year": "integer or null",
  "provinces": ["array of values from this exact list only: Eastern Cape | Free State | Gauteng | KwaZulu-Natal | Limpopo | Mpumalanga | Northern Cape | North West | Western Cape. If the document is genuinely nationally-scoped (covers the whole country, not tied to specific provinces), list all nine of the above explicitly. Never output the word National or any value outside this list."],
  "districts": ["array of district names or empty array"],
  "grades": ["array e.g. Grade 1, Grade 2"],
  "subject_area": "Mathematics | Literacy | Language | Science | Multi-subject | null",
  "sample_size_learners": "integer or null",
  "sample_size_schools": "integer or null",
  "sample_size_teachers": "integer or null",
  "unit_of_analysis": "Learner | School | Teacher | District | System | null",
  "population_served": "brief description or null",
  "implementing_organisation_name": "string or null",
  "external_evaluator": "true | false | null",
  "publication_status": "Published | Unpublished | Grey Literature",
  "funder_names": ["array or empty array"],
  "record_series": "BASELINE | MIDLINE | ENDLINE | FOLLOW_UP | STANDALONE",
  "parent_document_hint": "If this appears to be a sub-report or component of a larger evaluation series, describe the parent evaluation briefly. Otherwise null.",
  "eqs_pathway": "IMPACT | PROCESS | RESEARCH",
  "confidence_scores": {
    "document_type": "float 0.0 to 1.0",
    "programme_name": "float 0.0 to 1.0",
    "year": "float 0.0 to 1.0"
  }
}`;

async function classifyPass1({ filename, text, programme, role, phase, institution }) {
  const excerpt = buildStructuredExcerpt(text);
  const userPrompt = `Institution: ${institution || 'the client organisation'}
Filename: ${filename}
Programme (pre-detected, may be wrong): ${programme || 'Unknown'}
Role (pre-detected): ${role || 'standalone'}
Phase (pre-detected): ${phase || 'Unknown'}

Return JSON matching exactly this schema:
${PASS1_SCHEMA}

DOCUMENT TEXT:
${excerpt}`;

  const startTime = Date.now();
  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 3000,
    temperature: 0,
    system: PASS1_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const rawContent = message.content[0].text;
  const parsed = parseJsonResponse(rawContent);

  return {
    pass1: parsed,
    usage: usageFrom(message, userPrompt, rawContent, startTime),
  };
}

// ─── Pass 2: Methodological Extraction ─────────────────────────────────
// Only runs for document_type Impact Evaluation or Process Evaluation.

const PASS2_SYSTEM_PROMPT = `You are a senior methodologist reviewing a South African education evaluation. You have been provided the full document text and an initial structural classification. Extract methodological details with precision. Return ONLY valid JSON. Return null for any field not explicitly stated in the document. Do not infer or estimate.`;

const PASS2_SCHEMA = `{
  "evaluation_design": "RCT | Quasi-Experimental | Pre-Post Without Comparison | Cross-Sectional | Longitudinal Panel | Qualitative | Mixed Methods",
  "comparison_group": "Randomised | Matched Statistical | Convenience | Self-Selected | None",
  "has_control_group": "true | false",
  "baseline_available": "true | false",
  "endline_available": "true | false",
  "methodology_description": "2-4 sentence summary of research design and methods",
  "data_sources": ["array: e.g. EGRA, EGMA, teacher observation, admin records"],
  "key_finding_1": "primary finding stated as a clear evidence claim. Must not be a placeholder. Null if no clear finding.",
  "key_finding_2": "string or null",
  "key_finding_3": "string or null",
  "null_findings_reported": "true | false",
  "non_significant_variables": "string describing what was tested but showed no effect, or null",
  "effect_size_composite": "string describing effect size with units e.g. 0.3 SD improvement, or null",
  "effect_direction": "Positive | Negative | Mixed | Null Finding",
  "limitations": "string summarising stated limitations, or null",
  "replication_conditions": "string describing conditions needed for replication, or null",
  "cost_data_present": "AUDITED | PROXY | ABSENT",
  "cost_data_source": "string or null",
  "theory_of_change_explicit": "true | false",
  "fidelity_reported": "true | false",
  "dosage_documented": "true | false",
  "equity_considerations": "string or null",
  "policy_relevance_score": "integer 1 to 5",
  "strategic_value_score": "integer 1 to 5",
  "nls_alignment": "true | false | null",
  "funrs_alignment": "true | false | null",
  "dbe_adoption_status": "ADOPTED | PILOTED | REFERENCED | NONE",
  "commissioning_standards_met": "true | false | null",
  "confidence_scores": {
    "evaluation_design": "float 0.0 to 1.0",
    "key_finding_1": "float 0.0 to 1.0",
    "effect_size_composite": "float 0.0 to 1.0"
  }
}`;

const PASS2_ELIGIBLE_TYPES = ['Impact Evaluation', 'Process Evaluation'];

function needsPass2(pass1DocumentType) {
  return PASS2_ELIGIBLE_TYPES.includes(pass1DocumentType);
}

// The Pass 2 schema shows booleans as quoted "true | false" (a string enum
// to the model), so Claude reliably returns JSON strings rather than JSON
// booleans for these fields. Coerce them back to real booleans so strict
// equality checks in validateClassification() work correctly.
const BOOLEAN_FIELDS_PASS2 = [
  'has_control_group',
  'baseline_available',
  'endline_available',
  'null_findings_reported',
  'theory_of_change_explicit',
  'fidelity_reported',
  'dosage_documented',
  'nls_alignment',
  'funrs_alignment',
  'commissioning_standards_met',
  'external_evaluator',
];

function normaliseBooleans(obj) {
  if (!obj) return obj;
  const result = { ...obj };
  BOOLEAN_FIELDS_PASS2.forEach(field => {
    if (result[field] === 'true') result[field] = true;
    else if (result[field] === 'false') result[field] = false;
    else if (result[field] === 'null' || result[field] === 'NULL') result[field] = null;
  });
  return result;
}

async function classifyPass2({ text, pass1 }) {
  const excerpt = buildStructuredExcerpt(text);
  const userPrompt = `Initial classification:
${JSON.stringify(pass1, null, 2)}

Now extract methodological fields. Return JSON matching exactly this schema:
${PASS2_SCHEMA}

DOCUMENT TEXT:
${excerpt}`;

  const startTime = Date.now();
  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    temperature: 0,
    system: PASS2_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const rawContent = message.content[0].text;
  const parsed = normaliseBooleans(parseJsonResponse(rawContent));

  return {
    pass2: parsed,
    usage: usageFrom(message, userPrompt, rawContent, startTime),
  };
}

// ─── Pass 3: Validation Layer ──────────────────────────────────────────
// Pure function - no DB/network side effects. Returns flags for the
// caller (pipeline.js, Phase B6) to persist via db.createAuditLog() and
// to attach to the record's validation_flags JSONB column.

const PLACEHOLDER_FINDINGS = [
  'not applicable', 'n/a', 'none reported', 'no finding',
  'not recorded', 'not captured', 'no primary finding',
  'no secondary finding', 'no tertiary finding',
];

function validateClassification(pass1, pass2, extractionQuality) {
  const flags = [];
  const docType = pass1 && pass1.document_type;

  if (PASS2_ELIGIBLE_TYPES.includes(docType) && !(pass2 && pass2.evaluation_design)) {
    flags.push({
      field: 'evaluation_design',
      rule: 'REQUIRED_FOR_TYPE',
      action: 'FLAG_FOR_MANUAL',
      message: `${docType} requires evaluation_design`,
    });
  }

  if (pass2 && pass2.has_control_group === true && !pass2.comparison_group) {
    flags.push({
      field: 'comparison_group',
      rule: 'REQUIRED_WITH_CONTROL',
      action: 'FLAG_FOR_MANUAL',
      message: 'has_control_group is true but comparison_group is null',
    });
  }

  ['key_finding_1', 'key_finding_2', 'key_finding_3'].forEach(fieldName => {
    const raw = pass2 && pass2[fieldName];
    const val = raw && String(raw).toLowerCase().trim();
    if (val && PLACEHOLDER_FINDINGS.some(ph => val.includes(ph))) {
      if (pass2) pass2[fieldName] = null;
      flags.push({
        field: fieldName,
        rule: 'PLACEHOLDER_CLEARED',
        action: 'CLEARED',
        message: 'Placeholder string removed',
      });
    }
  });

  if (extractionQuality === 'LOW' || extractionQuality === 'NEEDS_OCR') {
    flags.push({
      field: 'eqs_tier',
      rule: 'LOW_SOURCE_QUALITY',
      action: 'CAP_AT_TIER_2',
      message: `Source quality is ${extractionQuality}: EQS capped at Tier 2`,
    });
  }

  if (docType === 'Impact Evaluation' && !(pass2 && pass2.evaluation_design)) {
    flags.push({
      field: 'eqs_tier',
      rule: 'MISSING_DESIGN_FOR_IMPACT',
      action: 'CAP_AT_TIER_2',
      message: 'Impact Evaluation without evaluation_design: EQS capped at Tier 2',
    });
  }

  if (extractionQuality === 'FAILED') {
    flags.push({
      field: 'board_citable',
      rule: 'FAILED_EXTRACTION',
      action: 'SET_FALSE',
      message: 'Extraction failed: not board-citable',
    });
  }

  return flags;
}

// ─── Merge ──────────────────────────────────────────────────────────────
// Combines pass1 + pass2 + validation flags into one record object ready
// for db.createRecord(). CAP_AT_TIER_2 is not applied here directly (EQS
// tiering happens in eqs-scorer.js) - it's passed through as a flag for
// computeEQS() to honour, per the B4/B5 split.

function mergeClassification(pass1, pass2, flags) {
  const merged = {
    ...pass1,
    ...(pass2 || {}),
    validation_flags: flags,
  };

  // Pass 1 and Pass 2 each return their own confidence_scores object;
  // combine both rather than letting the pass2 spread above clobber pass1's.
  merged.confidence_scores = {
    ...((pass1 && pass1.confidence_scores) || {}),
    ...((pass2 && pass2.confidence_scores) || {}),
  };

  for (const flag of flags) {
    if (flag.action === 'SET_FALSE' && flag.field === 'board_citable') {
      merged.board_citable = false;
    }
  }

  const pathwayInfo = detectEQSPathway(merged.document_type, merged.evaluation_subtype);
  merged.eqs_pathway = merged.eqs_pathway || pathwayInfo.pathway;
  merged.eqs_version = 'v2.0';
  merged.scoring_logic_version = 'v2.0';

  return merged;
}

// ─── Knowledge Products Phase A: canonical synthesis + CEO transformer ──
// Two-stage architecture: record → canonical evidence synthesis (once,
// cached, keyed to record_version) → persona transformer reads the cached
// synthesis and reshapes it, never re-deriving evidence. Only the CEO
// persona is wired to this new path in Phase A; the other five audiences
// remain on the legacy single-prompt flat-text path in
// generateKnowledgeProduct() below until Phase B/C.

const CANONICAL_SYNTHESIS_SYSTEM_PROMPT = `You are performing the canonical evidence synthesis for a single Zenex evaluation record. This synthesis will be reused by six different audience-specific knowledge products. It must be the single source of truth for what this record shows. No persona-specific framing yet.

HARD RULES (apply all of these to this single-record synthesis):

RULE 1 SCOPE: The scope of every claim must not exceed the scope of the evidence in this record. Do not generalise beyond what this specific evaluation tested.

RULE 2 CAUSALITY: Do not use necessary, sufficient, required, drives, active ingredient, or equivalent causal language unless the study design directly supports it. Use associated with, linked to, consistent with, may contribute to for associative, observational, qualitative, pre-post, or quasi-experimental evidence.

RULE 3 HETEROGENEITY: Differing results within this record (by subgroup, geography, timepoint) are heterogeneity, not contradiction, unless genuinely incompatible. Explain plausible moderators.

RULE 5 DECISION BOUNDARY: Distinguish what this evidence supports deciding from what it does not yet support, and what additional evidence would reduce uncertainty.

RULE 6 ACTION: Do not manufacture a next step if the evidence does not support one.

RULE 12: Never present absence of evidence as evidence of absence.

RULE 13: Never convert association into causation.

Do not cite internal scoring weights, formula components, or numeric fields you cannot explain in plain language. If a number's meaning is not self-evident from context, omit it rather than state it.

EVIDENCE_CURRENCY_DETAIL INSTRUCTIONS: In addition to the free-text evidence_currency assessment inside evidence_boundary, provide a structured currency signal. years_since_evidence is the number of whole years between the evidence's collection/endline date and today, or null if genuinely undeterminable from the record. currency_band is CURRENT for evidence less than roughly 2 years old, AGING for roughly 2 to 5 years old, and DATED for older than roughly 5 years or where programme/context has materially changed since. newer_evidence_exists is true only if the record itself references a more recent evaluation or data collection round, false if it explicitly does not, and unknown if the record gives no basis to determine this either way. Do not guess; use unknown rather than fabricate a determination the record does not support.

Return a single complete valid JSON object with this exact shape. Begin with { and end with }. No markdown, no preamble.

{
  "record_id": "",
  "programme_name": "",
  "evidence_boundary": {
    "scope": "",
    "evidence_stage": "baseline | midline | endline | follow-up | longitudinal | unknown",
    "evidence_currency": "year and age assessment",
    "study_design": "",
    "population_context": ""
  },
  "evidence_currency_detail": {
    "years_since_evidence": null,
    "currency_band": "CURRENT | AGING | DATED",
    "newer_evidence_exists": "true | false | unknown"
  },
  "claims": [
    {
      "claim": "",
      "confidence": "HIGH | MODERATE | LOW | INSUFFICIENT",
      "evidence_basis": "",
      "qualifications": [],
      "capital_implication": ""
    }
  ],
  "heterogeneity": [],
  "limitations": [
    {
      "issue": "",
      "severity": "HIGH | MODERATE | LOW",
      "decision_relevance": ""
    }
  ],
  "decision_boundary": {
    "supported": [],
    "not_yet_supported": [],
    "evidence_needed": []
  },
  "transferability": {
    "demonstrated_in": [],
    "uncertain_for": []
  },
  "implementation_conditions": {
    "fidelity": "",
    "dosage": "",
    "support_requirements": "",
    "contextual_factors": ""
  },
  "cost_and_value": {
    "known": [],
    "unknown": []
  },
  "open_questions": [],
  "financial_capital": null,
  "evidence_capital_note": ""
}`;

/**
 * Canonical evidence synthesis for a single record. Runs ONCE per record
 * (cached in zenex.canonical_synthesis, keyed to tenant + record + the
 * record's updated_at/created_at version so a re-classification
 * invalidates the cache). This is NOT persona-shaped; it is the raw
 * material every audience transformer reads from.
 */
async function generateCanonicalSynthesis(record, tenantId) {
  const pool = getPool();
  if (!pool) throw new Error('DATABASE_URL not configured: cannot read/write canonical_synthesis cache');

  const recordVersion = record.updated_at || record.created_at;

  const cached = await pool.query(
    `SELECT synthesis FROM zenex.canonical_synthesis
     WHERE tenant_id=$1 AND record_id=$2 AND record_version=$3`,
    [tenantId, record.id, recordVersion]
  );
  if (cached.rowCount > 0) {
    return cached.rows[0].synthesis;
  }

  // Explicit allowlist of evidence-content fields only. Excludes internal
  // EQS scoring/weight fields (policy_relevance_weight, policy_relevance_score,
  // half_life_weight, dim_* rigour/quality dimension scores, etc) that exist
  // on the raw record but are formula components, not evidence content --
  // passing them here previously let the model cite them in prose (e.g.
  // "policy alignment (0.80)") without any instruction on how to interpret
  // or explain them. Superset of synthesis.js's buildCorpusSummary allowlist
  // (adds total_cost_rand, sample_size_learners, comparison_group, which
  // Knowledge Products' capital_accountability/decision_boundary sections
  // require but Ask Zenex's cross-corpus summary does not).
  const canonicalSynthesisInput = {
    id: record.id,
    programme_name: record.programme_name,
    document_type: record.document_type,
    evaluation_subtype: record.evaluation_subtype,
    key_finding_1: record.key_finding_1,
    key_finding_2: record.key_finding_2,
    key_finding_3: record.key_finding_3,
    eqs_composite: record.eqs_composite,
    eqs_tier: record.eqs_tier,
    phase: record.phase,
    provinces: record.provinces,
    year: record.year,
    methodology_description: record.methodology_description,
    evidence_gap_1: record.evidence_gap_1,
    effect_size_composite: record.effect_size_composite,
    effect_direction: record.effect_direction,
    implementing_organisation_name: record.implementing_organisation_name,
    responsible_pm: record.responsible_pm,
    baseline_available: record.baseline_available,
    endline_available: record.endline_available,
    total_cost_rand: record.total_cost_rand,
    sample_size_learners: record.sample_size_learners,
    comparison_group: record.comparison_group,
  };

  const msg = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 8000,
    system: CANONICAL_SYNTHESIS_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `Record: ${JSON.stringify(canonicalSynthesisInput)}`,
    }],
  });

  const text = extractText(msg.content);
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Canonical synthesis: no JSON object found in Claude response. Raw: ${text.substring(0, 200)}`);
  const synthesis = JSON.parse(match[0]);

  await pool.query(
    `INSERT INTO zenex.canonical_synthesis (tenant_id, record_id, record_version, synthesis)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (tenant_id, record_id, record_version)
     DO UPDATE SET synthesis = EXCLUDED.synthesis`,
    [tenantId, record.id, recordVersion, JSON.stringify(synthesis)]
  );

  return synthesis;
}

/**
 * Shared structural validator for Knowledge Product transformer output.
 * Modelled on api/routes/synthesis.js's validateAndRepair pattern, but
 * generalised across personas: takes a parsed (syntactically valid) JSON
 * object and a list of required top-level fields for that audience's
 * schema, and confirms none of them are missing, null, or empty. This is
 * a distinct failure mode from raw JSON parse failure (malformed JSON
 * syntax) -- that is handled separately, inside each transformer, before
 * this validator ever runs. This validator catches syntactically valid
 * JSON that is nonetheless structurally incomplete (e.g. the model
 * silently dropped a required field), which would otherwise reach the
 * frontend looking superficially fine but missing content.
 *
 * One repair attempt via haiku, same convention as the existing raw-JSON
 * repair fallback already inside each transformer.
 */
function isFieldMissing(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string' && value.trim() === '') return true;
  if (Array.isArray(value) && value.length === 0) return true;
  if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) return true;
  return false;
}

// Checks whether `value` matches the shape of `expectedShape` (an example
// object whose keys are the required keys for that field, e.g.
// { evidence_status: 'string', ... }). Only used for fields that have an
// entry in fieldShapes; fields without an entry are presence-only (checked
// by isFieldMissing alone). Does not check value types recursively, only
// that `value` is a non-array object containing all of expectedShape's keys
// -- sufficient to catch the observed failure mode (a required object field
// coming back as a plain string).
function shapeMismatch(value, expectedShape) {
  if (!expectedShape) return false;
  if (typeof value !== 'object' || Array.isArray(value) || value === null) return true;
  const expectedKeys = Object.keys(expectedShape);
  const actualKeys = Object.keys(value);
  const missingKeys = expectedKeys.filter(k => !actualKeys.includes(k));
  return missingKeys.length > 0;
}

async function validateKnowledgeProductSchema(parsed, requiredFields, audienceLabel, rawText, client, fieldShapes = {}) {
  const missing = requiredFields.filter(f =>
    isFieldMissing(parsed?.[f]) || shapeMismatch(parsed?.[f], fieldShapes[f])
  );

  if (missing.length === 0) {
    return { valid: true, data: parsed, repaired: false };
  }

  console.warn(`Knowledge Product schema incomplete for ${audienceLabel}: missing [${missing.join(', ')}]. Attempting repair.`);

  try {
    const shapeHints = missing
      .filter(f => fieldShapes[f])
      .map(f => `${f} must be an object with this exact shape: ${JSON.stringify(fieldShapes[f])}`)
      .join('\n');

    const system = `You are a JSON repair tool. The following JSON object is missing required fields: ${missing.join(', ')}.
${shapeHints ? '\n\nShape requirements for object/array fields:\n' + shapeHints : ''}
Return the complete corrected JSON object with all missing fields populated based on the content already present in the object, respecting the exact shape given above for any field listed. No markdown, no explanation, raw JSON only.`;

    const repair = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8000,
      temperature: 0,
      system,
      messages: [{
        role: 'user',
        content: JSON.stringify(parsed),
      }],
    });
    const repairText = (repair.content || []).find(b => b.type === 'text')?.text || '';
    const m = repairText.match(/\{[\s\S]*\}/);
    const repaired = JSON.parse(m[0]);

    const stillMissing = requiredFields.filter(f =>
      isFieldMissing(repaired?.[f]) || shapeMismatch(repaired?.[f], fieldShapes[f])
    );

    if (stillMissing.length === 0) {
      return { valid: true, data: repaired, repaired: true };
    }

    return { valid: false, data: repaired, repaired: true, stillMissing };
  } catch (e) {
    return { valid: false, data: parsed, repaired: false, error: e.message };
  }
}

const CEO_REQUIRED_FIELDS = [
  'bottom_line', 'decision_chain', 'evidence_quality_note', 'decision_utility',
  'decision_boundary', 'strategic_risks', 'capital_view', 'leadership_questions',
];

const TRUSTEE_REQUIRED_FIELDS = [
  'bottom_line', 'evidence_estate_health', 'capital_accountability', 'key_institutional_findings',
  'material_risks_for_board_attention', 'decision_boundary', 'continuity_and_learning', 'board_consideration',
  'governance_signal',
];

// Only fields whose value must be an object/array with specific keys need
// an entry here; simple string fields are covered by isFieldMissing alone.
// Used by validateKnowledgeProductSchema's repair path so the repair model
// knows the exact nested shape to restore, not just that the field is
// missing (e.g. governance_signal must come back as a 5-key object, not a
// plain string).
const CEO_FIELD_SHAPES = {
  decision_utility: {
    for_implementation_design: 'string',
    for_capital_allocation: 'string',
  },
  capital_view: {
    financial_capital: 'string',
    evidence_capital: 'string',
    decision_capital: 'string',
  },
  decision_boundary: {
    supported: [],
    not_yet_supported: [],
    evidence_needed_to_decide: [],
  },
};

const TRUSTEE_FIELD_SHAPES = {
  evidence_estate_health: {
    coverage: 'string',
    quality: 'string',
    currency: 'string',
    utilisation: 'string',
  },
  capital_accountability: {
    financial_capital: 'string',
    evidence_capital: 'string',
    decision_capital: 'string',
    accountability_gap: 'string',
  },
  decision_boundary: {
    supported: [],
    not_yet_supported: [],
  },
  continuity_and_learning: {
    evidence_age: 'string',
    learning_compounding: 'string',
    unresolved_legacy_questions: [],
  },
  governance_signal: {
    evidence_status: 'string',
    financial_accountability: 'string',
    causal_confidence: 'string',
    continuity: 'string',
    primary_board_question: 'string',
  },
};

const DBE_NATIONAL_REQUIRED_FIELDS = [
  'bottom_line', 'system_signal', 'what_the_evidence_shows',
  'scalability_and_transferability', 'policy_relevant_gaps', 'decision_boundary',
  'possible_collaboration_or_evidence_sharing',
];

const DBE_NATIONAL_FIELD_SHAPES = {
  system_signal: {
    evidence_confidence: 'string',
    evidence_currency: 'string',
    evidence_stage: 'string',
    transferability: 'string',
  },
  scalability_and_transferability: {
    demonstrated: [],
    uncertain: [],
    evidence_needed: [],
  },
  decision_boundary: {
    supported: [],
    not_yet_supported: [],
  },
};

const PROVINCIAL_HOD_REQUIRED_FIELDS = [
  'bottom_line', 'provincial_evidence_signal', 'key_findings',
  'implementation_conditions', 'provincial_variation', 'transferability_risks',
  'decision_boundary', 'adoption_or_adaptation_considerations',
];

const PROVINCIAL_HOD_FIELD_SHAPES = {
  provincial_evidence_signal: {
    evidence_confidence: 'string',
    province_coverage: 'string',
    evidence_currency: 'string',
    transferability: 'string',
  },
  implementation_conditions: {
    fidelity: 'string',
    dosage: 'string',
    support_requirements: 'string',
    contextual_conditions: 'string',
  },
  decision_boundary: {
    supported: [],
    not_yet_supported: [],
    evidence_needed_before_adoption: [],
  },
};

const CO_FUNDER_REQUIRED_FIELDS = [
  'bottom_line', 'evidence_signal', 'evidence_strength', 'cost_and_value_evidence',
  'additionality', 'decision_boundary', 'joint_learning_or_commissioning_options',
];

const CO_FUNDER_FIELD_SHAPES = {
  evidence_signal: {
    strength: 'string',
    confidence: 'string',
    currency: 'string',
    evidence_stage: 'string',
  },
  evidence_strength: {
    strongest_support: [],
    mixed_or_limited_evidence: [],
    important_unknowns: [],
  },
  cost_and_value_evidence: {
    known: [],
    unknown: [],
    evidence_needed: [],
  },
  additionality: {
    potential: 'string',
    evidence: 'string',
    uncertainty: 'string',
  },
  decision_boundary: {
    supported: [],
    not_yet_supported: [],
    evidence_needed: [],
  },
};

const SECTOR_PEER_REQUIRED_FIELDS = [
  'bottom_line', 'evidence_signal', 'what_the_evidence_shows',
  'positive_and_null_or_mixed_findings', 'limitations_and_uncertainties', 'decision_boundary',
];

const SECTOR_PEER_FIELD_SHAPES = {
  evidence_signal: {
    overall_confidence: 'string',
    evidence_currency: 'string',
    evidence_stage: 'string',
    methodological_strength: 'string',
  },
  positive_and_null_or_mixed_findings: {
    positive: [],
    null: [],
    mixed: [],
  },
  decision_boundary: {
    supported: [],
    not_yet_supported: [],
  },
};

/**
 * CEO persona transformer. Takes the cached canonical synthesis (never the
 * raw record) and reshapes it into the CEO Evidence Brief schema. Does not
 * re-read the source document or re-derive evidence; may only select,
 * prioritise, reword, and contextualise what is already in `synthesis`.
 */
async function transformToCEOBrief(synthesis, recordMeta) {
  const system = `You are transforming an existing, fixed evidence synthesis into a CEO Evidence Brief for Zenex leadership.

CRITICAL: You are NOT performing new evidence synthesis. You are NOT permitted to introduce claims, confidence levels, or findings that are not already present in the canonical synthesis object below. You may select, prioritise, reword, and contextualise. You may not invent or strengthen.

Your purpose is to make the decision boundary visible, not to make the decision for the CEO.

Prioritise: portfolio implications, evidence confidence, capital implications, material risks, evidence gaps, sequencing considerations, uncertainty that could materially change a decision.

Do not prescribe that the CEO should fund, scale, pause, exit or commission something. Instead, identify decision options or questions the evidence now legitimately surfaces for leadership consideration.

Minimise methodological detail unless it materially affects the decision.

Do not frame any programme as ready for scale unless the decision_boundary in the canonical synthesis explicitly supports that interpretation.

DECISION_CHAIN INSTRUCTIONS: Produce one decision_chain entry per materially distinct finding in the canonical synthesis (typically 2 to 4). Do not merge unrelated findings into one chain entry. Each entry must follow the sequence evidence, then confidence, then boundary, then implication, then decision_question, in that order, and each field must be one to two sentences, not a paragraph. The decision_question field must be an actual question ending in a question mark, not a restated recommendation.

LEADERSHIP_QUESTIONS INSTRUCTIONS: Classify each question you generate into exactly one of three groups. decision_critical: questions that must be answered before any capital or scale-up decision. evidence_building: questions about sustainability, mechanism, or further validation that matter but do not block an immediate decision. transferability: questions about whether findings apply beyond the sampled context, such as geography, quintile, or population. Base the classification on whether the question must be resolved before a capital decision, whether it concerns durability or mechanism, or whether it concerns generalising beyond the tested context.

CAPITAL_VIEW INSTRUCTIONS: financial_capital must state what cost or value comparison becomes possible or impossible as a direct consequence of what financial data does or does not exist in this record. Do not merely state that data is missing; state the decision-relevant consequence of that gap. evidence_capital must summarise the evidence base's rigour, data quality, transparency, replicability, and causal identification in one to two sentences, in plain language, not by repeating the EQS score. decision_capital must end with an explicit statement of what this record can and cannot independently justify deciding. This is the anti-promotional rule: never imply that this record alone should trigger a scale-up, continuation, or capital allocation decision unless the decision_boundary explicitly supports that interpretation.

EVIDENCE_QUALITY_NOTE AND DECISION_UTILITY INSTRUCTIONS: evidence_quality_note must state the EQS tier and composite score, and explicitly note that this is a single composite covering rigour, data quality, transparency, replicability, and context relevance, and does NOT mean uniform confidence across every individual finding. decision_utility must be assessed separately for for_implementation_design and for_capital_allocation since they typically differ; a record can be highly useful for informing delivery design while being low utility for a funding decision. Do not add a single merged decision utility field. Do not add a field such as confidence_by_finding since per-finding confidence already lives inside each decision_chain entry; do not duplicate it.

Return a single complete valid JSON object with this exact shape. Begin with { and end with }. No markdown, no preamble.

{
  "audience": "CEO",
  "external_use": false,
  "title": "",
  "date": "",
  "executive_signal": {
    "evidence_confidence": "HIGH | MODERATE | LOW | INSUFFICIENT",
    "evidence_currency": "",
    "evidence_stage": "",
    "evidence_health_signal": ""
  },
  "bottom_line": "3-5 sentences",
  "decision_chain": [
    {
      "evidence": "One finding, stated plainly.",
      "confidence": "HIGH | MODERATE | LOW",
      "boundary": "What this finding does NOT yet establish or does not extend to.",
      "implication": "What this boundary suggests about the underlying mechanism or programme theory, stated as a possibility not a fact.",
      "decision_question": "The specific question this finding raises for leadership, phrased as a question."
    }
  ],
  "evidence_quality_note": "",
  "decision_utility": {
    "for_implementation_design": "HIGH | MODERATE | LOW",
    "for_capital_allocation": "HIGH | MODERATE | LOW"
  },
  "decision_boundary": {
    "supported": [],
    "not_yet_supported": [],
    "evidence_needed_to_decide": []
  },
  "strategic_risks": [],
  "capital_view": {
    "financial_capital": "",
    "evidence_capital": "",
    "decision_capital": ""
  },
  "leadership_questions": {
    "decision_critical": [],
    "evidence_building": [],
    "transferability": []
  },
  "sources_summary": ""
}

CANONICAL SYNTHESIS (source of truth, do not contradict or extend):
${JSON.stringify(synthesis)}`;

  const msg = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 8000,
    system,
    messages: [{
      role: 'user',
      content: 'Generate the CEO Evidence Brief.',
    }],
  });

  const text = extractText(msg.content);
  const match = text.match(/\{[\s\S]*\}/);
  let parsed = null;
  try {
    if (!match) throw new Error('No JSON object found in response');
    parsed = JSON.parse(match[0]);
  } catch (err) {
    // One repair attempt via haiku, same convention as
    // api/routes/synthesis.js validateAndRepair().
    const repair = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 6000,
      system: 'Return only valid complete JSON. No markdown.',
      messages: [{
        role: 'user',
        content: 'Repair this JSON: ' + text.slice(0, 8000),
      }],
    });
    const repairText = extractText(repair.content);
    const repairMatch = repairText.match(/\{[\s\S]*\}/);
    if (!repairMatch) throw new Error(`CEO brief JSON repair failed. Raw: ${repairText.substring(0, 200)}`);
    parsed = JSON.parse(repairMatch[0]);
  }

  const validated = await validateKnowledgeProductSchema(parsed, CEO_REQUIRED_FIELDS, 'CEO', text, client, CEO_FIELD_SHAPES);
  if (!validated.valid) {
    // Log loudly, this should never reach a user silently broken.
    console.error(`CEO brief validation FAILED for record ${recordMeta.id} after repair attempt. Missing: ${validated.stillMissing?.join(', ')}`);
  }
  return validated.data;
}

/**
 * Trustee persona transformer. Takes the cached canonical synthesis (never
 * the raw record) and reshapes it into the Trustee Evidence Brief schema.
 * Does not re-read the source document or re-derive evidence; may only
 * select, prioritise, reword, and contextualise what is already in
 * `synthesis`. Governance framing, not operational framing: this is the
 * Board's oversight lens, distinct from the CEO's decision lens.
 */
async function transformToTrusteeBrief(synthesis, recordMeta) {
  const system = `You are transforming an existing, fixed evidence synthesis into a Trustee Evidence Brief for the Zenex Board.

CRITICAL: You are NOT performing new evidence synthesis. You may only select, prioritise, reword, and contextualise claims already present in the canonical synthesis object below. You may not invent or strengthen any claim.

Focus on: Evidence Estate Health, capital accountability, institutional learning, continuity, ageing evidence, major evidence gaps, material strategic risks, whether learning is accumulating and being utilised.

Surface issues requiring Board awareness, oversight, or endorsement. Do not descend into operational recommendations, that is the CEO's domain, not the Board's.

Connect the record to the long-term stewardship question: is Zenex converting financial capital into evidence capital and, ultimately, decision capital?

Do not imply an evidence gap represents programme failure unless the evidence supports that conclusion.

Apply the same epistemic discipline as the canonical synthesis: preserve confidence levels exactly, use associative not causal language unless the study design supports causation, never convert absence of evidence into evidence of absence.

Return a single complete valid JSON object with this exact shape. Begin with { and end with }. No markdown, no preamble.

{
  "audience": "Trustee",
  "external_use": false,
  "title": "",
  "date": "",
  "evidence_estate_health": {
    "coverage": "One to two sentences on how this record fits the broader evidence estate coverage question.",
    "quality": "EQS tier and composite, in context.",
    "currency": "How old is this evidence, and does that matter for the question the record addresses.",
    "utilisation": "Is this the kind of evidence that gets used in decisions, or does it risk sitting unused."
  },
  "capital_accountability": {
    "financial_capital": "",
    "evidence_capital": "",
    "decision_capital": "",
    "accountability_gap": "What stewardship question this record's gaps raise for the Board specifically, distinct from an operational gap."
  },
  "bottom_line": "3-5 sentences, governance framing not operational framing.",
  "key_institutional_findings": [
    {
      "finding": "",
      "confidence": "HIGH | MODERATE | LOW",
      "governance_relevance": "Why this matters for Board oversight specifically, not why it matters for programme decisions."
    }
  ],
  "material_risks_for_board_attention": [],
  "decision_boundary": {
    "supported": [],
    "not_yet_supported": []
  },
  "continuity_and_learning": {
    "evidence_age": "",
    "learning_compounding": "Is this record part of a growing, connected evidence base, or an isolated data point.",
    "unresolved_legacy_questions": []
  },
  "board_consideration": "One to two sentences. The specific thing the Board should note, ask, or request, phrased as an oversight matter not an operational recommendation.",
  "governance_signal": {
    "evidence_status": "One to three words, e.g. Current / Aging / Dated / Incomplete, drawn from evidence_currency_detail's currency_band already in the canonical synthesis, do not invent a new assessment.",
    "financial_accountability": "One to three words, e.g. Complete / Partial / Incomplete, based on whether capital_accountability's financial_capital field indicates cost data exists or is missing.",
    "causal_confidence": "One to three words, e.g. Strong / Limited / Insufficient, based on whether the canonical synthesis claims include a comparison/control group design.",
    "continuity": "One to three words, e.g. Confirmed / Unconfirmed / Unknown, based on continuity_and_learning's learning_compounding field.",
    "primary_board_question": "The single most important question this record raises for Board oversight, phrased as a question. This should usually align with or sharpen board_consideration, not introduce an unrelated concern."
  },
  "sources_summary": ""
}

GOVERNANCE_SIGNAL INSTRUCTIONS: This field must be derived entirely from content already present elsewhere in this same brief (evidence_estate_health, capital_accountability, key_institutional_findings, continuity_and_learning). Do not introduce any new assessment, finding, or claim not already stated elsewhere in the output. This is a compressed restatement for board scanning, not new analysis.

CANONICAL SYNTHESIS (source of truth, do not contradict or extend):
${JSON.stringify(synthesis)}`;

  const msg = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 8000,
    system,
    messages: [{
      role: 'user',
      content: 'Generate the Trustee Evidence Brief.',
    }],
  });

  const text = extractText(msg.content);
  const match = text.match(/\{[\s\S]*\}/);
  let parsed = null;
  try {
    if (!match) throw new Error('No JSON object found in response');
    parsed = JSON.parse(match[0]);
  } catch (err) {
    // One repair attempt via haiku, same convention as transformToCEOBrief.
    const repair = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 6000,
      system: 'Return only valid complete JSON. No markdown.',
      messages: [{
        role: 'user',
        content: 'Repair this JSON: ' + text.slice(0, 8000),
      }],
    });
    const repairText = extractText(repair.content);
    const repairMatch = repairText.match(/\{[\s\S]*\}/);
    if (!repairMatch) throw new Error(`Trustee brief JSON repair failed. Raw: ${repairText.substring(0, 200)}`);
    parsed = JSON.parse(repairMatch[0]);
  }

  const validated = await validateKnowledgeProductSchema(parsed, TRUSTEE_REQUIRED_FIELDS, 'Trustee', text, client, TRUSTEE_FIELD_SHAPES);
  if (!validated.valid) {
    // Log loudly, this should never reach a user silently broken.
    console.error(`Trustee brief validation FAILED for record ${recordMeta.id} after repair attempt. Missing: ${validated.stillMissing?.join(', ')}`);
  }
  return validated.data;
}

/**
 * DBE National persona transformer (Phase C). Takes the cached canonical
 * synthesis (never the raw record) and reshapes it into the DBE National
 * Knowledge Product schema. Does not re-read the source document or
 * re-derive evidence; may only select, prioritise, reword, and
 * contextualise what is already in `synthesis`. This is the first
 * external_use: true persona: a shared-evidence brief for a policy
 * partner (Department of Basic Education, national level), not an
 * internal Zenex decision document, hence the strict scope/transferability
 * and non-oppositional stance rules below.
 */
async function transformToDBENationalBrief(synthesis, recordMeta) {
  const system = `You are transforming an existing, fixed evidence synthesis into a DBE National Evidence Brief, shared with the Department of Basic Education at national level.

CRITICAL: You are NOT performing new evidence synthesis. You may only select, prioritise, reword, and contextualise claims already present in the canonical synthesis object below. You may not invent or strengthen any claim.

Frame evidence in terms of: system improvement, national relevance, scalability, implementation conditions, transferability, curriculum and learning priorities, teacher support, mother-tongue based bilingual education where relevant, learning backlogs where relevant, evidence gaps relevant to national policy.

Prioritise evidence demonstrated in South African public-school contexts.

RULE (SCOPE, STRICT): Clearly distinguish evidence demonstrated in the specific setting tested from evidence demonstrated at broader or national scale. Do not recommend, endorse, or imply national adoption, scaling, or integration into any national programme or framework unless the canonical synthesis's decision_boundary explicitly supports that interpretation for transferability beyond the tested context. A study conducted in a small number of schools in one province, with no comparison group, cannot on its own justify language such as "warrants integration into the national framework" or "should be adopted at scale." If the evidence does not support a national-scale claim, say so plainly rather than softening it into advocacy language.

RULE (NON-OPPOSITIONAL STANCE): Do not introduce internal Zenex portfolio politics, internal funding considerations, or organisational strategy unless explicitly relevant to the shared evidence question. Do not present Zenex's interpretation as government policy. Maintain a collaborative and non-oppositional stance throughout, this brief is shared evidence for a policy partner, not a recommendation Zenex is making to itself.

Apply the same epistemic discipline as the canonical synthesis: preserve confidence levels exactly, use associative not causal language unless the study design supports causation, never convert absence of evidence into evidence of absence, never let two sections of the same brief contradict each other, if you state a limitation in one section it must be honoured consistently in every other section, particularly between the evidence findings and any decision-relevant framing later in the brief.

Return a single complete valid JSON object with this exact shape. Begin with { and end with }. No markdown, no preamble.

{
  "audience": "DBE_National",
  "external_use": true,
  "review_status": "Human review required",
  "title": "",
  "date": "",
  "system_signal": {
    "evidence_confidence": "HIGH | MODERATE | LOW | INSUFFICIENT",
    "evidence_currency": "",
    "evidence_stage": "",
    "transferability": "One to two sentences, plain statement of what is and is not yet demonstrated beyond the tested context."
  },
  "bottom_line": "3-5 sentences, collaborative framing, no advocacy language.",
  "what_the_evidence_shows": [
    {
      "finding": "",
      "confidence": "HIGH | MODERATE | LOW",
      "context_tested": "Exactly where and with whom this was demonstrated.",
      "system_relevance": "Why this matters for the national system, stated without implying the finding is already proven at that scale."
    }
  ],
  "implementation_conditions": [],
  "scalability_and_transferability": {
    "demonstrated": [],
    "uncertain": [],
    "evidence_needed": []
  },
  "policy_relevant_gaps": [],
  "decision_boundary": {
    "supported": [],
    "not_yet_supported": []
  },
  "possible_collaboration_or_evidence_sharing": [],
  "sources_summary": ""
}

Do NOT include: decision_chain, evidence_quality_note, decision_utility, strategic_risks, capital_view, leadership_questions (all CEO-only), evidence_estate_health, capital_accountability, key_institutional_findings, material_risks_for_board_attention, continuity_and_learning, governance_signal, board_consideration (all Trustee-only).

CANONICAL SYNTHESIS (source of truth, do not contradict or extend):
${JSON.stringify(synthesis)}`;

  const msg = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 8000,
    system,
    messages: [{
      role: 'user',
      content: 'Generate the DBE National Evidence Brief.',
    }],
  });

  const text = extractText(msg.content);
  const match = text.match(/\{[\s\S]*\}/);
  let parsed = null;
  try {
    if (!match) throw new Error('No JSON object found in response');
    parsed = JSON.parse(match[0]);
  } catch (err) {
    // One repair attempt via haiku, same convention as transformToCEOBrief
    // and transformToTrusteeBrief.
    const repair = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 6000,
      system: 'Return only valid complete JSON. No markdown.',
      messages: [{
        role: 'user',
        content: 'Repair this JSON: ' + text.slice(0, 8000),
      }],
    });
    const repairText = extractText(repair.content);
    const repairMatch = repairText.match(/\{[\s\S]*\}/);
    if (!repairMatch) throw new Error(`DBE National brief JSON repair failed. Raw: ${repairText.substring(0, 200)}`);
    parsed = JSON.parse(repairMatch[0]);
  }

  const validated = await validateKnowledgeProductSchema(parsed, DBE_NATIONAL_REQUIRED_FIELDS, 'DBE_National', text, client, DBE_NATIONAL_FIELD_SHAPES);
  if (!validated.valid) {
    // Log loudly, this should never reach a user silently broken.
    console.error(`DBE National brief validation FAILED for record ${recordMeta.id} after repair attempt. Missing: ${validated.stillMissing?.join(', ')}`);
  }
  return validated.data;
}

async function transformToProvincialHODBrief(synthesis, recordMeta) {
  const system = `You are transforming an existing, fixed evidence synthesis into a Provincial HOD Evidence Brief, shared with a provincial Head of Department for education.

CRITICAL: You are NOT performing new evidence synthesis. You may only select, prioritise, reword, and contextualise claims already present in the canonical synthesis object below. You may not invent or strengthen any claim.

Prioritise: evidence from the relevant province, evidence from comparable provinces, provincial heterogeneity, implementation fidelity, dosage, delivery conditions, teacher support, contextual factors, adaptation requirements, transferability.

Clearly identify where evidence is concentrated geographically.

RULE (NO CROSS-PROVINCE ASSUMPTION, STRICT): Never assume that evidence demonstrated in one province automatically transfers to another. If the canonical synthesis's provinces field shows this evidence comes from a different province than the one an HOD reading this brief might be in, this must be stated explicitly, not implied or glossed over. Findings from Western Cape schools do not establish anything about KwaZulu-Natal or Limpopo schools without independent evidence from those contexts. This is the same discipline as the SCOPE rule applied to CEO/Trustee/DBE National, but the specific failure mode to guard against here is geographic transfer, not causal or temporal overreach.

Do not use national political framing unless directly relevant to the evidence question.

Do not expose internal funder metrics (Zenex-internal cost figures, portfolio allocation detail) unless specifically relevant to the adoption/adaptation decision.

RULE (NON-OPPOSITIONAL STANCE): Same as DBE National, this is shared evidence for a government partner, not a Zenex recommendation to itself. Maintain a collaborative tone throughout.

Apply the same epistemic discipline as the canonical synthesis: preserve confidence levels exactly, associative not causal language unless design supports causation, never convert absence of evidence into evidence of absence, no internal contradiction between sections.

Return a single complete valid JSON object with this exact shape. Begin with { and end with }. No markdown, no preamble.

{
  "audience": "Provincial_HOD",
  "external_use": true,
  "review_status": "Human review required",
  "title": "",
  "date": "",
  "provincial_evidence_signal": {
    "evidence_confidence": "HIGH | MODERATE | LOW | INSUFFICIENT",
    "province_coverage": "Which province(s) this evidence actually comes from, stated plainly.",
    "evidence_currency": "",
    "transferability": "One to two sentences on whether and how this evidence applies beyond the tested province."
  },
  "bottom_line": "3-5 sentences, collaborative, geography-explicit.",
  "key_findings": [
    {
      "finding": "",
      "confidence": "HIGH | MODERATE | LOW",
      "province": "The specific province this finding was demonstrated in.",
      "context": "District, quintile, or other contextual detail relevant to adoption decisions.",
      "provincial_relevance": "What this means for a province considering adoption, stated without assuming transfer."
    }
  ],
  "implementation_conditions": {
    "fidelity": "",
    "dosage": "",
    "support_requirements": "",
    "contextual_conditions": ""
  },
  "provincial_variation": [],
  "transferability_risks": [],
  "decision_boundary": {
    "supported": [],
    "not_yet_supported": [],
    "evidence_needed_before_adoption": []
  },
  "adoption_or_adaptation_considerations": [],
  "sources_summary": ""
}

Do NOT include any CEO-only, Trustee-only, or DBE-National-only fields (decision_chain, capital_view, leadership_questions, evidence_estate_health, capital_accountability, governance_signal, system_signal, scalability_and_transferability, policy_relevant_gaps, possible_collaboration_or_evidence_sharing).

CANONICAL SYNTHESIS (source of truth, do not contradict or extend):
${JSON.stringify(synthesis)}`;

  const msg = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 8000,
    system,
    messages: [{
      role: 'user',
      content: 'Generate the Provincial HOD Evidence Brief.',
    }],
  });

  const text = extractText(msg.content);
  const match = text.match(/\{[\s\S]*\}/);
  let parsed = null;
  try {
    if (!match) throw new Error('No JSON object found in response');
    parsed = JSON.parse(match[0]);
  } catch (err) {
    // One repair attempt via haiku, same convention as the other three
    // canonical-synthesis-plus-transformer personas.
    const repair = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 6000,
      system: 'Return only valid complete JSON. No markdown.',
      messages: [{
        role: 'user',
        content: 'Repair this JSON: ' + text.slice(0, 8000),
      }],
    });
    const repairText = extractText(repair.content);
    const repairMatch = repairText.match(/\{[\s\S]*\}/);
    if (!repairMatch) throw new Error(`Provincial HOD brief JSON repair failed. Raw: ${repairText.substring(0, 200)}`);
    parsed = JSON.parse(repairMatch[0]);
  }

  const validated = await validateKnowledgeProductSchema(parsed, PROVINCIAL_HOD_REQUIRED_FIELDS, 'Provincial_HOD', text, client, PROVINCIAL_HOD_FIELD_SHAPES);
  if (!validated.valid) {
    console.error(`Provincial HOD brief validation FAILED for record ${recordMeta.id} after repair attempt. Missing: ${validated.stillMissing?.join(', ')}`);
  }
  return validated.data;
}

async function transformToCoFunderBrief(synthesis, recordMeta) {
  const system = `You are transforming an existing, fixed evidence synthesis into a Co-Funder Evidence Brief, shared with a potential or existing co-funder or investment partner.

CRITICAL: You are NOT performing new evidence synthesis. You may only select, prioritise, reword, and contextualise claims already present in the canonical synthesis object below. You may not invent or strengthen any claim.

Do not sell a programme, model, or investment opportunity. Present: evidence strength, methodological confidence, remaining uncertainty, evidence currency, cost/value information where available, additionality, implementation risks, evidence gaps, opportunities for joint learning.

Be especially explicit about what is NOT known.

RULE (NO COST-EFFECTIVENESS INFERENCE, STRICT): Do not infer cost-effectiveness from impact evidence alone. Impact evidence and cost evidence are separate questions. If the canonical synthesis's cost_and_value.known list is empty or sparse, state plainly that cost-effectiveness cannot currently be assessed, do not construct an implied cost-effectiveness case by juxtaposing strong impact language next to weak or absent cost data, that juxtaposition itself is a form of unsupported inference.

RULE (NO PERSUASIVE INVESTMENT LANGUAGE, STRICT): Do not describe a model as ready for scale or co-investment unless the canonical synthesis's decision_boundary.supported explicitly contains that claim. Do not use language such as "compelling opportunity," "strong case for investment," "proven returns," or equivalent promotional framing. This brief's job is to let a funder assess where further investment could generate additional programme value, additional evidence value, or additional learning value, without presuming that further investment is warranted. State uncertainty as clearly as you would to a research peer, not as softly as you would to a prospect.

Where cost or value data is unavailable, say so plainly rather than filling the gap with impact narrative.

Apply the same epistemic discipline as the canonical synthesis: preserve confidence levels exactly, associative not causal language unless design supports causation, never convert absence of evidence into evidence of absence, no internal contradiction between sections.

Return a single complete valid JSON object with this exact shape. Begin with { and end with }. No markdown, no preamble.

{
  "audience": "Co_Funder",
  "external_use": true,
  "review_status": "Human review required",
  "title": "",
  "date": "",
  "evidence_signal": {
    "strength": "HIGH | MODERATE | LOW | INSUFFICIENT",
    "confidence": "",
    "currency": "",
    "evidence_stage": ""
  },
  "bottom_line": "3-5 sentences, no promotional language, explicit about what is and is not known.",
  "evidence_strength": {
    "strongest_support": [],
    "mixed_or_limited_evidence": [],
    "important_unknowns": []
  },
  "models_or_approaches_with_strongest_support": [],
  "uncertainty_and_risk": [],
  "cost_and_value_evidence": {
    "known": [],
    "unknown": [],
    "evidence_needed": []
  },
  "additionality": {
    "potential": "What additional value further investment or evidence could plausibly create, stated as a genuine open question not a pitch.",
    "evidence": "What in the canonical synthesis actually supports this potential, if anything.",
    "uncertainty": "What remains genuinely unknown about additionality."
  },
  "decision_boundary": {
    "supported": [],
    "not_yet_supported": [],
    "evidence_needed": []
  },
  "joint_learning_or_commissioning_options": [],
  "sources_summary": ""
}

Do NOT include any field belonging to CEO, Trustee, DBE National, or Provincial HOD's schemas.

CANONICAL SYNTHESIS (source of truth, do not contradict or extend):
${JSON.stringify(synthesis)}`;

  const msg = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 8000,
    system,
    messages: [{
      role: 'user',
      content: 'Generate the Co-Funder Evidence Brief.',
    }],
  });

  const text = extractText(msg.content);
  const match = text.match(/\{[\s\S]*\}/);
  let parsed = null;
  try {
    if (!match) throw new Error('No JSON object found in response');
    parsed = JSON.parse(match[0]);
  } catch (err) {
    // One repair attempt via haiku, same convention as the other four
    // canonical-synthesis-plus-transformer personas.
    const repair = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 6000,
      system: 'Return only valid complete JSON. No markdown.',
      messages: [{
        role: 'user',
        content: 'Repair this JSON: ' + text.slice(0, 8000),
      }],
    });
    const repairText = extractText(repair.content);
    const repairMatch = repairText.match(/\{[\s\S]*\}/);
    if (!repairMatch) throw new Error(`Co-Funder brief JSON repair failed. Raw: ${repairText.substring(0, 200)}`);
    parsed = JSON.parse(repairMatch[0]);
  }

  const validated = await validateKnowledgeProductSchema(parsed, CO_FUNDER_REQUIRED_FIELDS, 'Co_Funder', text, client, CO_FUNDER_FIELD_SHAPES);
  if (!validated.valid) {
    console.error(`Co-Funder brief validation FAILED for record ${recordMeta.id} after repair attempt. Missing: ${validated.stillMissing?.join(', ')}`);
  }
  return validated.data;
}

async function transformToSectorPeerBrief(synthesis, recordMeta) {
  const system = `You are transforming an existing, fixed evidence synthesis into a Sector Peer Evidence Brief, shared with a peer organisation, researcher, or practitioner working in the same field.

CRITICAL: You are NOT performing new evidence synthesis. You may only select, prioritise, reword, and contextualise claims already present in the canonical synthesis object below. You may not invent or strengthen any claim.

This brief is fundamentally different in purpose from the other five personas. It does not exist to support a decision. It exists to support learning, replication, and further research by a peer organisation.

Prioritise: methodological transparency, study design, population and context, implementation conditions, heterogeneity, null findings, mixed findings, limitations, evidence gaps, open questions, replication opportunities.

RULE (NO SUPPRESSION, STRICT): Do not suppress inconvenient findings because they weaken a positive narrative. If the canonical synthesis contains a claim with LOW confidence, a null result, or a finding that complicates a simpler positive story, that finding must appear in this brief with the same prominence its confidence level warrants, not minimised or relegated. A Sector Peer brief that reads as more positive than the underlying canonical synthesis warrants has failed its purpose.

Do not position Zenex as the sole authority on this evidence.

RULE (EPISTEMIC PROVENANCE, STRICT): Distinguish explicitly and consistently between: a study finding (what one specific evaluation directly measured), a synthesis across studies (a pattern observed by comparing multiple records), an interpretation (a reasonable reading that goes beyond what any single record states), a hypothesis (a plausible but untested explanation), and an unanswered question (something the evidence genuinely cannot address). Never let language drift between these categories without making the shift explicit.

Make methodological limitations visible, not as a defensive afterthought but as core content this audience specifically needs.

Invite further research, replication, or shared inquiry where the evidence genuinely warrants it, do not invite this generically if the record offers nothing specific to build on.

Apply the same epistemic discipline as the canonical synthesis: preserve confidence levels exactly, associative not causal language unless design supports causation, never convert absence of evidence into evidence of absence, no internal contradiction between sections.

Return a single complete valid JSON object with this exact shape. Begin with { and end with }. No markdown, no preamble.

{
  "audience": "Sector_Peer",
  "external_use": true,
  "review_status": "Human review required",
  "title": "",
  "date": "",
  "evidence_signal": {
    "overall_confidence": "HIGH | MODERATE | LOW | INSUFFICIENT",
    "evidence_currency": "",
    "evidence_stage": "",
    "methodological_strength": ""
  },
  "bottom_line": "3-5 sentences, methodologically transparent, no suppression of weak findings.",
  "what_the_evidence_shows": [
    {
      "finding": "",
      "confidence": "HIGH | MODERATE | LOW",
      "study_design": "",
      "context": "",
      "methodological_notes": ""
    }
  ],
  "positive_and_null_or_mixed_findings": {
    "positive": [],
    "null": [],
    "mixed": []
  },
  "implementation_and_contextual_lessons": [],
  "heterogeneity": [],
  "limitations_and_uncertainties": [],
  "decision_boundary": {
    "supported": [],
    "not_yet_supported": []
  },
  "open_questions_for_the_sector": [],
  "research_or_replication_opportunities": [],
  "invitation_to_further_work": "One to two sentences, only if the evidence genuinely warrants an invitation, otherwise state plainly that no specific invitation is warranted by this record alone rather than manufacturing one.",
  "sources_summary": ""
}

Do NOT include any field belonging to CEO, Trustee, DBE National, Provincial HOD, or Co-Funder's schemas.

If positive, null, or mixed findings genuinely cannot be populated from this record (for example, no clean null result exists), the null and mixed arrays may legitimately be empty. An empty array is a true statement about this record, not missing data. Do not manufacture a null or mixed finding that does not exist in the canonical synthesis.

CANONICAL SYNTHESIS (source of truth, do not contradict or extend):
${JSON.stringify(synthesis)}`;

  const msg = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 8000,
    system,
    messages: [{
      role: 'user',
      content: 'Generate the Sector Peer Evidence Brief.',
    }],
  });

  const text = extractText(msg.content);
  const match = text.match(/\{[\s\S]*\}/);
  let parsed = null;
  try {
    if (!match) throw new Error('No JSON object found in response');
    parsed = JSON.parse(match[0]);
  } catch (err) {
    // One repair attempt via haiku, same convention as the other five
    // canonical-synthesis-plus-transformer personas.
    const repair = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 6000,
      system: 'Return only valid complete JSON. No markdown.',
      messages: [{
        role: 'user',
        content: 'Repair this JSON: ' + text.slice(0, 8000),
      }],
    });
    const repairText = extractText(repair.content);
    const repairMatch = repairText.match(/\{[\s\S]*\}/);
    if (!repairMatch) throw new Error(`Sector Peer brief JSON repair failed. Raw: ${repairText.substring(0, 200)}`);
    parsed = JSON.parse(repairMatch[0]);
  }

  const validated = await validateKnowledgeProductSchema(parsed, SECTOR_PEER_REQUIRED_FIELDS, 'Sector_Peer', text, client, SECTOR_PEER_FIELD_SHAPES);
  if (!validated.valid) {
    console.error(`Sector Peer brief validation FAILED for record ${recordMeta.id} after repair attempt. Missing: ${validated.stillMissing?.join(', ')}`);
  }
  return validated.data;
}

const STRATEGIC_SYNTHESIS_REQUIRED_FIELDS = [
  'findings', 'evidence_gaps', 'leverage_points',
];

// cross_patterns is deliberately excluded from the required list: the
// frontend already treats it as optional (SynthesisePage only renders the
// Cross-document Patterns section when the array is non-empty), and
// forcing it to be non-empty would incentivise the model to manufacture a
// pattern across records that do not actually share one, which is exactly
// the fabrication risk this rebuild exists to close.
//
// Top-level fields here are all arrays, not objects, so no fieldShapes
// entries apply (shapeMismatch treats any array value against a defined
// shape as an automatic mismatch) -- same convention as every other
// persona's FIELD_SHAPES, which only ever shape-check nested object
// fields, never the top-level arrays themselves.
const STRATEGIC_SYNTHESIS_FIELD_SHAPES = {};

/**
 * Strategic Synthesis cross-record transformer. Takes the cached canonical
 * syntheses for each selected record (never raw records, never full
 * document text) and reshapes them into cross-document findings, evidence
 * gaps, leverage points, and cross patterns. Does not re-read source
 * documents or re-derive individual-record evidence; may only select,
 * compare, and contextualise what is already in each canonical synthesis.
 */
async function transformToStrategicSynthesis(canonicalSyntheses, recordMetas) {
  const system = `You are producing a Strategic Synthesis across ${canonicalSyntheses.length} evaluation records, synthesising patterns, gaps, and strategic leverage points across records that have each already been through canonical evidence synthesis.

CRITICAL: You are NOT performing new evidence synthesis at the individual-record level, that has already happened. Each canonical synthesis object below is the disciplined, verified summary of one evaluation. Your job is to find patterns, gaps, and strategic implications ACROSS these already-synthesised objects. You may not invent or strengthen any individual-record claim beyond what its canonical synthesis states.

CRITICAL, SOURCE DISCIPLINE, STRICT: You must not introduce any external knowledge not present in the canonical synthesis objects provided. This includes but is not limited to: named policy frameworks, dated policy documents, government planning cycles, legislative timelines, named events or meetings (e.g. any named lekgotla, conference, or convening), or any other real-world fact about South African education policy, government, or planning processes that is not explicitly stated in the canonical synthesis objects themselves. If a cross-document pattern would be strengthened by referencing a policy context, and that policy context is not present in the provided synthesis objects, you must either omit the reference entirely or explicitly flag it as external context requiring independent verification before use, phrased exactly as: "This would benefit from being checked against [topic] separately, this is not drawn from the evidence records themselves." Findings and leverage points must be traceable to the provided canonical synthesis objects and their record IDs, nothing else.

RULE 1 SCOPE: Do not generalise findings beyond what the specific combination of selected records supports. A pattern across 2 records is a pattern across 2 records, not a portfolio-wide or sector-wide claim, unless explicitly qualified as such.

RULE 2 CAUSALITY: No "drives", "causes", "necessary", "active ingredient", or equivalent unless directly supported by at least one canonical synthesis's own evidence_boundary.study_design indicating an RCT or quasi-experimental design behind that specific claim.

RULE 3 HETEROGENEITY vs CONTRADICTION: Two records showing different results under different contexts (different provinces, populations, designs) are heterogeneity, explain the plausible moderator. Reserve "contradiction" for genuinely incompatible claims about the same proposition under comparable conditions.

RULE 4 INDEPENDENCE: Before treating two records as corroborating each other, check whether they share the same implementing organisation, programme, sample, or underlying study using each canonical synthesis's evidence_boundary.study_design and evidence_boundary.population_context fields. If records are not independent, say so explicitly rather than treating convergence as stronger evidence than it is.

RULE (NO SUPPRESSION, STRICT): Do not omit or soften a finding from any selected record's canonical synthesis because it complicates a cleaner cross-document narrative. If two records disagree, or if one record's findings are weak, that must appear with the same prominence its confidence level in its own canonical synthesis warrants.

UK English throughout. No contractions. No em dashes or en dashes.

Return a single complete valid JSON object. Begin with { and end with }. No markdown, no preamble, no explanation outside the JSON:

{
  "findings": [
    {
      "finding": "",
      "confidence": "HIGH | MODERATE | LOW",
      "study_type": "derived from the relevant record's evidence_boundary.study_design",
      "source_record_ids": [],
      "corroborated": false,
      "contested": false,
      "contradiction_note": null
    }
  ],
  "evidence_gaps": [
    {
      "gap": "",
      "policy_relevance": "Only populate if explicitly present in a canonical synthesis object's own content, for example its decision_boundary.evidence_needed or open_questions. Otherwise use null, or the exact external-verification-needed flag sentence specified above. Never fabricate a named policy, framework, or event.",
      "urgency": "HIGH | MEDIUM | LOW",
      "commissioning_opportunity": false
    }
  ],
  "leverage_points": [
    {
      "action": "",
      "rationale": "",
      "urgency": "HIGH | MEDIUM | LOW",
      "expected_influence": ""
    }
  ],
  "cross_patterns": [
    {
      "pattern": "",
      "records_involved": [],
      "implication": ""
    }
  ]
}

Maximum 3 findings, 3 evidence gaps, 3 leverage points, and 3 cross patterns. Keep each string value under 35 words. If fewer than 3 genuine cross-document patterns exist across these specific records, return fewer, or an empty cross_patterns array. Do not manufacture a pattern to fill the array.

Every finding, gap, leverage point and cross pattern must cite its source_record_ids / records_involved using the record_id values from the canonical synthesis objects below, e.g. [ADEI-ZF-001].

CANONICAL SYNTHESES (source of truth, one per selected record, do not contradict or extend beyond what each states):
${JSON.stringify(canonicalSyntheses)}`;

  const message = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 8000,
    system,
    messages: [{
      role: 'user',
      content: `Generate the Strategic Synthesis across these ${canonicalSyntheses.length} already-synthesised records.`,
    }],
  });

  const text = extractText(message.content);
  const match = text.match(/\{[\s\S]*\}/);
  let parsed = null;
  try {
    if (!match) throw new Error('No JSON object found in response');
    parsed = JSON.parse(match[0]);
  } catch (err) {
    // One repair attempt via haiku, same convention as the other
    // canonical-synthesis-plus-transformer personas.
    const repair = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 6000,
      system: 'Return only valid complete JSON. No markdown.',
      messages: [{
        role: 'user',
        content: 'Repair this JSON: ' + text.slice(0, 8000),
      }],
    });
    const repairText = extractText(repair.content);
    const repairMatch = repairText.match(/\{[\s\S]*\}/);
    if (!repairMatch) throw new Error(`Strategic Synthesis JSON repair failed. Raw: ${repairText.substring(0, 200)}`);
    parsed = JSON.parse(repairMatch[0]);
  }

  const validated = await validateKnowledgeProductSchema(parsed, STRATEGIC_SYNTHESIS_REQUIRED_FIELDS, 'Strategic_Synthesis', text, client, STRATEGIC_SYNTHESIS_FIELD_SHAPES);
  if (!validated.valid) {
    console.error(`Strategic Synthesis validation FAILED for records [${recordMetas.map(r => r.id).join(', ')}] after repair attempt. Missing: ${validated.stillMissing?.join(', ')}`);
  }
  return validated.data;
}

/**
 * Generate an audience-calibrated knowledge product from a classified record
 */
async function generateKnowledgeProduct({ record, audience, tenant, synthesisContext = '' }) {
  const audienceKeyUpper = String(audience || '').toUpperCase();
  if (audienceKeyUpper === 'CEO') {
    const synthesis = await generateCanonicalSynthesis(record, tenant.slug);
    return transformToCEOBrief(synthesis, record);
  }
  if (audienceKeyUpper === 'TRUSTEE') {
    const synthesis = await generateCanonicalSynthesis(record, tenant.slug);
    return transformToTrusteeBrief(synthesis, record);
  }
  if (audienceKeyUpper === 'DBE_NATIONAL') {
    const synthesis = await generateCanonicalSynthesis(record, tenant.slug);
    return transformToDBENationalBrief(synthesis, record);
  }
  if (audienceKeyUpper === 'PROVINCIAL_HOD') {
    const synthesis = await generateCanonicalSynthesis(record, tenant.slug);
    return transformToProvincialHODBrief(synthesis, record);
  }
  if (audienceKeyUpper === 'CO_FUNDER') {
    const synthesis = await generateCanonicalSynthesis(record, tenant.slug);
    return transformToCoFunderBrief(synthesis, record);
  }
  if (audienceKeyUpper === 'SECTOR_PEER') {
    const synthesis = await generateCanonicalSynthesis(record, tenant.slug);
    return transformToSectorPeerBrief(synthesis, record);
  }

  const audienceDescriptions = {
    TRUSTEE: 'A board trustee focused on governance, fiduciary responsibility, portfolio value, and institutional accountability. Needs plain language, quantified returns, and clear risk framing.',
    CEO: 'The Foundation CEO focused on strategic portfolio decisions, organisational positioning, and evidence-based leadership. Needs portfolio-level insight and next-action clarity.',
    DBE_NATIONAL: 'A national Department of Basic Education official focused on policy alignment, scale, and implementation evidence. Needs effect sizes, design quality, and replication conditions.',
    PROVINCIAL_HOD: 'A provincial Head of Department focused on district and school-level implementation. Needs minimum dosage, fidelity requirements, and practical conditions for adoption.',
    CO_FUNDER: 'A co-funder or potential investment partner focused on evidence quality, proven reach, and return on philanthropic capital. Needs confidence tier, EROI narrative, and leverage case.',
    SECTOR_PEER: 'A sector researcher or peer organisation focused on methodology, limitations, and replication potential. Needs design detail, effect sizes, and honest limitations.',
  };

  const safe = (value, fallback = 'Not recorded') => {
    if (value === undefined || value === null || value === '') return fallback;
    if (Array.isArray(value)) return value.length ? value.join(', ') : fallback;
    return String(value);
  };
  const audienceKey = String(audience || 'TRUSTEE').toUpperCase();
  const audienceProfile = audienceDescriptions[audienceKey] || audienceDescriptions.TRUSTEE;
  const orgAttribution = tenant.organisation_type === 'FUNDER'
    ? `This organisation is a philanthropy and funder. Always use attribution language such as "Zenex-funded evidence shows" or "Zenex-commissioned evaluation found". Never write "Zenex delivered" or "Zenex achieved" because Zenex funds and commissions; implementing organisations deliver.`
    : `This organisation directly implements programmes. Direct attribution of outcomes is appropriate.`;
  const synthesisSection = synthesisContext || '';

  const systemPrompt = `You are producing a formal evidence brief for ${tenant.name}.

${orgAttribution}

${synthesisSection}

You must produce ALL seven sections below in full.
Never write "undefined", "not available", or leave a section blank. If specific data is absent from the record, derive a contextually appropriate statement from the other fields provided or acknowledge the gap honestly and specifically.

Write in UK English. Senior consultant register.
No contractions. No em dashes. Precise and authoritative throughout.

AUDIENCE: ${audienceKey}
AUDIENCE PROFILE: ${audienceProfile}

Produce exactly these seven sections with these exact headings:

EXECUTIVE SUMMARY
2-3 sentences. What this programme is, what the evidence shows, and why it matters for this specific audience.

KEY FINDING
The most important quantified finding from this evaluation. Include effect size where available. Name the study design, for example RCT or quasi-experimental. Name provinces and sample size.

INVESTMENT AND REACH
How much was invested and how many learners, schools, or districts were reached. If cost data is absent, note this explicitly: "Cost per beneficiary data is not available in this record."

DECISION IMPLICATION
What this finding means specifically for the ${audienceProfile.split('.')[0]}. Be specific to their role and responsibilities. Not generic.

EVIDENCE CONFIDENCE
EQS composite: ${safe(record.eqs_composite)}/5.0 · ${safe(record.eqs_tier).replace('_', ' ')}
Name one key methodological strength and one named limitation from the record. If limitations field is populated, use it. Do not invent limitations.

RECOMMENDED ACTION
One specific, actionable sentence. What should this audience do with this evidence right now?

SUPPORTING RECORDS
Note any other classified records in the corpus that corroborate, extend, or contextualise this finding. If none are available yet, write: "Additional evaluations will be cross-referenced as the full corpus classification completes."`;

  const userPrompt = `Generate a ${audienceKey} evidence brief for the following classified record.

INTELLIGENCE RECORD:
Programme: ${safe(record.programme_name)}
Record ID: ${safe(record.id)}
Document type: ${safe(record.document_type)}
Evaluation design: ${safe(record.evaluation_subtype, 'Not specified')}
Year: ${safe(record.year)}
Provinces: ${safe(record.provinces, 'Not specified')}
Implementing organisation: ${safe(record.implementing_organisation_name, 'Not specified')}
Sample size: ${record.sample_size_learners ? `${record.sample_size_learners} learners` : 'Not specified'}
Schools: ${record.sample_size_schools ? `${record.sample_size_schools} schools` : 'Not specified'}
Key finding 1: ${safe(record.key_finding_1)}
Key finding 2: ${safe(record.key_finding_2)}
Key finding 3: ${safe(record.key_finding_3)}
Effect size: ${record.effect_size_composite ? `${record.effect_size_composite} SD` : 'Not recorded'}
Effect direction: ${safe(record.effect_direction)}
EQS composite: ${safe(record.eqs_composite)}/5.0
EQS tier: ${safe(record.eqs_tier)}
Method rigour: ${safe(record.dim_methodological_rigour)}/5
Data quality: ${safe(record.dim_data_quality)}/5
Transparency: ${safe(record.dim_transparency)}/5
Replicability: ${safe(record.dim_replicability)}/5
Policy relevance: ${safe(record.policy_relevance_score)}/5
Policy alignment: ${safe(record.policy_alignment)}
Decision relevance: ${safe(record.decision_relevance)}
DBE adoption: ${safe(record.dbe_adoption_status, 'Unknown')}
Evidence gap: ${safe(record.evidence_gap_1, 'None identified')}
Limitations: ${safe(record.limitations, 'Not recorded in this version')}
Cost data: ${safe(record.cost_data_present)} - ${safe(record.cost_data_source, 'source not specified')}`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    temperature: 0.2,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  return (message.content[0].text || '')
    .replace(/\bundefined\b/gi, 'Not recorded')
    .replace(/[–—]/g, '-');
}

module.exports = {
  detectEQSPathway,
  buildStructuredExcerpt,
  classifyPass1,
  classifyPass2,
  needsPass2,
  validateClassification,
  mergeClassification,
  generateKnowledgeProduct,
  generateCanonicalSynthesis,
  transformToCEOBrief,
  transformToTrusteeBrief,
  transformToDBENationalBrief,
  transformToProvincialHODBrief,
  transformToCoFunderBrief,
  transformToSectorPeerBrief,
  transformToStrategicSynthesis,
  validateKnowledgeProductSchema,
};
