'use strict';
// Tests for the community-list converters (autoconsent / ToS;DR / whotracks.me).
// Every converter is a PURE function, so these run fully offline. The key
// assertions prove the OUTPUT is drop-in valid for the consumers that already
// exist in the extension (we replicate those consumers' own validators here).

const { test, assert, eq } = require('./harness/framework');
const fs = require('fs');
const path = require('path');

const ac = require('../tools/autoconsent-to-consent-rules');
const td = require('../tools/tosdr-to-grades');
const wtm = require('../tools/whotracksme-to-firstparty');

const CATALOG_METADATA = Object.freeze({
  configVersion: '2026-07-14',
  source: 'fixture-catalog',
  sourceLicense: 'CC0-1.0',
  attribution: 'Test fixture catalog',
});
const TOSDR_OPTIONS = Object.freeze({ configVersion: '20260714000000' });
const AUTOCONSENT_OPTIONS = Object.freeze({
  configVersion: '20260714000000',
  v2ConfigVersion: '20260714000000.2',
});

// ── Replicated ConsentGhost validators (must stay in sync with consent-ghost.js)
function cgUsable(cfg) {
  return !!cfg && cfg.schemaVersion === 1 && Array.isArray(cfg.frameworks);
}
function cgValidEntry(f) {
  return !!f && f.enabled !== false &&
    typeof f.name === 'string' && typeof f.containerSelector === 'string' &&
    Array.isArray(f.rejectSelectors);
}
function cgSelectorList(value, required) {
  return Array.isArray(value) &&
    (!required || value.length > 0) &&
    value.every((selector) => ac.isSafeSelector(selector));
}
function cgV2HasRequiredRoles(selectors) {
  return cgSelectorList(selectors.containers, true) &&
    cgSelectorList(selectors.directReject, true) &&
    cgSelectorList(selectors.openPreferences, false) &&
    cgSelectorList(selectors.completion, false);
}
function cgV2HasNoRemoteSave(selectors) {
  return Array.isArray(selectors.save) && selectors.save.length === 0;
}
function cgV2HasIdentity(f) {
  return !!f && f.enabled !== false && typeof f.name === 'string' && !!f.selectors;
}
function cgV2ValidEntry(f) {
  if (!cgV2HasIdentity(f)) return false;
  const frameworkKeys = ['enabled', 'name', 'pierceShadow', 'selectors'];
  const selectorKeys = ['completion', 'containers', 'directReject', 'openPreferences', 'save'];
  if (Object.keys(f).some((key) => !frameworkKeys.includes(key))) return false;
  if (Object.keys(f.selectors).sort().join(',') !== selectorKeys.join(',')) return false;
  return cgV2HasRequiredRoles(f.selectors) && cgV2HasNoRemoteSave(f.selectors);
}

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.resolve(__dirname, 'fixtures', name), 'utf8'));
}

// ─────────────────────────────── autoconsent ───────────────────────────────
test('autoconsent: parseRule pulls container + splits comma-joined reject selectors', () => {
  const rules = loadFixture('autoconsent-sample.json');
  const e = ac.parseRule(rules[0]);
  assert(e, 'entry produced for Onetrust');
  assert(e.containerSelector.indexOf('#onetrust-banner-sdk') !== -1, 'container selector present');
  assert(e.rejectSelectors.length === 2, 'comma-joined reject split into two');
  assert(e.rejectSelectors.indexOf('#onetrust-reject-all-handler') !== -1, 'first reject kept');
  assert(e.rejectSelectors.indexOf('.ot-pc-refuse-all-handler') !== -1, 'second reject kept');
});

test('autoconsent: a hide-only rule (no reject click) is skipped', () => {
  const rules = loadFixture('autoconsent-sample.json');
  const hideOnly = rules.find((r) => r.name === 'HideOnly');
  assert(ac.parseRule(hideOnly) === null, 'hide-only rule produces no entry');
});

