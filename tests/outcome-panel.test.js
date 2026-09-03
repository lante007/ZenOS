'use strict';

// tests/outcome-panel.test.js — C6: the Chief of Staff cockpit's outcome
// capture panel appears once a job is complete, and not before.
//
// The frontend has no test framework or dependency of its own (no jest, no
// testing-library — see frontend/package.json); this repo adds none for it.
// Instead, the render decision lives in a small plain module,
// frontend/src/lib/outcomePanel.js, with no JSX and no React import, so it
// can be exercised directly here with a native dynamic import() from this
// plain Node/CommonJS test (Node supports importing an ESM module from a
// CommonJS file this way without any additional tooling). main.jsx imports
// this exact same function for its real render condition, so this test is
// not a reimplementation of the logic under a different name — it is the
// logic.

const assert = require('assert');
const path = require('path');

const MODULE_PATH = path.join(__dirname, '..', 'frontend', 'src', 'lib', 'outcomePanel.js');

const DONE_JOB = { job_id: '11111111-1111-1111-1111-111111111111', answer: 'Here is the synthesis.', status: 'completed' };

module.exports = {
  'the outcome panel shows once a job is done and has produced an answer': async () => {
    const { shouldShowOutcomePanel } = await import(MODULE_PATH);
    assert.strictEqual(shouldShowOutcomePanel('done', DONE_JOB), true);
  },

  'the outcome panel does not show while a job is starting or running': async () => {
    const { shouldShowOutcomePanel } = await import(MODULE_PATH);
    assert.strictEqual(shouldShowOutcomePanel('starting', null), false);
    assert.strictEqual(shouldShowOutcomePanel('running', { job_id: 'x' }), false);
  },

  'the outcome panel does not show when a job failed, even if a job object is present': async () => {
    const { shouldShowOutcomePanel } = await import(MODULE_PATH);
    assert.strictEqual(shouldShowOutcomePanel('error', { job_id: 'x', answer: null }), false);
  },

  'the outcome panel does not show for a done phase with no job loaded yet': async () => {
    const { shouldShowOutcomePanel } = await import(MODULE_PATH);
    assert.strictEqual(shouldShowOutcomePanel('done', null), false);
  },

  'the outcome panel does not show if the job has no answer or no job_id, even when done': async () => {
    const { shouldShowOutcomePanel } = await import(MODULE_PATH);
    assert.strictEqual(shouldShowOutcomePanel('done', { job_id: '1', answer: '' }), false);
    assert.strictEqual(shouldShowOutcomePanel('done', { answer: 'x' }), false);
  },
};
