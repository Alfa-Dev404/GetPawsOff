/* PawsOff - prehide/engine split (perf Change 3).
 *
 * consent-prehide.js runs at document_start and owns flash suppression with an
 * UNCONDITIONAL watchdog; the engine (document_idle) reveals early via the shared
 * isolated-world hook window.__pawsOff_revealPrehide. These tests lock: watchdog
 * reveal with no engine, hook reveal, double-reveal idempotency, and the
 * selector-set sync contract (incl. coverage of the CMP-API target set).
 */
'use strict';

const { test, assert, eq } = require('./harness/framework');
const { loadConsentPrehide, loadConsentGhost } = require('./harness/sandbox');

test('prehide: injects a <style> and exposes the reveal hook', () => {
  const p = loadConsentPrehide();
  eq(p.document.documentElement._kids.length, 1, 'prehide <style> injected at document_start');
  assert(typeof p.win.__pawsOff_revealPrehide === 'function', 'reveal hook exposed on isolated-world window');
  assert(p.scheduled.length === 1 && p.scheduled[0].ms === p.internals.PREHIDE_MAX_MS,
    'watchdog scheduled at PREHIDE_MAX_MS');
});

test('prehide: (ii) gated sub-frame / no engine - watchdog still reveals', () => {
  const p = loadConsentPrehide();
  eq(p.document.documentElement._kids.length, 1);
  p.scheduled[0].fn();                       // engine never loads; only the watchdog fires
  eq(p.document.documentElement._kids.length, 0, 'watchdog removed the style with no engine present');
});

test('prehide: engine reveal hook removes the style (early optimization path)', () => {
  const p = loadConsentPrehide();
  p.win.__pawsOff_revealPrehide();           // simulate the engine calling the hook
  eq(p.document.documentElement._kids.length, 0, 'hook removed the style');
});

test('prehide: (iii) double-reveal is idempotent (watchdog + hook)', () => {
  const p = loadConsentPrehide();
  p.win.__pawsOff_revealPrehide();
  p.scheduled[0].fn();                        // second reveal must be a safe no-op
  p.win.__pawsOff_revealPrehide();
  eq(p.document.documentElement._kids.length, 0, 'still removed exactly once, no throw');
});

test('prehide: SYNC CONTRACT - selector set equals the engine BUNDLED set', () => {
  const prehide = loadConsentPrehide().internals.CONTAINER_SELECTORS;
  const bundled = loadConsentGhost().internals.BUNDLED_CONSENT_CONFIG.map((f) => f.containerSelector);
  eq(JSON.stringify(prehide), JSON.stringify(bundled),
    'consent-prehide CONTAINER_SELECTORS must mirror BUNDLED_CONSENT_CONFIG containerSelectors');
});

test('prehide: (i) covers every CMP-API target selector (no flash from idle ping)', () => {
  // requestCmpApiMain iterates activeConfig (= BUNDLED at request time); every
  // selector it can target must be prehidden so the idle ping causes no flash.
  const prehide = loadConsentPrehide().internals.CONTAINER_SELECTORS;
  const targets = loadConsentGhost().internals.BUNDLED_CONSENT_CONFIG.map((f) => f.containerSelector);
  assert(targets.every((s) => prehide.includes(s)),
    'prehide selector set is a superset of the CMP-API target set');
});

test('prehide: buildPrehideCss matches the engine (per-rule, injection-safe)', () => {
  const a = loadConsentPrehide().internals.buildPrehideCss(['#a, .b', 'x{}', '@bad']);
  const b = loadConsentGhost().internals.buildPrehideCss(['#a, .b', 'x{}', '@bad']);
  eq(a, b, 'identical CSS builder behavior across the split');
  eq(a, '#a{visibility:hidden!important}.b{visibility:hidden!important}', 'expected output');
});