test('autoconsent: convert output is drop-in valid for consent-ghost', () => {
  const rules = loadFixture('autoconsent-sample.json');
  const { config, stats } = ac.convert(rules, AUTOCONSENT_OPTIONS);
  assert(cgUsable(config), 'isUsableRemoteConfig accepts it');
  assert(config.frameworks.every(cgValidEntry), 'every framework entry is valid');
  assert(stats.emitted === 3, 'three usable CMPs emitted');
  assert(stats.skipped === 1, 'one (hide-only) skipped');
  assert(config.sourceLicense === 'MPL-2.0', 'AutoConsent data licence recorded accurately');
  assert(config.attribution.indexOf('AutoConsent') !== -1, 'AutoConsent attribution embedded');
});

test('autoconsent: reject clicks inside if/then branches are collected', () => {
  const rules = loadFixture('autoconsent-sample.json');
  const sp = ac.parseRule(rules.find((r) => r.name === 'Sourcepoint'));
  assert(sp && sp.rejectSelectors.indexOf('.sp_choice_type_REJECT_ALL') !== -1, 'nested reject found');
  assert(sp.rejectSelectors.indexOf('.sp_choice_type_12') === -1, 'ambiguous top-level click is dropped');
});

test('autoconsent: v1 emits only semantically explicit reject controls', () => {
  const entry = ac.parseRule({
    name: 'Mixed actions',
    detectPopup: [{ visible: '#cmp' }],
    optOut: [
      { click: '#manage-preferences' },
      { click: '#save-choices' },
      { click: '#accept-all' },
      { click: '#reject-all' },
    ],
  });
  assert(entry, 'explicit reject keeps the rule usable');
  assert(entry.rejectSelectors.length === 1, 'only one safe action remains');
  assert(entry.rejectSelectors[0] === '#reject-all', 'only the explicit reject is published');
});

test('autoconsent v2: emits constrained roles, never an executable step list', () => {
  const { v2Config, stats } = ac.convert(loadFixture('autoconsent-sample.json'), AUTOCONSENT_OPTIONS);
  assert(v2Config.schemaVersion === 2, 'schema v2 emitted');
  assert(v2Config.configVersion === '20260714000000.2', 'v2 sorts after the compatibility feed');
  assert(v2Config.frameworks.every(cgV2ValidEntry), 'all entries use constrained selector roles');
  assert(v2Config.frameworks.every((entry) => !Object.prototype.hasOwnProperty.call(entry, 'steps')), 'no remote steps');
  assert(stats.emittedV2 >= 2, 'high-confidence reject rules emitted');
  const onetrust = v2Config.frameworks.find((entry) => entry.name === 'Onetrust');
  assert(onetrust.selectors.directReject.indexOf('#onetrust-reject-all-handler') !== -1, 'reject role retained');
  assert(!cgV2ValidEntry({ ...onetrust, steps: [{ click: '#reject' }] }), 'top-level executable steps are rejected');
  assert(!cgV2ValidEntry({
    ...onetrust,
    selectors: { ...onetrust.selectors, acceptAll: ['#accept-all'] },
  }), 'unknown selector roles are rejected');
});

