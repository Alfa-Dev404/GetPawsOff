'use strict';

const { webcrypto } = require('node:crypto');
const { test, assert, eq } = require('./harness/framework');
const SignedFeed = require('../src/background/release-feed.js');

function manifest(overrides) {
  const base = {
    schemaVersion: 1,
    sequence: 20260714001,
    releaseId: '2026-07-14.1',
    generatedAt: '2026-07-14T05:00:00.000Z',
    expiresAt: '2026-07-21T05:00:00.000Z',
    minimumEngineVersion: '1.0.0',
    feeds: {
      consentGhost: {
        path: '/releases/2026-07-14.1/consent-config.json',
        signaturePath: '/releases/2026-07-14.1/consent-config.json.sig',
        sha256: 'a'.repeat(64),
        bytes: 42,
        configVersion: '20260714000000',
      },
    },
  };
  return Object.assign(base, overrides || {});
}

test('signed feed: accepts a current, compatible, immutable release manifest', () => {
  assert(SignedFeed.validateManifest(manifest(), {
    nowMs: Date.parse('2026-07-15T00:00:00Z'),
    currentVersion: '1.0.0',
  }));
});

test('signed feed: timestamps require an explicit UTC offset', () => {
  const options = {
    nowMs: Date.parse('2026-07-15T00:00:00Z'),
    currentVersion: '1.0.0',
  };
  assert(!SignedFeed.validateManifest(manifest({
    generatedAt: '2026-07-14T05:00:00',
  }), options), 'offsetless generatedAt rejected');
  assert(!SignedFeed.validateManifest(manifest({
    expiresAt: '2026-07-21T05:00:00',
  }), options), 'offsetless expiresAt rejected');
  assert(SignedFeed.validateManifest(manifest({
    generatedAt: '2026-07-14T10:30:00+05:30',
    expiresAt: '2026-07-21T10:30:00+05:30',
  }), options), 'numeric UTC offsets accepted');
});

test('signed feed: rejects expiry, incompatible engines, traversal, and unsigned paths', () => {
  assert(!SignedFeed.validateManifest(manifest(), {
    nowMs: Date.parse('2026-07-22T00:00:00Z'), currentVersion: '1.0.0',
  }), 'expired release rejected');
  assert(!SignedFeed.validateManifest(manifest({ minimumEngineVersion: '2.0.0' }), {
    nowMs: Date.parse('2026-07-15T00:00:00Z'), currentVersion: '1.0.0',
  }), 'newer engine requirement rejected');

  const traversal = manifest();
  traversal.feeds.consentGhost.path = '/releases/2026-07-14.1/../evil.json';
  traversal.feeds.consentGhost.signaturePath = traversal.feeds.consentGhost.path + '.sig';
  assert(!SignedFeed.validateManifest(traversal, {
    nowMs: Date.parse('2026-07-15T00:00:00Z'), currentVersion: '1.0.0',
  }), 'path traversal rejected');

  const mismatchedSignature = manifest();
  mismatchedSignature.feeds.consentGhost.signaturePath = '/releases/2026-07-14.1/other.sig';
  assert(!SignedFeed.validateManifest(mismatchedSignature, {
    nowMs: Date.parse('2026-07-15T00:00:00Z'), currentVersion: '1.0.0',
  }), 'signature must belong to the immutable feed');
});

test('signed feed: manifest and descriptors reject unknown fields', () => {
  assert(!SignedFeed.validateManifest(manifest({ action: 'execute' }), {
    nowMs: Date.parse('2026-07-15T00:00:00Z'),
    currentVersion: '1.0.0',
  }), 'unknown manifest field rejected');
  const candidate = manifest();
  candidate.feeds.consentGhost.action = 'execute';
  assert(!SignedFeed.validateManifest(candidate, {
    nowMs: Date.parse('2026-07-15T00:00:00Z'),
    currentVersion: '1.0.0',
  }), 'unknown descriptor field rejected');
  const missing = manifest();
  delete missing.generatedAt;
  assert(!SignedFeed.validateManifest(missing, {
    nowMs: Date.parse('2026-07-15T00:00:00Z'),
    currentVersion: '1.0.0',
  }), 'missing manifest field rejected');
});

