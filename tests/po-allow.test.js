/* PawsOff - unit tests for the per-site allow-list model (src/lib/po-allow.js). */
'use strict';
const { test, assert, eq } = require('./harness/framework');
const { loadAllow } = require('./harness/sandbox');

test('po-allow: module surface + constants', () => {
  const { A } = loadAllow();
  ['normDomain','emptyState','normalizeState','isPaused','isDomainAllowed','isAllowed',
   'setPaused','setDomain','clearSite','allowedDomains','prune','read','write'].forEach((k) => {
    assert(typeof A[k] === 'function', 'missing ' + k);
  });
  eq(A.STORAGE_KEY, '__pawsOff_allowlist');
  eq(A.SCHEMA, 1);
});

test('po-allow: normDomain strips scheme/www/path/port and rejects junk', () => {
  const { A } = loadAllow();
  eq(A.normDomain('https://www.Example.com/p?x=1'), 'example.com');
  eq(A.normDomain('DoubleClick.net:443'), 'doubleclick.net');
  eq(A.normDomain('a.tracker.com'), 'a.tracker.com'); // real subdomains preserved
  eq(A.normDomain('localhost'), '');
  eq(A.normDomain('..bad'), '');
  eq(A.normDomain(''), '');
});

test('po-allow: empty state is a clean v1 shape', () => {
  const { A } = loadAllow();
  const s = A.emptyState();
  eq(s.v, 1);
  eq(Object.keys(s.sites).length, 0);
});

test('po-allow: site pause is scoped + reversible', () => {
  const { A } = loadAllow();
  let s = A.setPaused(A.emptyState(), 'h:a', true);
  assert(A.isPaused(s, 'h:a'), 'paused on its site');
  assert(A.isAllowed(s, 'h:a', 'anything.com'), 'pause lets everything through');
  assert(!A.isPaused(s, 'h:b'), 'other site unaffected');
  s = A.setPaused(s, 'h:a', false);
  assert(!A.isPaused(s, 'h:a'), 'resumed');
});

test('po-allow: per-domain allow is scoped to its own site', () => {
  const { A } = loadAllow();
  let s = A.setDomain(A.emptyState(), 'h:a', 'doubleclick.net', true);
  assert(A.isDomainAllowed(s, 'h:a', 'doubleclick.net'), 'allowed here');
  assert(!A.isDomainAllowed(s, 'h:b', 'doubleclick.net'), 'not on another site');
  assert(!A.isDomainAllowed(s, 'h:a', 'google-analytics.com'), 'other domain still blocked');
  s = A.setDomain(s, 'h:a', 'doubleclick.net', false);
  assert(!A.isDomainAllowed(s, 'h:a', 'doubleclick.net'), 're-blocked');
});

test('po-allow: allowedDomains lists the current allows', () => {
  const { A } = loadAllow();
  let s = A.setDomain(A.emptyState(), 'h:a', 'doubleclick.net', true);
  s = A.setDomain(s, 'h:a', 'scorecardresearch.com', true);
  eq(A.allowedDomains(s, 'h:a').sort().join(','), 'doubleclick.net,scorecardresearch.com');
});

test('po-allow: clearSite wipes one site, leaves others', () => {
  const { A } = loadAllow();
  let s = A.setPaused(A.emptyState(), 'h:a', true);
  s = A.setDomain(s, 'h:b', 'doubleclick.net', true);
  s = A.clearSite(s, 'h:a');
  assert(!A.isPaused(s, 'h:a'), 'a cleared');
  assert(A.isDomainAllowed(s, 'h:b', 'doubleclick.net'), 'b untouched');
});

test('po-allow: normalizeState repairs garbage into a clean model', () => {
  const { A } = loadAllow();
  const s = A.normalizeState({ sites: { 'h:x': { paused: 'no', domains: { 'WWW.Doubleclick.net': 5, 'bad host': 9, 'z.com': 0 } } } });
  assert(!A.isPaused(s, 'h:x'), 'bad paused coerced off');
  assert(A.isDomainAllowed(s, 'h:x', 'doubleclick.net'), 'domain normalized + kept');
  assert(!A.isDomainAllowed(s, 'h:x', 'z.com'), 'zero timestamp dropped');
  eq(A.allowedDomains(s, 'h:x').length, 1);
});

test('po-allow: normalizeState drops plaintext (non-hash) site keys', () => {
  const { A } = loadAllow();
  const s = A.normalizeState({ sites: {
    'nytimes.com': { paused: 5, domains: {} },          // plaintext host → must be dropped
    'h:1a2b3c4d': { paused: 7, domains: {} },           // real hashHost digest → kept
  } });
  eq(A.isPaused(s, 'nytimes.com'), false, 'a plaintext hostname can never survive a load');
  eq(A.isPaused(s, 'h:1a2b3c4d'), true, 'a hashed site key is kept');
  assert(A.isHashKey('h:1a2b3c4d') && !A.isHashKey('nytimes.com'), 'isHashKey guards the boundary');
});

test('po-allow: normalizeState caps domains per site on load', () => {
  const { A } = loadAllow();
  const domains = {};
  for (let i = 0; i < A.MAX_DOMAINS_PER_SITE + 25; i++) domains['d' + i + '.com'] = 1000 + i;
  const s = A.normalizeState({ sites: { 'h:cap': { paused: 0, domains: domains } } });
  eq(A.allowedDomains(s, 'h:cap').length, A.MAX_DOMAINS_PER_SITE, 'load enforces MAX_DOMAINS_PER_SITE');
});

test('po-allow: empty sites auto-prune', () => {
  const { A } = loadAllow();
  let s = A.setDomain(A.emptyState(), 'h:a', 'doubleclick.net', true);
  s = A.setDomain(s, 'h:a', 'doubleclick.net', false); // removed last domain
  eq(Object.keys(s.sites).length, 0);
});