test('autoconsent v2: selector classifier refuses ambiguous and executable inputs', () => {
  assert(ac.selectorRole('#reject-all') === 'directReject', 'reject classified');
  assert(ac.selectorRole('#accept-none') === 'directReject', 'accept-none remains a reject action');
  assert(ac.selectorRole('#accept-all:not(.reject)') === null, 'conflicting accept and reject hints are refused');
  assert(ac.selectorRole('#reject-dialog #accept-all') === null, 'accept target inside a reject surface is refused');
  assert(ac.selectorRole('.cookie-preferences') === 'openPreferences', 'preferences classified');
  assert(ac.selectorRole('#save-choices') === null, 'standalone save is never remotely actionable');
  assert(ac.selectorRole('#accept-all') === null, 'accept selector never becomes an action');
  assert(ac.selectorRole('xpath///button[contains(., "Reject")]') === null, 'XPath is outside the remote schema');
  assert(ac.selectorRole('button') === null, 'semantic-free selector rejected');
  assert(ac.selectorRole('#disagree') === 'directReject', 'agree is not matched inside disagree');
  assert(ac.selectorRole('#confirm-reject') === null, 'save/confirm veto wins over reject wording');
  assert(ac.isSafeSelector('#cmp >>> #reject'), 'custom shadow combinator is structurally validated');
  for (const selector of ['button[', 'button)', 'button("x"', '#cmp >>> ', '//div']) {
    assert(!ac.isSafeSelector(selector), `malformed selector rejected: ${selector}`);
  }
});

test('autoconsent: selector splitting honors CSS escape parity', () => {
  eq(ac.isEscapedAt('\\,', 1), true, 'odd backslash count escapes a delimiter');
  eq(ac.isEscapedAt('\\\\,', 2), false, 'even backslash count leaves a delimiter active');
  eq(ac.splitSelectors(String.raw`#reject\,all, #deny`).length, 2, 'escaped comma stays inside one selector');
  eq(
    ac.splitSelectors(String.raw`button[data-label="say \", no"], #deny`).length,
    2,
    'escaped quote keeps the comma inside the attribute value',
  );
  assert(ac.isSafeSelector(String.raw`#reject\[all\]`), 'escaped brackets do not corrupt nesting');
});

test('autoconsent: untrusted input and serialized output are bounded', () => {
  const base = {
    name: 'Bounded',
    detectPopup: [{ visible: '#cmp' }],
    optOut: [{ click: '#reject-all' }],
  };
  for (const rules of [
    Array.from({ length: ac.MAX_INPUT_RULES + 1 }, () => base),
    [{ ...base, name: 'x'.repeat(ac.MAX_NAME_LENGTH + 1) }],
  ]) {
    let rejected = false;
    try { ac.convert(rules, AUTOCONSENT_OPTIONS); } catch (_) { rejected = true; }
    assert(rejected, 'oversized input rejected');
  }

  let nested = { click: '#reject-all' };
  for (let depth = 0; depth <= ac.MAX_RULE_DEPTH; depth += 1) nested = { then: [nested] };
  let depthRejected = false;
  try { ac.convert([{ ...base, optOut: [nested] }], AUTOCONSENT_OPTIONS); } catch (_) { depthRejected = true; }
  assert(depthRejected, 'deep recursive rule rejected');

  let outputRejected = false;
  try { ac.convert([base], { ...AUTOCONSENT_OPTIONS, maxOutputBytes: 100 }); } catch (_) { outputRejected = true; }
  assert(outputRejected, 'serialized output cap enforced before publication');
});

test('autoconsent: release versions are explicit and monotonic', () => {
  const rules = loadFixture('autoconsent-sample.json');
  for (const options of [
    {},
    { configVersion: '20260714000000' },
    { configVersion: '2026-07-14', v2ConfigVersion: '2026-07-14.2' },
    { configVersion: '20260714000000', v2ConfigVersion: '20260713000000.2' },
    { configVersion: '20260714000000', v2ConfigVersion: '20260714000000.3' },
  ]) {
    let rejected = false;
    try { ac.convert(rules, options); } catch (_) { rejected = true; }
    assert(rejected, 'invalid or implicit release versions are rejected');
  }
  let byteCapRejected = false;
  try { ac.nextInputByteTotal(ac.MAX_TOTAL_INPUT_BYTES - 1, 2, 'overflow.json'); }
  catch (_) { byteCapRejected = true; }
  assert(byteCapRejected, 'aggregate input bytes are bounded before file reads');
});