test('signed feed: descriptor size, digest, path, and version boundaries fail closed', () => {
  const base = manifest().feeds.consentGhost;
  assert(SignedFeed.validateDescriptor(base, '2026-07-14.1'), 'valid descriptor accepted');
  const invalid = [
    { ...base, bytes: 0 },
    { ...base, bytes: SignedFeed.MAX_FEED_BYTES + 1 },
    { ...base, sha256: 'g'.repeat(64) },
    { ...base, path: '/releases/other/feed.json', signaturePath: '/releases/other/feed.json.sig' },
    { ...base, configVersion: 'future' },
  ];
  for (const descriptor of invalid) {
    assert(!SignedFeed.validateDescriptor(descriptor, '2026-07-14.1'), 'invalid descriptor rejected');
  }
});

test('signed feed: future timestamps are limited to the clock-skew allowance', () => {
  const nowMs = Date.parse('2026-07-15T00:00:00Z');
  assert(SignedFeed.validateManifest(manifest({
    generatedAt: '2026-07-15T00:10:00Z',
    expiresAt: '2026-07-16T00:00:00Z',
  }), { nowMs, currentVersion: '1.0.0' }), 'exact skew boundary accepted');
  assert(!SignedFeed.validateManifest(manifest({
    generatedAt: '2026-07-15T00:10:00.001Z',
    expiresAt: '2026-07-16T00:00:00Z',
  }), { nowMs, currentVersion: '1.0.0' }), 'timestamp beyond skew boundary rejected');
});

test('signed feed: feed keys and feed count are bounded', () => {
  const unsafeKey = manifest();
  unsafeKey.feeds['../consent'] = unsafeKey.feeds.consentGhost;
  delete unsafeKey.feeds.consentGhost;
  assert(!SignedFeed.validateManifest(unsafeKey, {
    nowMs: Date.parse('2026-07-15T00:00:00Z'),
    currentVersion: '1.0.0',
  }), 'unsafe feed key rejected');

  const tooMany = manifest();
  tooMany.feeds = {};
  for (let i = 0; i <= SignedFeed.MAX_FEEDS; i += 1) {
    tooMany.feeds['feed' + i] = {
      path: `/releases/${tooMany.releaseId}/feed${i}.json`,
      signaturePath: `/releases/${tooMany.releaseId}/feed${i}.json.sig`,
      sha256: 'a'.repeat(64),
      bytes: 1,
      configVersion: '1.0.0',
    };
  }
  assert(!SignedFeed.validateManifest(tooMany, {
    nowMs: Date.parse('2026-07-15T00:00:00Z'),
    currentVersion: '1.0.0',
  }), 'feed count cap enforced');
});

test('signed feed: versions are canonical dotted integers', () => {
  eq(SignedFeed.compareVersions('1.2.0', '1.10.0'), -1);
  eq(SignedFeed.compareVersions('1.0', '1.0.0'), 0);
  for (const value of ['v1.0.0', '1.0.0-beta', 'x1.0', '01.0', '1..0', '']) {
    eq(SignedFeed.compareVersions(value, '1.0.0'), null, `malformed version rejected: ${value}`);
  }
  assert(!SignedFeed.validateManifest(manifest({ minimumEngineVersion: 'v1.0.0' }), {
    nowMs: Date.parse('2026-07-15T00:00:00Z'),
    currentVersion: '1.0.0',
  }), 'malformed engine version rejected');
  const malformedDescriptor = manifest();
  malformedDescriptor.feeds.consentGhost.configVersion = '2026-07-14';
  assert(!SignedFeed.validateManifest(malformedDescriptor, {
    nowMs: Date.parse('2026-07-15T00:00:00Z'),
    currentVersion: '1.0.0',
  }), 'malformed feed version rejected');
});

