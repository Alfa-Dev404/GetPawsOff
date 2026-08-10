/* PawsOff — Tier-1 unit tests for ToS Shield (tos-shield.js).
 *
 * Covers the PURE, side-effect-free engine that decides whether a clause in a
 * Terms-of-Service / privacy policy is predatory:
 *   - matchSentence(): the core anchor+object pattern matcher, including the two
 *     subtle behaviours the code is explicitly built around:
 *       • negation is a confidence REDUCER ("we will never sell your data" drops
 *         below threshold instead of scoring as a data sale)
 *       • the "without notice" aggravator family is STRIPPED before the negation
 *         test so the bare cue "without" can't turn a predatory clause into a
 *         false negative — and it boosts severity to "aggravated"
 *       • per-category toggles are respected
 *   - segmentSentences() with abbreviation handling ("Inc." is not a boundary)
 *   - normalizeForMatch(), buildAltRegex() word-boundary matching
 *   - pageConfidence() scoring of how policy-like a page is
 *   - validateConfig() structural + engine-version gate, compareVersions,
 *     base64ToBytes, defaultSettings/normalizeSettings
 *
 * The matcher reads compiled patterns from closure state, so the harness primes
 * it once via compileConfig(DEFAULT_CONFIG) + defaultSettings() before the tests
 * run — exactly what init() does in the browser. The DOM half (findContentRoot,
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
  splitClauseSpans,
  buildEvidenceRegex,
  evidenceSpans,
  pageConfidence,
  hasUrlOrTitleSignal,
  compileConfig,
  base64ToBytes,
  normalizeReputationResponse,
  gradePresentation,
  findingEvidenceLabel,
  panelTitle,
  renderPanel,
  policyFingerprint,
  policySnapshotKey,
  hashHost,
  describePolicyChange,
  updatePolicySnapshot,
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

function withPageSignals({ href, title, heading }, run) {
  const location = loaded.sandbox.location;
  const document = loaded.document;
  const previous = { href: location.href, title: document.title, querySelector: document.querySelector };
  location.href = href;
  document.title = title;
  document.querySelector = (selector) => (selector === 'h1, h2' ? { textContent: heading } : null);
  try {
    return run();
  } finally {
    location.href = previous.href;
    document.title = previous.title;
    document.querySelector = previous.querySelector;
  }
}

function fakeElement(tagName) {
  return {
    tagName: String(tagName || '').toUpperCase(),
    children: [],
    attributes: {},
    listeners: {},
    className: '',
    textContent: '',
    parentNode: null,
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
      child.parentNode = null;
      return child;
    },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(type, listener) { this.listeners[type] = listener; },
    click() { if (this.listeners.click) this.listeners.click(); },
    attachShadow() {
      this.closedShadow = fakeElement('shadow-root');
      return this.closedShadow;
    },
  };
}

function findByClass(root, className) {
  if (!root) return null;
  if (root.className === className) return root;
  for (const child of root.children || []) {
    const match = findByClass(child, className);
    if (match) return match;
  }
  return null;
}

function findByAttribute(root, name, value) {
  if (!root) return null;
  if (root.attributes && root.attributes[name] === value) return root;
  for (const child of root.children || []) {
    const match = findByAttribute(child, name, value);
    if (match) return match;
  }
  return null;
}

test('tosShield: the Jest-style hook exposes the pure helpers', () => {
  assert(T && typeof T === 'object', '__test object exposed');
  ['matchSentence', 'segmentSentences', 'validateConfig', 'pageConfidence', 'compileConfig'].forEach((k) => {
    assert(typeof T[k] === 'function', k + ' is a function');
  });
});

// ── compareVersions / base64ToBytes ─────────────────────────────────
test('compareVersions: compares canonical safe dotted versions only', () => {
  eq(compareVersions('1.0.0', '1.0.0'), 0);
  eq(compareVersions('1.2.0', '1.10.0'), -1, '2 < 10 numerically');
  eq(compareVersions('2.0', '1.9.9'), 1);
  eq(compareVersions('v1.0', '1.0.0'), null, 'prefixed versions rejected');
  eq(compareVersions('9007199254740992', '1.0.0'), null, 'unsafe integer components rejected');
});

test('base64ToBytes: decodes to the exact byte sequence', () => {
  const b = base64ToBytes('AAEC/w==');
  eq(b.length, 4);
  eq(b[0], 0); eq(b[1], 1); eq(b[2], 2); eq(b[3], 255);
});

test('signed reputation context is constrained and clearly separated from findings', () => {
  const result = normalizeReputationResponse({
    ok: true,
    reputation: {
      name: 'Example Service',
      grade: 'd',
      flagged: [{ title: 'Broad licence', topic: 'Content', severity: 'high' }],
    },
    source: { attribution: 'Data from ToS;DR', configVersion: '2026-07-14' },
  });
  eq(result.reputation.grade, 'D');
  eq(result.reputation.flagged.length, 1);
  eq(gradePresentation('D').tone, 'poor');
  assert(/community rating/.test(gradePresentation('C').summary), 'grade copy says community rating');
  eq(findingEvidenceLabel({ level: 'aggravated' }), 'Strong phrase match');
  eq(findingEvidenceLabel({ level: 'present' }), 'Direct phrase match');
});

test('malformed or absent reputation responses fail closed to no context', () => {
  eq(normalizeReputationResponse(null), null);
  eq(normalizeReputationResponse({ ok: false }), null);
  eq(normalizeReputationResponse({ ok: true, reputation: { name: 7, grade: 'A' } }), null);
});

test('a successful zero-result scan renders a clear completion panel', () => {
  const root = fakeElement('html');
  const previousDoc = {
    documentElement: loaded.document.documentElement,
    body: loaded.document.body,
    createElement: loaded.document.createElement,
  };
  const state = getState();
  const previousPanel = {
    categoryById: state.categoryById,
    panelHost: state.panelHost,
    policyChange: state.policyChange,
    reputation: state.reputation,
    reputationSource: state.reputationSource,
    shadowRoot: state.shadowRoot,
  };
  loaded.document.documentElement = root;
  loaded.document.body = fakeElement('body');
  loaded.document.createElement = fakeElement;
  try {
    state.reputation = null;
    state.reputationSource = null;
    state.policyChange = null;
    renderPanel([]);

    assert(state.panelHost, 'the panel is attached even without findings');
    eq(root.children.length, 1, 'one panel host attached');
    eq(findByClass(state.panelHost.closedShadow, 'po-ts-title').textContent, 'GetPawsOff: Scan complete');
    eq(findByClass(state.panelHost.closedShadow, 'po-ts-empty').textContent, 'No risky clauses found.');
    eq(panelTitle(1), 'GetPawsOff · 1 clause flagged');
    eq(panelTitle(2), 'GetPawsOff · 2 clauses flagged');
  } finally {
    loaded.document.documentElement = previousDoc.documentElement;
    loaded.document.body = previousDoc.body;
    loaded.document.createElement = previousDoc.createElement;
    Object.assign(state, previousPanel);
  }
});

test('interactive findings render as keyboard-operable native buttons', () => {
  const root = fakeElement('html');
  const previousDoc = {
    documentElement: loaded.document.documentElement,
    body: loaded.document.body,
    createElement: loaded.document.createElement,
  };
  const state = getState();
  const previousPanel = {
    categoryById: state.categoryById,
    panelHost: state.panelHost,
    policyChange: state.policyChange,
    reputation: state.reputation,
    reputationSource: state.reputationSource,
    shadowRoot: state.shadowRoot,
  };
  loaded.document.documentElement = root;
  loaded.document.body = fakeElement('body');
  loaded.document.createElement = fakeElement;
  try {
    state.reputation = null;
    state.reputationSource = null;
    state.policyChange = null;
    state.categoryById = { data_sale: { label: 'Sells data', severity: 'high' } };
    renderPanel([{ categoryId: 'data_sale', level: 'present', text: 'We may sell your data.', phraseCount: 1 }]);
    const item = findByClass(state.panelHost.closedShadow, 'po-ts-item');
    eq(item.tagName, 'BUTTON');
    eq(item.type, 'button');
  } finally {
    loaded.document.documentElement = previousDoc.documentElement;
    loaded.document.body = previousDoc.body;
    loaded.document.createElement = previousDoc.createElement;
    Object.assign(state, previousPanel);
  }
});

test('panel renders optional context, navigates findings, and dismisses cleanly', () => {
  const root = fakeElement('html');
  const previousDoc = {
    documentElement: loaded.document.documentElement,
    body: loaded.document.body,
    createElement: loaded.document.createElement,
  };
  const state = getState();
  const previousPanel = {
    categoryById: state.categoryById,
    panelHost: state.panelHost,
    policyChange: state.policyChange,
    reputation: state.reputation,
    reputationSource: state.reputationSource,
    shadowRoot: state.shadowRoot,
  };
  let scrolled = 0;
  loaded.document.documentElement = root;
  loaded.document.body = fakeElement('body');
  loaded.document.createElement = fakeElement;
  try {
    state.categoryById = { data_sale: { label: 'Sells data', severity: 'high' } };
    state.policyChange = { summary: 'Policy changed.' };
    state.reputation = { name: 'Example', grade: 'D', flagged: [] };
    state.reputationSource = { attribution: 'Data from ToS;DR.' };
    renderPanel([{
      categoryId: 'data_sale',
      level: 'present',
      text: 'We may sell your data.',
      phraseCount: 1,
      range: { startContainer: { nodeType: 3, parentElement: { scrollIntoView() { scrolled += 1; } } } },
    }]);

    assert(findByClass(state.panelHost.closedShadow, 'po-ts-change'), 'policy-change context rendered');
    assert(findByClass(state.panelHost.closedShadow, 'po-ts-context'), 'reputation context rendered');
    findByClass(state.panelHost.closedShadow, 'po-ts-item').click();
    eq(scrolled, 1, 'finding activation navigates to its clause');
    findByAttribute(state.panelHost.closedShadow, 'aria-label', 'Dismiss').click();
    eq(state.panelHost, null, 'dismissal removes the panel');
  } finally {
    loaded.document.documentElement = previousDoc.documentElement;
    loaded.document.body = previousDoc.body;
    loaded.document.createElement = previousDoc.createElement;
    Object.assign(state, previousPanel);
  }
});

test('policy change detection stores no text and explains aggregate risk deltas', async () => {
  const first = await policyFingerprint('We may sell your data.');
  eq(first, await policyFingerprint('  WE may   sell your data. '), 'case and whitespace do not create false changes');
  assert(first !== await policyFingerprint('We never sell your data.'), 'material text change alters fingerprint');
  assert(/^sha256:[a-f0-9]{64}$/.test(first), 'policy fingerprint is collision-resistant SHA-256');
  const changed = describePolicyChange(
    { v: 2, fingerprint: `sha256:${'a'.repeat(64)}`, total: 2, ts: 10 },
    { v: 2, fingerprint: `sha256:${'b'.repeat(64)}`, total: 4, ts: 20 },
  );
  eq(changed.delta, 2);
  assert(/2 more local risk matches/.test(changed.summary), 'aggregate increase explained');
  eq(describePolicyChange({ v: 2, fingerprint: first }, { v: 2, fingerprint: first }), null, 'same policy stays quiet');
  eq(describePolicyChange(
    { v: 1, fingerprint: 'h:legacy' },
    { v: 2, fingerprint: first },
  ), null, 'legacy weak fingerprints are invalidated without a false change alert');
});

test('policy snapshots use separate hash-only keys for separate policy paths', () => {
  const privacy = policySnapshotKey('example.com', '/legal/privacy/');
  const terms = policySnapshotKey('example.com', '/legal/terms/');
  assert(privacy !== terms, 'different policy documents never share a snapshot');
  assert(!privacy.includes('example.com') && !privacy.includes('/legal/privacy'), 'host and path remain hashed at rest');
  const siteKey = privacy.match(/([0-9a-f]{8})_[0-9a-f]{8}$/);
  eq(`h:${siteKey[1]}`, hashHost('example.com'), 'site-key portion uses the canonical host hash');
  eq(policySnapshotKey('example.com', '/legal/privacy'), privacy, 'trailing slash is normalized');
});

test('policy snapshot update drops stale async work after a page reset', async () => {
  const state = getState();
  const storage = loaded.sandbox.chrome.storage.local;
  const previousGet = storage.get;
  const previousSet = storage.set;
  const previousPath = loaded.sandbox.location.pathname;
  let releaseGet;
  let markGetStarted;
  const getStarted = new Promise((resolve) => { markGetStarted = resolve; });
  const writes = [];
  storage.get = () => new Promise((resolve) => {
    releaseGet = resolve;
    markGetStarted();
  });
  storage.set = (value) => { writes.push(value); return Promise.resolve(); };
  try {
    state.scanGeneration = 10;
    state.findings = [{ categoryId: 'data_sale' }];
    state.policyChange = null;
    loaded.sandbox.location.pathname = '/privacy';
    const pending = updatePolicySnapshot('We may sell data.', { data_sale: 1 });
    await getStarted;
    state.scanGeneration = 11;
    releaseGet({});
    await pending;
    eq(writes.length, 0, 'stale page never writes a snapshot');
    eq(state.policyChange, null, 'stale page never mutates current UI state');
  } finally {
    storage.get = previousGet;
    storage.set = previousSet;
    loaded.sandbox.location.pathname = previousPath;
    state.findings = [];
    state.policyChange = null;
  }
});

test('policy snapshot completion does not reopen a panel the user dismissed', async () => {
  const state = getState();
  const storage = loaded.sandbox.chrome.storage.local;
  const previousGet = storage.get;
  const previousSet = storage.set;
  let finishWrite;
  let markWriteStarted;
  const writeStarted = new Promise((resolve) => { markWriteStarted = resolve; });
  storage.get = (key) => Promise.resolve({
    [key]: { v: 2, fingerprint: `sha256:${'a'.repeat(64)}`, total: 0, ts: 1 },
  });
  storage.set = () => new Promise((resolve) => {
    finishWrite = resolve;
    markWriteStarted();
  });
  try {
    state.scanGeneration = 20;
    state.findings = [{ categoryId: 'data_sale' }];
    state.panelHost = { parentNode: { removeChild() {} } };
    const pending = updatePolicySnapshot('We may sell data.', { data_sale: 1 });
    await writeStarted;
    loaded.internals.removePanel();
    finishWrite();
    await pending;
    eq(state.panelHost, null, 'dismissed panel stays closed');
  } finally {
    storage.get = previousGet;
    storage.set = previousSet;
    state.findings = [];
    state.policyChange = null;
    state.panelHost = null;
  }
});

test('policy snapshot update replaces legacy weak fingerprints without reporting a change', async () => {
  const state = getState();
  const storage = loaded.sandbox.chrome.storage.local;
  const previousGet = storage.get;
  const previousSet = storage.set;
  let written;
  storage.get = (key) => Promise.resolve({ [key]: { v: 1, fingerprint: 'h:legacy', total: 9, ts: 1 } });
  storage.set = (value) => { written = value; return Promise.resolve(); };
  try {
    state.scanGeneration = 30;
    state.findings = [{ categoryId: 'data_sale' }];
    state.policyChange = null;
    state.panelHost = null;
    await updatePolicySnapshot('We may sell data.', { data_sale: 1 });
    const snapshot = Object.values(written)[0];
    eq(snapshot.v, 2, 'snapshot schema is upgraded');
    assert(/^sha256:[a-f0-9]{64}$/.test(snapshot.fingerprint), 'weak fingerprint is replaced');
    eq(state.policyChange, null, 'migration never reports a synthetic policy change');
  } finally {
    storage.get = previousGet;
    storage.set = previousSet;
    state.findings = [];
    state.policyChange = null;
  }
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
  assert(!validateConfig({ ...DEFAULT_CONFIG, configVersion: 'future' }), 'non-canonical configVersion');
  assert(!validateConfig({ ...DEFAULT_CONFIG, minEngineVersion: 'future' }), 'non-canonical engine version');
  assert(!validateConfig({ ...DEFAULT_CONFIG, categories: undefined }), 'missing categories array');
  assert(!validateConfig({ ...DEFAULT_CONFIG, scoring: undefined }), 'missing a required section');
});

test('validateConfig: rejects a config that needs a newer engine', () => {
  assert(!validateConfig({ ...DEFAULT_CONFIG, minEngineVersion: '9.9.9' }), 'engine too old → invalid');
});

test('validateConfig: deeply validates exact sections, bounded collections, and references', () => {
  const cases = [
    { ...DEFAULT_CONFIG, action: 'execute' },
    { ...DEFAULT_CONFIG, pageDetection: { ...DEFAULT_CONFIG.pageDetection, action: 'fetch' } },
    { ...DEFAULT_CONFIG, pageDetection: { ...DEFAULT_CONFIG.pageDetection, confidenceThreshold: 2 } },
    { ...DEFAULT_CONFIG, negation: { ...DEFAULT_CONFIG.negation, scope: 'document' } },
    { ...DEFAULT_CONFIG, categories: [{ ...DEFAULT_CONFIG.categories[0], severity: 'critical' }] },
    { ...DEFAULT_CONFIG, categories: DEFAULT_CONFIG.categories.concat(DEFAULT_CONFIG.categories[0]) },
    {
      ...DEFAULT_CONFIG,
      patterns: [{ ...DEFAULT_CONFIG.patterns[0], categoryId: 'missing_category' }],
    },
    {
      ...DEFAULT_CONFIG,
      patterns: [{ ...DEFAULT_CONFIG.patterns[0], anchors: new Array(129).fill('sell') }],
    },
  ];
  for (const candidate of cases) assert(!validateConfig(candidate), 'malformed nested config is rejected');
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

test('exact evidence highlighting keeps clause context but returns phrase-only offsets', () => {
  const sentence = 'We may sell your personal data to third parties.';
  const spans = evidenceSpans(sentence, buildEvidenceRegex(['sell', 'personal data', 'third parties']));
  const phrases = spans.map((span) => sentence.slice(span.start, span.end));
  eq(phrases.join('|'), 'sell|personal data|third parties');
  assert(spans.every((span) => span.end - span.start < sentence.length), 'no highlight covers the entire clause');
});

test('clause splitting preserves offsets in the original sentence', () => {
  const sentence = 'We collect data, unless we do not sell it.';
  const clauses = splitClauseSpans(sentence, /,|\bunless\b/i);
  eq(clauses.length, 3);
  eq(sentence.slice(clauses[0].start, clauses[0].end), 'We collect data');
  eq(sentence.slice(clauses[2].start, clauses[2].end), ' we do not sell it.');
});

// ── matchSentence — the core predatory-clause detector ───────────────────
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

test('pageConfidence: compact privacy-choice pages qualify with substantive rights content', () => {
  const body = ('plain language '.repeat(165))
    + 'Privacy policies explain your personal information rights. You may opt-out, '
    + 'change cookie preferences, or submit a request.';
  const score = withPageSignals({
    href: 'https://example.com/legal/privacy/privacy-choices/',
    title: 'Privacy Choices | Example',
    heading: 'Privacy Choices',
  }, () => pageConfidence(body));
  approx(score, 0.8, 1e-9, 'smart title + privacy URL + compact rights body');
});

test('pageConfidence: smart privacy pages still need enough rights content', () => {
  const page = {
    href: 'https://example.com/privacy-choices/',
    title: 'Privacy Choices',
    heading: 'Privacy Choices',
  };
  const shortScore = withPageSignals(page, () => pageConfidence(
    'Personal information opt out cookie preferences. '.repeat(12),
  ));
  const markerlessScore = withPageSignals(page, () => pageConfidence(
    'A general article about making thoughtful choices online. '.repeat(35),
  ));
  assert(shortScore < DEFAULT_CONFIG.pageDetection.confidenceThreshold, 'short lookalike remains below threshold');
  assert(markerlessScore < DEFAULT_CONFIG.pageDetection.confidenceThreshold, 'markerless article remains below threshold');
});

test('pageConfidence: a generic data-protection product page remains excluded', () => {
  const body = 'Backup software keeps business systems available. '.repeat(90);
  let hasSignal = false;
  const score = withPageSignals({
    href: 'https://example.com/products/data-protection/',
    title: 'Data Protection Software',
    heading: 'Data Protection Software',
  }, () => {
    hasSignal = hasUrlOrTitleSignal();
    return pageConfidence(body);
  });
  eq(hasSignal, true, 'the smart slug reaches the cheap pre-gate');
  assert(score < DEFAULT_CONFIG.pageDetection.confidenceThreshold, 'generic product page remains below threshold');
});
