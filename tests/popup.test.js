/* PawsOff - Tier-1 unit tests for the "Today's catch" popup logic (popup.js).
 *
 * The popup's rendering is DOM (Tier-2/jsdom), but the decisions behind it are
 * pure and user-visible, so they get locked down here:
 *   - hashHost(): the same FNV-1a/32 digest used everywhere (privacy invariant)
 *   - loadCatches() + isFromOtherOrigin(): the per-site filter that guarantees
 *     the popup only ever shows catches for the tab you're looking at, plus the
 *     60-item cap and newest-first ordering
 *   - catColor / actClass / actLabel / radarVerdict*: the label + colour mapping
 *     for each catch type (banner / tracker / terms / wall) and radar verdict
 *   - ago(): relative-time formatting
 *   - num(): the defensive number coercion that keeps the popup from showing NaN
 *
 * The harness injects a `module` to read the page's __test hook; init() is gated
 * on DOMContentLoaded so no DOM/storage work runs under test.
 */
'use strict';

const { test, assert, eq } = require('./harness/framework');
const { loadPopup } = require('./harness/sandbox');

const P = loadPopup().internals || {};
const {
  hashHost,
  num,
  ago,
  catColor,
  actClass,
  actLabel,
  isFromOtherOrigin,
  loadCatches,
  radarVerdictLabel,
  radarVerdictClass,
  getState,
} = P;

function fnv(host) {
  let h = 0x811c9dc5;
  const s = host.toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return 'h:' + h.toString(16).padStart(8, '0');
}

test('popup: the test hook exposes the pure helpers', () => {
  ['hashHost', 'num', 'ago', 'catColor', 'actClass', 'actLabel', 'isFromOtherOrigin', 'loadCatches'].forEach((k) => {
    assert(typeof P[k] === 'function', k + ' is a function');
  });
});

test('hashHost: matches the canonical digest used across the extension', () => {
  eq(hashHost('example.com'), fnv('example.com'));
  eq(hashHost('EXAMPLE.com'), fnv('example.com'), 'case-insensitive');
  eq(hashHost(''), null);
  eq(hashHost(null), null);
});

test('num: numbers pass through, everything else becomes 0 (never NaN)', () => {
  eq(num(5), 5);
  eq(num(0), 0);
  eq(num(undefined), 0);
  eq(num('7'), 0, 'strings are not numbers here');
  eq(num(null), 0);
});

test('ago: formats relative time across s / m / h / d buckets', () => {
  const now = Date.now();
  eq(ago(now - 5 * 1000), '5s ago');
  eq(ago(now - 65 * 1000), '1m ago');
  eq(ago(now - 3 * 3600 * 1000), '3h ago');
  eq(ago(now - 25 * 3600 * 1000), '1d ago');
  eq(ago(0), Math.floor(Date.now() / 1000 / 86400) + 'd ago', 'huge age clamps to days');
});

test('catColor: maps each catch type / tracker category to its dot colour', () => {
  eq(catColor({ wall: true }), 'c-wall', 'wall wins over everything');
  eq(catColor({ feature: 'banner' }), 'c-banner');
  eq(catColor({ feature: 'terms' }), 'c-terms');
  eq(catColor({ feature: 'tracker', category: 'Advertising' }), 'c-ad');
  eq(catColor({ feature: 'tracker', category: 'Social' }), 'c-social');
  eq(catColor({ feature: 'tracker', category: 'Fingerprinting' }), 'c-finger');
  eq(catColor({ feature: 'tracker', category: 'Analytics' }), 'c-analytics', 'default tracker colour');
});

test('actClass / actLabel: the action badge per catch type', () => {
  eq(actClass({ wall: true }), 'wall');
  eq(actClass({ feature: 'banner' }), 'rejected');
  eq(actClass({ feature: 'terms' }), 'flagged');
  eq(actClass({ feature: 'tracker' }), 'blocked');
  eq(actLabel({ wall: true }), 'Wall');
  eq(actLabel({ feature: 'banner' }), 'Rejected');
  eq(actLabel({ feature: 'terms' }), 'Flagged');
  eq(actLabel({ feature: 'tracker' }), 'Blocked');
});

test('radarVerdictLabel / radarVerdictClass: observe-only verdict mapping', () => {
  eq(radarVerdictLabel('block'), 'Tracker');
  eq(radarVerdictLabel('cookieblock'), 'Cookie tracker');
  eq(radarVerdictLabel('observing'), 'Watching', 'default is the soft "watching"');
  eq(radarVerdictClass('block'), 'rv-track');
  eq(radarVerdictClass('cookieblock'), 'rv-cookie');
  eq(radarVerdictClass('anything'), 'rv-watch');
});