test('signed feed: resolves only same-origin HTTPS release paths', () => {
  const base = 'https://config.getpawsoff.app/release-manifest.json';
  eq(
    SignedFeed.resolveReleaseUrl(base, '/releases/r1/feed.json'),
    'https://config.getpawsoff.app/releases/r1/feed.json',
  );
  eq(SignedFeed.resolveReleaseUrl('http://config.getpawsoff.app/release-manifest.json', '/releases/r1/feed.json'), null);
  eq(SignedFeed.resolveReleaseUrl('https://evil.example/release-manifest.json', '/releases/r1/feed.json'), null);
  eq(SignedFeed.resolveReleaseUrl(base, '//evil.example/releases/r1/feed.json'), null);
});

test('signed feed: verifies exact UTF-8 bytes and SHA-256 digest', async () => {
  const raw = '{"schemaVersion":1,"configVersion":"20260714000000"}\n';
  const bytes = new TextEncoder().encode(raw);
  const digest = await webcrypto.subtle.digest('SHA-256', bytes);
  const sha256 = Buffer.from(digest).toString('hex');
  const descriptor = {
    path: '/releases/r1/feed.json',
    signaturePath: '/releases/r1/feed.json.sig',
    sha256,
    bytes: bytes.length,
    configVersion: '20260714000000',
  };
  assert(await SignedFeed.verifyFeedText(raw, descriptor, webcrypto), 'exact payload accepted');
  assert(!(await SignedFeed.verifyFeedText(raw + ' ', descriptor, webcrypto)), 'byte change rejected');
  assert(!(await SignedFeed.verifyFeedText(raw, { ...descriptor, sha256: '0'.repeat(64) }, webcrypto)), 'same-length digest mismatch rejected');
});

test('signed feed: sequence high-water mark prevents rollback and replay', () => {
  assert(SignedFeed.shouldAdoptManifest(40, { sequence: 41 }), 'new sequence accepted');
  assert(!SignedFeed.shouldAdoptManifest(40, { sequence: 40 }), 'replay rejected');
  assert(!SignedFeed.shouldAdoptManifest(40, { sequence: 39 }), 'rollback rejected');
  [undefined, null, '40', -1, Number.MAX_SAFE_INTEGER + 1].forEach((value) => {
    assert(!SignedFeed.shouldAdoptManifest(value, { sequence: 41 }), 'corrupt high-water state fails closed');
  });
});

test('signed client refuses cached manifests not linked to their high-water mark', async () => {
  const { root } = require('./harness/sandbox').loadBackground();
  const candidate = manifest();
  const client = root.PawsOffSignedConfigClient.create({
    signedFeed: SignedFeed,
    currentVersion: '1.0.0',
    manifestCacheKey: 'manifest',
    sequenceKey: 'sequence',
    storage: {
      get: () => Promise.resolve({ manifest: candidate, sequence: candidate.sequence - 1 }),
    },
  });
  const state = await client.getStoredReleaseState();
  eq(state.manifest, null);
  eq(state.sequence, candidate.sequence - 1);
});

function raceCandidate(version, sequence) {
  return {
    schemaVersion: 1,
    sequence,
    releaseId: `r${sequence}`,
    generatedAt: '2026-07-14T05:00:00Z',
    expiresAt: '2026-07-21T05:00:00Z',
    minimumEngineVersion: '1.0.0',
    feeds: {
      consentGhost: {
        path: `/releases/r${sequence}/feed.json`,
        signaturePath: `/releases/r${sequence}/feed.json.sig`,
        configVersion: version,
      },
    },
  };
}

