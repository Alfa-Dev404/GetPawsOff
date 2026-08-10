/* PawsOff — Tier-1 unit tests for the background service worker.
 *
 * Covers the PURE, side-effect-free logic that ships in background.js:
 *   - version comparison + config-adoption (anti-rollback) policy
 *   - DNR rule building, id-band validation, and message-rule sanitisation
 *     (the defensive layer that forces `block` and clamps ids)
 *   - structural validators for the three signed remote configs
 *   - the fail-closed signature gate (pinned key + WebCrypto both required)
 *   - base64 decoding
 *
 * The DOM-free service worker loads cleanly into the vm harness; the file's
 * guarded hook exposes these helpers only because the harness sets
 * self.__pawsOff_TEST. Network/DNR side effects never run (they live in
 * install/startup callbacks that the test never fires).
 */
'use strict';

const { test, assert, eq } = require('./harness/framework');
const { loadBackground } = require('./harness/sandbox');

test('network catch records use a generic label and hash-only identity', () => {
  const { internals } = loadBackground();
  const fields = internals.networkCatchFieldsForRule({ 42: 'tracker.example' }, 42);
  eq(fields.label, 'Tracker');
  assert(/^h:[0-9a-f]{8}$/.test(fields.detail), 'detail is an opaque digest');
  assert(!JSON.stringify(fields).includes('tracker.example'), 'plaintext tracker hostname is not persisted');
});

const loaded = loadBackground();
const internals = loaded.internals || {};
const {
  compareVersions,
  base64ToBytes,
  buildProviderRule,
  isValidRuleId,
  sanitizeRules,
  isPlainObject,
  hasRequiredArrays,
  hasRequiredSections,
  validateConfig,
  validateTosReputationConfig,
  lookupTosReputation,
  validateConsentConfig,
  validatePixelBlockConfig,
  canVerifySignatures,
  PINNED_PUBLIC_KEY_JWK,
  isPinnedConfigUrl,
  DNR_RULE_ID_BASE,
  DNR_ID_MIN,
  DNR_ID_MAX,
  TRACKING_DOMAINS,
  PIXELBLOCK_PROVIDERS,
  masterProtectionEnabled,
  trackerProtectionEnabled,
  summarizeDnrMatches,
  VERSION,
} = internals;

test('background: the guarded test hook exposes the pure helpers', () => {
  assert(internals && typeof internals === 'object', 'internals object exposed');
  ['compareVersions', 'base64ToBytes', 'buildProviderRule', 'isValidRuleId', 'sanitizeRules', 'validateConfig'].forEach((k) => {
    assert(typeof internals[k] === 'function', k + ' is a function');
  });
});

test('tracker protection: master and Trackers feature both gate every blocking tier', () => {
  assert(masterProtectionEnabled({}), 'missing master state defaults to protection on');
  assert(masterProtectionEnabled({ __pawsOff_master_enabled: true }), 'explicit master on');
  assert(!masterProtectionEnabled({ __pawsOff_master_enabled: false }), 'explicit master pause');
  assert(trackerProtectionEnabled({}), 'missing settings default to protection on');
  assert(trackerProtectionEnabled({ __pawsOff_pixelBlock_settings: { globalEnabled: true } }), 'Trackers on');
  assert(!trackerProtectionEnabled({ __pawsOff_master_enabled: false }), 'master pause wins');
  assert(!trackerProtectionEnabled({ __pawsOff_pixelBlock_settings: { globalEnabled: false } }), 'Trackers off stands down');
});

test('DNR reconciliation stands down before reading matches when Trackers is off', async () => {
  const { internals: helpers, chrome } = loadBackground();
  await chrome.storage.local.set({
    __pawsOff_master_enabled: true,
    __pawsOff_pixelBlock_settings: { globalEnabled: false },
  });
  let reads = 0;
  chrome.declarativeNetRequest.getMatchedRules = () => {
    reads += 1;
    return Promise.resolve({ rulesMatchedInfo: [] });
  };
  eq(await helpers.readNewDnrMatches(), null);
  eq(reads, 0, 'disabled tracker state never processes buffered matches');
  assert(helpers.getLastDnrPoll() > 0, 'cursor advances so disabled-period matches stay discarded');
});