// ──────────────────────────────────  ToS;DR  ───────────────────────────────
test('tosdr: parseService keeps only bad/blocker points and maps grade + hosts', () => {
  const svcs = loadFixture('tosdr-sample.json');
  const p = td.parseService(svcs[0]);
  assert(p, 'parsed');
  assert(p.hosts.indexOf('example.com') !== -1, 'host stripped of scheme + www');
  assert(p.hosts.indexOf('example.net') !== -1, 'secondary host kept');
  assert(p.entry.grade === 'E', 'grade letter uppercased');
  assert(p.entry.flagged.length === 2, 'only blocker + bad surfaced (good/neutral dropped)');
  assert(p.entry.flagged[0].severity === 'high', 'blocker -> high severity');
});

test('tosdr: convert embeds attribution and lookupGrade resolves www + subdomains', () => {
  const { config, stats } = td.convert(loadFixture('tosdr-sample.json'), TOSDR_OPTIONS);
  assert(config.schemaVersion === 1, 'schemaVersion set');
  assert(typeof config.attribution === 'string' && config.attribution.indexOf('ToS;DR') !== -1, 'CC-BY-SA attribution embedded');
  assert(stats.flagged === 4, 'flagged counted per emitted host (2 hosts x 2 clauses)');
  assert(td.lookupGrade('www.example.com', config).grade === 'E', 'lookup strips www');
  assert(td.lookupGrade('app.example.com', config).grade === 'E', 'lookup falls back to base domain');
  assert(td.lookupGrade('unknown.tld', config) === null, 'unknown host -> null');
});

test('tosdr: host normalization strips URL syntax and drops malformed service keys', () => {
  assert(td.stripHost('https://www.example.com:443/privacy') === 'example.com', 'scheme, port, www, and path removed');
  assert(td.stripHost('*.example.com') === null, 'wildcard is not a cache key');
  assert(td.stripHost('not a host') === null, 'invalid host dropped');
});

test('tosdr: empty reviewed titles are dropped and blank service names fall back to the host', () => {
  const parsed = td.parseService({
    name: '   ',
    urls: ['example.com'],
    points: [
      { classification: 'bad', title: '   ' },
      { classification: 'bad', title: 'Tracks users' },
    ],
  });
  eq(parsed.entry.name, 'example.com');
  eq(parsed.entry.flagged.length, 1);
  eq(parsed.entry.flagged[0].title, 'Tracks users');
});

test('tosdr: flagged ordering uses deterministic code-point comparison', () => {
  eq(td.compareText('Zeta', 'alpha'), -1);
  eq(td.compareText('same', 'same'), 0);
  eq(td.compareText('zeta', 'Alpha'), 1);
});

test('tosdr: duplicate hosts retain complementary grade and reviewed detail', () => {
  const { config } = td.convert([
    { name: 'Rated', urls: ['example.com'], rating: 'A', points: [] },
    { name: 'Reviewed', urls: ['example.com'], points: [{ classification: 'bad', title: 'Tracks users' }] },
  ], TOSDR_OPTIONS);
  eq(config.services['example.com'].grade, 'A');
  eq(config.services['example.com'].flagged.length, 1);
});

test('tosdr: duplicate hosts merge, deduplicate, prioritize, and cap reviewed detail', () => {
  const med = Array.from({ length: td.MAX_FLAGGED_PER_SERVICE }, (_, index) => ({
    classification: 'bad',
    title: `Medium ${index}`,
  }));
  const { config } = td.convert([
    { name: 'First', urls: ['example.com'], points: med.concat({ classification: 'blocker', title: 'Critical' }) },
    {
      name: 'Second',
      urls: ['example.com'],
      points: [
        { classification: 'bad', title: 'Medium 0' },
        { classification: 'blocker', title: 'Critical' },
        { classification: 'bad', title: 'Complementary' },
      ],
    },
  ], TOSDR_OPTIONS);
  const flagged = config.services['example.com'].flagged;
  eq(flagged.length, td.MAX_FLAGGED_PER_SERVICE, 'merged detail remains capped');
  eq(flagged[0].title, 'Critical', 'high severity sorts first');
  eq(flagged.filter((point) => point.title === 'Critical').length, 1, 'duplicate detail removed');
  assert(flagged.some((point) => point.title === 'Complementary'), 'complementary detail retained');
});