function createRaceClient(root, shared, version, sequence) {
  const candidate = raceCandidate(version, sequence);
  const raw = JSON.stringify({ schemaVersion: 2, configVersion: version, frameworks: [] });
  return root.PawsOffSignedConfigClient.create({
    signedFeed: {
      MAX_FEED_BYTES: 1024,
      validateManifest: () => true,
      resolveReleaseUrl: (_base, path) => `https://config.getpawsoff.app${path}`,
      verifyFeedText: () => Promise.resolve(true),
    },
    currentVersion: '1.0.0',
    manifestCacheKey: `manifest-${sequence}`,
    sequenceKey: `sequence-${sequence}`,
    manifestUrl: 'https://config.getpawsoff.app/release-manifest.json',
    manifestSignatureUrl: 'https://config.getpawsoff.app/release-manifest.json.sig',
    configOrigin: 'https://config.getpawsoff.app',
    manifestMaxBytes: 1024,
    signatureMaxBytes: 128,
    publicKey: {},
    crypto: {},
    boundedResponse: { readText: (response) => Promise.resolve(response.text) },
    fetch: (url) => Promise.resolve({ ok: true, text: url.endsWith('.sig') ? 'signature' : raw }),
    verifySignature: () => Promise.resolve(true),
    compareVersions: SignedFeed.compareVersions,
    log: () => Promise.resolve(),
    storage: {
      get: () => Promise.resolve({
        [`manifest-${sequence}`]: candidate,
        [`sequence-${sequence}`]: sequence,
      }),
      set: (payload) => { Object.assign(shared, payload); return Promise.resolve(); },
    },
  });
}

function raceOptions(getCached) {
  return {
    feedKey: 'consentGhost',
    cacheKey: 'shared-config',
    validate: () => true,
    getCached,
    logPrefix: 'consent',
  };
}

function createManifestRaceClient(root, shared, candidate, beforeVerify) {
  const raw = JSON.stringify(candidate);
  return root.PawsOffSignedConfigClient.create({
    signedFeed: {
      validateManifest: () => true,
      shouldAdoptManifest: SignedFeed.shouldAdoptManifest,
    },
    currentVersion: '1.0.0',
    manifestCacheKey: 'manifest',
    sequenceKey: 'sequence',
    manifestUrl: 'https://config.getpawsoff.app/release-manifest.json',
    manifestSignatureUrl: 'https://config.getpawsoff.app/release-manifest.json.sig',
    configOrigin: 'https://config.getpawsoff.app',
    manifestMaxBytes: 1024,
    signatureMaxBytes: 128,
    publicKey: {},
    boundedResponse: { readText: (response) => Promise.resolve(response.text) },
    fetch: (url) => Promise.resolve({ ok: true, text: url.endsWith('.sig') ? 'signature' : raw }),
    verifySignature: async () => {
      if (beforeVerify) await beforeVerify();
      return true;
    },
    log: () => Promise.resolve(),
    storage: {
      get(keys) {
        const out = {};
        for (const key of keys) {
          if (Object.prototype.hasOwnProperty.call(shared, key)) out[key] = shared[key];
        }
        return Promise.resolve(out);
      },
      set(payload) { Object.assign(shared, payload); return Promise.resolve(); },
    },
  });
}

test('signed client serializes compare-and-write adoption per cache key', async () => {
  const { root } = require('./harness/sandbox').loadBackground();
  const shared = {};
  let releaseOlderRead;
  let markOlderRead;
  let newerReads = 0;
  const olderReadStarted = new Promise((resolve) => { markOlderRead = resolve; });
  const olderReadGate = new Promise((resolve) => { releaseOlderRead = resolve; });
  const older = createRaceClient(root, shared, '1.0.0', 1);
  const newer = createRaceClient(root, shared, '2.0.0', 2);
  const olderPending = older.fetchReleaseConfig(raceOptions(async () => {
    markOlderRead();
    await olderReadGate;
    return shared['shared-config'] || null;
  }));
  await olderReadStarted;
  const newerPending = newer.fetchReleaseConfig(raceOptions(() => {
    newerReads += 1;
    return Promise.resolve(shared['shared-config'] || null);
  }));
  await Promise.resolve();
  await Promise.resolve();
  eq(newerReads, 0, 'newer adoption waits for the in-flight compare-and-write');
  releaseOlderRead();
  await Promise.all([olderPending, newerPending]);
  eq(shared['shared-config'].configVersion, '2.0.0', 'older fetch cannot overwrite the newer config');
});

