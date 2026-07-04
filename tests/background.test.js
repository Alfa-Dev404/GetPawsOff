/* PawsOff - Tier-1 unit tests for the background service worker.
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
  validateConsentConfig,
  validatePixelBlockConfig,
  canVerifySignatures,
  PINNED_PUBLIC_KEY_JWK,
  shouldAdoptConfig,
  bothResponsesOk,
  DNR_RULE_ID_BASE,
  DNR_ID_MIN,
  DNR_ID_MAX,
  TRACKING_DOMAINS,
  PIXELBLOCK_PROVIDERS,
  VERSION,
} = internals;

test('background: the guarded test hook exposes the pure helpers', () => {
  assert(internals && typeof internals === 'object', 'internals object exposed');
  ['compareVersions', 'base64ToBytes', 'buildProviderRule', 'isValidRuleId', 'sanitizeRules', 'validateConfig'].forEach((k) => {
    assert(typeof internals[k] === 'function', k + ' is a function');
  });
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

// ── shouldAdoptConfig (anti-rollback policy on top of compareVersions) ───────
test('shouldAdoptConfig: adopts when forced, uncached, or strictly newer', () => {
  assert(shouldAdoptConfig(true, { configVersion: '9.9.9' }, { configVersion: '1.0.0' }), 'force always adopts');
  assert(shouldAdoptConfig(false, null, { configVersion: '1.0.0' }), 'uncached adopts');
  assert(shouldAdoptConfig(false, { configVersion: '1.0.0' }, { configVersion: '1.0.1' }), 'newer adopts');
});

test('shouldAdoptConfig: refuses same or older config (no silent downgrade)', () => {
  assert(!shouldAdoptConfig(false, { configVersion: '1.0.0' }, { configVersion: '1.0.0' }), 'same not adopted');
  assert(!shouldAdoptConfig(false, { configVersion: '2.0.0' }, { configVersion: '1.9.9' }), 'older not adopted (anti-rollback)');
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

// ── sanitizeRules - the security-critical defensive layer ────────────────────
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
test('validateConfig (ToS): accepts a well-formed config', () => {
  const good = { schemaVersion: 1, configVersion: '1.0.0', categories: [], patterns: [], pageDetection: {}, segmentation: {}, negation: {}, scoring: {} };
  assert(validateConfig(good), 'valid ToS config accepted');
});

test('validateConfig (ToS): rejects wrong schema, missing arrays / sections / version', () => {
  assert(!validateConfig(null), 'null rejected');
  assert(!validateConfig({ schemaVersion: 2, configVersion: '1', categories: [], patterns: [], pageDetection: {}, segmentation: {}, negation: {}, scoring: {} }), 'wrong schemaVersion rejected');
  assert(!validateConfig({ schemaVersion: 1, configVersion: '1', categories: [], pageDetection: {}, segmentation: {}, negation: {}, scoring: {} }), 'missing patterns array rejected');
  assert(!validateConfig({ schemaVersion: 1, configVersion: '1', categories: [], patterns: [] }), 'missing sections rejected');
  assert(!validateConfig({ schemaVersion: 1, configVersion: 7, categories: [], patterns: [], pageDetection: {}, segmentation: {}, negation: {}, scoring: {} }), 'non-string configVersion rejected');
});

// ── validateConsentConfig ────────────────────────────────────────────────────
test('validateConsentConfig: needs schema + string version + non-empty frameworks', () => {
  assert(validateConsentConfig({ schemaVersion: 1, configVersion: '1.0.0', frameworks: [{}] }), 'valid consent config');
  assert(!validateConsentConfig({ schemaVersion: 1, configVersion: '1.0.0', frameworks: [] }), 'empty frameworks rejected');
  assert(!validateConsentConfig({ schemaVersion: 1, configVersion: '1.0.0' }), 'missing frameworks rejected');
  assert(!validateConsentConfig({ schemaVersion: 9, configVersion: '1', frameworks: [{}] }), 'wrong schema rejected');
});

// ── validatePixelBlockConfig ─────────────────────────────────────────────────
test('validatePixelBlockConfig: needs schema + string version + providers array', () => {
  assert(validatePixelBlockConfig({ schemaVersion: 1, configVersion: '1.0.0', providers: [] }), 'valid (empty providers) ok');
  assert(!validatePixelBlockConfig({ schemaVersion: 1, configVersion: '1.0.0', providers: {} }), 'providers must be an array');
  assert(!validatePixelBlockConfig({ schemaVersion: 1, configVersion: 5, providers: [] }), 'non-string version rejected');
});

// ── canVerifySignatures - requires BOTH a pinned key AND a WebCrypto impl ─────
// Sandbox omits self.crypto.subtle on purpose, to keep exercising the
// fail-closed path even with the key pinned.
test('canVerifySignatures: false without a WebCrypto implementation (fail-closed)', () => {
  eq(canVerifySignatures(), false, 'no remote config is trusted without self.crypto.subtle');
});

// ── PINNED_PUBLIC_KEY_JWK - must stay a well-formed P-256 JWK, never null ─────
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
  assert(bothResponsesOk({ ok: true }, { ok: true }), 'both ok');
  assert(!bothResponsesOk({ ok: false }, { ok: true }), 'config not ok');
  assert(!bothResponsesOk({ ok: true }, null), 'sig missing');
  assert(!bothResponsesOk(null, null), 'both missing');
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