test('master pause greys the icon while preserving the accumulated badge', async () => {
  const { internals: helpers, chrome, emitStorageChange } = loadBackground();
  await Promise.resolve(); // let the load-time icon sync finish against inert stubs
  const icons = [];
  const badges = [];
  const session = {
    __pawsOff_badge_7: { k: ['d1', 'd2', 'd3', 'd4'], n: 4 },
    unrelated: { keep: true },
  };
  chrome.action = {
    setIcon: (value) => { icons.push(value); return Promise.resolve(); },
    setBadgeText: (value) => { badges.push(value); return Promise.resolve(); },
  };
  chrome.tabs = { query: () => Promise.resolve([{ id: 7 }]) };
  chrome.storage.session = {
    get: () => Promise.resolve({ ...session }),
    remove: (keys) => {
      (Array.isArray(keys) ? keys : [keys]).forEach((key) => { delete session[key]; });
      return Promise.resolve();
    },
  };
  await chrome.storage.local.set({ __pawsOff_master_enabled: false });
  await emitStorageChange({ __pawsOff_master_enabled: { oldValue: true, newValue: false } });

  await helpers.rehydrateBadges();

  eq(icons[icons.length - 1].path[16], '/icons/icon16-off.png');
  eq(badges[badges.length - 1].tabId, 7);
  eq(badges[badges.length - 1].text, '4');
  assert(session.__pawsOff_badge_7, 'paused count retained in session storage');
  assert(session.unrelated.keep, 'unrelated session state preserved');

  await chrome.storage.local.set({ __pawsOff_master_enabled: true });
  await emitStorageChange({ __pawsOff_master_enabled: { oldValue: false, newValue: true } });
  eq(icons[icons.length - 1].path[16], '/icons/icon16.png');
  eq(badges[badges.length - 1].text, '4', 'resume keeps the accumulated count');
});

test('master pause prevents matched-rule reconciliation from counting old blocks', async () => {
  const { internals: helpers, chrome } = loadBackground();
  let reads = 0;
  chrome.declarativeNetRequest.getMatchedRules = () => {
    reads += 1;
    return Promise.resolve({ rulesMatchedInfo: [] });
  };
  await chrome.storage.local.set({ __pawsOff_master_enabled: false });

  await helpers.reconcileDnrMatches(true);

  eq(reads, 0, 'paused suite never queries or counts matched rules');
});

test('EasyPrivacy ruleset follows the popup Trackers feature', async () => {
  const { internals: helpers, chrome } = loadBackground();
  const calls = [];
  chrome.declarativeNetRequest.updateEnabledRulesets = (update) => { calls.push(update); return Promise.resolve(); };

  await chrome.storage.local.set({ __pawsOff_pixelBlock_settings: { globalEnabled: false } });
  await helpers.syncEasyPrivacyRuleset();
  eq(calls[0].disableRulesetIds[0], 'easyprivacy');

  await chrome.storage.local.set({
    __pawsOff_master_enabled: false,
    __pawsOff_pixelBlock_settings: { globalEnabled: true },
  });
  await helpers.syncEasyPrivacyRuleset();
  eq(calls[1].disableRulesetIds[0], 'easyprivacy');

  await chrome.storage.local.set({
    __pawsOff_master_enabled: true,
    __pawsOff_pixelBlock_settings: { globalEnabled: true },
  });
  await helpers.syncEasyPrivacyRuleset();
  eq(calls[2].enableRulesetIds[0], 'easyprivacy');
});

test('unreadable protection state stands every network blocker down', async () => {
  const { internals: helpers, chrome } = loadBackground();
  chrome.storage.local.get = () => Promise.reject(new Error('storage unavailable'));
  const staticCalls = [];
  chrome.declarativeNetRequest.updateEnabledRulesets = (update) => { staticCalls.push(update); return Promise.resolve(); };
  chrome.declarativeNetRequest.getDynamicRules = () => Promise.resolve([{ id: 20005 }]);

  assert(!(await helpers.isMasterProtectionEnabled()), 'master state read failure stands badge work down');
  await helpers.syncEasyPrivacyRuleset();
  eq(staticCalls[0].disableRulesetIds[0], 'easyprivacy');

  await helpers.syncBaselineRules();
  const baseline = chrome.declarativeNetRequest._calls.find((call) => call.removeRuleIds && call.removeRuleIds[0] === DNR_RULE_ID_BASE);
  eq(baseline.addRules.length, 0, 'provider rules are removed without being re-added');

  const delta = await helpers.syncEasyPrivacyDeltaRules();
  eq(delta.enabled, false, 'signed delta rules stand down');
});