test('tosdr: severity truncation and equal-quality merges are deterministic', () => {
  const points = Array.from({ length: td.MAX_FLAGGED_PER_SERVICE }, (_, index) => ({
    classification: 'bad',
    title: `Medium ${index}`,
  })).concat({ classification: 'blocker', title: 'Critical last' });
  const parsed = td.parseService({ name: 'Priority', urls: ['priority.example'], points });
  eq(parsed.entry.flagged[0].title, 'Critical last', 'blocker survives truncation regardless of input position');

  const services = [
    { name: 'Zulu', urls: ['z.example', 'shared.example'], rating: 'B' },
    { name: 'Alpha', urls: ['a.example', 'shared.example'], rating: 'B' },
  ];
  const first = td.convert(services, TOSDR_OPTIONS).config;
  const second = td.convert(services.slice().reverse(), TOSDR_OPTIONS).config;
  eq(JSON.stringify(first), JSON.stringify(second), 'service order cannot change serialized output');
  eq(Object.keys(first.services).join(','), 'a.example,shared.example,z.example', 'host keys use code-point order');
  eq(first.services['shared.example'].name, 'Alpha', 'equal-quality entries use a stable tie-breaker');
});

test('tosdr: empty strings fall through and broad lookup stops at registrable domains', () => {
  eq(td.firstString(['', '  ', 'usable']), 'usable');
  const config = {
    services: {
      'example.co.uk': { grade: 'B' },
      'co.uk': { grade: 'E' },
    },
  };
  eq(td.lookupGrade('app.example.co.uk', config).grade, 'B', 'registrable domain is eligible');
  eq(td.lookupGrade('unknown.co.uk', config), null, 'public suffix is never treated as a service');
});

test('tosdr: untrusted collection and serialized-output caps fail closed', () => {
  let pointsRejected = false;
  try {
    td.parseService({
      urls: ['example.com'],
      points: Array.from({ length: td.MAX_POINTS_PER_SERVICE + 1 }, () => ({ classification: 'bad' })),
    });
  } catch (_) { pointsRejected = true; }
  assert(pointsRejected, 'oversized point collection rejected');

  let outputRejected = false;
  try {
    td.convert([{ name: 'Example', urls: ['example.com'], rating: 'A' }], { ...TOSDR_OPTIONS, maxOutputBytes: 100 });
  } catch (_) { outputRejected = true; }
  assert(outputRejected, 'serialized byte cap enforced');
});

// ─────────────────────────────── whotracks.me ──────────────────────────────
test('whotracksme: domains are grouped by company into first-party sets (>=2)', () => {
  const { config } = wtm.convert(loadFixture('whotracksme-sample.json'), CATALOG_METADATA);
  const googleSet = config.firstPartySets.find((s) => s.indexOf('google.com') !== -1);
  assert(googleSet, 'google set exists');
  assert(googleSet.indexOf('doubleclick.net') !== -1, 'doubleclick merged into google');
  assert(googleSet.indexOf('google-analytics.com') !== -1, 'analytics merged into google');
  assert(!config.firstPartySets.some((s) => s.length < 2), 'no singleton sets (vimeo dropped)');
});

