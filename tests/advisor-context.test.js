'use strict';

// tests/advisor-context.test.js — C3: source-type labelling instructions in
// ADVISOR_CONTEXT.
//
// ADVISOR_CONTEXT is sent as the Anthropic `system` prompt on every Advisor
// call (see runAdvisorAgent in api/intelligence/agents/advisor.js) -- it is
// a static string, not built per-request, so it carries no tenantId/meta
// and cannot itself be flag-gated. That is exactly the point of C3: the
// instruction to label every claim EVIDENCE / MEMORY / SIGNAL / INFERRED /
// RECOMMENDATION, and never blend those categories, must always be present,
// whether or not MEMORY_CONTEXT_ENABLED is on for the tenant asking the
// question. This test asserts that unconditionally, with no DB required.

const assert = require('assert');
const { ADVISOR_CONTEXT } = require('../api/intelligence/contexts/advisor');

module.exports = {
  'ADVISOR_CONTEXT names all five source-type labels': async () => {
    for (const label of ['EVIDENCE', 'MEMORY', 'SIGNAL', 'INFERRED', 'RECOMMENDATION']) {
      assert.ok(
        ADVISOR_CONTEXT.includes(label),
        `expected ADVISOR_CONTEXT to mention the ${label} source-type label`,
      );
    }
  },

  'ADVISOR_CONTEXT instructs against blending source-type categories': async () => {
    assert.ok(
      /never blend/i.test(ADVISOR_CONTEXT),
      'expected an explicit instruction not to blend source-type categories',
    );
  },

  'ADVISOR_CONTEXT instructs against manufacturing MEMORY or SIGNAL claims when none were supplied': async () => {
    assert.ok(
      /no MEMORY or no SIGNAL/i.test(ADVISOR_CONTEXT) || /none were available/i.test(ADVISOR_CONTEXT),
      'expected an instruction against fabricating MEMORY/SIGNAL claims when none were supplied',
    );
  },

  'the labelling instructions do not depend on any flag or tenant (static string)': async () => {
    // ADVISOR_CONTEXT takes no arguments and is exported as a plain string;
    // its presence/content cannot vary by tenant or by MEMORY_CONTEXT_ENABLED.
    assert.strictEqual(typeof ADVISOR_CONTEXT, 'string');
    const first = require('../api/intelligence/contexts/advisor').ADVISOR_CONTEXT;
    assert.strictEqual(first, ADVISOR_CONTEXT);
  },
};
