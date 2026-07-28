'use strict';

const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const { requireRoles } = require('../middleware/permissions');
const db = require('../services/db');
const { getOrgContext } = require('../services/org-context');

const anthropic = new Anthropic();

router.post('/generate',
  requireRoles(
    'ORGANISATION_LEAD',
    'EVIDENCE_ANALYST'
  ),
  async (req, res, next) => {
    try {
      const { record_ids } = req.body;
      const tenant = req.tenant;

      if (!Array.isArray(record_ids) ||
          record_ids.length < 1) {
        return res.status(400).json({
          error: 'record_ids must be an array ' +
            'with at least one record',
        });
      }
      if (record_ids.length > 10) {
        return res.status(400).json({
          error: 'Maximum 10 records per synthesis',
        });
      }

      // Load full record data for each ID.
      const records = await db.getRecordsByIds(
        tenant, record_ids
      );

      if (!records || records.length === 0) {
        return res.status(404).json({
          error: 'No records found for provided IDs',
        });
      }

      const orgContext = getOrgContext(tenant);

      const systemPrompt = `You are a senior
evidence analyst for ${tenant.name}, a
${tenant.organisation_type || 'FUNDER'} in
South Africa's education sector.

You have been given ${records.length} classified
evaluation records from the ADEI corpus.

${orgContext.attribution}

CRITICAL RULES:
- Every finding must cite its source record ID
  in square brackets e.g. [ADEI-ZF-001]
- Confidence: HIGH (RCT or strong
  quasi-experimental), MODERATE (pre-post or
  comparison group), LOW (descriptive or
  narrative only)
- Evidence gaps must reference current policy
  context where relevant: FUNRS 2025,
  NLS 2024-2030, MTEF cycle,
  January 2026 lekgotla
- Leverage points must be specific and
  actionable for ${tenant.name} as a
  ${tenant.organisation_type || 'FUNDER'}
- For funders: leverage points are about what
  to commission, publish, or present
- Flag contradictions between records explicitly
- UK English throughout
- No contractions
- No em dashes
- Never use undefined or not available
- Keep the response concise enough to fit the
  token budget: maximum 3 findings, 3 evidence
  gaps, 3 leverage points, and 3 cross patterns
- Keep each string value under 35 words

Return ONLY valid JSON matching this exact
structure. No markdown. No preamble.
No explanation outside the JSON:

{
  "findings": [
    {
      "finding": "string",
      "confidence": "HIGH|MODERATE|LOW",
      "study_type": "string",
      "source_record_ids": ["string"],
      "corroborated": false,
      "contested": false,
      "contradiction_note": null
    }
  ],
  "evidence_gaps": [
    {
      "gap": "string",
      "policy_relevance": "string or null",
      "urgency": "HIGH|MEDIUM|LOW",
      "commissioning_opportunity": false
    }
  ],
  "leverage_points": [
    {
      "action": "string",
      "rationale": "string",
      "urgency": "HIGH|MEDIUM|LOW",
      "expected_influence": "string"
    }
  ],
  "cross_patterns": [
    {
      "pattern": "string",
      "records_involved": ["string"],
      "implication": "string"
    }
  ]
}`;

      // Build corpus for Claude.
      const corpusSummary = records.map(r => ({
        id: r.id,
        programme_name: r.programme_name,
        document_type: r.document_type,
        evaluation_subtype: r.evaluation_subtype,
        evaluation_design: r.evaluation_design,
        year: r.year,
        provinces: r.provinces,
        grade: r.grade,
        sample_size_learners: r.sample_size_learners,
        sample_size_schools: r.sample_size_schools,
        methodology_description:
          r.methodology_description,
        key_finding_1: r.key_finding_1,
        key_finding_2: r.key_finding_2,
        key_finding_3: r.key_finding_3,
        null_findings_reported:
          r.null_findings_reported,
        non_significant_variables:
          r.non_significant_variables,
        effect_size_composite:
          r.effect_size_composite,
        effect_direction: r.effect_direction,
        eqs_composite: r.eqs_composite,
        eqs_tier: r.eqs_tier,
        policy_alignment: r.policy_alignment,
        decision_relevance: r.decision_relevance,
        evidence_gap_1: r.evidence_gap_1,
        evidence_gap_2: r.evidence_gap_2,
        limitations: r.limitations,
        dbe_adoption_status: r.dbe_adoption_status,
        implementing_organisation_name:
          r.implementing_organisation_name,
        cost_data_present: r.cost_data_present,
        half_life_rating: r.half_life_rating,
      }));

      const userPrompt =
        `Produce a strategic synthesis for ` +
        `these ${records.length} classified ` +
        `evaluation records:\n\n` +
        JSON.stringify(corpusSummary, null, 2);

      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 3000,
        temperature: 0.1,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: userPrompt,
        }],
      });

      // Extract and parse JSON response.
      let rawText = message.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');

      // Strip markdown code fences if present.
      rawText = rawText
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();

      const firstBrace = rawText.indexOf('{');
      const lastBrace = rawText.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        rawText = rawText.slice(firstBrace, lastBrace + 1);
      }

      let parsed;
      try {
        parsed = JSON.parse(rawText);
      } catch (parseErr) {
        console.error(
          'Synthesis JSON parse error:',
          parseErr.message,
          rawText.slice(0, 500)
        );
        return res.status(500).json({
          error: 'Synthesis response could not ' +
            'be parsed. Please try again.',
        });
      }

      // Save to zenex.syntheses.
      const synthesisTitle = records
        .map(r => r.programme_name)
        .join(' + ')
        .slice(0, 200);

      const saved = await db.saveSynthesis(tenant, {
        title: synthesisTitle,
        record_ids: record_ids,
        record_count: records.length,
        findings: parsed.findings || [],
        evidence_gaps: parsed.evidence_gaps || [],
        leverage_points: parsed.leverage_points || [],
        cross_patterns: parsed.cross_patterns || [],
      });

      return res.json({
        success: true,
        synthesis_id: saved.id,
        title: synthesisTitle,
        record_ids: record_ids,
        record_count: records.length,
        findings: parsed.findings || [],
        evidence_gaps: parsed.evidence_gaps || [],
        leverage_points:
          parsed.leverage_points || [],
        cross_patterns:
          parsed.cross_patterns || [],
        generated_at: new Date().toISOString(),
      });

    } catch (err) {
      next(err);
    }
  }
);

// GET saved synthesis by ID.
router.get('/:id',
  requireRoles(
    'ORGANISATION_LEAD',
    'EVIDENCE_ANALYST',
    'COMMUNICATIONS',
    'CEO_EXEC'
  ),
  async (req, res, next) => {
    try {
      const synthesis = await db.getSynthesis(
        req.tenant, req.params.id
      );
      if (!synthesis) {
        return res.status(404).json({
          error: 'Synthesis not found',
        });
      }
      return res.json(synthesis);
    } catch (err) {
      next(err);
    }
  }
);

// GET list of syntheses for tenant.
router.get('/',
  requireRoles(
    'ORGANISATION_LEAD',
    'EVIDENCE_ANALYST'
  ),
  async (req, res, next) => {
    try {
      const list = await db.listSyntheses(
        req.tenant
      );
      return res.json(list);
    } catch (err) {
      next(err);
    }
  }
);

// POST confirm a synthesis.
router.post('/:id/confirm',
  requireRoles('ORGANISATION_LEAD'),
  async (req, res, next) => {
    try {
      const updated = await db.confirmSynthesis(
        req.tenant,
        req.params.id,
        req.user?.sub
      );
      return res.json({
        success: true,
        synthesis: updated,
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
