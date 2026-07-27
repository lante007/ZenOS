'use strict';
/**
 * ADEI Claude Classifier
 * Primary classification using Anthropic Claude Sonnet (not Bedrock)
 * Produces the full 55-field ADEI taxonomy record
 */

const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CLASSIFICATION_PROMPT = `You are the ADEI Evidence Intelligence classification engine for Auxeira. 
You are classifying evaluation and research documents for {{INSTITUTION}}, a client organisation using EvidenceOS.

TAXONOMY v2.1 — Classify this document across these fields.
Return ONLY valid JSON, no preamble, no markdown.

{
  "document_type": "Impact Evaluation | Process Evaluation | Research Study | Board Proposal | Financial Record | Other",
  "evaluation_subtype": "RCT | Quasi-experimental | Pre-post | Mixed methods | Formative | Descriptive | Literature Review | Landscape Analysis | null",
  "programme_name": "string or Unknown",
  "phase": "Foundation Phase | Grade R | Senior Phase | Teacher Development | System-Wide | Post-School | Unknown",
  "year": "YYYY or null",
  "provinces": ["list of SA provinces mentioned"],
  "sample_size_learners": "number or null",
  "sample_size_schools": "number or null",
  "has_control_group": true | false | null,
  "methodology_description": "2-3 sentence description",
  "key_finding_1": "string or null",
  "key_finding_2": "string or null",
  "key_finding_3": "string or null",
  "null_findings_reported": true | false,
  "cost_data_present": "AUDITED | PROXY | ABSENT",
  "theory_of_change_explicit": true | false,
  "external_evaluator": true | false | null,
  "fidelity_reported": true | false,
  "dosage_documented": true | false,
  "publication_status": "Published | Grey Literature | Confidential | Unknown",
  "policy_relevance_score": 1 | 2 | 3 | 4 | 5,
  "strategic_value_score": 1 | 2 | 3 | 4 | 5,
  "nls_alignment": true | false,
  "funrs_alignment": true | false,
  "dbe_adoption_status": "ADOPTED | PILOTED | REFERENCED | NONE | UNKNOWN",
  "audience_relevance": ["Trustee", "CEO", "DBE National", "Provincial HOD", "Co-Funder", "Sector Peer"],
  "co_funder_documented": true | false,
  "confidentiality_flag": "DO NOT CITE | RESTRICTED | CLEAR",
  "evidence_gap_1": "string or null",
  "evidence_gap_2": "string or null",
  "commissioning_standards_met": 0..9,
  "confidence_scores": {
    "document_type": 0.0..1.0,
    "evaluation_subtype": 0.0..1.0,
    "programme_name": 0.0..1.0,
    "overall": 0.0..1.0
  }
}

CLASSIFICATION RULES (non-negotiable):
PA1. Null findings are classified at the SAME confidence tier as positive findings.
PA2. Process evaluations NEVER receive causal attribution.
PA3. Cost data is AUDITED only when explicitly from audited financial records; otherwise use PROXY or ABSENT.
PA4. Confidence tiers must be disaggregated by unit of analysis where the document supports this.
PA5. Non-significant tested variables must be explicitly reported in key_findings.
PA6. Decision relevance is judged by asymmetry: assumption-challenging findings outrank confirming findings.
If omitted variable bias is detected, note it in methodology_description.

DOCUMENT TO CLASSIFY:
Filename: {{FILENAME}}
Institution: {{INSTITUTION}}
Programme (pre-detected): {{PROGRAMME}}
Role (pre-detected): {{ROLE}}
Phase (pre-detected): {{PHASE}}

DOCUMENT TEXT:
{{TEXT}}`;

/**
 * Classify a document using Claude Sonnet
 */
async function classifyDocument({ filename, text, programme, role, phase, institution }) {
  const inputText = text.substring(0, 12000);
  const prompt = CLASSIFICATION_PROMPT
    .replaceAll('{{INSTITUTION}}', institution || 'the client organisation')
    .replace('{{FILENAME}}', filename)
    .replace('{{PROGRAMME}}', programme || 'Unknown')
    .replace('{{ROLE}}', role || 'standalone')
    .replace('{{PHASE}}', phase || 'Unknown')
    .replace('{{TEXT}}', inputText);

  const startTime = Date.now();

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    temperature: 0,
    messages: [{ role: 'user', content: prompt }],
  });

  const latencyMs = Date.now() - startTime;
  const rawContent = message.content[0].text;

  // Parse JSON — strip any accidental markdown
  let parsed;
  try {
    const clean = rawContent.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    parsed = JSON.parse(clean);
  } catch (err) {
    throw new Error(`Claude returned invalid JSON: ${err.message}\nRaw: ${rawContent.substring(0, 200)}`);
  }

  return {
    classification: parsed,
    usage: {
      model: 'claude-sonnet-4-6',
      input_tokens: message.usage.input_tokens,
      output_tokens: message.usage.output_tokens,
      input_words: prompt.split(/\s+/).filter(Boolean).length,
      output_words: rawContent.split(/\s+/).filter(Boolean).length,
      latency_ms: latencyMs,
      bedrock_agent: false,
    },
  };
}

/**
 * Generate an audience-calibrated knowledge product from a classified record
 */
async function generateKnowledgeProduct({ record, audience, tenant }) {
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

  const systemPrompt = `You are producing a formal evidence brief for ${tenant.name}.

${orgAttribution}

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

module.exports = { classifyDocument, generateKnowledgeProduct };
