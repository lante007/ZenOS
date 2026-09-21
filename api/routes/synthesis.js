'use strict';

const express  = require('express');
const crypto   = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const db       = require('../services/db');
const { requireRoles } = require('../middleware/permissions');
const { orgTypeContext } = require('../services/org-context');

const router = express.Router();

// In-memory async job store for POST /. Deliberately not backed by RDS,
// same rationale as api/routes/tor.js: jobs are short-lived (a few minutes)
// and single-process (pm2 runs this app in fork mode, not cluster), so
// there is no cross-process visibility requirement that would justify a
// DB round-trip on every poll. Jobs do not survive a pm2 restart.
const jobs = {};
const JOB_TTL_MS = 10 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of Object.entries(jobs)) {
    if (job.createdAt < cutoff) delete jobs[id];
  }
}, 60 * 1000).unref();

// claude-sonnet-5 uses extended thinking by default, which prepends a
// `thinking` content block before the `text` block. content[0] is not
// reliably the answer, so find the first text block explicitly.
function extractText(content) {
  const block = (content || []).find(b => b.type === 'text');
  return block?.text || '';
}

// ─── corpus summary ──────────────────────────────────────────
function buildCorpusSummary(records) {
  return records.map(r => ({
    id: r.id,
    programme_name: r.programme_name,
    document_type: r.document_type,
    evaluation_subtype: r.evaluation_subtype,
    key_finding_1: r.key_finding_1,
    key_finding_2: r.key_finding_2,
    key_finding_3: r.key_finding_3,
    eqs_composite: r.eqs_composite,
    eqs_tier: r.eqs_tier,
    phase: r.phase,
    provinces: r.provinces,
    year: r.year,
    methodology_description: r.methodology_description,
    evidence_gap_1: r.evidence_gap_1,
    effect_size_composite: r.effect_size_composite,
    effect_direction: r.effect_direction,
    implementing_organisation_name: r.implementing_organisation_name,
    responsible_pm: r.responsible_pm,
    baseline_available: r.baseline_available,
    endline_available: r.endline_available,
  }));
}

// ─── role context ────────────────────────────────────────────
function getRoleContext(role) {
  switch (role) {
    case 'CEO_EXEC':
      return 'Lead with strategic implication and portfolio choice. Frame findings in terms of what Zenex can reasonably decide, invest in, or hold. Suppress methodological detail unless it changes the decision.';
    case 'ORGANISATION_LEAD':
      return 'Emphasise methodological strength, limitations, programme continuity, evidence quality and gaps. Surface what the evidence implies for commissioning and portfolio decisions.';
    case 'EVIDENCE_ANALYST':
      return 'Prioritise evidence quality, study design, effect sizes, independence, heterogeneity, methodological limitations and research gaps. Be precise about causal language and confidence gradations.';
    case 'COMMUNICATIONS':
      return 'Prioritise clear, provenance-backed claims and messaging-ready language. Flag what can and cannot credibly be said publicly. Apply strict causal language discipline throughout.';
    default:
      return 'Provide a balanced evidence summary suitable for an informed professional audience.';
  }
}