// ── compareVersions ─────────────────────────────────────────────────────────
test('compareVersions: orders dotted numeric versions (numeric, not lexical)', () => {
  eq(compareVersions('1.0.0', '1.0.0'), 0);
  eq(compareVersions('1.2.0', '1.10.0'), -1, '2 < 10 numerically');
  eq(compareVersions('2.0', '1.9.9'), 1);
  eq(compareVersions('1.0.1', '1.0'), 1);
});

test('compareVersions: tolerates junk / missing parts (treated as 0)', () => {
  eq(compareVersions('', ''), 0);
  eq(compareVersions(null, undefined), 0);
  eq(compareVersions('v1.0', '1.0.0'), 0, 'non-digits stripped');
  eq(compareVersions('1.0', '1.0.0'), 0, 'missing trailing part is 0');
});

test('signed client exposes only the release-manifest fetch path', () => {
  const api = loaded.root.PawsOffSignedConfigClient;
  const client = api.create({});
  assert(typeof client.fetchReleaseConfig === 'function', 'release feed fetch remains available');
  assert(typeof client.fetchSignedConfig === 'undefined', 'standalone mutable config fetch is absent');
  assert(typeof api.shouldAdoptConfig === 'undefined', 'legacy config adoption helper is absent');
});

// ── isValidRuleId + reserved id band ─────────────────────────────────────────
test('isValidRuleId: only integers inside the reserved DNR band', () => {
  eq(DNR_ID_MIN, DNR_RULE_ID_BASE);
  eq(DNR_ID_MAX, DNR_RULE_ID_BASE + 99);
  assert(isValidRuleId(DNR_RULE_ID_BASE), 'low edge in range');
  assert(isValidRuleId(DNR_ID_MAX), 'high edge in range');
  assert(!isValidRuleId(DNR_ID_MIN - 1), 'below band rejected');
  assert(!isValidRuleId(DNR_ID_MAX + 1), 'above band rejected');
  assert(!isValidRuleId(9100.5), 'non-integer rejected');
  assert(!isValidRuleId('9100'), 'string rejected');
});

// ── buildProviderRule ────────────────────────────────────────────────────────
test('buildProviderRule: image-only block rule scoped to the provider origin', () => {
  const p = PIXELBLOCK_PROVIDERS[0];
  const rule = buildProviderRule(p);
  eq(rule.id, DNR_RULE_ID_BASE + p.dnrIndex, 'id is base + index');
  eq(rule.action.type, 'block');
  assert(rule.condition.resourceTypes.length === 1 && rule.condition.resourceTypes[0] === 'image', 'image only');
  eq(rule.condition.requestDomains.length, TRACKING_DOMAINS.length, 'targets the tracker domains');
});

test('buildProviderRule: every provider gets a unique in-band id', () => {
  const ids = PIXELBLOCK_PROVIDERS.map((q) => buildProviderRule(q).id);
  eq(new Set(ids).size, ids.length, 'ids are unique');
  ids.forEach((id) => assert(isValidRuleId(id), 'id ' + id + ' inside reserved band'));
});

// ── sanitizeRules — the security-critical defensive layer ────────────────────
test('sanitizeRules: forces block action (never honours redirect/header intent)', () => {
  const out = sanitizeRules([
    { id: DNR_RULE_ID_BASE, action: { type: 'redirect' }, condition: { requestDomains: ['x.com'] } },
  ]);
  eq(out.length, 1);
  eq(out[0].action.type, 'block', 'redirect forced to block');
  eq(out[0].condition.resourceTypes[0], 'image', 'image only');
});

test('sanitizeRules: clamps ids to the reserved band and drops the rest', () => {
  const out = sanitizeRules([
    { id: DNR_RULE_ID_BASE + 3, condition: {} },
    { id: 1, condition: {} },
    { id: 999999, condition: {} },
    { id: 'nope', condition: {} },
    null,
  ]);
  eq(out.length, 1, 'only the in-band rule survives');
  eq(out[0].id, DNR_RULE_ID_BASE + 3);
});

test('sanitizeRules: non-array input yields an empty list', () => {
  eq(sanitizeRules(null).length, 0);
  eq(sanitizeRules(undefined).length, 0);
  eq(sanitizeRules('oops').length, 0);
});

