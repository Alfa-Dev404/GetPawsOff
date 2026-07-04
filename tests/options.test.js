/* PawsOff - Tier-1 unit tests for the settings page logic (options.js).
 *
 * options.js is mostly DOM (toggles built with createElement + textContent, no
 * innerHTML, for CSP/XSS safety), which is Tier-2 (jsdom). What IS pure and
 * worth locking down is the activity-log plumbing that turns raw storage keys
 * into human-readable rows:
 *   - activityKindOf(): which feature wrote a given storage key (or null)
 *   - collectActivityRows(): gather only activity records, newest first
 *   - activityDetail(): the per-feature one-line summary
 * Plus the PB_PROVIDERS / TS_CATEGORIES taxonomies, which MUST stay in lockstep
 * with pixel-block.js and tos-shield.js or the settings page silently drifts.
 *
 * The harness injects a `module` to read the page's __test hook; init() is gated
 * on DOMContentLoaded so no DOM/storage work runs under test.
 */
'use strict';

const { test, assert, eq } = require('./harness/framework');
const { loadOptions } = require('./harness/sandbox');

const O = loadOptions().internals || {};
const {
  activityKindOf,
  collectActivityRows,
  activityDetail,
  PB_PROVIDERS,
  TS_CATEGORIES,
  PB_SETTINGS,
  TS_SETTINGS,
  CG_DISABLED,
} = O;

test('options: the test hook exposes the pure helpers + taxonomies', () => {
  ['activityKindOf', 'collectActivityRows', 'activityDetail'].forEach((k) => {
    assert(typeof O[k] === 'function', k + ' is a function');
  });
  assert(Array.isArray(PB_PROVIDERS) && Array.isArray(TS_CATEGORIES), 'taxonomies exported');
});

test('activityKindOf: maps each feature key prefix (else null)', () => {
  eq(activityKindOf('__pawsOff_consentGhost_log_123'), 'ConsentGhost');
  eq(activityKindOf('__pawsOff_pixelBlock_event_123'), 'PixelBlock');
  eq(activityKindOf('__pawsOff_tosShield_event_123'), 'ToS Shield');
  eq(activityKindOf('__pawsOff_catch_123'), null, 'catch entries are not activity rows');
  eq(activityKindOf('something_else'), null);
});

test('collectActivityRows: keeps only activity records, newest first', () => {
  const all = {
    '__pawsOff_consentGhost_log_a': { ts: 100 },
    '__pawsOff_pixelBlock_event_b': { ts: 300 },
    '__pawsOff_tosShield_event_c': { ts: 200 },
    '__pawsOff_catch_d': { ts: 999 },      // not an activity record
    '__pawsOff_master_enabled': true,      // unrelated
  };
  const rows = collectActivityRows(all);
  eq(rows.length, 3, 'three activity rows, catch + flag excluded');
  eq(rows[0].ts, 300, 'sorted newest first');
  eq(rows[1].ts, 200);
  eq(rows[2].ts, 100);
  eq(rows[0].kind, 'PixelBlock', 'kind carried through');
});

test('activityDetail: ConsentGhost - status with optional framework', () => {
  eq(activityDetail({ kind: 'ConsentGhost', e: { status: 'rejected', framework: 'OneTrust' } }), 'rejected · OneTrust');
  eq(activityDetail({ kind: 'ConsentGhost', e: { status: 'rejected' } }), 'rejected', 'framework optional');
});

test('activityDetail: PixelBlock - blocked count with optional provider', () => {
  eq(activityDetail({ kind: 'PixelBlock', e: { blocked_count: 3, provider: 'gmail' } }), '3 blocked · gmail');
  eq(activityDetail({ kind: 'PixelBlock', e: {} }), '0 blocked', 'defaults to 0');
});

test('activityDetail: ToS Shield - clause count with optional domain', () => {
  eq(activityDetail({ kind: 'ToS Shield', e: { total: 5, domain: 'x.com' } }), '5 clauses · x.com');
  eq(activityDetail({ kind: 'ToS Shield', e: {} }), '0 clauses');
});

test('PB_PROVIDERS: stays in lockstep with pixel-block (9 providers, iCloud noted)', () => {
  eq(PB_PROVIDERS.length, 9, 'nine webmail providers');
  assert(PB_PROVIDERS.some((p) => p.id === 'gmail'), 'gmail present');
  const icloud = PB_PROVIDERS.find((p) => p.id === 'icloud');
  assert(icloud && typeof icloud.note === 'string' && /iframe/i.test(icloud.note), 'iCloud carries its iframe caveat');
  PB_PROVIDERS.forEach((p) => assert(p.id && p.name, 'every provider has id + name'));
});

test('TS_CATEGORIES: stays in lockstep with tos-shield (12 categories, labelled)', () => {
  eq(TS_CATEGORIES.length, 12, 'twelve clause categories');
  assert(TS_CATEGORIES.some((c) => c.id === 'data_sale'), 'data_sale present');
  TS_CATEGORIES.forEach((c) => assert(c.id && c.label, 'every category has id + label'));
});

test('storage key constants are the shapes the content scripts read', () => {
  eq(PB_SETTINGS, '__pawsOff_pixelBlock_settings');
  eq(TS_SETTINGS, '__pawsOff_tosShield_settings');
  eq(CG_DISABLED, '__pawsOff_consentGhost_disabled');
});
