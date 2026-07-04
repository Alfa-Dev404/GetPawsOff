/* PawsOff - tests for the OBSERVE-ONLY prevalence collector (content script).
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
