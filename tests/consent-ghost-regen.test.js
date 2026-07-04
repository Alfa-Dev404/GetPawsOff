/* PawsOff - ConsentGhost banner-REGENERATION breaker.
 *
 * Regression coverage for the repubblica.it / focus.de (contentpass) loop: the
 * CMP does NOT reload the page - it re-INJECTS a fresh banner after each
 * dismissal and fires a pushState that runs resetForNavigation(), wiping the
 * sessionStorage CLICK budget every cycle. The async chrome.storage reload guard
 * races and never accumulates under a sub-second loop, so we'd reject → new
 * banner → reject forever.
 *
 * The regeneration breaker counts our REJECTIONS per origin in sessionStorage
 * (synchronous, and NOT cleared by resetForNavigation), then stands down for a
 * cool-off once we've clearly looped. These tests drive the real internals via
 * the harness, sharing one sessionStorage stub across simulated SPA reloads.
 */
'use strict';

const { test, assert, eq } = require('./harness/framework.js');
const { loadConsentGhost } = require('./harness/sandbox.js');

function makeSession() {
  let store = {};
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; },
    _raw() { return store; },
  };
}

test('regen: stands down only AFTER exceeding the per-origin reject allowance', () => {
  const { internals } = loadConsentGhost({ sessionStorage: makeSession() });
  const max = internals.REGEN_MAX_REJECTS;
  assert(max >= 1, 'a positive allowance');
  eq(internals.regenLoopTripped(), false, 'fresh origin is not tripped');
  for (let i = 0; i < max; i++) {
    internals.recordRejectForRegen();
  }
  eq(internals.regenLoopTripped(), true, 'tripped once the allowance is reached');
});

test('regen: the stand-down SURVIVES SPA navigation (resetForNavigation never clears it)', () => {
  // Each "reload" is a fresh module load sharing the same frame sessionStorage,
  // exactly like a CMP that re-injects + pushState()s after every reject.
  const session = makeSession();
  const max = loadConsentGhost({ sessionStorage: session }).internals.REGEN_MAX_REJECTS;

  for (let cycle = 0; cycle < max; cycle++) {
    const { internals } = loadConsentGhost({ sessionStorage: session });
    internals.recordRejectForRegen(); // one reject per regenerated banner
  }
  // A brand-new load (post-pushState) must still see the tripped cool-off.
  const fresh = loadConsentGhost({ sessionStorage: session }).internals;
  eq(fresh.regenLoopTripped(), true, 'cool-off persists across SPA navigations');
});

test('regen: the cool-off self-heals after REGEN_STANDDOWN_MS', () => {
  const session = makeSession();
  const { internals } = loadConsentGhost({ sessionStorage: session });
  const max = internals.REGEN_MAX_REJECTS;
  for (let i = 0; i < max; i++) internals.recordRejectForRegen();
  eq(internals.regenLoopTripped(), true, 'tripped');

  // Rewind the stored cool-off deadline into the past.
  const rec = JSON.parse(session.getItem(internals.REGEN_KEY));
  rec.until = Date.now() - 1000;
  session.setItem(internals.REGEN_KEY, JSON.stringify(rec));

  eq(internals.regenLoopTripped(), false, 'cool-off elapsed → we may try again');
});

test('regen: a window-elapsed reject count resets (occasional rejects never trip)', () => {
  const session = makeSession();
  const { internals } = loadConsentGhost({ sessionStorage: session });
  const max = internals.REGEN_MAX_REJECTS;

  // max-1 rejects, then let the window lapse before the next one.
  for (let i = 0; i < max - 1; i++) internals.recordRejectForRegen();
  const rec = JSON.parse(session.getItem(internals.REGEN_KEY));
  rec.t = Date.now() - (internals.REGEN_WINDOW_MS + 1000);
  session.setItem(internals.REGEN_KEY, JSON.stringify(rec));

  internals.recordRejectForRegen(); // starts a fresh window at n=1
  eq(internals.regenLoopTripped(), false, 'spread-out rejects do not trip the loop guard');
});

test('regen: never throws and stays quiet with no sessionStorage at all', () => {
  const { internals } = loadConsentGhost(); // default sandbox: no sessionStorage
  let threw = false;
  try {
    eq(internals.regenLoopTripped(), false, 'no storage → not tripped');
    for (let i = 0; i < internals.REGEN_MAX_REJECTS; i++) internals.recordRejectForRegen();
    // In-memory fallback still enforces the loop guard.
    eq(internals.regenLoopTripped(), true, 'in-memory fallback still bounds the loop');
  } catch (_) { threw = true; }
  assert(!threw, 'no exception escapes when sessionStorage is absent');
});