test('generic tracker catalog: yellowlist only includes function-critical categories', () => {
  const { config } = wtm.convert(loadFixture('whotracksme-sample.json'), CATALOG_METADATA);
  assert(config.yellowlist.indexOf('cloudflare.com') !== -1, 'cdn domain is yellow');
  assert(config.yellowlist.indexOf('vimeo.com') !== -1, 'audio_video_player is yellow');
  assert(config.yellowlist.indexOf('doubleclick.net') === -1, 'advertising is NOT yellow');
  assert(config.yellowlist.indexOf('google-analytics.com') === -1, 'site_analytics is NOT yellow');
  assert(config.sourceLicense === CATALOG_METADATA.sourceLicense, 'caller-verified licence is preserved');
  assert(config.attribution === CATALOG_METADATA.attribution, 'caller attribution is preserved');
});

test('generic tracker catalog: missing provenance metadata fails closed', () => {
  let rejected = false;
  try { wtm.convert(loadFixture('whotracksme-sample.json')); }
  catch (_) { rejected = true; }
  assert(rejected, 'a caller-supplied catalog is not emitted with invented provenance');

  let oversized = false;
  try {
    wtm.convert(loadFixture('whotracksme-sample.json'), {
      ...CATALOG_METADATA,
      attribution: 'x'.repeat(wtm.METADATA_MAX.attribution + 1),
    });
  } catch (_) { oversized = true; }
  assert(oversized, 'oversized provenance metadata is rejected before emission');
});

test('generic tracker catalog: missing collections and malformed hostnames fail closed', () => {
  let schemaRejected = false;
  try { wtm.convert({}, CATALOG_METADATA); } catch (_) { schemaRejected = true; }
  assert(schemaRejected, 'tracker and company collections are both required');

  const { config } = wtm.convert({
    trackers: [{
      company_id: 1,
      domains: ['user:pass@example.com', 'example.com:443', '*.example.com', '127.0.0.1', '[::1]', 'valid.example'],
    }],
    companies: [{ id: 1, domains: ['second.example'] }],
  }, CATALOG_METADATA);
  const serialized = JSON.stringify(config);
  assert(!serialized.includes('"example.com"'), 'malformed inputs are not normalized into a hostname');
  assert(!serialized.includes('user:pass'), 'credentialed host rejected');
  assert(!serialized.includes(':443'), 'ported host rejected');
  assert(!serialized.includes('*.example.com'), 'wildcard host rejected');
  assert(!serialized.includes('127.0.0.1'), 'IPv4 literal rejected');
  assert(!serialized.includes('::1'), 'IPv6 literal rejected');
  assert(serialized.includes('valid.example'), 'canonical hostname retained');
});

test('generic tracker catalog: output ordering is independent of catalog ordering', () => {
  const input = {
    trackers: [
      { company_id: 2, domains: ['zeta.example', 'alpha.example'] },
      { company_id: 1, domains: ['bravo.example', 'charlie.example'] },
    ],
    companies: [{ id: 1 }, { id: 2 }],
  };
  const reversed = {
    trackers: input.trackers.slice().reverse().map((tracker) => ({
      ...tracker,
      domains: tracker.domains.slice().reverse(),
    })),
    companies: input.companies.slice().reverse(),
  };
  const first = wtm.convert(input, CATALOG_METADATA).config;
  const second = wtm.convert(reversed, CATALOG_METADATA).config;
  eq(JSON.stringify(first.firstPartySets), JSON.stringify(second.firstPartySets));
});

test('generic tracker catalog: collection and per-item domain caps fail closed before indexing', () => {
  for (const input of [
    { trackers: new Array(wtm.MAX_TRACKERS + 1), companies: [] },
    { trackers: [], companies: new Array(wtm.MAX_COMPANIES + 1) },
    {
      trackers: [{ company_id: 1, domains: new Array(wtm.MAX_DOMAINS_PER_ITEM + 1).fill('valid.example') }],
      companies: [],
    },
  ]) {
    let rejected = false;
    try { wtm.convert(input, CATALOG_METADATA); } catch (_) { rejected = true; }
    assert(rejected, 'oversized catalog input rejected');
  }
});