// ─── schema ──────────────────────────────────────────────────
const SCHEMA = `{
  "evidence_boundary": {
    "scope": "current Zenex evidence estate",
    "records_searched": 0,
    "records_retrieved_as_relevant": 0,
    "records_used_in_synthesis": 0,
    "records_excluded": 0,
    "exclusion_reasons": [],
    "external_evidence_used": false,
    "search_completeness": "known | partial | unknown"
  },
  "bottom_line": "2–4 sentence executive answer. Lead with what is established and how strongly. Never open with a hedge.",
  "what_the_evidence_shows": [
    {
      "claim": "",
      "confidence": "HIGH | MODERATE | LOW | INSUFFICIENT",
      "evidence_basis": "",
      "evidence_role": "supporting | qualifying | challenging",
      "causal_design": "RCT | quasi-experimental | pre-post | process | observational | synthesis | unknown",
      "population_context": "",
      "outcome": "",
      "timepoint": "baseline | midline | endline | unknown",
      "qualifications": [],
      "supporting_records": []
    }
  ],
  "why_this_matters_for_zenex": "2–5 sentences linking findings to Zenex Strategy 2030 priorities.",
  "decision_boundary": {
    "supported": [],
    "not_yet_supported": [],
    "evidence_needed_to_decide": []
  },
  "recommended_action": null,
  "what_we_do_not_know": [],
  "confidence_summary": "Short explanation of overall confidence referencing tier mix, design strength and independence.",
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
  "evidence_limitations": [
    {
      "issue": "",
      "affected_claims": [],
      "severity": "HIGH | MODERATE | LOW",
      "decision_relevance": ""
    }
  ],
  "sources": [
    {
      "record_id": "",
      "title_or_programme": "",
      "year": "",
      "tier": "",
      "pathway": "Impact | Process | Research",
      "eqs": null,
      "role_in_answer": "supporting | qualifying | challenging"
    }
  ],
  "gap_triggers_fired": [],
  "role_framing": "CEO_EXEC | ORGANISATION_LEAD | EVIDENCE_ANALYST | COMMUNICATIONS"
}`;

// ─── system prompt ───────────────────────────────────────────
function buildSystem(tenant, user, attributionContext) {
  const role = user?.role || 'ORGANISATION_LEAD';
  const orgType = tenant.organisation_type || 'FUNDER';
  const roleContext = getRoleContext(role);

  return `You are EvidenceOS, ${tenant.name}'s institutional evidence intelligence layer.
Your sole job is to answer from the classified Zenex evidence estate with maximum epistemic discipline.

ROLE CONTEXT (${role}):
${roleContext}

Attribution rule: This organisation is a ${orgType}. ${attributionContext}

TEN HARD RULES — these override everything else:

RULE 1 — SCOPE:
The scope of every claim must not exceed the scope of the evidence supporting it. Do not generalise from a single programme, intervention arm, province, subgroup, outcome, or time point to a broader intervention class unless multiple sufficiently independent studies justify the generalisation.

RULE 2 — CAUSALITY:
Do not use "necessary," "sufficient," "required," "drives," "active ingredient," "key mechanism," or equivalent causal or mechanistic language unless the evidence design directly supports that inference. Where evidence is associative, observational, qualitative, pre-post, or quasi-experimental, use appropriately qualified language such as "associated with," "linked to," or "observed alongside."

RULE 3 — HETEROGENEITY:
Different results are not contradictions unless they represent materially incompatible propositions under sufficiently comparable conditions. Classify differing effect sizes, subgroup effects, provincial results, or contextual differences as heterogeneity and explain plausible moderators. Reserve "contradiction" for genuinely incompatible claims.

RULE 4 — INDEPENDENCE:
Multiple records do not automatically constitute independent confirmations. Consider whether studies share the same programme, sample, evaluation, data source, population, or underlying quantitative study. Assess independence explicitly before upgrading confidence.

RULE 5 — DECISION BOUNDARY:
Distinguish explicitly between what the evidence supports Zenex deciding, what it does not yet support, and what additional evidence would materially reduce uncertainty. Do not conflate "the evidence is promising" with "Zenex should act."

RULE 6 — ACTION:
For decision-oriented questions, provide one specific, evidence-linked next step in recommended_action. Do not use generic advice such as "review the evidence," "conduct more research," or "commission further research." If the evidence genuinely does not support a specific action, set recommended_action to null and state explicitly what uncertainty prevents one.

RULE 7 — MODERATOR LANGUAGE:
Do not infer that an identified moderator drives, determines or causes outcome differences unless the evidence directly establishes that causal relationship. Where evidence only identifies an association or plausible explanation, use "may contribute to", "is consistent with", or "may help explain" rather than causal verbs.

RULE 8 — EVIDENCE VS INFERENCE:
In decision-oriented responses, explicitly distinguish evidence-backed conclusions from strategic inference. Use the labels [Evidence-backed] and [Inference] inline where a statement could otherwise be interpreted as an empirical finding. Do not present a strategic premise as an empirical finding unless supported by the evidence estate.

RULE 9 — ACTION BOUNDARY:
Recommended action must be evidence-linked but must not impose a portfolio restriction, funding condition or sequencing requirement that the evidence does not directly support. Distinguish the evidence-supported next step from any broader strategic inference.

RULE 10 — EXCLUSION REPORTING:
If relevant records are retrieved but not used in synthesis, report the count in records_excluded and the principal reason in exclusion_reasons. Do not imply that all retrieved evidence contributed equally to the conclusion.

GAP TRIGGER RULES:
- Fewer than 2 relevant records retrieved → add "INSUFFICIENT_COVERAGE" to gap_triggers_fired.
- Most recent key evidence more than 3 years old and topic is fast-moving → add "CURRENCY_RISK".
- Two or more records reach opposing conclusions under comparable conditions → add "CONTRADICTION_DETECTED".
- Response requires inference beyond what records directly state → add "INFERENCE_RISK".

OUTPUT REQUIREMENTS:
Return a single, complete, syntactically valid JSON object conforming exactly to the schema below.
Never truncate, omit, or leave any field structurally incomplete.
If content must be shortened to fit, shorten prose inside fields — never omit fields or close braces early.
Return raw JSON only. No markdown. No code fences. No preamble. No explanation outside the JSON object. Begin your response with the opening brace { and end with the closing brace }. The final characters of your response must be }. Never stop generating before the closing brace.

CRITICAL: The JSON object must be syntactically complete. confidence_summary, sources, gap_triggers_fired and role_framing are mandatory closing fields. Never truncate the JSON before these fields are written. If content must be shortened to preserve output budget, shorten prose inside earlier fields — never omit or truncate later fields. Write concise evidence_basis values (1-2 sentences maximum per claim) to preserve budget for the mandatory closing fields.

SCHEMA:
${SCHEMA}`;
}

