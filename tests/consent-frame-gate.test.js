/* PawsOff - sub-frame relevance gate (perf Change 2).
 *
 * The broad consent script injects into EVERY frame (all_frames:true). Empty ad
 * iframes must not pay for the regex rebuild + scan + MutationObserver. init()
 * now bails early in a sub-frame unless it's a known CMP host or reads like a
 * consent page. shouldRunInFrame(isTop, hostname, bodyText) is the pure decision
 * behind that gate; we lock its semantics here.
 */
'use strict';

const { test, assert } = require('./harness/framework.js');
const { loadConsentGhost } = require('./harness/sandbox.js');

const { internals } = loadConsentGhost();
const shouldRunInFrame = internals.shouldRunInFrame;

test('frame-gate: exported as a pure function', () => {
  assert(typeof shouldRunInFrame === 'function', 'shouldRunInFrame is exported via __test');
});

test('frame-gate: top frame always runs', () => {
  assert(shouldRunInFrame(true, 'ad.doubleclick.net', '') === true, 'top frame runs regardless');
  assert(shouldRunInFrame(true, 'example.com', 'cookie consent') === true, 'top frame with keywords runs');
});

test('frame-gate: sub-frame on a non-CMP host with no consent text is skipped', () => {
  assert(shouldRunInFrame(false, 'ad.doubleclick.net', '') === false, 'empty ad iframe skipped');
  assert(shouldRunInFrame(false, 'tpc.googlesyndication.com', 'buy now great deals') === false,
    'non-consent ad content skipped');
});

test('frame-gate: sub-frame whose document reads like a consent page runs', () => {
  assert(shouldRunInFrame(false, 'example.org', 'We use cookies to improve your experience') === true,
    'consent keyword triggers run');
  assert(shouldRunInFrame(false, 'example.org', 'Datenschutz und Einwilligung') === true,
    'non-English consent keyword triggers run');
});

test('frame-gate: sub-frame on a known CMP host always runs (even with empty body)', () => {
  assert(shouldRunInFrame(false, 'cdn.privacy-mgmt.com', '') === true, 'privacy-mgmt.com runs');
  assert(shouldRunInFrame(false, 'foo.sp-prod.net', '') === true, 'sp-prod.net runs');
  assert(shouldRunInFrame(false, 'sourcepoint.theguardian.com', '') === true, 'sourcepoint host runs');
});

test('frame-gate: a large sub-frame document is treated as real content and skipped', () => {
  const big = ('cookie '.repeat(4000)); // > 20000 chars, contains the keyword
  assert(big.length > 20000, 'fixture exceeds the 20000-char cap');
  assert(shouldRunInFrame(false, 'example.org', big) === false,
    'oversized body is a real content frame, not a banner');
});
