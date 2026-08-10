#!/usr/bin/env node
/* PawsOff — assemble an atomic, signed-config-ready release directory.
 *
 * The output keeps the legacy URLs used by Store version 0.1.0 while also
 * publishing content-addressed release files plus a small release-manifest.
 * The workflow signs every JSON file after this tool exits, and deploys the
 * complete directory atomically through Cloudflare Pages.
 *
 * Usage:
 *   node tools/build-release-manifest.mjs \
 *     --release-id 2026-07-14.123 --sequence 2026071400123 \
 *     --previous-sequence 2026071300999 \
 *     --generated-at 2026-07-14T05:00:00.000Z \
 *     --out publish
 *
 * Inputs are the deterministic artifacts under dist-lists/. Consent is
 * required; ToS reputation and EasyPrivacy delta are included when present.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { isSafeSelector: converterSelectorIsSafe } = require('./autoconsent-to-consent-rules.js');
const { MAX_RELEASE_HOSTS } = require('./tosdr-to-grades.js');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_SCHEMA_VERSION = 1;
const DEFAULT_TTL_DAYS = 7;
const RELEASE_ID_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,79}$/;
const RELEASE_CONFIG_VERSION_RE = /^(\d{14})(\.2)?$/;
const UTC_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SAFE_RESOURCE_TYPES = new Set(['ping', 'image', 'xmlhttprequest', 'script', 'stylesheet', 'font']);
const FEED_BYTE_LIMITS = Object.freeze({
  consentGhostV2: 1024 * 1024,
  consentGhost: 2 * 1024 * 1024,
  tosReputation: 4 * 1024 * 1024,
  easyPrivacyDelta: 1024 * 1024,
  tosPatterns: 512 * 1024,
  pixelBlock: 256 * 1024,
});

const FEEDS = [
  {
    key: 'consentGhostV2',
    required: true,
    input: 'dist-lists/consent-ghost/consent-config-v2.json',
    fileName: 'consent-config-v2.json',
    legacyPath: 'consent-ghost/consent-config-v2.json',
  },
  {
    key: 'consentGhost',
    required: true,
    input: 'dist-lists/consent-ghost/consent-config.json',
    fileName: 'consent-config.json',
    legacyPath: 'consent-ghost/consent-config.json',
  },
  {
    key: 'tosReputation',
    required: false,
    input: 'dist-lists/tos-shield/tosdr-grades.json',
    fileName: 'tosdr-grades.json',
    legacyPath: 'tos-shield/reputation.json',
  },
  {
    key: 'easyPrivacyDelta',
    required: false,
    input: 'dist-lists/easyprivacy-delta/domains.json',
    fileName: 'domains.json',
    legacyPath: 'easyprivacy-delta/domains.json',
  },
  {
    // legacyPath is the URL 0.1.0 has been fetching (and 404ing on) since launch.
    key: 'tosPatterns',
    required: false,
    input: 'dist-lists/tos-shield/patterns.json',
    fileName: 'patterns.json',
    legacyPath: 'tos-shield/patterns.json',
  },
  {
    key: 'pixelBlock',
    required: false,
    input: 'dist-lists/pixel-block/pixel-config.json',
    fileName: 'pixel-config.json',
    legacyPath: 'pixel-block/pixel-config.json',
  },
];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${arg}`);
    out[key] = value;
  }
  return out;
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasText(value, max) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function hasOnlyKeys(value, allowed) {
  if (!isRecord(value)) return false;
  return Object.keys(value).every((key) => allowed.has(key));
}

const CONSENT_FEED_KEYS = new Set([
  'schemaVersion', 'configVersion', 'source', 'sourceVersion', 'sourceUrl',
  'sourceLicense', 'attribution', 'frameworks',
]);
const CONSENT_V1_FRAMEWORK_KEYS = new Set(['name', 'containerSelector', 'rejectSelectors', 'pierceShadow', 'enabled']);
const CONSENT_V2_FRAMEWORK_KEYS = new Set(['name', 'enabled', 'pierceShadow', 'selectors']);
const CONSENT_V2_SELECTOR_KEYS = new Set(['containers', 'directReject', 'openPreferences', 'save', 'completion']);
const REPUTATION_FEED_KEYS = new Set([
  'schemaVersion', 'configVersion', 'source', 'sourceUrl', 'sourceLicense',
  'licenseUrl', 'attribution', 'modifications', 'services',
]);
const REPUTATION_ENTRY_KEYS = new Set(['name', 'grade', 'flagged']);
const REPUTATION_POINT_KEYS = new Set(['title', 'topic', 'severity']);
const DELTA_FEED_KEYS = new Set([
  'schemaVersion', 'configVersion', 'source', 'sourceVersion', 'sourceUrl',
  'sourceLicense', 'licenseUrl', 'attribution', 'modifications', 'domains',
]);
const DELTA_ITEM_KEYS = new Set(['domain', 'resourceTypes']);

function hasFeedMetadata(feed) {
  return [
    hasText(feed.configVersion, 80),
    hasText(feed.source, 80),
    hasText(feed.sourceLicense, 120),
    hasText(feed.attribution, 500),
  ].every(Boolean);
}

function isSafeSelector(value, max = 512) {
  return hasText(value, max) && converterSelectorIsSafe(value);
}

function isSelectorList(value, maxItems, { required = false } = {}) {
  if (!Array.isArray(value)) return false;
  if (value.length > maxItems) return false;
  if (required && !value.length) return false;
  return value.every((selector) => isSafeSelector(selector));
}

function optionalBoolean(value) {
  return value === undefined || typeof value === 'boolean';
}

function boundedNonEmptyArray(value, maxItems) {
  if (!Array.isArray(value)) return false;
  return value.length > 0 && value.length <= maxItems;
}

function validFeedEnvelope(feed, schemaVersion, source) {
  return [
    isRecord(feed),
    feed && feed.schemaVersion === schemaVersion,
    feed && feed.source === source,
    feed && hasFeedMetadata(feed),
  ].every(Boolean);
}

function validConsentV1Framework(framework) {
  return [
    isRecord(framework),
    hasOnlyKeys(framework, CONSENT_V1_FRAMEWORK_KEYS),
    framework && hasText(framework.name, 160),
    framework && isSafeSelector(framework.containerSelector, 4096),
    framework && isSelectorList(framework.rejectSelectors, 32, { required: true }),
    framework && optionalBoolean(framework.pierceShadow),
    framework && optionalBoolean(framework.enabled),
  ].every(Boolean);
}

function validateConsentV1(feed) {
  if (!validFeedEnvelope(feed, 1, 'autoconsent')) return false;
  if (!hasOnlyKeys(feed, CONSENT_FEED_KEYS)) return false;
  if (!boundedNonEmptyArray(feed.frameworks, 1200)) return false;
  return feed.frameworks.every(validConsentV1Framework);
}

function validConsentV2Selectors(selectors) {
  if (!isRecord(selectors)) return false;
  return [
    hasOnlyKeys(selectors, CONSENT_V2_SELECTOR_KEYS),
    isSelectorList(selectors.containers, 16, { required: true }),
    isSelectorList(selectors.directReject, 24, { required: true }),
    isSelectorList(selectors.openPreferences, 12),
    isSelectorList(selectors.completion, 16),
    Array.isArray(selectors.save),
    Array.isArray(selectors.save) && selectors.save.length === 0,
  ].every(Boolean);
}

function validConsentV2Framework(framework) {
  return [
    isRecord(framework),
    hasOnlyKeys(framework, CONSENT_V2_FRAMEWORK_KEYS),
    framework && hasText(framework.name, 160),
    framework && validConsentV2Selectors(framework.selectors),
    framework && optionalBoolean(framework.pierceShadow),
    framework && optionalBoolean(framework.enabled),
  ].every(Boolean);
}

function validateConsentV2(feed) {
  if (!validFeedEnvelope(feed, 2, 'autoconsent')) return false;
  if (!hasOnlyKeys(feed, CONSENT_FEED_KEYS)) return false;
  if (!boundedNonEmptyArray(feed.frameworks, 600)) return false;
  return feed.frameworks.every(validConsentV2Framework);
}

function validReputationPoint(point) {
  return [
    isRecord(point),
    hasOnlyKeys(point, REPUTATION_POINT_KEYS),
    point && hasText(point.title, 140),
    point && typeof point.topic === 'string',
    point && typeof point.topic === 'string' && point.topic.length <= 60,
    point && ['high', 'med'].includes(point.severity),
  ].every(Boolean);
}

function validReputationEntry(host, entry) {
  if (!DOMAIN_RE.test(host)) return false;
  if (!isRecord(entry)) return false;
  if (!hasOnlyKeys(entry, REPUTATION_ENTRY_KEYS)) return false;
  if (!hasText(entry.name, 160)) return false;
  if (entry.grade !== null && !/^[A-E]$/.test(entry.grade)) return false;
  if (!Array.isArray(entry.flagged)) return false;
  if (entry.flagged.length > 25) return false;
  return entry.flagged.every(validReputationPoint);
}

function validateTosReputation(feed) {
  if (!validFeedEnvelope(feed, 1, 'tosdr')) return false;
  if (!hasOnlyKeys(feed, REPUTATION_FEED_KEYS)) return false;
  if (!isRecord(feed.services)) return false;
  const hosts = Object.keys(feed.services);
  if (!boundedNonEmptyArray(hosts, MAX_RELEASE_HOSTS)) return false;
  return hosts.every((host) => validReputationEntry(host, feed.services[host]));
}

function validDeltaItem(item, seen) {
  if (!isRecord(item)) return false;
  if (!hasOnlyKeys(item, DELTA_ITEM_KEYS)) return false;
  if (!DOMAIN_RE.test(item.domain)) return false;
  if (seen.has(item.domain)) return false;
  seen.add(item.domain);
  if (!boundedNonEmptyArray(item.resourceTypes, SAFE_RESOURCE_TYPES.size)) return false;
  return item.resourceTypes.every((type) => SAFE_RESOURCE_TYPES.has(type));
}

function validateEasyPrivacyDelta(feed) {
  if (!validFeedEnvelope(feed, 1, 'easyprivacy')) return false;
  if (!hasOnlyKeys(feed, DELTA_FEED_KEYS)) return false;
  if (!hasText(feed.sourceVersion, 80)) return false;
  if (!Array.isArray(feed.domains)) return false;
  if (feed.domains.length > 2000) return false;
  const seen = new Set();
  return feed.domains.every((item) => validDeltaItem(item, seen));
}

// ── Bundled-source feeds (ToS clause vocabulary, PixelBlock selectors) ───────
// These are generated from our own shipping content scripts rather than an
// upstream project, but they get the identical treatment: strict key allowlist,
// bounded strings, no regex source anywhere. The extension compiles the term
// lists into regexes, so "literal strings only" is the property that keeps a
// poisoned feed from becoming a ReDoS bomb.
const TOS_PATTERNS_FEED_KEYS = new Set([
  'schemaVersion', 'configVersion', 'minEngineVersion', 'locale', 'source',
  'sourceUrl', 'sourceLicense', 'attribution', 'pageDetection', 'segmentation',
  'negation', 'scoring', 'categories', 'patterns',
]);
const TOS_CATEGORY_KEYS = new Set(['id', 'label', 'description', 'severity', 'defaultEnabled']);
const TOS_PATTERN_KEYS = new Set(['id', 'categoryId', 'enabled', 'weight', 'anchors', 'objects', 'modifiers']);
const TOS_SEVERITIES = new Set(['low', 'med', 'high']);
const PIXEL_FEED_KEYS = new Set([
  'schemaVersion', 'configVersion', 'source', 'sourceUrl', 'sourceLicense',
  'attribution', 'providers',
]);
const PIXEL_PROVIDER_KEYS = new Set(['id', 'emailBodySelectors', 'excludeSelectors', 'legitimateProxies']);
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** A vocabulary term: bounded literal text, never a regex source. */
function isVocabTerm(value) {
  return hasText(value, 200);
}

