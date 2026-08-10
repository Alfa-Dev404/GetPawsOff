'use strict';
/* PawsOff — tests for the two bundled-source feed builders.
 *
 * These two feeds are different from the upstream converters: their input is our
 * own shipping content script, so the thing that actually breaks in production
 * is not a parsing bug, it is DRIFT. Someone edits DEFAULT_CONFIG or
 * PROVIDER_CONFIG, the generated feed no longer satisfies the validator the
 * extension applies before adopting it, and every client silently keeps its
 * bundled copy while CI stays green and the file publishes fine.
 *
 * So the load-bearing tests here are the round-trips: build from the REAL
 * bundled data, then push the output through both gates it has to survive, the
 * release-manifest validator at publish time and the extension's own
 * validateConfig at adopt time.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, assert, eq } = require('./harness/framework');
const { loadTosShield, loadPixelBlock } = require('./harness/sandbox');
const tosPatterns = require('../tools/tos-shield-to-patterns.js');
const pixelBlock = require('../tools/pixelblock-to-config.js');

const RELEASE_VERSION = '20260715000000';

/**
 * The two new feeds AS THE REAL REGISTRY DECLARES THEM. Taken from FEEDS rather
 * than copied, so a path or filename edit in the builder cannot pass a test that
 * quietly kept testing the old value. Marked required so the release fails loudly
 * if either input is missing; the network-built consent feeds are left out
 * because this test builds a release from these two alone.
 */
async function bundledFeedSpecs() {
  const { FEEDS } = await api();
  const keys = new Set(['tosPatterns', 'pixelBlock']);
  const specs = FEEDS.filter((feed) => keys.has(feed.key)).map((feed) => ({ ...feed, required: true }));
  if (specs.length !== keys.size) throw new Error('bundled feeds are not registered in FEEDS');
  return specs;
}

let releaseModule;
async function api() {
  if (!releaseModule) releaseModule = await import('../tools/build-release-manifest.mjs');
  return releaseModule;
}

const tosShield = loadTosShield().internals;
const pixelInternals = loadPixelBlock().internals;
const BUNDLED_TOS = tosShield.DEFAULT_CONFIG;
const BUNDLED_PROVIDERS = pixelInternals.PROVIDER_CONFIG;

function buildTos(overrides) {
  const input = { ...BUNDLED_TOS, ...(overrides || {}) };
  return tosPatterns.convert(input, { configVersion: RELEASE_VERSION });
}

function rejects(fn, why) {
  let threw = false;
  try { fn(); } catch (_) { threw = true; }
  assert(threw, why);
}

// ── ToS Shield clause vocabulary ─────────────────────────────────────────────

test('tos patterns: the real bundled vocabulary converts and keeps every category', () => {
  const { config, stats } = buildTos();
  eq(config.schemaVersion, 1);
  eq(config.configVersion, RELEASE_VERSION);
  eq(config.source, 'pawsoff-bundled');
  eq(config.categories.length, BUNDLED_TOS.categories.length);
  eq(config.patterns.length, BUNDLED_TOS.patterns.length);
  assert(stats.terms > 100, 'vocabulary carries a meaningful number of terms');
  // minEngineVersion has to survive, or clients gate themselves out.
  eq(config.minEngineVersion, BUNDLED_TOS.minEngineVersion);
});

test('tos patterns: generated feed passes the extension\'s own validateConfig', () => {
  const { config } = buildTos();
  assert(tosShield.validateConfig(config), 'tos-shield.js would adopt the generated feed');
  // compileConfig is what actually runs against it. If the shape is wrong this
  // throws, which is the failure mode a pure schema check would miss.
  tosShield.compileConfig(config);
});

test('tos patterns: generated feed passes the release-manifest validator', async () => {
  const { validateFeed } = await api();
  const { config } = buildTos();
  const bytes = Buffer.from(JSON.stringify(config, null, 2));
  validateFeed({ key: 'tosPatterns', input: 'dist-lists/tos-shield/patterns.json' }, bytes, config);
});

test('tos patterns: drift in the bundled config fails the build, not the client', () => {
  rejects(() => buildTos({ schemaVersion: 2 }), 'unknown schemaVersion rejected');
  rejects(() => buildTos({ categories: [] }), 'empty categories rejected');
  rejects(() => buildTos({ patterns: [] }), 'empty patterns rejected');
  rejects(() => buildTos({ scoring: undefined }), 'missing behavioural section rejected');
  rejects(
    () => buildTos({ patterns: BUNDLED_TOS.patterns.concat([BUNDLED_TOS.patterns[0]]) }),
    'duplicate pattern id rejected',
  );
  rejects(
    () => buildTos({ patterns: [{ ...BUNDLED_TOS.patterns[0], categoryId: 'no_such_category' }] }),
    'pattern pointing at a missing category rejected',
  );
  rejects(
    () => buildTos({ patterns: [{ ...BUNDLED_TOS.patterns[0], anchors: [] }] }),
    'pattern that can never fire rejected',
  );
});