test('sanitizeRules: defaults requestDomains to the tracker list when absent', () => {
  const out = sanitizeRules([{ id: DNR_RULE_ID_BASE, condition: { initiatorDomains: ['mail.google.com'] } }]);
  eq(out.length, 1);
  eq(out[0].condition.requestDomains.length, TRACKING_DOMAINS.length);
});

// ── validateConfig (ToS Shield) ──────────────────────────────────────────────
function validTosConfig() {
  return {
    schemaVersion: 1,
    configVersion: '1.0.0',
    minEngineVersion: '1.0.0',
    locale: 'en',
    pageDetection: {
      urlTokens: ['privacy'],
      titleTokens: ['privacy policy'],
      legaleseMarkers: ['we may'],
      minWordCount: 400,
      confidenceThreshold: 0.6,
    },
    segmentation: { abbreviations: ['inc.'], clauseDelimiters: [';'] },
    negation: { cues: ['not'], scope: 'clause', penalty: 0.3 },
    scoring: { presentThreshold: 0.5, modifierBoost: 1.5, aggravatedModifiers: ['without notice'] },
    categories: [{
      id: 'data_sale',
      label: 'Sells data',
      description: 'The service may sell data.',
      severity: 'high',
      defaultEnabled: true,
    }],
    patterns: [{
      id: 'data_sale.core',
      categoryId: 'data_sale',
      enabled: true,
      weight: 1,
      anchors: ['sell'],
      objects: ['personal data'],
      modifiers: [],
      ignoreNegation: false,
    }],
  };
}

test('validateConfig (ToS): accepts a well-formed config', () => {
  const good = validTosConfig();
  assert(validateConfig(good), 'valid ToS config accepted');
});

test('validateConfig (ToS): rejects wrong schema, missing arrays / sections / version', () => {
  const good = validTosConfig();
  assert(!validateConfig(null), 'null rejected');
  assert(!validateConfig({ ...good, schemaVersion: 2 }), 'wrong schemaVersion rejected');
  assert(!validateConfig({ ...good, patterns: undefined }), 'missing patterns array rejected');
  assert(!validateConfig({ ...good, scoring: undefined }), 'missing sections rejected');
  assert(!validateConfig({ ...good, configVersion: 7 }), 'non-string configVersion rejected');
  assert(!validateConfig({ ...good, configVersion: 'future' }), 'non-canonical configVersion rejected');
  assert(!validateConfig({ ...good, minEngineVersion: '9007199254740992' }), 'unsafe version component rejected');
  assert(!validateConfig({ ...good, patterns: [{ ...good.patterns[0], xpath: '//button' }] }), 'unknown executable fields rejected');
  assert(!validateConfig({ ...good, pageDetection: { ...good.pageDetection, action: 'fetch' } }), 'unknown nested actions rejected');
});

test('ToS reputation: validates constrained data and resolves exact hosts', () => {
  const cfg = {
    schemaVersion: 1,
    configVersion: '20260714000000',
    source: 'tosdr',
    attribution: 'Data from ToS;DR',
    services: {
      'example.com': {
        name: 'Example',
        grade: 'D',
        flagged: [{ title: 'Broad licence', topic: 'Content', severity: 'high' }],
      },
    },
  };
  assert(validateTosReputationConfig(cfg), 'valid signed reputation data accepted');
  eq(lookupTosReputation('www.example.com', cfg).grade, 'D');
  eq(lookupTosReputation('unknown.example', cfg), null);
});

test('ToS reputation: rejects unsafe host keys and unconstrained point data', () => {
  const base = {
    schemaVersion: 1,
    configVersion: '1',
    source: 'tosdr',
    attribution: 'ToS;DR',
  };
  assert(!validateTosReputationConfig({
    ...base,
    services: { 'https://example.com': { name: 'Bad', grade: 'E', flagged: [] } },
  }), 'URL-shaped service keys rejected');
  assert(!validateTosReputationConfig({
    ...base,
    services: { 'example.com': { name: 'Bad', grade: 'E', flagged: [{ title: 'x', topic: 'x', severity: 'critical' }] } },
  }), 'unknown severity rejected');
  assert(!validateTosReputationConfig({
    ...base,
    services: { 'example.com': { name: 'Bad', grade: 'F', flagged: [] } },
  }), 'grade is constrained to A-E or null');
  assert(!validateTosReputationConfig({
    ...base,
    services: { 'example.com': { name: 'Bad', grade: 'E', flagged: [], action: 'click' } },
  }), 'unknown reputation entry fields rejected');
  assert(!validateTosReputationConfig({
    ...base,
    services: {
      'example.com': {
        name: 'Bad',
        grade: 'E',
        flagged: [{ title: 'x', topic: 'x', severity: 'high', code: 'x' }],
      },
    },
  }), 'unknown point fields rejected');
  assert(!validateTosReputationConfig({ ...base, configVersion: 'future', services: {} }), 'non-canonical reputation version rejected');
});

