'use strict';

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../services/db');
const { requireRoles } = require('../middleware/permissions');
const { orgTypeContext } = require('../services/org-context');

const router = express.Router();

function buildCorpusSummary(records) {
  return records.map(record => ({
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
  }));
}

function getRoleContext(role) {
  switch (role) {
    case 'CEO_EXEC':
      return 'Focus on strategic implication, portfolio choices, risk and what the evidence legitimately supports deciding. Lead with the institutional implication before the research detail.';
    case 'ORGANISATION_LEAD':
      return 'Emphasise methodological strength, limitations, programme continuity, evidence quality and gaps. Surface what the evidence implies for commissioning and portfolio decisions.';
    case 'EVIDENCE_ANALYST':
      return 'Prioritise evidence quality, study design, effect sizes, heterogeneity, methodological limitations and research gaps. Be precise about causal language.';
    case 'COMMUNICATIONS':
      return 'Prioritise clear provenance-backed claims and messaging-ready language. Flag what can and cannot credibly be said publicly. Apply strict causal language discipline.';
    default:
      return 'Provide a balanced evidence summary suitable for an informed professional audience.';
  }
}

function parseSynthesis(text, recordsSearched) {
  let parsed;
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    parsed = null;
  }

  if (parsed && parsed.bottom_line) {
    const recordIds = [];
    if (parsed.sources) {
      parsed.sources.forEach(s => { if (s.record_id) recordIds.push(s.record_id); });
    }
    return {
      answer: parsed.bottom_line + (parsed.why_this_matters_for_zenex ? '\n\n' + parsed.why_this_matters_for_zenex : ''),
      bottom_line: parsed.bottom_line,
      what_the_evidence_shows: parsed.what_the_evidence_shows || [],
      evidence_limitations: parsed.evidence_limitations || [],
      heterogeneity_or_contradictions: parsed.heterogeneity_or_contradictions || {},
      what_we_do_not_know: parsed.what_we_do_not_know || [],
      decision_boundary: parsed.decision_boundary || {},
      why_this_matters_for_zenex: parsed.why_this_matters_for_zenex || null,
      recommended_action: parsed.recommended_action || null,
      confidence_summary: parsed.confidence_summary || null,
      gap_triggers_fired: parsed.gap_triggers_fired || [],
      role_framing: parsed.role_framing || null,
      evidence_boundary: parsed.evidence_boundary || {},
      confidence: (parsed.what_the_evidence_shows?.[0]?.confidence) || 'LOW',
      records_searched: recordsSearched,
      supporting_record_ids: recordIds,
      contradictions: parsed.heterogeneity_or_contradictions?.contradictions?.join('; ') || null,
      generated_at: new Date().toISOString(),
    };
  }

  const recordIds = [...new Set((text.match(/\bADEI-[A-Z0-9-]+\b/g) || []))];
  const confidenceMatch = text.match(/\b(HIGH|MODERATE|LOW)\b/i);
  const actionMatch = text.match(/recommended action[:\s-]+([^\n]+)/i);
  return {
    answer: text,
    bottom_line: null,
    confidence: confidenceMatch ? confidenceMatch[1].toUpperCase() : 'LOW',
    records_searched: recordsSearched,
    supporting_record_ids: recordIds,
    contradictions: null,
    recommended_action: actionMatch ? actionMatch[1].trim() : null,
    generated_at: new Date().toISOString(),
  };
}