test('tos patterns: a category with no enabled pattern fails the build', () => {
  // An enabled category nothing can match renders a dead filter in the popup.
  const patterns = BUNDLED_TOS.patterns.filter((p) => p.categoryId !== 'data_sale');
  rejects(() => buildTos({ patterns }), 'orphaned category rejected');
});

test('tos patterns: term lists dedupe before they cap', () => {
  const terms = tosPatterns.cleanTerms(['Sell', 'sell', ' SELL ', 'rent', '', '   ']);
  eq(terms.length, 2);
  eq(terms[0], 'Sell');
  eq(terms[1], 'rent');
  // Padding with duplicates must not push real terms past the limit.
  const padded = new Array(tosPatterns.MAX_TERMS_PER_LIST + 50).fill('same').concat(['unique']);
  const cleaned = tosPatterns.cleanTerms(padded);
  eq(cleaned.length, 2);
  assert(cleaned.includes('unique'), 'the real term survived the padding');
});

// ── PixelBlock provider selectors ────────────────────────────────────────────

const SCANNABLE = BUNDLED_PROVIDERS.filter((p) => p.iframeLimited !== true);

test('pixelblock: the real bundled provider table converts', () => {
  const { config, stats } = pixelBlock.convert(BUNDLED_PROVIDERS, { configVersion: RELEASE_VERSION });
  eq(config.schemaVersion, 1);
  eq(config.configVersion, RELEASE_VERSION);
  eq(config.providers.length, SCANNABLE.length);
  assert(stats.selectors > 0, 'selectors were published');
});

test('pixelblock: iframe-limited providers are skipped, not published', () => {
  // iCloud ships empty selectors on purpose (cross-origin sandboxed iframe).
  // Publishing it would be dead weight the overlay ignores; erroring on it
  // would block the whole feed over a documented limitation.
  const limited = BUNDLED_PROVIDERS.filter((p) => p.iframeLimited === true);
  assert(limited.length > 0, 'the bundled table still has an iframe-limited provider to cover');
  const { config } = pixelBlock.convert(BUNDLED_PROVIDERS, { configVersion: RELEASE_VERSION });
  const published = new Set(config.providers.map((p) => p.id));
  for (const provider of limited) {
    assert(!published.has(provider.id), `${provider.id} stayed out of the feed`);
  }
  // But an empty selector list WITHOUT that flag is real drift and must fail.
  rejects(
    () => pixelBlock.convert([{ ...SCANNABLE[0], emailBodySelectors: [] }], { configVersion: RELEASE_VERSION }),
    'unflagged provider with no selectors rejected',
  );
});

test('pixelblock: only the three fields the shipped overlay reads are published', () => {
  const { config } = pixelBlock.convert(BUNDLED_PROVIDERS, { configVersion: RELEASE_VERSION });
  const allowed = new Set(['id'].concat(pixelBlock.OVERLAY_FIELDS));
  for (const provider of config.providers) {
    for (const key of Object.keys(provider)) {
      assert(allowed.has(key), `provider ${provider.id} published unread field ${key}`);
    }
  }
  // hosts/nativeProtection drive local detection and must never be published.
  const raw = JSON.stringify(config);
  assert(!raw.includes('nativeProtection'), 'nativeProtection stayed bundled');
  assert(!raw.includes('"hosts"'), 'host list stayed bundled');
});

test('pixelblock: every published id exists locally, or the overlay drops it', () => {
  const { config } = pixelBlock.convert(BUNDLED_PROVIDERS, { configVersion: RELEASE_VERSION });
  const localIds = new Set(BUNDLED_PROVIDERS.map((p) => p.id));
  for (const provider of config.providers) {
    assert(localIds.has(provider.id), `published id ${provider.id} has no local provider to overlay`);
  }
});

test('pixelblock: empty lists are omitted so the overlay cannot be fooled', () => {
  // loadRemoteProviderConfig() ignores empty arrays, so publishing one is dead
  // weight that also implies a clear this feed cannot actually perform.
  const { config } = pixelBlock.convert(BUNDLED_PROVIDERS, { configVersion: RELEASE_VERSION });
  for (const provider of config.providers) {
    for (const field of pixelBlock.OVERLAY_FIELDS) {
      if (provider[field] !== undefined) {
        assert(provider[field].length > 0, `${provider.id}.${field} is present but empty`);
      }
    }
  }
});