// ── validateConsentConfig ────────────────────────────────────────────────────
test('validateConsentConfig: needs schema + string version + non-empty frameworks', () => {
  const metadata = {
    configVersion: '1.0.0',
    source: 'autoconsent',
    sourceLicense: 'MPL-2.0',
    attribution: 'AutoConsent fixture',
  };
  const v1 = { ...metadata, schemaVersion: 1, frameworks: [{ name: 'CMP', containerSelector: '#cmp', rejectSelectors: ['#reject'] }] };
  const v2 = {
    ...metadata,
    schemaVersion: 2,
    frameworks: [{
      name: 'CMP',
      selectors: { containers: ['#cmp'], directReject: ['#reject'], openPreferences: [], save: [], completion: ['#cmp'] },
    }],
  };
  assert(validateConsentConfig(v1), 'valid consent config');
  assert(validateConsentConfig(v2), 'constrained role schema accepted');
  assert(!validateConsentConfig({ ...v1, frameworks: [] }), 'empty frameworks rejected');
  assert(!validateConsentConfig({ ...v1, frameworks: undefined }), 'missing frameworks rejected');
  assert(!validateConsentConfig({ ...v1, schemaVersion: 9 }), 'wrong schema rejected');
  assert(!validateConsentConfig({ ...v1, source: 'unknown' }), 'unexpected source rejected');
  assert(!validateConsentConfig({ ...v1, configVersion: 'future' }), 'non-canonical consent version rejected');
  assert(!validateConsentConfig({ ...v1, frameworks: [{ ...v1.frameworks[0], rejectSelectors: ['xpath///button'] }] }), 'XPath rejected');
  assert(!validateConsentConfig({ ...v2, frameworks: [{ ...v2.frameworks[0], selectors: { ...v2.frameworks[0].selectors, save: ['#save'] } }] }), 'remote save action rejected');
  assert(!validateConsentConfig({ ...v1, action: 'click' }), 'unknown consent top-level field rejected');
  assert(!validateConsentConfig({ ...v1, frameworks: [{ ...v1.frameworks[0], steps: [] }] }), 'unknown v1 framework field rejected');
  assert(!validateConsentConfig({
    ...v2,
    frameworks: [{
      ...v2.frameworks[0],
      selectors: { ...v2.frameworks[0].selectors, steps: [] },
    }],
  }), 'unknown v2 selector field rejected');
});

// ── validatePixelBlockConfig ─────────────────────────────────────────────────
test('validatePixelBlockConfig: needs schema + string version + providers array', () => {
  assert(validatePixelBlockConfig({ schemaVersion: 1, configVersion: '1.0.0', providers: [] }), 'valid (empty providers) ok');
  assert(validatePixelBlockConfig({
    schemaVersion: 1,
    configVersion: '1.0.0',
    providers: [{ id: 'gmail', emailBodySelectors: ['.message'], legitimateProxies: ['example.com'] }],
  }), 'constrained provider patch accepted');
  assert(!validatePixelBlockConfig({ schemaVersion: 1, configVersion: '1.0.0', providers: {} }), 'providers must be an array');
  assert(!validatePixelBlockConfig({ schemaVersion: 1, configVersion: 5, providers: [] }), 'non-string version rejected');
  assert(!validatePixelBlockConfig({ schemaVersion: 1, configVersion: 'future', providers: [] }), 'non-canonical version rejected');
  assert(!validatePixelBlockConfig({ schemaVersion: 1, configVersion: '1.0.0', providers: [{ id: 'gmail', xpath: '//img' }] }), 'XPath field rejected');
  assert(!validatePixelBlockConfig({ schemaVersion: 1, configVersion: '1.0.0', providers: [{ id: 'gmail', action: 'remove' }] }), 'unknown action field rejected');
  assert(!validatePixelBlockConfig({
    schemaVersion: 1,
    configVersion: '1.0.0',
    providers: [{ id: 'gmail' }, { id: 'gmail' }],
  }), 'duplicate provider ids rejected');
});