test('signed client serializes manifest adoption against its sequence high-water mark', async () => {
  const { root } = require('./harness/sandbox').loadBackground();
  const shared = {};
  let releaseOlderVerify;
  let markOlderVerify;
  const olderVerifyStarted = new Promise((resolve) => { markOlderVerify = resolve; });
  const olderVerifyGate = new Promise((resolve) => { releaseOlderVerify = resolve; });
  const older = createManifestRaceClient(root, shared, { ...manifest(), sequence: 6 }, async () => {
    markOlderVerify();
    await olderVerifyGate;
  });
  const newer = createManifestRaceClient(root, shared, { ...manifest(), sequence: 7 });

  const olderPending = older.fetchReleaseManifest(true);
  await olderVerifyStarted;
  const newerResult = await newer.fetchReleaseManifest(true);
  eq(newerResult.sequence, 7);
  eq(shared.sequence, 7, 'newer manifest commits first');
  releaseOlderVerify();
  const olderResult = await olderPending;
  eq(olderResult.sequence, 7, 'delayed older fetch returns the current manifest');
  eq(shared.sequence, 7, 'delayed sequence cannot roll storage back');
});

test('signed client never coalesces a forced fetch into a cache-only lookup', async () => {
  const { root } = require('./harness/sandbox').loadBackground();
  let releaseCacheRead;
  let markCacheRead;
  let reads = 0;
  let fetches = 0;
  const fetchOptions = [];
  const cacheReadStarted = new Promise((resolve) => { markCacheRead = resolve; });
  const cacheReadGate = new Promise((resolve) => { releaseCacheRead = resolve; });
  const cached = manifest();
  const client = root.PawsOffSignedConfigClient.create({
    signedFeed: {
      validateManifest: () => true,
      shouldAdoptManifest: () => false,
    },
    currentVersion: '1.0.0',
    manifestCacheKey: 'manifest',
    sequenceKey: 'sequence',
    manifestUrl: 'https://config.getpawsoff.app/release-manifest.json',
    manifestSignatureUrl: 'https://config.getpawsoff.app/release-manifest.json.sig',
    configOrigin: 'https://config.getpawsoff.app',
    manifestMaxBytes: 1024,
    signatureMaxBytes: 128,
    publicKey: {},
    boundedResponse: { readText: (response) => Promise.resolve(response.text) },
    fetch: (url, options) => {
      fetches += 1;
      fetchOptions.push(options);
      return Promise.resolve({ ok: true, text: url.endsWith('.sig') ? 'signature' : JSON.stringify(cached) });
    },
    verifySignature: () => Promise.resolve(true),
    log: () => Promise.resolve(),
    storage: {
      async get() {
        reads += 1;
        if (reads === 1) {
          markCacheRead();
          await cacheReadGate;
        }
        return { manifest: cached, sequence: cached.sequence };
      },
      set: () => Promise.resolve(),
    },
  });

  const cachedPending = client.getReleaseManifest(false);
  await cacheReadStarted;
  const forcedPending = client.getReleaseManifest(true);
  eq(fetches, 0, 'forced request waits for the cache-only lookup to finish');
  releaseCacheRead();
  await Promise.all([cachedPending, forcedPending]);
  eq(fetches, 2, 'forced request performs the manifest and signature fetches');
  assert(fetchOptions.every((options) => options.redirect === 'error'), 'signed fetches reject redirects');
});

