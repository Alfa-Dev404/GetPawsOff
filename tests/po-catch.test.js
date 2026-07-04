/* PawsOff - Tier-1 unit tests for the shared catch recorder (po-catch.js).
 *
 * po-catch is loaded first in every feature content script and is what feeds the
 * popup's "Today's catch". Two things matter and both are tested here:
 *   1. PRIVACY (the brand promise): the visited site is recorded ONLY as a
 *      one-way FNV-1a digest - never a plaintext host/URL - and nothing is ever
 *      transmitted. We assert the page hostname never appears in a written
 *      record and that originHash is the canonical digest.
 *   2. The convenience wrappers (recordTracker/Banner/Wall/Clause) produce the
 *      exact shape the popup renders, including the field length caps and the
 *      www.-stripping / humanize() label helpers.
 *
 * The harness loads the REAL shipping file with a callback-style in-memory
 * chrome.storage; record() is synchronous under that stub so getStore() reflects
 * writes immediately. No source edit - po-catch exposes window.PawsOffCatch.
 */
'use strict';

const { test, assert, eq } = require('./harness/framework');
const { loadPoCatch } = require('./harness/sandbox');

const PREFIX = '__pawsOff_catch_';

// Canonical FNV-1a/32 reference (must match the feature scripts + popup).
function fnv(host) {
  if (!host || typeof host !== 'string') return null;
  let h = 0x811c9dc5;
  const s = host.toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return 'h:' + h.toString(16).padStart(8, '0');
}

// Run `fn(api)` on a fresh instance and return the catch records that were written.
function catches(fn, opts) {
  const { api, getStore } = loadPoCatch(opts);
  fn(api);
  const store = getStore();
  const keys = Object.keys(store).filter((k) => k.indexOf(PREFIX) === 0);
  return { keys, recs: keys.map((k) => store[k]), one: keys.length ? store[keys[0]] : null };
}

test('poCatch: exposes the recorder API surface', () => {
  const { api } = loadPoCatch();
  assert(api && typeof api === 'object', 'window.PawsOffCatch defined');
  ['record', 'recordTracker', 'recordBanner', 'recordWall', 'recordClause', 'hashHost'].forEach((k) => {
    assert(typeof api[k] === 'function', k + ' is a function');
  });
  eq(api.PREFIX, PREFIX, 'exposes the catch key prefix');
});

test('poCatch.hashHost: matches the canonical FNV-1a/32 digest', () => {
  const { api } = loadPoCatch();
  eq(api.hashHost('shop.example.com'), fnv('shop.example.com'));
  eq(api.hashHost('SHOP.Example.COM'), fnv('shop.example.com'), 'case-insensitive');
  eq(api.hashHost(''), null, 'empty → null');
  eq(api.hashHost(null), null, 'non-string → null');
});

test('record: ignores an entry with no feature (nothing written)', () => {
  const { keys } = catches((api) => { api.record({}); api.record(null); api.record({ label: 'x' }); });
  eq(keys.length, 0, 'no catch persisted');
});

test('record: writes under the catch prefix with ts, feature, and a HASHED origin', () => {
  const { keys, one } = catches((api) => api.record({ feature: 'banner' }), { hostname: 'news.example.com' });
  eq(keys.length, 1, 'exactly one record');
  assert(keys[0].indexOf(PREFIX) === 0, 'key uses the catch prefix');
  eq(one.feature, 'banner');
  assert(typeof one.ts === 'number' && one.ts > 0, 'has a timestamp');
  eq(one.originHash, fnv('news.example.com'), 'origin stored as the canonical digest');
});

test('record: PRIVACY - the plaintext hostname never appears in the record', () => {
  const { one } = catches((api) => api.record({ feature: 'banner' }), { hostname: 'secret-site.example.org' });
  assert(JSON.stringify(one).indexOf('secret-site.example.org') === -1, 'no plaintext host leaks into storage');
});

