'use strict';
/**
 * ADEI Claude Classifier (Phase B4 rebuild)
 * Two-pass architecture:
 *   Pass 1 - structural extraction (all documents)
 *   Pass 2 - methodological extraction (Impact/Process Evaluation only)
 *   Pass 3 - deterministic validation layer over the combined output
 */

const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
  "provinces": ["array of province names"],
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

/**
 * Generate an audience-calibrated knowledge product from a classified record
 */
async function generateKnowledgeProduct({ record, audience, tenant, synthesisContext = '' }) {
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
};