function isTermList(value, maxItems, { required = false } = {}) {
  if (!Array.isArray(value)) return false;
  if (value.length > maxItems) return false;
  if (required && !value.length) return false;
  return value.every(isVocabTerm);
}

/** Behavioural sections carry only bounded strings, finite numbers, term lists. */
function validTosSection(section) {
  if (!isRecord(section)) return false;
  return Object.values(section).every((value) => {
    if (Array.isArray(value)) return isTermList(value, 256);
    if (typeof value === 'number') return Number.isFinite(value);
    return isVocabTerm(value);
  });
}

function validTosCategory(category) {
  return [
    isRecord(category),
    category && hasOnlyKeys(category, TOS_CATEGORY_KEYS),
    category && hasText(category.id, 80),
    category && hasText(category.label, 200),
    category && typeof category.description === 'string' && category.description.length <= 400,
    category && TOS_SEVERITIES.has(category.severity),
    category && typeof category.defaultEnabled === 'boolean',
  ].every(Boolean);
}

function validTosPattern(pattern, categoryIds) {
  return [
    isRecord(pattern),
    pattern && hasOnlyKeys(pattern, TOS_PATTERN_KEYS),
    pattern && hasText(pattern.id, 120),
    pattern && categoryIds.has(pattern.categoryId),
    pattern && typeof pattern.enabled === 'boolean',
    pattern && Number.isFinite(pattern.weight) && pattern.weight > 0 && pattern.weight <= 10,
    pattern && isTermList(pattern.anchors, 256, { required: true }),
    pattern && isTermList(pattern.objects, 256, { required: true }),
    pattern && isTermList(pattern.modifiers, 256),
  ].every(Boolean);
}