test('isFromOtherOrigin: true only when both hashes exist and differ', () => {
  const st = getState();
  st.originHash = 'h:11111111';
  assert(isFromOtherOrigin({ originHash: 'h:99999999' }), 'different origin → other');
  assert(!isFromOtherOrigin({ originHash: 'h:11111111' }), 'same origin → not other');
  assert(isFromOtherOrigin({}), 'entry with no origin → filtered out once the site is known');
  st.originHash = null;
  assert(!isFromOtherOrigin({ originHash: 'h:99999999' }), 'no active origin → loadCatches bails, nothing rendered');
});

test('loadCatches: per-site filter, banners kept, trackers capped', () => {
  const st = getState();
  st.originHash = 'h:11111111';
  const all = {
    '__pawsOff_catch_1': { ts: 100, originHash: 'h:11111111', feature: 'tracker' },
    '__pawsOff_catch_2': { ts: 300, originHash: null, feature: 'banner' },        // no origin → dropped
    '__pawsOff_catch_3': { ts: 200, originHash: 'h:99999999', feature: 'terms' }, // other site → dropped
    '__pawsOff_master_enabled': true,                                            // not a catch
  };
  loadCatches(all);
  eq(st.catches.length, 1, 'only this-site catches (origin-less + other-site dropped)');
  eq(st.catches[0].ts, 100, 'the one matching-origin catch');

  // No active site → render nothing (cross-site history leak guard)
  st.originHash = null;
  loadCatches(all);
  eq(st.catches.length, 0, 'no active-site hash → empty feed');
  st.originHash = 'h:11111111';

  // A flood of trackers must NEVER crowd out a page's lone banner (the bug:
  // newer tracker records pushed the early banner out of the window → "0 banners").
  const many = {};
  for (let i = 0; i < 100; i++) many['__pawsOff_catch_t' + i] = { ts: i + 10, originHash: 'h:11111111', feature: 'tracker' };
  many['__pawsOff_catch_banner'] = { ts: 1, originHash: 'h:11111111', feature: 'banner' }; // OLDEST - a flat top-N cap would drop it
  loadCatches(many);
  const banners = st.catches.filter((e) => e.feature === 'banner');
  const trackers = st.catches.filter((e) => e.feature === 'tracker');
  eq(banners.length, 1, 'the lone (oldest) banner is always kept');
  eq(trackers.length, 80, 'trackers are capped at the budget');
});

// ── readable tracker names + grouping (the "gtagv4.js × 60" fix) ─────────────
test('trackerLabel: maps EasyPrivacy url-filter patterns to company names', () => {
  const { trackerLabel } = P;
  eq(trackerLabel({ feature: 'tracker', detail: 'gtagv4.js', label: 'gtagv4.js' }), 'Google Analytics');
  eq(trackerLabel({ feature: 'tracker', detail: 'clarity.js', label: 'clarity.js' }), 'Microsoft Clarity');
  eq(trackerLabel({ feature: 'tracker', detail: 'pagead/doubleclick', label: '' }), 'Google Ads');
  // pixel-block records a real domain → pretty-print it through, www stripped
  eq(trackerLabel({ feature: 'tracker', detail: 'www.scorecardresearch.com', label: 'scorecardresearch.com' }), 'Comscore');
  eq(trackerLabel({ feature: 'tracker', detail: 'weirdvendor.io', label: 'weirdvendor.io' }), 'weirdvendor.io');
  // junky filter with no domain and no known vendor → honest generic
  eq(trackerLabel({ feature: 'tracker', detail: '&action=js_stats', label: '&action=js_stats' }), 'Tracker');
  eq(trackerLabel({ feature: 'banner', label: 'Cookie banner' }), 'Cookie banner');
});

test('trackerType: coarse type only when known, never invented', () => {
  const { trackerType } = P;
  eq(trackerType({ feature: 'tracker', detail: 'gtagv4.js' }), 'Analytics');
  eq(trackerType({ feature: 'tracker', detail: 'doubleclick.net' }), 'Ads');
  eq(trackerType({ feature: 'tracker', detail: 'clarity.js' }), 'Session');
  eq(trackerType({ feature: 'tracker', detail: '&action=js_stats', category: 'Tracker' }), '', 'unknown → no badge');
});

test('groupCatches: collapses duplicates into one row with a count + latest ts', () => {
  const { groupCatches } = P;
  const groups = groupCatches([
    { feature: 'tracker', detail: 'gtagv4.js', ts: 10 },
    { feature: 'tracker', detail: 'gtagv4.js', ts: 30 },
    { feature: 'tracker', detail: 'gtagv4.js', ts: 20 },
    { feature: 'tracker', detail: 'clarity.js', ts: 25 }
  ]);
  eq(groups.length, 2, 'two distinct vendors → two rows');
  eq(groups[0].name, 'Google Analytics', 'newest group first (latest ts wins)');
  eq(groups[0].count, 3, 'all three GA hits collapse into one row');
  eq(groups[0].ts, 30, 'group ts is the most recent');
  eq(groups[1].name, 'Microsoft Clarity');
  eq(groups[1].count, 1);
});

// ── activity donut (pure chart logic) ────────────────────────────────────────