test('generic tracker catalog: collections and records require explicit plain schemas', () => {
  assert(!wtm.isCollection(new Map()), 'Map is not accepted as a catalog collection');
  assert(!wtm.isCollection(new Date()), 'Date is not accepted as a catalog collection');
  for (const input of [
    { trackers: [null], companies: [] },
    { trackers: [{ company_id: 1, domains: 'tracker.example' }], companies: [] },
    { trackers: [], companies: { broken: 'not-a-record' } },
    { trackers: [], companies: [{ id: 1, domains: 'company.example' }] },
  ]) {
    let rejected = false;
    try { wtm.convert(input, CATALOG_METADATA); } catch (_) { rejected = true; }
    assert(rejected, 'malformed catalog record is rejected instead of skipped');
  }
});

test('generic tracker catalog: total company-domain associations are globally bounded', () => {
  const state = {
    byCompany: new Map([['company', new Set(['existing.example'])]]),
    yellow: new Set(),
    associations: wtm.MAX_DOMAIN_ASSOCIATIONS,
  };
  wtm.addCompanyDomain(state, 'company', 'existing.example');
  let rejected = false;
  try { wtm.addCompanyDomain(state, 'company', 'new.example'); } catch (_) { rejected = true; }
  assert(rejected, 'a new association beyond the global cap is rejected before insertion');
  assert(!state.byCompany.get('company').has('new.example'), 'oversized association is not retained');

  const orphanState = {
    byCompany: new Map(),
    yellow: new Set(),
    unowned: new Set(),
    associations: wtm.MAX_DOMAIN_ASSOCIATIONS,
  };
  rejected = false;
  try { wtm.addCompanyDomain(orphanState, null, 'orphan.example'); } catch (_) { rejected = true; }
  assert(rejected, 'unowned tracker domains still consume the global association budget');
});

test('generic tracker catalog: yellowlist growth is bounded before insertion', () => {
  const state = {
    yellow: new Set(Array.from({ length: wtm.MAX_YELLOW }, (_, index) => `yellow-${index}.example`)),
  };
  let rejected = false;
  try { wtm.addYellowDomain(state, 'overflow.example'); } catch (_) { rejected = true; }
  assert(rejected, 'new yellow domain beyond the cap is rejected');
  assert(!state.yellow.has('overflow.example'), 'oversized yellow domain is not retained');
});

test('tosdr: deterministic config version is mandatory', () => {
  let rejected = false;
  try { td.convert(loadFixture('tosdr-sample.json')); } catch (_) { rejected = true; }
  assert(rejected, 'date-dependent implicit versions are forbidden');
  for (const configVersion of ['2026-07-14', '01', '1..2', '1.2']) {
    let invalid = false;
    try { td.convert(loadFixture('tosdr-sample.json'), { configVersion }); } catch (_) { invalid = true; }
    assert(invalid, `non-canonical version rejected: ${configVersion}`);
  }
  eq(td.convert(loadFixture('tosdr-sample.json'), TOSDR_OPTIONS).config.configVersion, TOSDR_OPTIONS.configVersion);
});

// ── Generated artifacts (present only after a build run) stay drop-in valid ──
test('generated consent artifact, if built, is drop-in valid', () => {
  const p = path.resolve(__dirname, '../dist-lists/consent-ghost/consent-config.json');
  if (!fs.existsSync(p)) return; // built in CI / sample run only
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert(cgUsable(cfg), 'usable');
  assert(cfg.frameworks.every(cgValidEntry), 'all entries valid');
});

test('generated consent v2 artifact, if built, uses constrained roles', () => {
  const p = path.resolve(__dirname, '../dist-lists/consent-ghost/consent-config-v2.json');
  if (!fs.existsSync(p)) return;
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert(cfg.schemaVersion === 2, 'v2 schema');
  assert(Array.isArray(cfg.frameworks) && cfg.frameworks.length > 0, 'v2 artifact contains usable frameworks');
  assert(cfg.frameworks.every(cgV2ValidEntry), 'all entries valid');
});