// Guards the periodic-refresh contract: a cached manifest stays "valid" until
// expiresAt (ttl-days), so an unforced refresh never notices a new release. The
// CONFIG_ALARM handler must therefore force, or rules go stale for days.
test('signed client: only a forced manifest refresh notices a newer release', async () => {
  const { root } = require('./harness/sandbox').loadBackground();
  const cached = raceCandidate('20260810000000', 500);
  const published = raceCandidate('20260811000000', 900);
  const stored = { manifest: cached, sequence: 500 };
  let fetches = 0;

  const client = root.PawsOffSignedConfigClient.create({
    signedFeed: {
      validateManifest: () => true,
      shouldAdoptManifest: SignedFeed.shouldAdoptManifest,
    },
    currentVersion: '1.0.0',
    manifestCacheKey: 'manifest',
    sequenceKey: 'sequence',
    manifestUrl: 'https://config.getpawsoff.app/release-manifest.json',
    manifestSignatureUrl: 'https://config.getpawsoff.app/release-manifest.json.sig',
    configOrigin: 'https://config.getpawsoff.app',
    manifestMaxBytes: 1024,
    signatureMaxBytes: 128,
    publicKey: {},
    boundedResponse: { readText: (response) => Promise.resolve(response.text) },
    fetch: (url) => {
      fetches += 1;
      return Promise.resolve({
        ok: true,
        text: url.endsWith('.sig') ? 'signature' : JSON.stringify(published),
      });
    },
    verifySignature: () => Promise.resolve(true),
    compareVersions: SignedFeed.compareVersions,
    log: () => Promise.resolve(),
    storage: {
      get: () => Promise.resolve({ manifest: stored.manifest, sequence: stored.sequence }),
      set: (payload) => {
        stored.manifest = payload.manifest;
        stored.sequence = payload.sequence;
        return Promise.resolve();
      },
    },
  });

  const stale = await client.getReleaseManifest(false);
  eq(fetches, 0, 'an unforced refresh trusts the cached manifest and fetches nothing');
  eq(stale.sequence, 500, 'so it keeps serving the old release');

  const fresh = await client.getReleaseManifest(true);
  eq(fetches, 2, 'a forced refresh fetches the manifest and its signature');
  eq(fresh.sequence, 900, 'and adopts the newer release');
  eq(stored.sequence, 900, 'high-water mark advances');
});

// The caller-side half of the contract above: the CONFIG_ALARM handler must
// force. With a valid, unexpired manifest cached, an unforced refresh short-
// circuits before any network call, so a new release would go unseen until the
// cached manifest expired (ttl-days). Firing the alarm must hit the network.
test('background: the config alarm re-checks the manifest despite a fresh cache', async () => {
  const sandbox = require('./harness/sandbox');
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString().replace(/\.(\d{3})Z$/, '.$1Z');
  const cached = {
    schemaVersion: 1,
    sequence: 4242,
    releaseId: 'r4242',
    generatedAt: iso(now - 60 * 60 * 1000),
    expiresAt: iso(now + 7 * 24 * 60 * 60 * 1000), // still far from expiry
    minimumEngineVersion: '1.0.0',
    feeds: {
      consentGhost: {
        path: '/releases/r4242/consent-config.json',
        signaturePath: '/releases/r4242/consent-config.json.sig',
        sha256: 'a'.repeat(64),
        bytes: 42,
        configVersion: '20260810000000',
      },
    },
  };

  const bg = sandbox.loadBackground();
  const store = bg.getStore();
  store.__pawsOff_release_manifest = cached;
  store.__pawsOff_release_sequence = cached.sequence;

  eq(bg.fetchAttempts.length, 0, 'loading the worker performs no fetches');
  await bg.fireAlarm('pawsoff_tos_config_refresh');

  const manifestHits = bg.fetchAttempts.filter((u) => u.indexOf('release-manifest.json') !== -1);
  assert(
    manifestHits.length > 0,
    'the periodic refresh must force a manifest re-fetch, not trust the cached copy',
  );
});
