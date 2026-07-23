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
async function generateKnowledgeProduct({ record, audience, programmeContext }) {
  const audiencePrompts = {
    'Trustee': 'Write a 200-word trustee evidence brief. Focus on investment rationale, measurable outcomes, and EROI narrative. Use non-technical language. End with one recommendation.',
    'DBE National': 'Write a 200-word policy brief for national DBE officials. Focus on what the evidence shows works, at what scale, and what the implementation conditions are. Be precise about effect sizes.',
    'Provincial HOD': 'Write a 200-word implementation brief for a provincial Head of Department. Focus on what a school principal needs to know to implement this intervention. Include minimum effective dosage if available.',
    'Co-Funder': 'Write a 200-word joint investment brief for a potential co-funder. Focus on the evidence quality, proven reach, and what additional investment would produce.',
    'CEO': 'Write a 200-word strategic brief for the Foundation CEO. Focus on portfolio positioning, evidence gaps, and next commissioning priorities.',
    'Sector Peer': 'Write a 200-word methodology note for sector researchers. Focus on the evaluation design, key findings, and limitations.',
  };

  const prompt = `You are producing a knowledge product for ${record.institution || 'the client organisation'}.
  
Programme: ${record.programme_name}
Document type: ${record.document_type}
Key finding 1: ${record.key_finding_1 || 'Not available'}
Key finding 2: ${record.key_finding_2 || 'Not available'}
Policy relevance: ${record.policy_relevance_score}/5
EQS composite: ${record.eqs_composite || 'Pending'}

${audiencePrompts[audience] || audiencePrompts['Trustee']}

Additional context: ${programmeContext || ''}

Return only the brief text. No headings. No markdown. Plain paragraphs only.`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    temperature: 0.3,
    messages: [{ role: 'user', content: prompt }],
  });

  return message.content[0].text;
}

module.exports = { classifyDocument, generateKnowledgeProduct };
