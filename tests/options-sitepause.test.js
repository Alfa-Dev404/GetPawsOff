/* PawsOff — settings-page per-site pause helpers (options.js).
 *
 * The popup can pause PawsOff on the CURRENT site ("Unbreak this site"); these
 * helpers give the settings page parity by letting you pause sites by typing a
 * domain. Enforcement reuses the SHARED allow-list (window.PawsOffAllow) so no
 * content-script changes are needed; the pure bits worth locking down are:
 *   - hashHost():        FNV-1a/32 digest, MUST match po-catch.js / popup.js
 *   - normDomain():      typed-input → bare domain (mirrors po-allow.normDomain)
 *   - the CG_SITES companion map setters (add/remove/normalize/sort), which must
 *     never mutate their input and must drop junk.
 */
'use strict';

const { test, assert, eq } = require('./harness/framework');
const { loadOptions } = require('./harness/sandbox');

const O = loadOptions().internals || {};
const {
  hashHost,
  normDomain,
  siteHash,
  normalizeSiteMap,
  addSiteHost,
  removeSiteHost,
  sortedSiteHosts,
  setSitePaused,
  ALLOW_KEY,
  CG_SITES,
} = O;

test('sitepause: the test hook exposes the per-site helpers + keys', () => {
  ['hashHost', 'normDomain', 'normalizeSiteMap', 'addSiteHost', 'removeSiteHost', 'sortedSiteHosts', 'setSitePaused']
    .forEach((k) => assert(typeof O[k] === 'function', k + ' is a function'));
  eq(ALLOW_KEY, '__pawsOff_allowlist', 'shared allow-list key');
  eq(CG_SITES, '__pawsOff_consentGhost_sites', 'companion map key');
});

test('hashHost: deterministic, case-insensitive, h:<8 hex> shape', () => {
  const a = hashHost('example.com');
  assert(/^h:[0-9a-f]{8}$/.test(a), 'matches h:xxxxxxxx');
  eq(hashHost('example.com'), a, 'deterministic');
  eq(hashHost('EXAMPLE.COM'), a, 'case-insensitive (lower-cased before hashing)');
  assert(hashHost('example.org') !== a, 'different host → different digest');
  eq(hashHost(''), null, 'empty host → null');
  eq(hashHost(null), null, 'non-string → null');
});

test('normDomain: strips scheme/www/path, rejects junk', () => {
  eq(normDomain('https://www.Example.com/path?x=1'), 'example.com');
  eq(normDomain('  HTTP://sub.example.co.uk  '), 'sub.example.co.uk', 'real subdomains preserved');
  eq(normDomain('user@example.com'), 'example.com', 'userinfo stripped');
  eq(normDomain('localhost'), '', 'no dot → rejected');
  eq(normDomain('not a domain'), '', 'space → rejected');
  eq(normDomain('.example.com'), '', 'leading dot → rejected');
  eq(normDomain(''), '', 'empty → empty');
});

test('normalizeSiteMap: returns a clean {v:1,hosts} and drops invalid entries', () => {
  const st = normalizeSiteMap({ hosts: { 'Example.com': 5, 'bad domain': 9, 'x.com': 0, 'y.com': 'nope' } });
  eq(st.v, 1);
  eq(Object.keys(st.hosts).length, 1, 'only the one valid, positively-timestamped host survives');
  eq(st.hosts[hashHost('example.com')], 5, 'legacy plaintext is migrated to a hash');
  assert(!JSON.stringify(st).includes('example.com'), 'normalized map stores no plaintext hostname');
  eq(normalizeSiteMap(null).hosts && Object.keys(normalizeSiteMap(null).hosts).length, 0, 'garbage → empty');
});

test('addSiteHost: adds a hashed host without mutating the input', () => {
  const aHash = hashHost('a.com');
  const bHash = hashHost('b.com');
  const before = { v: 1, hosts: { [aHash]: 1 } };
  const after = addSiteHost(before, 'https://www.B.com/');
  assert(after !== before, 'returns a fresh object');
  eq(Object.keys(before.hosts).length, 1, 'input untouched');
  assert(after.hosts[bHash] > 0, 'normalized host hash added with a timestamp');
  assert(after.hosts[aHash] === 1, 'existing hash preserved');
  assert(!JSON.stringify(after).includes('b.com'), 'plaintext input is not retained');
  eq(addSiteHost(before, 'garbage value').hosts[aHash], 1, 'invalid input is a no-op add');
  assert(!('' in addSiteHost(before, 'garbage value').hosts), 'no empty-key entry created');
});

test('removeSiteHost: removes by hash without mutation or plaintext recovery', () => {
  const aHash = hashHost('a.com');
  const bHash = hashHost('b.com');
  const before = { v: 1, hosts: { [aHash]: 1, [bHash]: 2 } };
  const after = removeSiteHost(before, siteHash(aHash));
  assert(after !== before, 'fresh object');
  eq(Object.keys(before.hosts).length, 2, 'input untouched');
  assert(!(aHash in after.hosts), 'hash removed');
  assert(bHash in after.hosts, 'others kept');
  eq(siteHash(aHash), aHash, 'existing hash is accepted as the removal key');
});

test('sortedSiteHosts: newest-first by timestamp', () => {
  const oldHash = hashHost('old.com');
  const newHash = hashHost('new.com');
  const midHash = hashHost('mid.com');
  const list = sortedSiteHosts({ v: 1, hosts: { [oldHash]: 100, [newHash]: 300, [midHash]: 200 } });
  eq(list.join(','), [newHash, midHash, oldHash].join(','), 'hashes sorted newest-first');
  eq(sortedSiteHosts(null).length, 0, 'empty map → empty list');
});

test('site pause storage commits only after background DNR success', async () => {
  const failed = loadOptions({
    sendMessage(_message, callback) { callback({ ok: false }); },
  });
  eq(await failed.internals.setSitePaused('example.com', true), false);
  assert(!failed.getStore()[ALLOW_KEY], 'failed DNR pause leaves the allow-list untouched');

  const succeeded = loadOptions({
    sendMessage(_message, callback) { callback({ ok: true }); },
  });
  eq(await succeeded.internals.setSitePaused('example.com', true), true);
  const stored = succeeded.getStore()[ALLOW_KEY];
  assert(stored.sites[hashHost('example.com')].paused > 0, 'successful DNR pause is persisted');

  const existing = { v: 1, sites: { [hashHost('example.com')]: { paused: 10, domains: {} } } };
  const failedUnpause = loadOptions({
    initialStore: { [ALLOW_KEY]: existing },
    sendMessage(_message, callback) { callback({ ok: false }); },
  });
  eq(await failedUnpause.internals.setSitePaused(hashHost('example.com'), false), false);
  eq(failedUnpause.getStore()[ALLOW_KEY].sites[hashHost('example.com')].paused, 10);

  const successfulUnpause = loadOptions({
    initialStore: { [ALLOW_KEY]: existing },
    sendMessage(_message, callback) { callback({ ok: true }); },
  });
  eq(await successfulUnpause.internals.setSitePaused(hashHost('example.com'), false), true);
  eq(
    successfulUnpause.getStore()[ALLOW_KEY].sites[hashHost('example.com')].paused,
    0,
    'successful DNR unpause persists the unpaused state',
  );
});
