'use strict';

// api/intelligence/confidence.js
// Shared confidence vocabulary. Confidence is not decorative: it must track
// how well retrieved evidence actually answers the question.

const CONFIDENCE_LEVELS = ['HIGH', 'MODERATE', 'LOW', 'UNKNOWN'];

const CONFIDENCE_GUIDANCE = `
CONFIDENCE VOCABULARY (use exactly these four values)
HIGH: directly supported by retrieved evidence, source identifiable.
MODERATE: supported by multiple signals but with named limitations.
LOW: reasonable inference with material missing information.
UNKNOWN: the available corpus and context cannot answer this.
Confidence must reflect evidence availability, not tone. If no document was
retrieved for a claim, its confidence cannot be HIGH.
`;

function normaliseConfidence(value) {
  const v = String(value || '').trim().toUpperCase();
  return CONFIDENCE_LEVELS.includes(v) ? v : 'UNKNOWN';
}

module.exports = { CONFIDENCE_LEVELS, CONFIDENCE_GUIDANCE, normaliseConfidence };