function validateTosPatterns(feed) {
  if (!validFeedEnvelope(feed, 1, 'pawsoff-bundled')) return false;
  if (!hasOnlyKeys(feed, TOS_PATTERNS_FEED_KEYS)) return false;
  if (!hasText(feed.minEngineVersion, 32)) return false;
  if (!['pageDetection', 'segmentation', 'negation', 'scoring'].every((s) => validTosSection(feed[s]))) return false;
  if (!boundedNonEmptyArray(feed.categories, 64)) return false;
  if (!boundedNonEmptyArray(feed.patterns, 512)) return false;
  if (!feed.categories.every(validTosCategory)) return false;
  const categoryIds = new Set(feed.categories.map((c) => c.id));
  if (categoryIds.size !== feed.categories.length) return false;
  const patternIds = new Set(feed.patterns.map((p) => p && p.id));
  if (patternIds.size !== feed.patterns.length) return false;
  return feed.patterns.every((pattern) => validTosPattern(pattern, categoryIds));
}

function validPixelProvider(provider) {
  return [
    isRecord(provider),
    provider && hasOnlyKeys(provider, PIXEL_PROVIDER_KEYS),
    provider && typeof provider.id === 'string' && PROVIDER_ID_RE.test(provider.id),
    provider && isSelectorList(provider.emailBodySelectors, 32, { required: true }),
    provider && (provider.excludeSelectors === undefined || isSelectorList(provider.excludeSelectors, 32)),
    provider && (provider.legitimateProxies === undefined
      || (Array.isArray(provider.legitimateProxies)
        && provider.legitimateProxies.length <= 32
        && provider.legitimateProxies.every((host) => DOMAIN_RE.test(String(host).toLowerCase())))),
  ].every(Boolean);
}