test('donutSegments: splits catches by feature and folds live DNR count into trackers', () => {
  const { internals: I } = loadPopup();
  const catches = [
    { feature: 'tracker' },                       // DOM tier → counted
    { feature: 'tracker', source: 'dnr' },        // network record → NOT double-counted
    { feature: 'banner' },
    { feature: 'banner', wall: true },            // walls are not "handled banners"
    { feature: 'terms' },
  ];
  const segs = I.donutSegments(catches, 7);       // 7 live network blocks
  eq(segs[0].key, 'tracker'); eq(segs[0].count, 8); // 7 network + 1 DOM
  eq(segs[1].key, 'banner');  eq(segs[1].count, 1);
  eq(segs[2].key, 'terms');   eq(segs[2].count, 1);
  eq(I.donutTotal(segs), 10);
});

test('donutGradient: segments cover the full ring and end exactly at 360deg', () => {
  const { internals: I } = loadPopup();
  const segs = I.donutSegments([{ feature: 'banner' }], 3); // 3 trackers + 1 banner
  const g = I.donutGradient(segs);
  assert(g.indexOf('conic-gradient(') === 0, 'is a conic gradient');
  assert(g.indexOf('var(--dn-tracker) 0.00deg 270.00deg') >= 0, '3/4 of the ring is trackers');
  assert(/360deg\)$/.test(g), 'last stop pinned to 360deg');
  eq(I.donutGradient(I.donutSegments([], 0)), ''); // nothing → no gradient (neutral ring)
});

test('donutAriaLabel: readable summary, honest zero state, skips empty segments', () => {
  const { internals: I } = loadPopup();
  const segs = I.donutSegments([{ feature: 'banner' }], 2);
  const label = I.donutAriaLabel(segs, 'example.com');
  eq(label, 'Activity on example.com: 2 trackers blocked, 1 banners handled');
  eq(I.donutAriaLabel(I.donutSegments([], 0), 'example.com'),
    'No activity recorded on example.com yet');
});

// ── timed pause helpers (popup side) ────────────────────────────────────────

test('pauseUntilFromChoice: minutes map to an absolute expiry; 0 = indefinite', () => {
  const { internals: I } = loadPopup();
  eq(I.pauseUntilFromChoice(15, 1000), 1000 + 15 * 60000);
  eq(I.pauseUntilFromChoice(60, 1000), 1000 + 3600000);
  eq(I.pauseUntilFromChoice(0, 1000), 0);
  eq(I.pauseUntilFromChoice(null, 1000), 0);
});

test('pauseLeftMs/pauseLeftLabel: remaining time flows through to the button copy', () => {
  const { internals: I } = loadPopup();
  const allow = I.applyPaused({ v: 1, sites: {} }, 'h:x', true, Date.now() + 14 * 60000);
  const left = I.pauseLeftMs(allow, 'h:x');
  assert(left > 13 * 60000 && left <= 14 * 60000, 'about 14 minutes left');
  eq(I.pauseLeftLabel(left), '14m left');
  const always = I.applyPaused({ v: 1, sites: {} }, 'h:y', true, 0);
  eq(I.pauseLeftMs(always, 'h:y'), -1); // indefinite
  eq(I.pauseLeftLabel(-1), '');
});

// ── anonymous report (mailto draft) ─────────────────────────────────────────

test('buildReportMailto: correct inbox, encoded fields, and ONLY the expected fields', () => {
  const { internals: I } = loadPopup();
  eq(I.REPORT_EMAIL, 'report@getpawsoff.app');
  const href = I.buildReportMailto({
    host: 'news.example.com',
    version: '1.0.0',
    ua: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/126',
    features: 'banner, tracker, terms',
    blocked: 12,
  });
  assert(href.indexOf('mailto:report@getpawsoff.app?subject=') === 0, 'mailto to the report inbox');
  const body = decodeURIComponent(href.split('&body=')[1]);
  assert(body.indexOf('Site: news.example.com') >= 0, 'site line');
  assert(body.indexOf('Extension: GetPawsOff 1.0.0') >= 0, 'version line');
  assert(body.indexOf('Chrome/126') >= 0, 'browser line');
  assert(body.indexOf('Features on: banner, tracker, terms') >= 0, 'features line');
  assert(body.indexOf('Blocked on this page: 12') >= 0, 'count line');
  // No-PII allowlist: nothing beyond the five declared fields + the free-text prompt.
  const lines = body.split('\n').filter(function (l) { return l.trim() && l.indexOf(':') > 0; });
  eq(lines.length, 6); // 5 data lines + the "What went wrong" prompt line
});

test('buildReportMailto: missing info degrades to placeholders, never throws', () => {
  const { internals: I } = loadPopup();
  const href = I.buildReportMailto({});
  const body = decodeURIComponent(href.split('&body=')[1]);
  assert(body.indexOf('Site: unknown') >= 0, 'unknown site');
  assert(body.indexOf('GetPawsOff ?') >= 0, 'unknown version');
});
