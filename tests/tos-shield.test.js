/* PawsOff - Tier-1 unit tests for ToS Shield (tos-shield.js).
 *
 * Covers the PURE, side-effect-free engine that decides whether a clause in a
 * Terms-of-Service / privacy policy is predatory:
 *   - matchSentence(): the core anchor+object pattern matcher, including the two
 *     subtle behaviours the code is explicitly built around:
 *       • negation is a confidence REDUCER ("we will never sell your data" drops
 *         below threshold instead of scoring as a data sale)
 *       • the "without notice" aggravator family is STRIPPED before the negation
 *         test so the bare cue "without" can't turn a predatory clause into a
 *         false negative - and it boosts severity to "aggravated"
 *       • per-category toggles are respected
 *   - segmentSentences() with abbreviation handling ("Inc." is not a boundary)
 *   - normalizeForMatch(), buildAltRegex() word-boundary matching
 *   - pageConfidence() scoring of how policy-like a page is
 *   - validateConfig() structural + engine-version gate, compareVersions,
 *     base64ToBytes, defaultSettings/normalizeSettings
 *
 * The matcher reads compiled patterns from closure state, so the harness primes
 * it once via compileConfig(DEFAULT_CONFIG) + defaultSettings() before the tests
 * run - exactly what init() does in the browser. The DOM half (findContentRoot,
 * the Highlight API, the panel) is Tier-2 (jsdom). Loads the REAL shipping file
 * and satisfies its existing Jest-style hook (no source edit).
 */
'use strict';

const { test, assert, eq, approx } = require('./harness/framework');
const { loadTosShield } = require('./harness/sandbox');

const loaded = loadTosShield();
const T = loaded.internals || {};
const {
  compareVersions,
  buildAltRegex,
  validateConfig,
  normalizeSettings,
  defaultSettings,
  segmentSentences,
  normalizeForMatch,
  matchSentence,
  pageConfidence,
  compileConfig,
  base64ToBytes,
  DEFAULT_CONFIG,
  getState,
} = T;

// Prime the runtime exactly like init() does: compile the bundled config and
// install default (all-categories-on) settings so matchSentence can run.
if (typeof compileConfig === 'function') {
  compileConfig(DEFAULT_CONFIG);
  getState().settings = defaultSettings(DEFAULT_CONFIG);
}

function norm(s) { return normalizeForMatch(s); }
function cats(hits) { return hits.map((h) => h.categoryId); }

test('tosShield: the Jest-style hook exposes the pure helpers', () => {
  assert(T && typeof T === 'object', '__test object exposed');
  ['matchSentence', 'segmentSentences', 'validateConfig', 'pageConfidence', 'compileConfig'].forEach((k) => {
    assert(typeof T[k] === 'function', k + ' is a function');
  });
});

// ── compareVersions / base64ToBytes ─────────────────────────────────
test('compareVersions: numeric dotted comparison, junk tolerant', () => {
  eq(compareVersions('1.0.0', '1.0.0'), 0);
  eq(compareVersions('1.2.0', '1.10.0'), -1, '2 < 10 numerically');
  eq(compareVersions('2.0', '1.9.9'), 1);
  eq(compareVersions('v1.0', '1.0.0'), 0, 'non-digits ignored');
});

test('base64ToBytes: decodes to the exact byte sequence', () => {
  const b = base64ToBytes('AAEC/w==');
  eq(b.length, 4);
  eq(b[0], 0); eq(b[1], 1); eq(b[2], 2); eq(b[3], 255);
});

// ── buildAltRegex ────────────────────────────────────────────────
test('buildAltRegex: matches whole words only (no matching inside larger words)', () => {
  const re = buildAltRegex(['sell', 'rent']);
  assert(re.test('we may sell your data'), 'matches a standalone word');
  assert(re.test('homes for rent here'), 'matches an alternative');
  assert(!re.test('a reseller agreement'), '"sell" inside "reseller" is not matched');
  assert(buildAltRegex([]) === null, 'empty token list → null');
  assert(buildAltRegex('notarray') === null, 'non-array → null');
});

// ── validateConfig ──────────────────────────────────────────────
test('validateConfig: accepts the bundled DEFAULT_CONFIG', () => {
  assert(validateConfig(DEFAULT_CONFIG), 'the shipping config validates');
});

