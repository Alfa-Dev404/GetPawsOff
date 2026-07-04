/* PawsOff - privacy regression: the observe-only learner must NEVER persist a
 * plaintext browsing host as a storage KEY (CLAUDE.md #5: "sites keyed by
 * hashHost, never plaintext").
 *
 * The user's first-party sites (their browsing history) are stored ONLY as
 * hashed keys. The tracker's own registrable domain is public infrastructure,
 * not the user's history, and is kept as a VALUE (entry.d) so the popup radar +
 * enforcer can still name it - but it never appears as a key, and no first-party
 * host appears anywhere.
 */
'use strict';
const { test, assert, eq } = require('./harness/framework');
const { loadLearner, SNITCH_KEY } = require('./harness/sandbox');

const SIZES_KEY = '__pawsOff_pv_sizes';
const HASH_RE = /^h:[0-9a-f]{8}$/;

test('privacy: every learner storage KEY is a hashHost digest, never plaintext', async () => {
  const { NS, getStore } = loadLearner();
  // A few unrelated first parties, each seeing some trackers.
  await NS.record('news.example', ['ad.doubleclick.net', 'scorecardresearch.com']);
  await NS.record('shop.example', ['doubleclick.net', 'cdn.tracker.io']);
  await NS.record('blog.example', ['tracker.io']);
  await NS.recordSizes({ 'ad.doubleclick.net': 2048, 'tracker.io': 512 });

  const snitch = getStore()[SNITCH_KEY] || {};
  const sizes = getStore()[SIZES_KEY] || {};

  const trackerKeys = Object.keys(snitch);
  assert(trackerKeys.length > 0, 'recorded something');

  // Every tracker key + every first-party sighting key is a hash digest.
  for (const tk of trackerKeys) {
    assert(HASH_RE.test(tk), 'tracker key hashed: ' + tk);
    for (const fp of Object.keys(snitch[tk].s || {})) {
      assert(HASH_RE.test(fp), 'first-party key hashed: ' + fp);
    }
  }
  for (const sk of Object.keys(sizes)) assert(HASH_RE.test(sk), 'size key hashed: ' + sk);

  // No plaintext host we fed in appears as ANY key (first-party OR tracker).
  const plaintextHosts = [
    'news.example', 'shop.example', 'blog.example',
    'doubleclick.net', 'scorecardresearch.com', 'tracker.io',
  ];
  const allKeys = new Set([
    ...trackerKeys,
    ...trackerKeys.flatMap((tk) => Object.keys(snitch[tk].s || {})),
    ...Object.keys(sizes),
  ]);
  for (const host of plaintextHosts) {
    assert(!allKeys.has(host), 'no plaintext host as a key: ' + host);
  }

  // Strongest check: NO plaintext host appears ANYWHERE in the serialized store -
  // not as a key, not as a value (no entry.d, no leaked first party).
  const serialized = JSON.stringify(snitch) + JSON.stringify(sizes);
  for (const host of plaintextHosts) {
    assert(serialized.indexOf(host) === -1, 'no plaintext host anywhere in the store: ' + host);
  }

  // Callers still get real domains through the API (getVerdict echoes the query),
  // so behaviour is unchanged even though storage is hash-only.
  const v = await NS.getVerdict('doubleclick.net');
  eq(v.domain, 'doubleclick.net', 'verdict API still returns the real domain to callers');
});

test('privacy: legacy plaintext-keyed data is discarded on first load (migration)', async () => {
  const { NS, getStore } = loadLearner();
  // Seed an OLD-format store (plaintext keys) BEFORE the learner's first read.
  getStore()[SNITCH_KEY] = {
    'doubleclick.net': { s: { 'news.example': 20000 }, first: 20000, last: 20000 },
  };
  // First mutation forces load() → migrate (discard legacy) → add hashed → save.
  await NS.record('x.example', ['newtracker.io']);

  const snitch = getStore()[SNITCH_KEY] || {};
  assert(!('doubleclick.net' in snitch), 'legacy plaintext key discarded on load');
  assert(NS.hashHost('newtracker.io') in snitch, 'new data persisted under a hashed key');
  const v = await NS.getVerdict('doubleclick.net');
  eq(v.score, 0, 'discarded legacy tracker no longer scores');
});
