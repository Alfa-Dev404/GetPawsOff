/* PawsOff - ConsentGhost scan generation-guard (the double-click race fix).
 *
 * scanAndReject() is async: it awaits the autoconsent layer and per-framework
 * step engines BEFORE it clicks. The old in-flight lock was a bare boolean
 * (`_scanning`) that resetForNavigation() force-cleared. If an await resolved
 * AFTER a client-side navigation reset, the orphaned scan could resume and click
 * on the freshly-navigated page while a NEW scan was also running - a double
 * click (e.g. on pushState-spam consent walls like repubblica.it).
 *
 * The fix replaces that boolean with a monotonic GENERATION guard: a scan
 * captures the generation when it takes the lock; a navigation/disable reset
 * bumps the generation; the resumed scan sees its generation is stale and bails
 * BEFORE clicking (and refuses to clobber the newer scan's lock in `finally`).
 *
 * makeScanGuard() is the pure primitive behind that; we lock its semantics here.
 */
'use strict';

const { test, assert } = require('./harness/framework.js');
const { loadConsentGhost } = require('./harness/sandbox.js');

const { internals } = loadConsentGhost();
const makeScanGuard = internals.makeScanGuard;

test('scanguard: exported as a pure factory', () => {
  assert(typeof makeScanGuard === 'function', 'makeScanGuard is exported via __test');
});

test('scanguard: a scan is current right after it captures, stale after a reset', () => {
  const g = makeScanGuard();
  const my = g.capture();
  assert(g.isCurrent(my), 'current immediately after capture');
  g.invalidate(); // resetForNavigation() / re-enable bumps the generation
  assert(!g.isCurrent(my), 'stale once a navigation/disable reset invalidated it');
});

test('scanguard: a scan started AFTER the reset owns the current generation', () => {
  const g = makeScanGuard();
  const a = g.capture(); // scan A takes the lock
  g.invalidate();        // navigation resets
  const b = g.capture(); // scan B starts on the new page
  assert(!g.isCurrent(a), 'scan A is superseded');
  assert(g.isCurrent(b), 'scan B owns the current generation');
});

test('scanguard: models the double-click fix - resumed scan A bails, scan B proceeds', () => {
  // A: _scanning=true, captured gen ; navigation invalidates ; B: new scan.
  // When A resumes from its await, the guard must tell it to bail before click.
  const g = makeScanGuard();
  const aGen = g.capture();
  g.invalidate();
  const bGen = g.capture();
  const aShouldBail = !g.isCurrent(aGen);   // the post-await check inside scanAndReject
  const bShouldProceed = g.isCurrent(bGen);
  assert(aShouldBail, 'resumed scan A detects it is stale and returns before clicking');
  assert(bShouldProceed, 'scan B continues normally');
});

test('scanguard: independent instances do not interfere', () => {
  const g1 = makeScanGuard();
  const g2 = makeScanGuard();
  const t1 = g1.capture();
  g2.invalidate();
  assert(g1.isCurrent(t1), 'invalidating one guard never affects another');
});