// ── canVerifySignatures — requires BOTH a pinned key AND a WebCrypto impl ─────
// Sandbox omits self.crypto.subtle on purpose, to keep exercising the
// fail-closed path even with the key pinned.
test('canVerifySignatures: false without a WebCrypto implementation (fail-closed)', () => {
  eq(canVerifySignatures(), false, 'no remote config is trusted without self.crypto.subtle');
});

// ── PINNED_PUBLIC_KEY_JWK — must stay a well-formed P-256 JWK, never null ─────
// A falsy or malformed key silently disables every signed-config consumer.
test('PINNED_PUBLIC_KEY_JWK: a well-formed, non-null P-256 verify key', () => {
  assert(PINNED_PUBLIC_KEY_JWK && typeof PINNED_PUBLIC_KEY_JWK === 'object', 'key is pinned, not null');
  eq(PINNED_PUBLIC_KEY_JWK.kty, 'EC');
  eq(PINNED_PUBLIC_KEY_JWK.crv, 'P-256');
  assert(typeof PINNED_PUBLIC_KEY_JWK.x === 'string' && PINNED_PUBLIC_KEY_JWK.x.length > 0, 'x coordinate present');
  assert(typeof PINNED_PUBLIC_KEY_JWK.y === 'string' && PINNED_PUBLIC_KEY_JWK.y.length > 0, 'y coordinate present');
});

test('PINNED_PUBLIC_KEY_JWK: matches the committed tools/config-signing-public-key.json exactly', () => {
  // Catches a half-done key rotation (one file updated, not the other).
  const committed = require('../tools/config-signing-public-key.json');
  eq(PINNED_PUBLIC_KEY_JWK.x, committed.x, 'x coordinate matches the committed public key');
  eq(PINNED_PUBLIC_KEY_JWK.y, committed.y, 'y coordinate matches the committed public key');
  eq(PINNED_PUBLIC_KEY_JWK.crv, committed.crv);
  eq(PINNED_PUBLIC_KEY_JWK.kty, committed.kty);
});

// ── bothResponsesOk ───────────────────────────────────────────────────────
test('bothResponsesOk: true only when both fetches succeeded', () => {
  const bothResponsesOk = loaded.root.PawsOffSignedConfigClient.bothResponsesOk;
  assert(bothResponsesOk({ ok: true }, { ok: true }), 'both ok');
  assert(!bothResponsesOk({ ok: false }, { ok: true }), 'config not ok');
  assert(!bothResponsesOk({ ok: true }, null), 'sig missing');
  assert(!bothResponsesOk(null, null), 'both missing');
});

test('signed config URLs: only the credential-free pinned HTTPS origin is accepted', () => {
  assert(isPinnedConfigUrl('https://config.getpawsoff.app/tos-shield/patterns.json'), 'pinned URL accepted');
  assert(!isPinnedConfigUrl('http://config.getpawsoff.app/tos-shield/patterns.json'), 'HTTP rejected');
  assert(!isPinnedConfigUrl('https://config.getpawsoff.app.evil.example/feed.json'), 'lookalike origin rejected');
  assert(!isPinnedConfigUrl('https://user:pass@config.getpawsoff.app/feed.json'), 'credentials rejected');
});

test('bounded response reader rejects oversized declared and streamed bodies', async () => {
  const helpers = loadBackground().internals;
  let declaredCancelled = false;
  const declared = {
    headers: { get: () => '9' },
    body: { cancel: () => { declaredCancelled = true; return Promise.resolve(); } },
    text: () => Promise.resolve('small'),
  };
  eq(await helpers.readResponseTextWithinLimit(declared, 8), null, 'oversized Content-Length rejected before reading');
  assert(declaredCancelled, 'oversized declared body is cancelled');

  for (const raw of ['invalid', '-1', '1.5', '9007199254740992']) {
    let malformedCancelled = false;
    const malformed = {
      headers: { get: () => raw },
      body: { cancel: () => { malformedCancelled = true; return Promise.resolve(); } },
    };
    eq(await helpers.readResponseTextWithinLimit(malformed, 8), null, `malformed Content-Length rejected: ${raw}`);
    assert(malformedCancelled, `malformed declared body cancelled: ${raw}`);
  }

  let cancelled = false;
  const chunks = [new Uint8Array([97, 98, 99]), new Uint8Array([100, 101, 102])];
  const streamed = {
    headers: { get: () => null },
    body: {
      getReader() {
        let index = 0;
        return {
          read: () => Promise.resolve(index < chunks.length ? { done: false, value: chunks[index++] } : { done: true }),
          cancel: () => { cancelled = true; return Promise.resolve(); },
          releaseLock() {},
        };
      },
    },
  };
  eq(await helpers.readResponseTextWithinLimit(streamed, 5), null, 'chunked overflow rejected');
  assert(cancelled, 'oversized stream is cancelled immediately');

  const unstreamed = {
    headers: { get: () => null },
    text: () => Promise.resolve('unbounded fallback'),
  };
  eq(await helpers.readResponseTextWithinLimit(unstreamed, 100), null, 'response without a readable stream fails closed');
});