test('pixelblock: generated feed passes the release-manifest validator', async () => {
  const { validateFeed } = await api();
  const { config } = pixelBlock.convert(BUNDLED_PROVIDERS, { configVersion: RELEASE_VERSION });
  const bytes = Buffer.from(JSON.stringify(config, null, 2));
  validateFeed({ key: 'pixelBlock', input: 'dist-lists/pixel-block/pixel-config.json' }, bytes, config);
});

test('pixelblock: unusable bundled entries fail the build', () => {
  const good = BUNDLED_PROVIDERS[0];
  const convert = (providers) => pixelBlock.convert(providers, { configVersion: RELEASE_VERSION });
  rejects(() => convert([{ ...good, id: 'Bad Id' }]), 'malformed provider id rejected');
  rejects(() => convert([{ ...good, emailBodySelectors: [] }]), 'provider with no body selector rejected');
  rejects(() => convert([{ ...good, emailBodySelectors: ['{evil}'] }]), 'unsafe selector rejected');
  rejects(() => convert([{ ...good, legitimateProxies: ['not a host'] }]), 'non-host proxy rejected');
  rejects(() => convert([good, { ...good }]), 'duplicate provider id rejected');
  rejects(() => convert([]), 'empty provider table rejected');
});

test('pixelblock: proxy hosts are hostnames, never selectors', () => {
  assert(pixelBlock.isProxyHost('ci3.googleusercontent.com'), 'real proxy host accepted');
  assert(!pixelBlock.isProxyHost('.some-class'), 'CSS class rejected as a proxy host');
  assert(!pixelBlock.isProxyHost('localhost'), 'bare label rejected');
});

// ── Both feeds share the release's canonical configVersion ───────────────────

test('bundled feeds: a release writes exactly the URLs 0.1.0 has been 404ing on', async () => {
  const { buildRelease } = await api();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pawsoff-bundled-'));
  const write = (rel, config) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const bytes = Buffer.from(JSON.stringify(config, null, 2));
    fs.writeFileSync(abs, bytes);
    return bytes;
  };

  const tosBytes = write('dist-lists/tos-shield/patterns.json', buildTos().config);
  const pixelBytes = write(
    'dist-lists/pixel-block/pixel-config.json',
    pixelBlock.convert(BUNDLED_PROVIDERS, { configVersion: RELEASE_VERSION }).config,
  );

  const out = path.join(root, 'publish');
  const result = buildRelease({
    root,
    out,
    releaseId: '2026-07-15.1',
    sequence: 2026071500001,
    previousSequence: 2026071400001,
    generatedAt: '2026-07-15T05:00:00.000Z',
    ttlDays: 7,
    feeds: await bundledFeedSpecs(),
  });

  // These two paths are the whole point of the change: background.js has been
  // requesting them on every daily refresh since launch and getting a 404.
  const tosLegacy = path.join(out, 'tos-shield/patterns.json');
  const pixelLegacy = path.join(out, 'pixel-block/pixel-config.json');
  assert(fs.existsSync(tosLegacy), 'CONFIG_URL now resolves');
  assert(fs.existsSync(pixelLegacy), 'PB_CONFIG_URL now resolves');
  eq(fs.readFileSync(tosLegacy).toString(), tosBytes.toString(), 'legacy ToS copy is byte-identical');
  eq(fs.readFileSync(pixelLegacy).toString(), pixelBytes.toString(), 'legacy PixelBlock copy is byte-identical');

  // And the immutable copies the manifest points at must match those bytes too.
  for (const [key, bytes] of [['tosPatterns', tosBytes], ['pixelBlock', pixelBytes]]) {
    const desc = result.manifest.feeds[key];
    assert(desc, `${key} is described by the manifest`);
    eq(desc.bytes, bytes.length);
    eq(fs.readFileSync(path.join(out, desc.path)).toString(), bytes.toString(), `${key} immutable copy exact`);
  }
});

test('bundled feeds: configVersion is the plain 14-digit release version', async () => {
  const { assertConsistentConfigVersions } = await api();
  const tos = buildTos().config;
  const pixel = pixelBlock.convert(BUNDLED_PROVIDERS, { configVersion: RELEASE_VERSION }).config;
  assertConsistentConfigVersions([
    { spec: { key: 'tosPatterns', input: 'a' }, parsed: tos },
    { spec: { key: 'pixelBlock', input: 'b' }, parsed: pixel },
  ]);
  rejects(
    () => tosPatterns.convert(BUNDLED_TOS, { configVersion: '' }),
    'missing configVersion rejected',
  );
});