function validatePixelBlock(feed) {
  if (!validFeedEnvelope(feed, 1, 'pawsoff-bundled')) return false;
  if (!hasOnlyKeys(feed, PIXEL_FEED_KEYS)) return false;
  if (!boundedNonEmptyArray(feed.providers, 64)) return false;
  const ids = new Set(feed.providers.map((p) => p && p.id));
  if (ids.size !== feed.providers.length) return false;
  return feed.providers.every(validPixelProvider);
}

const FEED_VALIDATORS = Object.freeze({
  consentGhostV2: validateConsentV2,
  consentGhost: validateConsentV1,
  tosReputation: validateTosReputation,
  easyPrivacyDelta: validateEasyPrivacyDelta,
  tosPatterns: validateTosPatterns,
  pixelBlock: validatePixelBlock,
});

function assertFeedSize(spec, bytes) {
  const maxBytes = Number(spec.maxBytes) || FEED_BYTE_LIMITS[spec.key];
  const valid = [Number.isSafeInteger(maxBytes), maxBytes > 0, bytes.length <= maxBytes].every(Boolean);
  if (!valid) {
    throw new Error(`${spec.input} exceeds its release size limit`);
  }
}

function validateFeed(spec, bytes, parsed) {
  assertFeedSize(spec, bytes);
  const validator = spec.validate || FEED_VALIDATORS[spec.key];
  if (typeof validator !== 'function') throw new Error(`no release validator for feed: ${spec.key}`);
  if (!validator(parsed)) throw new Error(`${spec.input} failed ${spec.key} schema validation`);
}