test('bounded response reader contains stream read failures', async () => {
  const helpers = loadBackground().internals;
  let cancelled = false;
  const response = {
    headers: { get: () => null },
    body: {
      getReader() {
        return {
          read: () => Promise.reject(new Error('stream failed')),
          cancel: () => { cancelled = true; return Promise.resolve(); },
          releaseLock() {},
        };
      },
    },
  };
  eq(await helpers.readResponseTextWithinLimit(response, 100), null);
  assert(cancelled, 'failed reader is cancelled');
});

test('bounded response reader reconstructs a body that stays within its cap', async () => {
  const helpers = loadBackground().internals;
  const chunks = [new Uint8Array([104, 101]), new Uint8Array([108, 108, 111])];
  const response = {
    headers: { get: () => null },
    body: {
      getReader() {
        let index = 0;
        return {
          read: () => Promise.resolve(index < chunks.length ? { done: false, value: chunks[index++] } : { done: true }),
          cancel: () => Promise.resolve(),
          releaseLock() {},
        };
      },
    },
  };
  eq(await helpers.readResponseTextWithinLimit(response, 5), 'hello');
});

test('bounded response reader rejects invalid limits before opening the stream', async () => {
  const helpers = loadBackground().internals;
  for (const limit of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    let bodyCancelled = false;
    let readerOpened = false;
    const response = {
      headers: { get: () => null },
      body: {
        cancel() { bodyCancelled = true; return Promise.resolve(); },
        getReader() { readerOpened = true; throw new Error('must not read'); },
      },
    };
    eq(await helpers.readResponseTextWithinLimit(response, limit), null, `invalid limit rejected: ${limit}`);
    assert(bodyCancelled, `body cancelled for invalid limit: ${limit}`);
    assert(!readerOpened, `stream remains unopened for invalid limit: ${limit}`);
  }
});

test('failed unpause keeps the persisted pause mapping intact', async () => {
  const { internals: helpers, chrome, getStore } = loadBackground();
  const key = helpers.keyForHost('example.com');
  const id = helpers.sitePauseRuleId('example.com');
  await chrome.storage.local.set({
    __pawsOff_allow_idmap: {
      pause: { [key]: id },
      pauseMeta: { [key]: { u: Date.now() + 10000, oh: 'h:12345678' } },
      domain: {},
    },
  });
  let absentDuringDnr = false;
  chrome.declarativeNetRequest.updateDynamicRules = (update) => {
    const removesPause = update.removeRuleIds && update.removeRuleIds.includes(id) && !update.addRules.length;
    if (removesPause) {
      const current = getStore().__pawsOff_allow_idmap;
      absentDuringDnr = current.pause[key] == null && current.pauseMeta[key] == null;
    }
    return removesPause ? Promise.reject(new Error('DNR unavailable')) : Promise.resolve();
  };
  const result = await helpers.handleAllowMessage({ op: 'unpauseSiteHash', siteHash: key });
  assert(!result.ok, 'unpause failure is surfaced');
  assert(absentDuringDnr, 'bookkeeping deletion is persisted before DNR removal');
  const stored = getStore().__pawsOff_allow_idmap;
  eq(stored.pause[key], id, 'rule id remains persisted for retry');
  assert(stored.pauseMeta[key], 'pause metadata remains persisted for retry');
});

