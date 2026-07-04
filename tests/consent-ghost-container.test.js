/* PawsOff - H5 regression: findConsentContainer must not skip a high-z banner
 * that sits past node #MAX_CONTAINER_SCAN (1200) in DOM order.
 *
 * Old bug: the sweep capped the RAW node list in DOM order before filtering to
 * overlays, so a fixed/high-z banner beyond index 1200 was never examined. Fix:
 * filter to overlay-ish candidates FIRST (no cap), then sort-by-z and cap - so
 * the cap can only drop low-priority nodes, never the banner.
 */
'use strict';

const { test, assert, eq } = require('./harness/framework');
const { loadConsentGhost } = require('./harness/sandbox');

const I = () => loadConsentGhost().internals;

test('pickConsentContainer: high-z overlay survives the cap (sort-then-cap)', () => {
  const t = I();
  // 1200 low-z overlays FIRST, the real high-z banner LAST. A DOM-order cap would
  // drop it; sort-then-cap must keep it.
  const cands = [];
  for (let i = 0; i < 1200; i++) cands.push({ el: 'low' + i, z: 1, area: 99999, hasText: true });
  cands.push({ el: 'BANNER', z: 9999, area: 99999, hasText: true });
  eq(t.pickConsentContainer(cands, 1200), 'BANNER', 'high-z banner not dropped by the cap');
});

test('pickConsentContainer: size + text gates still apply', () => {
  const t = I();
  eq(t.pickConsentContainer([{ el: 'tiny', z: 5000, area: 10, hasText: true }], 1200), null, 'too-small rejected');
  eq(t.pickConsentContainer([{ el: 'notext', z: 5000, area: 99999, hasText: false }], 1200), null, 'no consent text rejected');
});

test('findConsentContainer: a high-z fixed banner at DOM index >1200 is still found', () => {
  // 1200 generic non-overlay <div>s (the bounded sweep) + the real banner, which
  // carries a dialog role/cookie marker so it lands in the UNCAPPED "strong" set.
  const divs = [];
  for (let i = 0; i < 1200; i++) {
    divs.push({ __style: { position: 'static', zIndex: 'auto' }, checkVisibility: () => true });
  }
  const banner = {
    __style: { position: 'fixed', zIndex: '9999' },
    checkVisibility: () => true,
    getBoundingClientRect: () => ({ width: 400, height: 80 }), // area 32000 ≥ MIN
    innerText: 'We use cookies. Reject all / Accept all',
    textContent: 'We use cookies. Reject all / Accept all',
  };

  const fakeDoc = {
    body: { textContent: 'This site uses cookies for consent.' }, // doc pre-gate hint
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    // Route by selector group: the strong (marker) set returns the banner; the
    // generic div/section sweep returns the 1200 plain divs; '*' → [] (no shadow walk).
    querySelectorAll(sel) {
      if (sel.indexOf('role="dialog"') >= 0) return [banner];
      if (sel.indexOf('div') === 0) return divs.slice();
      return [];
    },
    createElement() { return { style: {}, setAttribute() {}, appendChild() {}, removeChild() {}, textContent: '', parentNode: null }; },
  };

  const { internals } = loadConsentGhost({ document: fakeDoc });
  const found = internals.findConsentContainer();
  assert(found === banner, 'marker-bearing banner found via the uncapped strong set, despite 1200 generic divs');
});
