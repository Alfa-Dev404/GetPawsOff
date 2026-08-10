/* PawsOff — tests for the OBSERVE-ONLY prevalence collector (content script).
 *
 * The collector is mostly browser-lifecycle glue (PerformanceObserver, timers,
 * sendMessage) that can't run headless, but its two PURE helpers carry real
 * invariants worth pinning before any refactor:
 *   - hashHost(): the one-way FNV-1a/32 origin digest. It MUST stay byte-for-byte
 *     compatible with po-catch.js + popup.js, or the popup can't find a site's
 *     radar snapshot. We store only this digest (never plaintext history).
 *   - radarKeysToEvict(): bounded-storage eviction (keep at most RADAR_MAX sites,
 *     drop the oldest by timestamp).
 * These are reached via the file's guarded test-export hook.
 */
'use strict';

const { test, assert, eq } = require('./harness/framework');
const { loadCollector } = require('./harness/sandbox');

test('collector: the guarded test hook exposes the pure helpers', () => {
  const { internals } = loadCollector();
  assert(internals, 'test hook attached internals');
  eq(typeof internals.hashHost, 'function');
  eq(typeof internals.radarKeysToEvict, 'function');
});

test('collector: bounded snapshots cover initial, delayed, and long-lived resources', () => {
  const { internals } = loadCollector();
  eq(internals.SNAPSHOT_DELAYS_MS.join(','), '4000,15000,60000');
});

test('collector: every scheduled snapshot flushes and pagehide stops terminally', () => {
  const { internals, messages, timers, windowListeners } = loadCollector({ enabled: true });
  eq(timers.map((timer) => timer.delay).join(','), internals.SNAPSHOT_DELAYS_MS.join(','));
  timers.forEach((timer, index) => {
    internals.addEntry(`https://tracker-${index}.example/pixel`, index + 1);
    timer.listener();
  });
  eq(messages.length, internals.SNAPSHOT_DELAYS_MS.length, 'every bounded snapshot callback flushes');

  internals.addEntry('https://terminal.example/pixel', 10);
  windowListeners.pagehide();
  assert(internals.isStopped(), 'pagehide is the terminal observation path');
  const terminalCount = messages.length;
  timers[0].listener();
  eq(messages.length, terminalCount, 'scheduled callbacks are inert after pagehide');
});

test('collector: hiding a tab flushes without permanently stopping observation', () => {
  const { internals, document, messages } = loadCollector();
  internals.addEntry('https://tracker.example/pixel', 12);
  document.visibilityState = 'hidden';
  internals.onVisibilityChange();
  eq(messages.length, 1, 'hidden tab flushes its current observations');
  eq(messages[0].hosts[0], 'tracker.example');
  assert(!internals.isStopped(), 'visibility handling never takes the terminal pagehide path');
});

test('collector: repeated flushes send transfer-size deltas, not cumulative totals', () => {
  const { internals, document, messages } = loadCollector();
  internals.addEntry('https://tracker.example/first', 12);
  document.visibilityState = 'hidden';
  internals.onVisibilityChange();
  internals.addEntry('https://tracker.example/second', 8);
  internals.onVisibilityChange();
  eq(messages.length, 2);
  eq(messages[0].hostSizes['tracker.example'], 12);
  eq(messages[1].hostSizes['tracker.example'], 8, 'second flush contains only newly observed bytes');
  eq(messages[1].hosts[0], 'tracker.example', 'known-host sightings remain available across snapshots');
});

test('collector: host cap still aggregates known hosts and rejects non-finite sizes', () => {
  const { internals } = loadCollector();
  internals.addEntry('https://tracker.example/pixel', 12);
  for (let i = 0; i < internals.MAX_HOSTS - 1; i++) {
    internals.addEntry('https://d' + i + '.example/pixel', 1);
  }
  internals.addEntry('https://overflow.example/pixel', 99);
  internals.addEntry('https://tracker.example/again', 8);
  internals.addEntry('https://tracker.example/nan', NaN);
  const payload = internals.observationPayload();
  eq(payload.hosts.length, internals.MAX_HOSTS, 'new hosts stop at the hard cap');
  assert(payload.hosts.indexOf('overflow.example') < 0, 'overflow host is ignored');
  eq(payload.hostSizes['tracker.example'], 20, 'known host continues aggregating after the cap');
});

test('collector: same-site subdomains are not learned as third parties', () => {
  const { internals } = loadCollector();
  assert(internals.isSameSiteHost('cdn.example.com'), 'shared registrable domain is same-site');
  internals.addEntry('https://cdn.example.com/app.js', 12);
  internals.addEntry('https://tracker.other.test/pixel', 8);
  const payload = internals.observationPayload();
  assert(!payload.hosts.includes('cdn.example.com'), 'same-site resource is excluded');
  assert(payload.hosts.includes('tracker.other.test'), 'real third party remains observable');
});

test('hashHost: deterministic, lowercased, "h:" + 8 hex chars', () => {
  const { internals } = loadCollector();
  const a = internals.hashHost('example.com');
  assert(/^h:[0-9a-f]{8}$/.test(a), 'format h:xxxxxxxx, got ' + a);
  eq(internals.hashHost('EXAMPLE.COM'), a, 'case-insensitive');
  eq(internals.hashHost('example.com'), a, 'deterministic');
  assert(internals.hashHost('other.com') !== a, 'distinct host -> distinct digest');
});