test('record: respects an explicit originHash and caps field lengths', () => {
  const { one } = catches((api) => api.record({
    feature: 'tracker',
    originHash: 'h:deadbeef',
    label: 'L'.repeat(200),
    category: 'C'.repeat(200),
    detail: 'D'.repeat(200),
  }));
  eq(one.originHash, 'h:deadbeef', 'explicit originHash kept');
  eq(one.label.length, 80, 'label capped at 80');
  eq(one.category.length, 40, 'category capped at 40');
  eq(one.detail.length, 120, 'detail capped at 120');
});

test('record: mayBreak and wall default to false', () => {
  const { one } = catches((api) => api.record({ feature: 'tracker' }));
  eq(one.mayBreak, false);
  eq(one.wall, false);
});

test('recordTracker: pretty domain, default category, mayBreak flag', () => {
  const a = catches((api) => api.recordTracker('www.doubleclick.net', null, false)).one;
  eq(a.feature, 'tracker');
  eq(a.label, 'doubleclick.net', 'www. stripped for display');
  eq(a.category, 'Tracker', 'default category');
  eq(a.detail, 'www.doubleclick.net', 'raw domain kept in detail');
  eq(a.mayBreak, false);
  const b = catches((api) => api.recordTracker('ads.example.com', 'Advertising', true)).one;
  eq(b.category, 'Advertising');
  eq(b.mayBreak, true);
});

test('recordBanner: consent label, default and framework detail', () => {
  eq(catches((api) => api.recordBanner()).one.label, 'Cookie banner');
  eq(catches((api) => api.recordBanner()).one.category, 'Consent');
  eq(catches((api) => api.recordBanner()).one.detail, 'rejected', 'default detail');
  eq(catches((api) => api.recordBanner('OneTrust')).one.detail, 'via OneTrust', 'framework detail');
});

test('recordWall: flagged as a deliberately-untouched pay-or-consent wall', () => {
  const w = catches((api) => api.recordWall()).one;
  eq(w.feature, 'banner');
  eq(w.label, 'Cookie wall');
  eq(w.category, 'Pay-or-consent');
  eq(w.wall, true, 'marked as a wall so the popup shows we saw it and why');
});

test('recordClause: humanizes the category id into a Title-Case label', () => {
  const c = catches((api) => api.recordClause('data_sale')).one;
  eq(c.feature, 'terms');
  eq(c.category, 'Terms');
  eq(c.label, 'Data Sale', 'underscores → spaces, Title Case');
  eq(catches((api) => api.recordClause('unilateral_change')).one.label, 'Unilateral Change');
  eq(catches((api) => api.recordClause()).one.label, 'Risky clause', 'fallback when no id');
});

// ── prune policy: banners/terms must survive a flood of tracker catches ──────
// The popup's "0 banners on tracker-heavy sites" bug: a page rejects ONE banner
// early, then hundreds of trackers get blocked. The old prune dropped oldest-
// first, eventually evicting the banner. Prune must reclaim TRACKERS first.
test('pruneCatches: evicts oldest trackers first, never the rare banner/terms', () => {
  const { internals } = loadPoCatch();
  const { pruneCatches, CATCH_PREFIX, CATCH_MAX } = internals;
  assert(typeof pruneCatches === 'function', 'pruneCatches exposed via __test');

  const store = {};
  // One early banner + one early terms (oldest timestamps) ...
  store[CATCH_PREFIX + 'banner'] = { ts: 1, feature: 'banner', originHash: 'h:1' };
  store[CATCH_PREFIX + 'terms'] = { ts: 2, feature: 'terms', originHash: 'h:1' };
  // ... then enough NEWER trackers to push storage well over the cap.
  for (let i = 0; i < CATCH_MAX + 50; i++) {
    store[CATCH_PREFIX + 't' + i] = { ts: 100 + i, feature: 'tracker', originHash: 'h:1' };
  }
  const { internals: i2, getStore } = loadPoCatch({ initialStore: store });
  i2.pruneCatches();
  const after = getStore();
  const keys = Object.keys(after).filter((k) => k.indexOf(CATCH_PREFIX) === 0);
  assert(keys.length <= CATCH_MAX, 'pruned down to the cap');
  assert(after[CATCH_PREFIX + 'banner'], 'the banner survived the tracker flood');
  assert(after[CATCH_PREFIX + 'terms'], 'the terms finding survived too');
});
