/* PawsOff - orphaned-backdrop reaper.
 *
 * Bug: cross-origin CMPs (Sourcepoint) render the dialog in their OWN iframe, but
 * the full-screen click-blocking VEIL + page scroll-lock live in the TOP document.
 * When the reject happens inside that iframe, the CMP sometimes fails to tear the
 * veil down, leaving the page visually clear but unclickable/unscrollable.
 *
 * reapOrphanBackdrops() neutralizes a KNOWN consent veil + restores scrolling,
 * but ONLY when no consent dialog/iframe is still on screen (so it can never
 * strip a banner that's still legitimately up).
 */
'use strict';

const { test, assert, eq } = require('./harness/framework');
const { loadConsentGhost } = require('./harness/sandbox');

const I = () => loadConsentGhost({ enabled: true, document: makeDoc() }).internals;

// ── fake-DOM helpers ────────────────────────────────────────────────────────
function camel(k) { return k.replace(/-([a-z])/g, (_, c) => c.toUpperCase()); }
function styleObj(initial) {
  const s = Object.assign({ _props: {} }, initial || {});
  s.setProperty = function (k, v) { this._props[k] = v; this[camel(k)] = v; };
  s.removeProperty = function (k) { this._props[k] = undefined; this[camel(k)] = ''; };
  return s;
}
function classListObj(arr) {
  const set = new Set(arr || []);
  return { contains: (c) => set.has(c), remove: (c) => set.delete(c), add: (c) => set.add(c), _set: set };
}
function veilNode() {
  return { checkVisibility: () => true, style: styleObj() };
}
function iframeNode() {
  return { checkVisibility: () => true, getBoundingClientRect: () => ({ width: 600, height: 400 }) };
}

// A document whose querySelectorAll routes by selector substring. Override
// `veil` / `iframes` to model different on-screen states.
let _state;
function makeDoc() {
  _state = _state || { veil: null, iframes: [] };
  const html = { style: styleObj({ overflow: 'hidden' }), classList: classListObj(['sp-message-open']) };
  const body = { style: styleObj({ overflow: 'hidden' }), classList: classListObj([]), innerText: '' };
  return {
    documentElement: html,
    body,
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll(sel) {
      if (sel.indexOf('iframe') >= 0) return _state.iframes;
      if (sel.indexOf('sp_veil') >= 0) return _state.veil ? [_state.veil] : [];
      return [];
    },
    createElement() { return { style: {}, setAttribute() {}, appendChild() {}, removeChild() {}, textContent: '', parentNode: null }; },
    _html: html, _body: body,
  };
}

// ── pure decision ───────────────────────────────────────────────────────────
test('shouldReapBackdrop: only when a veil is visible AND no consent surface remains', () => {
  const t = I();
  eq(t.shouldReapBackdrop(true, false), true, 'orphaned veil → reap');
  eq(t.shouldReapBackdrop(true, true), false, 'banner still up → leave it');
  eq(t.shouldReapBackdrop(false, false), false, 'no veil → nothing to do');
});

// ── reaper neutralizes an orphaned veil + restores scrolling ────────────────
test('reapOrphanBackdrops: neutralizes an orphaned veil and restores scroll-lock', () => {
  _state = { veil: veilNode(), iframes: [] };
  const { internals, document } = loadConsentGhost({ enabled: true, document: makeDoc() });
  const veil = _state.veil;

  const reaped = internals.reapOrphanBackdrops();
  assert(reaped === true, 'reports it reaped');
  eq(veil.style._props['display'], 'none', 'veil display:none');
  eq(veil.style._props['pointer-events'], 'none', 'veil pointer-events:none');
  assert(document._html.style.overflow !== 'hidden', 'html scroll-lock cleared');
  assert(document._html.classList.contains('sp-message-open') === false, 'sp-message-open class removed');
});

// ── reaper leaves the veil alone while the banner is still visible ──────────
test('reapOrphanBackdrops: does NOT touch the veil while a consent iframe is on screen', () => {
  _state = { veil: veilNode(), iframes: [iframeNode()] };
  const { internals } = loadConsentGhost({ enabled: true, document: makeDoc() });
  const veil = _state.veil;

  const reaped = internals.reapOrphanBackdrops();
  assert(reaped === false, 'stands down while a surface is visible');
  eq(veil.style._props['display'], undefined, 'veil untouched');
});

// ── anyConsentSurfaceVisible reflects a visible CMP iframe ──────────────────
test('anyConsentSurfaceVisible: true when a CMP message iframe is visible', () => {
  _state = { veil: null, iframes: [iframeNode()] };
  const { internals } = loadConsentGhost({ enabled: true, document: makeDoc() });
  eq(internals.anyConsentSurfaceVisible(), true, 'visible CMP iframe counts as a live surface');

  _state = { veil: null, iframes: [] };
  const { internals: in2 } = loadConsentGhost({ enabled: true, document: makeDoc() });
  eq(in2.anyConsentSurfaceVisible(), false, 'no iframe / no dialog → no surface');
});

// ── curated selectors only (never a broad overlay matcher) ──────────────────
test('BACKDROP_SELECTORS are CMP-namespaced, never a blanket [class*=overlay]', () => {
  const t = I();
  assert(Array.isArray(t.BACKDROP_SELECTORS) && t.BACKDROP_SELECTORS.length > 0, 'list present');
  t.BACKDROP_SELECTORS.forEach((s) => {
    assert(!/^\[class\*?=?["']?overlay/i.test(s), 'no blanket overlay selector: ' + s);
  });
  assert(t.BACKDROP_SELECTORS.indexOf('.sp_veil') >= 0, 'covers Sourcepoint .sp_veil');
});