test('po-allow: setters never mutate the input model', () => {
  const { A } = loadAllow();
  const base = A.emptyState();
  const snap = JSON.stringify(base);
  A.setPaused(base, 'h:a', true);
  A.setDomain(base, 'h:a', 'doubleclick.net', true);
  A.clearSite(base, 'h:a');
  eq(JSON.stringify(base), snap);
});

test('po-allow: write then read round-trips through storage', async () => {
  const { A } = loadAllow();
  await new Promise((resolve) => {
    A.write(A.setDomain(A.emptyState(), 'h:a', 'doubleclick.net', true), function () { resolve(); });
  });
  const got = await new Promise((resolve) => { A.read(function (st) { resolve(st); }); });
  assert(A.isDomainAllowed(got, 'h:a', 'doubleclick.net'), 'persisted + read back');
});

// ── timed pause (pausedUntil) ────────────────────────────────────────────────

test('po-allow: legacy paused entries (no pausedUntil) stay paused forever', () => {
  const { A } = loadAllow();
  const legacy = { v: 1, sites: { 'h:a': { paused: 123, domains: {} } } };
  const st = A.normalizeState(legacy);
  eq(st.sites['h:a'].pausedUntil, 0);                    // normalizes to indefinite
  assert(A.isPaused(st, 'h:a'), 'legacy pause = Always');
  eq(A.pauseRemainingMs(st, 'h:a'), -1);                 // -1 = indefinite
});

test('po-allow: a timed pause is active before expiry and OFF the moment it lapses', () => {
  const { A } = loadAllow();
  const now = 1000000;
  const st = A.setPaused(A.emptyState(), 'h:a', true, now + 60000);
  assert(A.isPaused(st, 'h:a', now), 'active before expiry');
  eq(A.pauseRemainingMs(st, 'h:a', now), 60000);
  assert(!A.isPaused(st, 'h:a', now + 60000), 'expired = not paused (fail-safe)');
  eq(A.pauseRemainingMs(st, 'h:a', now + 60001), 0);
});

test('po-allow: isAllowed follows pause expiry (content scripts resume alone)', () => {
  const { A } = loadAllow();
  const now = Date.now();
  // Live timed pause: isAllowed is true for ANY domain on the site (isPaused
  // short-circuits isAllowed), not just ones on the per-domain allow list.
  const live = A.setPaused(A.emptyState(), 'h:a', true, now + 60000);
  assert(A.isPaused(live, 'h:a'), 'paused now');
  assert(A.isAllowed(live, 'h:a', 'doubleclick.net'), 'paused site lets everything through');
  assert(A.isAllowed(live, 'h:a', 'some-random-tracker.example'), 'not limited to a specific domain');
  // Expired timed pause: isAllowed reverts to the per-domain-only decision -
  // an untouched domain is no longer let through automatically.
  const expired = A.setPaused(A.emptyState(), 'h:a', true, now - 1);
  assert(!A.isPaused(expired, 'h:a'), 'expired: not paused');
  assert(!A.isAllowed(expired, 'h:a', 'doubleclick.net'), 'protection back after lapse');
});

test('po-allow: expiredPauses lists only lapsed TIMED pauses; timedPauses lists live ones', () => {
  const { A } = loadAllow();
  const now = 2000000;
  let st = A.emptyState();
  st = A.setPaused(st, 'h:lapsed', true, now - 1);     // expired
  st = A.setPaused(st, 'h:live', true, now + 60000);   // still running
  st = A.setPaused(st, 'h:always', true);              // indefinite
  eq(A.expiredPauses(st, now).join(','), 'h:lapsed');
  const timed = A.timedPauses(st, now);
  eq(timed.length, 1);
  eq(timed[0].oh, 'h:live');
  eq(timed[0].until, now + 60000);
});

test('po-allow: unpausing clears pausedUntil; bad pausedUntil is sanitized', () => {
  const { A } = loadAllow();
  let st = A.setPaused(A.emptyState(), 'h:a', true, Date.now() + 60000);
  st = A.setPaused(st, 'h:a', false);
  assert(!A.isPaused(st, 'h:a'), 'unpaused');
  // A pausedUntil field that IS present but corrupted (string, not a legacy
  // missing-field case) must NOT collapse to indefinite - that would silently
  // turn a broken timed pause into a permanent one. It must read as already
  // expired, so protection comes back instead of staying off forever.
  const junk = A.normalizeState({ v: 1, sites: { 'h:b': { paused: 5, pausedUntil: 'soon', domains: {} } } });
  assert(!isNaN(junk.sites['h:b'].pausedUntil), 'never NaN');
  assert(!A.isPaused(junk, 'h:b'), 'junk expiry does not become Always');
  eq(A.pauseRemainingMs(junk, 'h:b'), 0);
  // A genuinely LEGACY entry (field absent, not corrupted) still means Always.
  const legacy = A.normalizeState({ v: 1, sites: { 'h:c': { paused: 5, domains: {} } } });
  eq(legacy.sites['h:c'].pausedUntil, 0);
  assert(A.isPaused(legacy, 'h:c'), 'legacy entry stays indefinite');
});

test('po-allow: formatPauseLeft renders minutes and hours, hides none/indefinite', () => {
  const { A } = loadAllow();
  eq(A.formatPauseLeft(0), '');
  eq(A.formatPauseLeft(-1), '');
  eq(A.formatPauseLeft(30000), '1m left');       // ceil to the next minute
  eq(A.formatPauseLeft(14 * 60000), '14m left');
  eq(A.formatPauseLeft(60 * 60000), '1h left');
  eq(A.formatPauseLeft(62 * 60000), '1h 2m left');
});
