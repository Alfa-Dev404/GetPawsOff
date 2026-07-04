#!/usr/bin/env node
/* PawsOff - test runner.
 *
 * Discovers every *.test.js under tests/, registers their cases, runs them, and
 * exits non-zero if anything fails (so CI can gate on it). No dependencies.
 *
 *   node tests/run.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const framework = require('./harness/framework');

const dir = __dirname;
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

console.log('PawsOff test suite - ' + files.length + ' file(s)\n');
for (const f of files) {
  console.log(f);
  require(path.join(dir, f));
}
console.log('');

framework.runAll().then((failed) => process.exit(failed ? 1 : 0));