// ─── JSON validation and repair ──────────────────────────────
async function validateAndRepair(client, rawText, originalQuestion) {
  // First attempt: direct parse
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.bottom_line) return { parsed, method: 'direct' };
    } catch (_) {}
  }

  // Second attempt: ask Claude to repair
  try {
    const repair = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 16000,
      temperature: 0,
      system: 'You are a JSON repair tool. Return only valid, complete JSON. No markdown. No explanation.',
      messages: [{
        role: 'user',
        content: `The following text was supposed to be a JSON object but is malformed or incomplete. Repair it and return valid, complete JSON only:\n\n${rawText.slice(0, 16000)}`
      }]
    });
    const repairText = extractText(repair.content);
    const repairMatch = repairText.match(/\{[\s\S]*\}/);
    if (repairMatch) {
      const parsed = JSON.parse(repairMatch[0]);
      if (parsed.bottom_line) return { parsed, method: 'repaired' };
    }
  } catch (_) {}

  return { parsed: null, method: 'fallback' };
}

// ─── parse response ───────────────────────────────────────────
function parseSynthesis(parsed, rawText, recordsSearched, method) {
  if (parsed && parsed.bottom_line) {
    const recordIds = (parsed.sources || [])
      .map(s => s.record_id)
      .filter(Boolean);

    return {
      // v2 structured fields
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
      sources: parsed.sources || [],
      // v1 compat fields
      confidence: (parsed.what_the_evidence_shows?.[0]?.confidence) || 'LOW',
      records_searched: recordsSearched,
      supporting_record_ids: recordIds,
      contradictions: (parsed.heterogeneity_or_contradictions?.contradictions || []).join('; ') || null,
      generated_at: new Date().toISOString(),
      parse_method: method,
    };
  }

  // v1 regex fallback
  const recordIds = [...new Set((rawText.match(/\bADEI-[A-Z0-9-]+\b/g) || []))];
  const confidenceMatch = rawText.match(/\b(HIGH|MODERATE|LOW)\b/i);
  const actionMatch = rawText.match(/recommended action[:\s-]+([^\n]+)/i);
  return {
    answer: rawText,
    bottom_line: null,
    confidence: confidenceMatch ? confidenceMatch[1].toUpperCase() : 'LOW',
    records_searched: recordsSearched,
    supporting_record_ids: recordIds,
    contradictions: null,
    recommended_action: actionMatch ? actionMatch[1].trim() : null,
    generated_at: new Date().toISOString(),
    parse_method: 'regex_fallback',
  };
}