router.post('/', requireRoles('ORGANISATION_LEAD', 'EVIDENCE_ANALYST', 'CEO_EXEC', 'COMMUNICATIONS'), async (req, res, next) => {
  const startTime = Date.now();
  try {
    const question = String(req.body.question || '').trim();
    if (!question) return res.status(400).json({ error: 'question is required' });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured' });

    const records = process.env.DATABASE_URL ? await db.listRecords(req.tenant, {}) : [];
    const corpusSummary = buildCorpusSummary(records);
    const roleContext = getRoleContext(req.user?.role);
    const organisationType = req.tenant.organisation_type || 'FUNDER';
    const attributionContext = orgTypeContext(req.tenant);

    const system = `You are EvidenceOS, ${req.tenant.name}'s institutional evidence intelligence layer.
Your sole job is to answer from the classified Zenex evidence estate with maximum epistemic discipline.

CORE RULES:
- Speak only from the current Zenex evidence estate. Always make the boundary explicit.
- Never invent findings. If evidence is thin or absent, say so clearly.
- Distinguish causal evidence (Tier 1) from implementation, process or research evidence.
- Separate contradictions (incompatible claims about the same proposition) from heterogeneity (effects that differ by design, geography, subgroup, language, fidelity or context).
- Keep mechanism language conservative. An observed association does not prove causation.
- Never upgrade confidence merely because multiple records repeat the same finding. Assess independence, study design, sample overlap and methodological quality.
- Role framing may change emphasis, vocabulary and decision framing, but must never change the underlying claims, confidence ratings, source selection or evidentiary boundaries.
- Write in UK English, senior consultant register. No contractions. No em dashes.

ROLE CONTEXT (${req.user?.role || 'ORGANISATION_LEAD'}):
${roleContext}

Attribution rule: This organisation is a ${organisationType}. ${attributionContext}

OUTPUT: Return a single valid JSON object with exactly this structure:
{
  "evidence_boundary": {
    "scope": "current Zenex evidence estate",
    "relevant_record_count": 0,
    "external_evidence_used": false,
    "search_completeness": "known | partial | unknown"
  },
  "bottom_line": "2 to 4 sentence executive answer. Lead with what is established and how strongly.",
  "what_the_evidence_shows": [
    {
      "claim": "",
      "confidence": "HIGH | MODERATE | LOW | INSUFFICIENT",
      "evidence_basis": "",
      "qualifications": [],
      "supporting_records": []
    }
  ],
  "evidence_limitations": [
    {
      "issue": "",
      "affected_claims": [],
      "severity": "HIGH | MODERATE | LOW"
    }
  ],
  "heterogeneity_or_contradictions": {
    "contradictions": [],
    "heterogeneity": [
      {
        "dimension": "",
        "finding": "",
        "implication": ""
      }
    ]
  },
  "what_we_do_not_know": [],
  "decision_boundary": {
    "supported": [],
    "not_yet_supported": [],
    "evidence_needed_to_decide": []
  },
  "why_this_matters_for_zenex": "2 to 5 sentences linking findings to Zenex Strategy 2030 priorities.",
  "recommended_action": null,
  "confidence_summary": "Short explanation of overall confidence referencing tier mix, design strength and independence.",
  "sources": [
    {
      "record_id": "",
      "title_or_programme": "",
      "year": "",
      "tier": "",
      "pathway": "Impact | Process | Research"
    }
  ],
  "gap_triggers_fired": [],
  "role_framing": "${req.user?.role || 'ORGANISATION_LEAD'}"
}

GAP TRIGGER RULES:
- If fewer than 2 relevant records retrieved: add "INSUFFICIENT_COVERAGE" to gap_triggers_fired.
- If most recent key evidence is more than 3 years old and the topic is fast-moving: add "CURRENCY_RISK" to gap_triggers_fired.
- If two or more records reach opposing conclusions: add "CONTRADICTION_DETECTED" to gap_triggers_fired.
- If the only answer requires inference beyond what records directly state: add "INFERENCE_RISK" to gap_triggers_fired.
- If the query implies a commissioning or portfolio decision: populate decision_boundary and recommended_action or explicitly state evidence is insufficient.
- Never end with a generic statement. Make recommended_action specific or set it to null.
- Do not demand new research solely because evidence is older than 3 years if the proposition is stable.`;

    const user = `${question}

CLASSIFIED CORPUS (${corpusSummary.length} records):
${JSON.stringify(corpusSummary, null, 2)}`;

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      temperature: 0.2,
      system,
      messages: [{ role: 'user', content: user }],
    });

    const text = message.content?.[0]?.text || '';
    const parsed = parseSynthesis(text, corpusSummary.length);

    (async () => {
      try {
        await db.getPool().query(
          `INSERT INTO zenex.query_log (
            tenant_id, user_email, user_role, feature, query_text,
            response_length, records_cited, response_time_ms
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            req.user?.tenant_id || req.tenant?.slug || 'zenex',
            req.user?.email || 'unknown',
            req.user?.role || 'unknown',
            'ASK_ZENEX',
            question,
            text.length || 0,
            parsed.supporting_record_ids?.length || 0,
            Date.now() - startTime,
          ]
        );
      } catch (logErr) {
        console.error('query_log insert failed:', logErr.message);
      }
    })();

    res.json(parsed);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
