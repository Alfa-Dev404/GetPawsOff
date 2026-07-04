/* PawsOff - regression tests for the popup headline stats strip.
 *
 * Covers the new per-site headline logic. The "Blocked" stat now sums real-time
 * DNR requests for the current tab + DOM/pixel tier blocks from state.catches.
 * These are pure helpers exposed via the popup's __test hook, so no DOM runs.
 *
 * The "Saved" stat uses REAL learned average transfer sizes from the
 * Performance API instead of the old hardcoded 4.2 KB fiction. When no data
 * has been learned yet, it shows "0 KB" (honest) instead of a fake number.
 */
'use strict';

const { test, assert, eq } = require('./harness/framework');
const { loadPopup } = require('./harness/sandbox');

const P = loadPopup().internals || {};

// Restore the shared popup state so one test's mutations can't leak into the
// next - even when an assertion throws (hence finally, not a trailing reset).
function resetState() {
  const s = P.getState();
  s._tabDnrBlocked = 0;
  s.catches = [];
  s._learnedAvgKB = 0;
}

test('popup: headline helpers are exposed via the test hook', () => {
  assert(typeof P.formatSaved === 'function', 'formatSaved exported');
  assert(typeof P.computeHeadline === 'function', 'computeHeadline exported');
});

test('formatSaved: humanizes the bandwidth estimate, never NaN', () => {
  eq(P.formatSaved(0), '0 KB');
  eq(P.formatSaved(-5), '0 KB');
  eq(P.formatSaved(NaN), '0 KB');
  eq(P.formatSaved(12.34), '~12.3 KB');
  eq(P.formatSaved(250), '~250 KB');
  eq(P.formatSaved(2048), '~2.0 MB');
});

test('computeHeadline: Blocked sums real-time network + DOM tiers for current site', () => {
  const state = P.getState();
  try {
    state._tabDnrBlocked = 12;
    state.catches = [
      { feature: 'banner', network: false },
      { feature: 'banner', network: false },
      { feature: 'tracker', network: false }, // DOM block
      { feature: 'tracker', network: false }, // DOM block
      { feature: 'tracker', network: true }   // Network catch (ignored, handled by real-time _tabDnrBlocked)
    ];
    const h = P.computeHeadline();
    eq(h.blocked, 14, 'network (12) + DOM (2) are summed');
    eq(h.banners, 2);
    // With no learned average (_learnedAvgKB = 0), saved should be 0 KB (honest)
    eq(h.saved, '0 KB', 'no fake number when no data has been learned');
  } finally { resetState(); }
});

test('computeHeadline: DNR-sourced catches are not double-counted', () => {
  // Real DNR records are tagged source:'dnr' (no `network` flag). They must be
  // excluded from the DOM tally - they're already in the real-time _tabDnrBlocked
  // count - otherwise Blocked/Data-saved inflate.
  const state = P.getState();
  try {
    state._tabDnrBlocked = 5;
    state.catches = [
      { feature: 'tracker', source: 'dnr' }, // network block - must NOT add to DOM tally
      { feature: 'tracker', source: 'dnr' },
      { feature: 'tracker' }                  // genuine DOM block - counts
    ];
    const h = P.computeHeadline();
    eq(h.blocked, 6, 'real-time (5) + 1 DOM block; the two source:dnr records are excluded');
  } finally { resetState(); }
});

test('computeHeadline: network blocks alone surface', () => {
  const state = P.getState();
  try {
    state._tabDnrBlocked = 42;
    state.catches = [];
    const h = P.computeHeadline();
    eq(h.blocked, 42, 'network-only blocking is reported correctly');
  } finally { resetState(); }
});

test('computeHeadline: empty state yields zeros', () => {
  const state = P.getState();
  try {
    state._tabDnrBlocked = 0;
    state.catches = [];
    state._learnedAvgKB = 0;
    const empty = P.computeHeadline();
    eq(empty.blocked, 0);
    eq(empty.banners, 0);
    eq(empty.saved, '0 KB');
  } finally { resetState(); }
});

test('computeHeadline: learned average produces real saved estimate', () => {
  const state = P.getState();
  try {
    state._learnedAvgKB = 15.5; // 15.5 KB average per blocked request (realistic)
    state._tabDnrBlocked = 100;
    state.catches = [];
    const h = P.computeHeadline();
    // 100 blocks * 15.5 KB = 1550 KB → "~1.5 MB"
    eq(h.saved, '~1.5 MB', 'uses learned average, not a fake constant');
  } finally { resetState(); }
});