test('hashHost: matches the canonical FNV-1a/32 reference', () => {
  const { internals } = loadCollector();
  function ref(host) {
    let h = 0x811c9dc5;
    const s = host.toLowerCase();
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return 'h:' + h.toString(16).padStart(8, '0');
  }
  for (const host of ['check24.de', 'google.com', 'a', 'sub.domain.example.co.uk']) {
    eq(internals.hashHost(host), ref(host), 'digest for ' + host);
  }
});

test('hashHost: null / empty / non-string returns null', () => {
  const { internals } = loadCollector();
  eq(internals.hashHost(''), null);
  eq(internals.hashHost(null), null);
  eq(internals.hashHost(123), null);
});

test('radar snapshots retain only hash keys and bounded aggregate metadata', () => {
  const { internals } = loadCollector();
  const spots = internals.sanitizeRadarSpots([
    { domain: 'tracker.example', score: 4.25, sites: 3, verdict: 'block' },
  ]);
  eq(spots.length, 1);
  eq(spots[0].domainHash, internals.hashHost('tracker.example'));
  assert(!Object.prototype.hasOwnProperty.call(spots[0], 'domain'), 'plaintext domain is not persisted');
  assert(!JSON.stringify(spots).includes('tracker.example'), 'serialized snapshot is hash-only');
});

test('radar snapshots clear stale spots after a valid empty learner response', () => {
  const { internals, getStore } = loadCollector();
  const key = internals.RADAR_PREFIX + internals.hashHost('example.com');
  getStore()[key] = { ts: 1, spotted: [{ domainHash: 'h:11111111' }] };
  internals.stashRadarSnapshot({ ok: true, spotted: [] });
  eq(getStore()[key].spotted.length, 0, 'valid empty result replaces the stale snapshot');

  getStore()[key] = { ts: 2, spotted: [{ domainHash: 'h:22222222' }] };
  internals.stashRadarSnapshot({ ok: false, spotted: [] });
  eq(
    getStore()[key].spotted[0].domainHash,
    'h:22222222',
    'unsuccessful response does not rewrite the snapshot',
  );
});

test('radar snapshots reject inherited verdict names', () => {
  const { internals } = loadCollector();
  const spots = internals.sanitizeRadarSpots([
    { domain: 'tracker.example', score: 1, sites: 1, verdict: 'toString' },
  ]);
  eq(spots[0].verdict, 'allow', 'prototype properties are not allow-listed verdicts');
});

test('radarKeysToEvict: returns [] for junk input or within budget', () => {
  const { internals } = loadCollector();
  eq(internals.radarKeysToEvict(null).length, 0, 'null input');
  eq(internals.radarKeysToEvict({}).length, 0, 'empty input');
  const few = {};
  few[internals.RADAR_PREFIX + 'h:00000001'] = { ts: 1 };
  few[internals.RADAR_PREFIX + 'h:00000002'] = { ts: 2 };
  eq(internals.radarKeysToEvict(few).length, 0, 'well under RADAR_MAX');
});

test('radarKeysToEvict: ignores non-radar keys', () => {
  const { internals } = loadCollector();
  const all = { __pawsOff_master_enabled: true, foo: 1, __pawsOff_catch_3: {} };
  eq(internals.radarKeysToEvict(all).length, 0, 'no radar-prefixed keys');
});

test('radarKeysToEvict: over budget, evicts exactly the oldest overflow by ts', () => {
  const { internals } = loadCollector();
  const all = { __pawsOff_master_enabled: true }; // decoy non-radar key
  const N = internals.RADAR_MAX + 5;
  for (let i = 0; i < N; i++) {
    all[internals.RADAR_PREFIX + 'h:' + String(i).padStart(8, '0')] = { ts: 1000 + i };
  }
  const victims = internals.radarKeysToEvict(all);
  eq(victims.length, 5, 'evict count = total - RADAR_MAX');
  for (let i = 0; i < 5; i++) {
    assert(
      victims.indexOf(internals.RADAR_PREFIX + 'h:' + String(i).padStart(8, '0')) !== -1,
      'oldest key ' + i + ' is evicted'
    );
  }
  assert(
    victims.indexOf(internals.RADAR_PREFIX + 'h:' + String(N - 1).padStart(8, '0')) === -1,
    'newest key is kept'
  );
});

test('radarKeysToEvict: entries missing a ts sort as oldest (ts treated as 0)', () => {
  const { internals } = loadCollector();
  const all = {};
  const N = internals.RADAR_MAX + 1;
  // one entry with no ts; the rest have ascending positive ts
  all[internals.RADAR_PREFIX + 'h:notimestamp'] = {};
  for (let i = 0; i < N - 1; i++) {
    all[internals.RADAR_PREFIX + 'h:' + String(i).padStart(8, '0')] = { ts: 1000 + i };
  }
  const victims = internals.radarKeysToEvict(all);
  eq(victims.length, 1, 'exactly one over budget');
  eq(victims[0], internals.RADAR_PREFIX + 'h:notimestamp', 'the ts-less entry is evicted first');
});