// ─── route ───────────────────────────────────────────────────
// Async job pattern (matches api/routes/tor.js): the Anthropic call for the
// full v2.1 schema can take well over CloudFront's origin timeout, so POST
// returns a jobId in well under a second and the actual generation runs
// detached from the HTTP response cycle. The frontend polls GET
// /status/:jobId until status is 'complete' or 'failed'.
router.post(
  '/',
  requireRoles('ORGANISATION_LEAD', 'EVIDENCE_ANALYST', 'CEO_EXEC', 'COMMUNICATIONS'),
  async (req, res, next) => {
    try {
      const question = String(req.body.question || '').trim();
      if (!question) return res.status(400).json({ error: 'question is required' });
      if (!process.env.ANTHROPIC_API_KEY)
        return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured' });

      const jobId = crypto.randomUUID();
      const startTime = Date.now();
      jobs[jobId] = {
        status: 'pending',
        result: null,
        error: null,
        tenantId: req.tenant?.slug || 'zenex',
        userId: req.user?.sub || null,
        createdAt: startTime,
      };

      res.status(202).json({ jobId, status: 'pending' });

      (async () => {
        try {
          jobs[jobId].status = 'processing';

          const records = process.env.DATABASE_URL ? await db.listRecords(req.tenant, {}) : [];
          const corpus  = buildCorpusSummary(records);
          const system  = buildSystem(req.tenant, req.user, orgTypeContext(req.tenant));
          const client  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

          const message = await client.messages.create({
            model: 'claude-sonnet-5',
            max_tokens: 32000,
            system,
            messages: [{
              role: 'user',
              content: `${question}\n\nCLASSIFIED CORPUS (${corpus.length} records):\n${JSON.stringify(corpus, null, 2)}`
            }],
          });

          const rawText = extractText(message.content);
          const { parsed, method } = await validateAndRepair(client, rawText, question);
          const result = parseSynthesis(parsed, rawText, corpus.length, method);

          jobs[jobId].status = 'complete';
          jobs[jobId].result = result;

          // Non-blocking usage log - the job already resolved async of the
          // HTTP response, so this only needs its own try/catch.
          try {
            await db.getPool().query(
              `INSERT INTO zenex.query_log
                (tenant_id, user_email, user_role, feature,
                 query_text, response_length, records_cited, response_time_ms)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
              [
                req.user?.tenant_id || req.tenant?.slug || 'zenex',
                req.user?.email    || 'unknown',
                req.user?.role     || 'unknown',
                'ASK_ZENEX',
                question,
                rawText.length,
                result.supporting_record_ids?.length || 0,
                Date.now() - startTime,
              ]
            );
          } catch (logErr) {
            console.error('query_log insert failed:', logErr.message);
          }
        } catch (err) {
          console.error(`[synthesis] job ${jobId} failed: ${err.message}`);
          if (jobs[jobId]) {
            jobs[jobId].status = 'failed';
            jobs[jobId].error = err.message;
          }
        }
      })();
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/status/:jobId',
  requireRoles('ORGANISATION_LEAD', 'EVIDENCE_ANALYST', 'CEO_EXEC', 'COMMUNICATIONS'),
  (req, res, next) => {
    try {
      const job = jobs[req.params.jobId];
      // A jobId alone is not an authorisation boundary: a job belonging to
      // a different tenant or a different user within the same tenant
      // returns 404, not 403, so its existence is never confirmed to an
      // unauthorised caller.
      if (!job || job.tenantId !== (req.tenant?.slug || 'zenex') || job.userId !== (req.user?.sub || null)) {
        return res.status(404).json({ status: 'not_found', result: null });
      }

      const response = { jobId: req.params.jobId, status: job.status };
      if (job.status === 'complete') response.result = job.result;
      if (job.status === 'failed') response.error = job.error;
      return res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