function validReleaseId(releaseId) {
  return RELEASE_ID_RE.test(String(releaseId || ''));
}

function positiveSequence(sequence) {
  const value = Number(sequence);
  if (![Number.isSafeInteger(value), value > 0].every(Boolean)) {
    throw new Error('--sequence must be a positive safe integer');
  }
  return value;
}

function previousSequenceValue(sequence) {
  const value = Number(sequence);
  if (![Number.isSafeInteger(value), value >= 0].every(Boolean)) {
    throw new Error('--previous-sequence must be a non-negative safe integer');
  }
  return value;
}

function validGeneratedDate(generatedAt) {
  if (!UTC_TIMESTAMP_RE.test(String(generatedAt || ''))) {
    throw new Error('--generated-at must be a canonical UTC timestamp');
  }
  const value = new Date(generatedAt);
  if (!Number.isFinite(value.getTime()) || value.toISOString() !== generatedAt) {
    throw new Error('--generated-at must be a canonical UTC timestamp');
  }
  return value;
}

function boundedTtlDays(ttlDays) {
  const value = Number(ttlDays == null ? DEFAULT_TTL_DAYS : ttlDays);
  if (![Number.isInteger(value), value >= 1, value <= 30].every(Boolean)) {
    throw new Error('--ttl-days must be between 1 and 30');
  }
  return value;
}

function assertReleaseInputs({ releaseId, sequence, previousSequence, generatedAt, ttlDays }) {
  if (!validReleaseId(releaseId)) throw new Error('invalid --release-id');
  const currentSequence = positiveSequence(sequence);
  const highWater = previousSequenceValue(previousSequence);
  if (currentSequence <= highWater) throw new Error('--sequence must exceed --previous-sequence');
  return {
    sequence: currentSequence,
    previousSequence: highWater,
    generated: validGeneratedDate(generatedAt),
    ttlDays: boundedTtlDays(ttlDays),
  };
}

function describeFeed(bytes, parsed, path) {
  return {
    path,
    signaturePath: `${path}.sig`,
    sha256: sha256Hex(bytes),
    bytes: bytes.length,
    configVersion: typeof parsed.configVersion === 'string' ? parsed.configVersion : null,
    source: typeof parsed.source === 'string' ? parsed.source : null,
    sourceVersion: typeof parsed.sourceVersion === 'string' ? parsed.sourceVersion : null,
    sourceLicense: typeof parsed.sourceLicense === 'string' ? parsed.sourceLicense : null,
    attribution: typeof parsed.attribution === 'string' ? parsed.attribution : null,
  };
}

function ensureFreshOutput(outputDir) {
  if (!existsSync(outputDir)) return;
  if (readdirSync(outputDir).length) throw new Error(`release output must be empty: ${outputDir}`);
}

function parseFeedJson(spec, bytes) {
  try { return JSON.parse(bytes); }
  catch (error) { throw new Error(`${spec.input} is not valid JSON: ${error.message}`); }
}

