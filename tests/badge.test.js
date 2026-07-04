/* PawsOff - per-tab "trackers blocked" toolbar badge (pure logic).
 *
 * The badge shows a DISTINCT-blocked count for the current page (dedup key = the
 * DNR rule id today; a per-domain key is a build-time follow-up). Same blocked
 * entry counted once, 0 hidden, huge counts capped. The chrome.action /
 * tab-lifecycle wiring is an E2E concern; here we pin the pure count + text logic.
 */
'use strict';
const { test, assert, eq } = require('./harness/framework');
const { loadBackground } = require('./harness/sandbox');

function bg() { const { internals } = loadBackground(); return internals; }

test('badgeText: 0 is the visible baseline, normal counts render, huge counts cap at 99+', () => {
  const I = bg();
  eq(I.badgeText(0), '0');     // baseline "0" - sits there and ticks up on detection
  eq(I.badgeText(-3), '0');    // never negative, floors to "0"
  eq(I.badgeText(1), '1');
  eq(I.badgeText(4), '4');      // the "it's working" number
  eq(I.badgeText(99), '99');
  eq(I.badgeText(100), '99+');
  eq(I.badgeText(5000), '99+');
});

test('addTrackers: counts DISTINCT labels per tab (a company counted once)', () => {
  const I = bg();
  const map = new Map();
  // doubleclick blocked 3× on tab 1 + scorecard 1× → 2 distinct trackers.
  eq(I.addTrackers(map, 1, ['DoubleClick', 'DoubleClick', 'Scorecard Research']), 2);
  // more of the same company on the same tab does not bump the count.
  eq(I.addTrackers(map, 1, ['DoubleClick']), 2);
  // a new company does.
  eq(I.addTrackers(map, 1, ['Criteo']), 3);
  // falsy labels are ignored.
  eq(I.addTrackers(map, 1, ['', null, undefined]), 3);
});

test('addTrackers: tabs are independent', () => {
  const I = bg();
  const map = new Map();
  eq(I.addTrackers(map, 1, ['A', 'B']), 2);
  eq(I.addTrackers(map, 2, ['A']), 1); // tab 2 has its own set
  eq(map.get(1).size, 2);
  eq(map.get(2).size, 1);
});

test('dedupKeyForRule: rules of one tracker company collapse to a single count', () => {
  const I = bg();
  // byId[ruleId] = index into d; -1 = unmapped (path/query rule with no domain).
  // rules 10,11,12 → doubleclick.net (idx 0); rule 20 → criteo.com (idx 1);
  // rule 30 unmapped; rule 99 out of range. Keys are OPAQUE indices ('d'+idx) -
  // never the domain string, which for first-party EasyPrivacy rules could be
  // the visited page's own host (hash-only privacy rule).
  const idMap = { d: ['doubleclick.net', 'criteo.com'], byId: [] };
  idMap.byId[10] = 0; idMap.byId[11] = 0; idMap.byId[12] = 0;
  idMap.byId[20] = 1; idMap.byId[30] = -1;
  // three DoubleClick rules share one key → counted once.
  eq(I.dedupKeyForRule(idMap, 10), 'd0');
  eq(I.dedupKeyForRule(idMap, 11), 'd0');
  eq(I.dedupKeyForRule(idMap, 12), 'd0');
  eq(I.dedupKeyForRule(idMap, 20), 'd1');   // a different company
  eq(I.dedupKeyForRule(idMap, 30), 'r30');  // unmapped → per-rule
  eq(I.dedupKeyForRule(idMap, 99), 'r99');  // out of range → per-rule

  // end-to-end: DoubleClick trips 3 rules + Criteo 1 → badge reads "2", not "4".
  const map = new Map();
  const keys = [10, 11, 12, 20].map(function (id) { return I.dedupKeyForRule(idMap, id); });
  I.addTrackers(map, 5, keys);
  eq(I.badgeText(map.get(5).size), '2');
});

