/* PawsOff - ConsentGhost reload-loop circuit breaker.
 *
 * Regression coverage for the corriere.it / Sourcepoint hang: a CMP
 * "Preferences/Manage" opener that NAVIGATES the iframe (instead of opening an
 * in-document modal) makes the content script re-run on every reload, click the
 * opener again, and loop until Chrome's IPC-flooding throttle hangs the tab.
 *
 * The breaker bounds consent CLICK actions per frame within a short window,
 * persisted in sessionStorage so the count SURVIVES reloads. These tests load
 * the REAL src/content/consent-ghost.js via the harness, sharing one
 * sessionStorage stub across simulated reloads.
 */
'use strict';

const { test, assert, eq } = require('./harness/framework.js');
const { loadConsentGhost } = require('./harness/sandbox.js');

// Minimal Web Storage stub (synchronous, in-memory).
function makeSession() {
  let store = {};
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; },
    _raw() { return store; },
  };
}

// A storage stub whose every access throws - simulates a sandboxed / partitioned
// frame where `sessionStorage` raises SecurityError.
function makeThrowingSession() {
  return {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('SecurityError'); },
    removeItem() { throw new Error('SecurityError'); },
  };
}

test('breaker: allows up to CB_MAX_ACTIONS clicks, then trips', () => {
  const { internals } = loadConsentGhost();
  const max = internals.CB_MAX_ACTIONS;
  assert(max >= 1, 'a positive budget');
  for (let i = 0; i < max; i++) {
    eq(internals.consentClickAllowed(), true, 'click ' + (i + 1) + ' within budget');
  }
  eq(internals.consentClickAllowed(), false, 'next click trips the breaker');
  eq(internals.consentClickAllowed(), false, 'stays tripped within the window');
});

test('breaker: budget PERSISTS across a frame reload (the corriere.it loop is broken)', () => {
  const session = makeSession();
  const max = loadConsentGhost({ sessionStorage: session }).internals.CB_MAX_ACTIONS;

  // Simulate the loop: each reload is a FRESH module load that shares the same
  // frame sessionStorage. Each load clicks the navigating Preferences opener once.
  let lastAllowed = null;
  for (let reload = 0; reload < max + 2; reload++) {
    const { internals } = loadConsentGhost({ sessionStorage: session });
    lastAllowed = internals.consentClickAllowed();
  }
  eq(lastAllowed, false, 'after exhausting the budget across reloads, further clicks are denied');
  // And a brand-new module load still sees the tripped budget (no reset on reload).
  const fresh = loadConsentGhost({ sessionStorage: session }).internals;
  eq(fresh.consentClickAllowed(), false, 'reload does not reset the persisted budget');
});

test('breaker: the sliding window self-heals after it elapses', () => {
  const session = makeSession();
  const { internals } = loadConsentGhost({ sessionStorage: session });
  const max = internals.CB_MAX_ACTIONS;
  for (let i = 0; i < max; i++) internals.consentClickAllowed();
  eq(internals.consentClickAllowed(), false, 'tripped at the cap');

  // Rewind the stored timestamp beyond the window → next call resets the counter.
  const raw = JSON.parse(session.getItem(internals.CB_KEY));
  raw.t = Date.now() - (internals.CB_WINDOW_MS + 1000);
  session.setItem(internals.CB_KEY, JSON.stringify(raw));

  eq(internals.consentClickAllowed(), true, 'window elapsed → budget restored');
});

test('breaker: a throwing sessionStorage never throws and still enforces via memory', () => {
  const { internals } = loadConsentGhost({ sessionStorage: makeThrowingSession() });
  const max = internals.CB_MAX_ACTIONS;
  let threw = false;
  let allowed = 0;
  try {
    for (let i = 0; i < max; i++) { if (internals.consentClickAllowed()) allowed++; }
  } catch (_) { threw = true; }
  assert(!threw, 'no exception escapes even when sessionStorage throws');
  eq(allowed, max, 'in-memory fallback still grants the full budget');
  eq(internals.consentClickAllowed(), false, 'and still trips after the cap (memory-enforced)');
});

test('breaker: with no sessionStorage at all, the in-memory counter still works', () => {
  const { internals } = loadConsentGhost(); // default sandbox has no sessionStorage
  const max = internals.CB_MAX_ACTIONS;
  for (let i = 0; i < max; i++) eq(internals.consentClickAllowed(), true, 'within budget');
  eq(internals.consentClickAllowed(), false, 'trips without persistent storage too');
});
