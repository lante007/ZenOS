'use strict';

// api/memory/prophet-contract.js
// Capability contract for future Prophet processing. NO execution here. This
// documents and validates the shape of a Prophet assessment so the rest of
// the system can be built against a stable interface. Prophet, when built,
// consumes signals + patterns + memory and MUST keep these layers distinct:
//   observed fact -> interpretation -> assumption -> scenario -> confidence -> recommendation
// No unsupported certainty: every scenario carries explicit assumptions and a
// confidence level, and every consequential recommendation requires approval.

const PROPHET_PIPELINE = ['signal', 'pattern', 'risk_or_opportunity', 'scenario', 'consequence', 'recommendation'];
const LAYERS = ['observed_fact', 'interpretation', 'assumption', 'scenario', 'confidence', 'recommendation'];

// Shape a Prophet assessment must satisfy (validation only).
function validateProphetAssessment(a) {
  const errors = [];
  if (!a || typeof a !== 'object') return ['assessment must be an object'];
  if (!Array.isArray(a.observed_facts)) errors.push('observed_facts[] required');
  if (!Array.isArray(a.interpretations)) errors.push('interpretations[] required');
  if (!Array.isArray(a.assumptions)) errors.push('assumptions[] required');
  if (!Array.isArray(a.scenarios) || a.scenarios.length === 0) errors.push('scenarios[] required (>=1)');
  else {
    a.scenarios.forEach((s, i) => {
      if (!s.description) errors.push(`scenarios[${i}].description required`);
      if (!['HIGH', 'MODERATE', 'LOW', 'UNKNOWN'].includes(s.confidence)) errors.push(`scenarios[${i}].confidence must be HIGH|MODERATE|LOW|UNKNOWN`);
      if (!Array.isArray(s.rests_on_assumptions)) errors.push(`scenarios[${i}].rests_on_assumptions[] required`);
    });
  }
  if (!Array.isArray(a.recommendations)) errors.push('recommendations[] required');
  else {
    a.recommendations.forEach((r, i) => {
      if (!r.action) errors.push(`recommendations[${i}].action required`);
      if (r.consequential && r.requires_approval !== true) errors.push(`recommendations[${i}] is consequential and must set requires_approval:true`);
    });
  }
  return errors;
}

module.exports = { PROPHET_PIPELINE, LAYERS, validateProphetAssessment };