test('DNR reconciliation advances its cursor to the query start time', async () => {
  let now = 100;
  class FakeDate extends Date {}
  FakeDate.now = () => now;
  const { internals: helpers, chrome } = loadBackground({ Date: FakeDate });
  let releaseQuery;
  let markQueryStarted;
  const queryStarted = new Promise((resolve) => { markQueryStarted = resolve; });
  chrome.declarativeNetRequest.getMatchedRules = () => new Promise((resolve) => {
    releaseQuery = resolve;
    markQueryStarted();
  });
  const pending = helpers.readNewDnrMatches();
  await queryStarted;
  now = 200;
  releaseQuery({ rulesMatchedInfo: [] });
  await pending;
  eq(helpers.getLastDnrPoll(), 100, 'matches arriving during the query remain in the next window');
});

test('DNR summaries retain the navigation epoch captured with each match', () => {
  const { internals: helpers } = loadBackground();
  const tabId = 17;
  const epoch = helpers.bumpTabEpoch(tabId, 100);
  const summary = helpers.summarizeDnrMatches([{
    tabId,
    timeStamp: 101,
    rule: { ruleId: 1, rulesetId: 'easyprivacy' },
  }]);
  const entry = summary.epByTab.get(tabId);
  eq(entry.epoch, epoch, 'summary owns the match-time epoch');
  helpers.bumpTabEpoch(tabId, 200);
  eq(entry.epoch, epoch, 'later navigation cannot relabel the queued match');
  assert(entry.ruleIds.has(1), 'rule id is retained beside its epoch');
});

// ── base64ToBytes ────────────────────────────────────────────────────────────
test('base64ToBytes: decodes to the exact byte sequence', () => {
  const bytes = base64ToBytes('AAEC/w==');
  eq(bytes.length, 4);
  eq(bytes[0], 0);
  eq(bytes[1], 1);
  eq(bytes[2], 2);
  eq(bytes[3], 255);
});

// ── small structural building blocks ─────────────────────────────────────────
test('isPlainObject / hasRequiredArrays / hasRequiredSections behave', () => {
  assert(isPlainObject({}), 'object is plain');
  assert(!isPlainObject(null), 'null is not');
  assert(!isPlainObject('x'), 'string is not');
  assert(hasRequiredArrays({ categories: [], patterns: [] }), 'both arrays present');
  assert(!hasRequiredArrays({ categories: [] }), 'missing patterns');
  assert(hasRequiredSections({ pageDetection: {}, segmentation: {}, negation: {}, scoring: {} }), 'all four sections');
  assert(!hasRequiredSections({ pageDetection: {}, segmentation: {}, negation: {} }), 'missing scoring');
});

test('namespace: VERSION is a dotted semver-ish string', () => {
  assert(typeof VERSION === 'string' && /^\d+\.\d+\.\d+$/.test(VERSION), 'semver-ish version');
});

// iCloud shipped in pixel-block.js PROVIDER_CONFIG and in the options toggle
// list, but was missing from the background PIXELBLOCK_PROVIDERS table, so its
// options toggle controlled nothing and iCloud got no network-tier blocking at
// all. The DOM tier and the network tier are independent: iframeLimited only
// means the content script cannot read the message body, it says nothing about
// whether DNR can block the request.
test('pixelblock: every DOM-tier provider also has a network-tier DNR rule', () => {
  const { loadPixelBlock } = require('./harness/sandbox');
  const pb = loadPixelBlock().internals || {};
  const domIds = (pb.PROVIDER_CONFIG || []).map((p) => p.id).sort();
  const dnrIds = (internals.PIXELBLOCK_PROVIDERS || []).map((p) => p.id).sort();
  assert(domIds.length > 0, 'PROVIDER_CONFIG is readable');
  const missing = domIds.filter((id) => dnrIds.indexOf(id) === -1);
  assert(missing.length === 0, 'providers with no DNR rule: ' + missing.join(', '));
  assert(dnrIds.indexOf('icloud') !== -1, 'iCloud has a network-tier rule');
});

test('pixelblock: DNR rule ids stay unique and inside the reserved band', () => {
  const providers = internals.PIXELBLOCK_PROVIDERS || [];
  const rules = providers.map(internals.buildProviderRule);
  const ids = rules.map((r) => r.id);
  eq(new Set(ids).size, ids.length, 'no two providers share a rule id');
  ids.forEach((id) => assert(internals.isValidRuleId(id), 'rule id ' + id + ' is inside the reserved band'));
  rules.forEach((r) => {
    eq(r.action.type, 'block');
    eq(r.condition.resourceTypes.join(','), 'image');
    assert(r.condition.initiatorDomains.length > 0, 'every rule is initiator-scoped, never global');
  });
});
