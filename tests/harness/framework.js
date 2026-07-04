/* PawsOff - tiny zero-dependency test framework.
 *
 * Just enough to register tests, assert, and exit non-zero on failure so it can
 * run under `node tests/run.js` (and later in CI) without any npm install.
 */
'use strict';

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg ? msg + ': ' : '') + 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

function approx(actual, expected, eps, msg) {
  const e = eps == null ? 1e-9 : eps;
  // NaN is typeof 'number' and `Math.abs(NaN - x) > e` is false, so a NaN result
  // would silently pass. Reject it explicitly.
  if (typeof actual !== 'number' || Number.isNaN(actual) || Math.abs(actual - expected) > e) {
    throw new Error((msg ? msg + ': ' : '') + 'expected ~' + expected + ', got ' + actual);
  }
}

async function runAll() {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log('  \u2713 ' + t.name);
    } catch (e) {
      failed++;
      console.log('  \u2717 ' + t.name);
      const line = e && e.stack ? e.stack.split('\n').slice(0, 2).join('\n        ') : String(e);
      console.log('        ' + line);
    }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed, ' + tests.length + ' total');
  return failed;
}

module.exports = { test, assert, eq, approx, runAll };