test('validateConfig: rejects wrong schema / version type / missing parts', () => {
  assert(!validateConfig(null), 'null');
  assert(!validateConfig({ ...DEFAULT_CONFIG, schemaVersion: 999 }), 'wrong schemaVersion');
  assert(!validateConfig({ ...DEFAULT_CONFIG, configVersion: 7 }), 'non-string configVersion');
  assert(!validateConfig({ ...DEFAULT_CONFIG, categories: undefined }), 'missing categories array');
  assert(!validateConfig({ ...DEFAULT_CONFIG, scoring: undefined }), 'missing a required section');
});

test('validateConfig: rejects a config that needs a newer engine', () => {
  assert(!validateConfig({ ...DEFAULT_CONFIG, minEngineVersion: '9.9.9' }), 'engine too old → invalid');
});

// ── settings ──────────────────────────────────────────────────
test('defaultSettings/normalizeSettings: enabled + every category on, coercion', () => {
  const d = defaultSettings(DEFAULT_CONFIG);
  eq(d.enabled, true);
  eq(d.categories.data_sale, true, 'data_sale on by default');
  eq(Object.keys(d.categories).length, DEFAULT_CONFIG.categories.length, 'one toggle per category');
  eq(normalizeSettings(null, DEFAULT_CONFIG).enabled, true, 'non-object → defaults');
  const out = normalizeSettings({ enabled: false, categories: { data_sale: false } }, DEFAULT_CONFIG);
  eq(out.enabled, false, 'explicit disable respected');
  eq(out.categories.data_sale, false, 'explicit category off respected');
  eq(out.categories.tracking_surveillance, true, 'missing category defaults on');
});

// ── normalizeForMatch / segmentSentences ──────────────────────────────
test('normalizeForMatch: lowercases and collapses whitespace', () => {
  eq(normalizeForMatch('  We  MAY\n\tSell '), 'we may sell');
});

test('segmentSentences: splits on sentence punctuation', () => {
  const segs = segmentSentences('First sentence. Second one! A third?');
  eq(segs.length, 3, 'three sentences');
});

test('segmentSentences: does not split on a known abbreviation (Inc.)', () => {
  const segs = segmentSentences('Acme Inc. ships worldwide today.');
  eq(segs.length, 1, '"Inc." is not treated as a sentence boundary');
});

// ── matchSentence - the core predatory-clause detector ───────────────────
test('matchSentence: flags a plain data-sale clause', () => {
  const hits = matchSentence(norm('We may sell your personal data to third parties.'));
  assert(cats(hits).indexOf('data_sale') !== -1, 'data_sale detected');
});

test('matchSentence: negation drops a clause below threshold (no false flag)', () => {
  const hits = matchSentence(norm('We will never sell your personal data.'));
  assert(cats(hits).indexOf('data_sale') === -1, 'a clear negation is not flagged as a data sale');
});

test('matchSentence: "without notice" aggravates, it does not negate (Bug-4 fix)', () => {
  const hits = matchSentence(norm('We may change these terms at any time without notice.'));
  const hit = hits.find((h) => h.categoryId === 'unilateral_change');
  assert(hit, 'unilateral_change is still flagged despite the word "without"');
  eq(hit.level, 'aggravated', 'the aggravator family raises severity to aggravated');
});

test('matchSentence: empty and irrelevant text produce no hits', () => {
  eq(matchSentence('').length, 0, 'empty');
  eq(matchSentence(norm('The weather is lovely today and the cafe is open.')).length, 0, 'ordinary prose');
});

test('matchSentence: respects a disabled category toggle', () => {
  const st = getState();
  st.settings.categories.data_sale = false;
  try {
    const hits = matchSentence(norm('We may sell your personal data to third parties.'));
    assert(cats(hits).indexOf('data_sale') === -1, 'disabled category is skipped');
  } finally {
    st.settings.categories.data_sale = true; // restore for any later test
  }
});

// ── pageConfidence ────────────────────────────────────────────
test('pageConfidence: a long legalese body scores from its markers', () => {
  const body = ('lorem '.repeat(420)) + 'shall herein you agree reserve the right';
  // url/title carry no policy tokens in the stub, so the score is purely the
  // body-marker contribution: >=3 legalese markers over the word-count floor.
  approx(pageConfidence(body), 0.4, 1e-9, 'three+ legalese markers → +0.4');
});

test('pageConfidence: a too-short page is penalised (negative)', () => {
  assert(pageConfidence('hello there') < 0, 'below the word-count floor scores negative');
});
