// frontend/src/lib/outcomePanel.js
// C6: the pure decision behind whether the Chief of Staff cockpit shows the
// outcome capture panel below an Advisor response. Kept as a small, plain
// (non-JSX) module, separate from main.jsx, specifically so it can be
// imported and unit tested without a JSX/React test runner: this repo adds
// no new frontend test dependency for it (see tests/outcome-panel.test.js,
// which imports this file directly via dynamic import()).
//
// The panel must appear once a job has actually produced an answer, and
// must not appear while a job is still starting, running, or has failed --
// there is nothing to record an outcome against yet.
export function shouldShowOutcomePanel(phase, job) {
  return phase === 'done' && Boolean(job) && Boolean(job.answer) && Boolean(job.job_id);
}
