#!/usr/bin/env node
'use strict';

// tests/run.js — the entire test runner. On purpose there is nothing clever
// here: it finds every *.test.js file under tests/, requires it, and calls
// each exported function. A test passes if its function does not throw
// (use Node's built-in assert). A test can return the string 'SKIP' to be
// counted separately, e.g. when a required external dependency (a database,
// AWS credentials) is not available in the current environment.
//
// Write a test file like this:
//
//   'use strict';
//   const assert = require('assert');
//   module.exports = {
//     'flag OFF returns false': async () => {
//       assert.strictEqual(1 + 1, 2);
//     },
//   };
//
// Run with: npm test  (or: node tests/run.js)

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const TESTS_DIR = __dirname;

function findTestFiles(dir) {
  let files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files = files.concat(findTestFiles(full));
    else if (entry.name.endsWith('.test.js')) files.push(full);
  }
  return files;
}

async function main() {
  const files = findTestFiles(TESTS_DIR).sort();
  let pass = 0;
  let fail = 0;
  let skip = 0;
  const failures = [];

  for (const file of files) {
    const rel = path.relative(TESTS_DIR, file);
    let mod;
    try {
      mod = require(file);
    } catch (err) {
      fail += 1;
      failures.push({ label: `${rel} (require failed)`, err });
      console.log(`FAIL  ${rel} (failed to load: ${err.message})`);
      continue;
    }

    for (const [name, fn] of Object.entries(mod)) {
      if (typeof fn !== 'function') continue;
      const label = `${rel} > ${name}`;
      try {
        const result = await fn();
        if (result === 'SKIP') {
          skip += 1;
          console.log(`SKIP  ${label}`);
        } else {
          pass += 1;
          console.log(`PASS  ${label}`);
        }
      } catch (err) {
        fail += 1;
        failures.push({ label, err });
        console.log(`FAIL  ${label}`);
        console.log(`      ${err.message}`);
      }
    }
  }

  console.log('');
  console.log(`${pass} passed, ${fail} failed, ${skip} skipped, ${pass + fail + skip} total`);

  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
      console.log(`  - ${f.label}`);
      if (f.err && f.err.stack) console.log(`    ${f.err.stack.split('\n').slice(0, 3).join('\n    ')}`);
    }
  }

  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
