/* PawsOff - settings-page per-site pause helpers (options.js).
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
  normalizeSiteMap,
  addSiteHost,
  removeSiteHost,
  sortedSiteHosts,
  ALLOW_KEY,
  CG_SITES,
} = O;

test('sitepause: the test hook exposes the per-site helpers + keys', () => {
  ['hashHost', 'normDomain', 'normalizeSiteMap', 'addSiteHost', 'removeSiteHost', 'sortedSiteHosts']
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
  eq(st.hosts['example.com'], 5, 'normalized + timestamp kept');
  eq(normalizeSiteMap(null).hosts && Object.keys(normalizeSiteMap(null).hosts).length, 0, 'garbage → empty');
});

test('addSiteHost: adds a normalized host without mutating the input', () => {
  const before = { v: 1, hosts: { 'a.com': 1 } };
  const after = addSiteHost(before, 'https://www.B.com/');
  assert(after !== before, 'returns a fresh object');
  eq(Object.keys(before.hosts).length, 1, 'input untouched');
  assert(after.hosts['b.com'] > 0, 'normalized host added with a timestamp');
  assert(after.hosts['a.com'] === 1, 'existing host preserved');
  eq(addSiteHost(before, 'garbage value').hosts['a.com'], 1, 'invalid input is a no-op add');
  assert(!('' in addSiteHost(before, 'garbage value').hosts), 'no empty-key entry created');
});

test('removeSiteHost: removes a host (normalizing first) without mutation', () => {
  const before = { v: 1, hosts: { 'a.com': 1, 'b.com': 2 } };
  const after = removeSiteHost(before, 'https://www.A.com');
  assert(after !== before, 'fresh object');
  eq(Object.keys(before.hosts).length, 2, 'input untouched');
  assert(!('a.com' in after.hosts), 'normalized host removed');
  assert('b.com' in after.hosts, 'others kept');
});

test('sortedSiteHosts: newest-first by timestamp', () => {
  const list = sortedSiteHosts({ v: 1, hosts: { 'old.com': 100, 'new.com': 300, 'mid.com': 200 } });
  eq(list.join(','), 'new.com,mid.com,old.com', 'sorted newest-first');
  eq(sortedSiteHosts(null).length, 0, 'empty map → empty list');
});