test('blockedKeyForUrl: counts only OUR tracker domains, as OPAQUE index keys', () => {
  const I = bg();
  const idx = new Map([['doubleclick.net', 0], ['criteo.com', 1]]);
  const getBase = (h) => h.split('.').slice(-2).join('.'); // toy eTLD+1 for the test
  // a blocked tracker subdomain collapses to its base domain's index - the
  // domain string itself is discarded (hash-only privacy rule).
  eq(I.blockedKeyForUrl('https://stats.g.doubleclick.net/j/collect?x=1', idx, getBase), 'd0');
  eq(I.blockedKeyForUrl('https://criteo.com/px.gif', idx, getBase), 'd1');
  // a blocked NON-tracker (e.g. another extension blocked it) is not counted.
  eq(I.blockedKeyForUrl('https://cdn.example.com/app.js', idx, getBase), '');
  // garbage in → '' out, never a throw.
  eq(I.blockedKeyForUrl('not a url', idx, getBase), '');
  eq(I.blockedKeyForUrl('https://doubleclick.net/x', null, getBase), '');
  eq(I.blockedKeyForUrl('https://doubleclick.net/x', idx, null), '');
});

test('badge tiers cannot double-count: webRequest + reconcile emit the same key', () => {
  const I = bg();
  const idMap = { d: ['doubleclick.net'], byId: [] };
  idMap.byId[10] = 0;
  const idx = new Map([['doubleclick.net', 0]]);
  const getBase = (h) => h.split('.').slice(-2).join('.');
  const map = new Map();
  // webRequest tier sees the blocked request first…
  I.addTrackers(map, 3, [I.blockedKeyForUrl('https://ad.doubleclick.net/i.js', idx, getBase)]);
  // …then the reconcile poll reports the same block via its rule id.
  I.addTrackers(map, 3, [I.dedupKeyForRule(idMap, 10)]);
  eq(map.get(3).size, 1); // one tracker, one count - regardless of which tier saw it
});

test('dedupKeyForRule: fails open to per-rule when the map is missing/empty', () => {
  const I = bg();
  eq(I.dedupKeyForRule(null, 7), 'r7');
  eq(I.dedupKeyForRule({}, 7), 'r7');
  eq(I.dedupKeyForRule({ d: [], byId: [] }, 7), 'r7');
});

test('bumpBlockedReqs: counts every blocked REQUEST per tab (popup stats feed)', () => {
  const I = bg();
  const m = new Map();
  // 3 blocked requests on tab 1 - even from the SAME tracker - count as 3
  // (the popup's Blocked/Data-saved use requests; the badge uses distinct).
  eq(I.bumpBlockedReqs(m, 1), 1);
  eq(I.bumpBlockedReqs(m, 1), 2);
  eq(I.bumpBlockedReqs(m, 1), 3);
  eq(I.bumpBlockedReqs(m, 2), 1); // tabs independent
  eq(m.get(1), 3);
  eq(m.get(2), 1);
});

test('badge: distinct count drives the rendered text end-to-end (pure)', () => {
  const I = bg();
  const map = new Map();
  I.addTrackers(map, 7, ['Ad Co', 'Ad Co', 'Analytics Co', 'Beacon Co']);
  eq(I.badgeText(map.get(7).size), '3');
});

test('tabEpoch/bumpTabEpoch: per-tab navigation generation, fences stale async work', () => {
  const I = bg();
  eq(I.tabEpoch(1), 0); // unseen tab starts at generation 0
  eq(I.bumpTabEpoch(1), 1); // navigation start bumps it
  eq(I.tabEpoch(1), 1);
  eq(I.bumpTabEpoch(1), 2);
  eq(I.tabEpoch(2), 0); // tabs are independent
  // The pattern callers use: capture epoch before an await, compare after.
  const before = I.tabEpoch(1);
  I.bumpTabEpoch(1); // simulates a navigation happening mid-await
  eq(I.tabEpoch(1) === before, false); // stale - caller should discard its result
});
