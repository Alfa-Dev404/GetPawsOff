/* PawsOff - "detected but couldn't reject" banner accounting.
 *
 * Bug: the popup "Banners" stat showed 0 even when a banner was plainly on
 * screen, because only a CONFIRMED reject was recorded. The classic case is a
 * cross-origin CMP (Sourcepoint) whose reject button lives in the vendor's OWN
 * iframe, so the page frame detects the wrapper but can't click it.
 *
 * Fix: po-catch.recordBannerSeen() records a banner with seen:true; the popup
 * counts it (so the field isn't 0) but labels it "Detected" - NEVER "Rejected",
 * so we never claim a block we didn't make.
 */
'use strict';

const { test, assert, eq } = require('./harness/framework');
const { loadPoCatch, loadPopup } = require('./harness/sandbox');

const PREFIX = '__pawsOff_catch_';

function catches(fn) {
  const { api, getStore } = loadPoCatch();
  fn(api);
  const store = getStore();
  const keys = Object.keys(store).filter((k) => k.indexOf(PREFIX) === 0);
  return keys.length ? store[keys[0]] : null;
}

// ── recorder ────────────────────────────────────────────────────────────────
test('poCatch: recordBannerSeen is part of the API surface', () => {
  const { api } = loadPoCatch();
  assert(typeof api.recordBannerSeen === 'function', 'recordBannerSeen exported');
});

test('poCatch.recordBannerSeen: writes a banner flagged seen (not a reject)', () => {
  const rec = catches((api) => api.recordBannerSeen('Sourcepoint'));
  assert(rec, 'a record was written');
  eq(rec.feature, 'banner', 'feature is banner');
  eq(rec.seen, true, 'flagged seen:true');
  eq(rec.wall, false, 'not a wall');
  eq(rec.label, 'Cookie banner', 'label stays generic');
  assert(/Sourcepoint/.test(rec.detail), 'detail names the framework');
});

test('poCatch.recordBanner: a real reject is NOT flagged seen', () => {
  const rec = catches((api) => api.recordBanner('OneTrust'));
  eq(rec.feature, 'banner');
  eq(rec.seen, false, 'a confirmed reject must never carry seen:true');
});

// ── popup labelling: honest, never overclaims ───────────────────────────────
const P = loadPopup().internals || {};

test('popup: a seen banner is badged "Detected", a real one "Rejected"', () => {
  eq(P.actLabel({ feature: 'banner', seen: true }), 'Detected', 'seen → Detected');
  eq(P.actClass({ feature: 'banner', seen: true }), 'detected', 'seen → detected class');
  eq(P.actLabel({ feature: 'banner' }), 'Rejected', 'reject → Rejected');
  eq(P.actClass({ feature: 'banner' }), 'rejected', 'reject → rejected class');
  eq(P.actLabel({ feature: 'banner', wall: true }), 'Wall', 'wall unchanged');
});

test('popup: a detected banner still counts toward the Banners stat (not 0)', () => {
  const state = P.getState();
  try {
    state._tabDnrBlocked = 0;
    state._learnedAvgKB = 0;
    state.catches = [{ feature: 'banner', seen: true, network: false }];
    const h = P.computeHeadline();
    eq(h.banners, 1, 'a detected banner is counted so the field is never a bare 0');
  } finally {
    state.catches = [];
    state._tabDnrBlocked = 0;
    state._learnedAvgKB = 0;
  }
});

test('popup: detected and rejected banners group separately', () => {
  const groups = P.groupCatches([
    { feature: 'banner', seen: true, ts: 2 },
    { feature: 'banner', ts: 1 },
  ]);
  eq(groups.length, 2, 'seen vs rejected are distinct rows, not merged');
});