function prepareFeed(spec, inputRoot) {
  const inputPath = resolve(inputRoot, spec.input);
  if (!existsSync(inputPath)) {
    if (spec.required) throw new Error(`missing required feed: ${spec.input}`);
    return null;
  }
  const bytes = readFileSync(inputPath);
  assertFeedSize(spec, bytes);
  const parsed = parseFeedJson(spec, bytes);
  validateFeed(spec, bytes, parsed);
  return { spec, bytes, parsed };
}

function prepareFeeds(feedSpecs, inputRoot) {
  return feedSpecs.map((spec) => prepareFeed(spec, inputRoot)).filter(Boolean);
}

function feedConfigVersionBase(item) {
  const version = item && item.parsed && item.parsed.configVersion;
  const match = RELEASE_CONFIG_VERSION_RE.exec(String(version || ''));
  const expectsV2Suffix = item && item.spec && item.spec.key === 'consentGhostV2';
  if (!match || Boolean(match[2]) !== expectsV2Suffix) {
    throw new Error(`${item.spec.input} has an invalid release configVersion`);
  }
  return match[1];
}

function assertConsistentConfigVersions(prepared) {
  let common = null;
  for (const item of prepared) {
    const base = feedConfigVersionBase(item);
    if (common !== null && base !== common) {
      throw new Error('release feeds do not share one configVersion');
    }
    common = base;
  }
  return common;
}

function writePreparedFeed(item, context) {
  const { spec, bytes, parsed } = item;
  const releasePath = join(context.releaseDir, spec.fileName);
  const legacyPath = join(context.outputDir, spec.legacyPath);
  mkdirSync(dirname(legacyPath), { recursive: true });
  writeFileSync(releasePath, bytes);
  writeFileSync(legacyPath, bytes);
  context.feeds[spec.key] = describeFeed(
    bytes,
    parsed,
    `/releases/${context.releaseId}/${basename(releasePath)}`,
  );
}

function writePreparedFeeds(prepared, outputDir, releaseId) {
  const releaseDir = join(outputDir, 'releases', releaseId);
  mkdirSync(releaseDir, { recursive: true });
  const context = { feeds: {}, outputDir, releaseDir, releaseId };
  prepared.forEach((item) => writePreparedFeed(item, context));
  return context.feeds;
}

function releaseManifest(options, checked, feeds) {
  const expires = new Date(checked.generated.getTime() + checked.ttlDays * 86400000);
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    sequence: checked.sequence,
    releaseId: options.releaseId,
    generatedAt: checked.generated.toISOString(),
    expiresAt: expires.toISOString(),
    minimumEngineVersion: '1.0.0',
    feeds,
  };
}

function buildRelease(options) {
  const checked = assertReleaseInputs(options);
  const inputRoot = resolve(options.root || ROOT);
  const feedSpecs = options.feeds || FEEDS;
  const outputDir = resolve(options.out || join(inputRoot, 'publish'));
  ensureFreshOutput(outputDir);
  const prepared = prepareFeeds(feedSpecs, inputRoot);
  assertConsistentConfigVersions(prepared);
  const feeds = writePreparedFeeds(prepared, outputDir, options.releaseId);
  const manifest = releaseManifest(options, checked, feeds);
  const manifestPath = join(outputDir, 'release-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return { manifest, manifestPath, outputDir };
}

function isMain() {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch (_) { return false; }
}

if (isMain()) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = buildRelease(args);
    process.stderr.write(
      `built ${result.manifestPath} (${Object.keys(result.manifest.feeds).length} feeds, release ${result.manifest.releaseId})\n`,
    );
  } catch (error) {
    process.stderr.write(`error: ${error && error.message}\n`);
    process.exit(1);
  }
}

export {
  FEEDS,
  FEED_BYTE_LIMITS,
  MANIFEST_SCHEMA_VERSION,
  assertConsistentConfigVersions,
  assertReleaseInputs,
  buildRelease,
  describeFeed,
  parseArgs,
  sha256Hex,
  validateFeed,
};
