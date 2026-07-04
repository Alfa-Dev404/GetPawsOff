/* PawsOff - Tier-1 unit tests for the Pixel & Tracker Swatter (pixel-block.js).
 *
 * Covers the PURE, side-effect-free core of the content script:
 *   - classifyUrl(): the 4-way allow / skip / block / inspect decision that
 *     decides whether an <img> is a tracking pixel. This is the heart of the
 *     feature and the place a bug either breaks real images (over-block) or
 *     leaks a spy pixel (under-block), so it gets the most cases:
 *       • inline refs (cid:/blob:) are ALLOWED, data: is SKIPPED (no network)
 *       • a provider's legitimate proxy (Gmail googleusercontent) is ALLOWED
 *         even though it is remote - it already shields the user
 *       • known tracker domains + unambiguous tracker path/query are BLOCKED
 *       • everything unknown falls through to INSPECT (load-time size probe)
 *   - matchesTrackerDomain() exact + subdomain matching
 *   - hostOf() hostname extraction + lowercasing (logging de-identification)
 *   - parseSrcset() candidate extraction
 *   - isExcluded() provider-UI guard
 *   - defaultSettings()/normalizeSettings() forward-compatible settings coercion
 *   - knownLimitations() (iCloud cross-origin iframe) + PROVIDER_CONFIG sanity
 *
 * The DOM-mutating half (processImg, neutralize, the size-probe, the observer)
 * is Tier-2 (jsdom) and runs on a real machine. The harness loads the REAL
 * shipping file and satisfies its existing Jest-style hook (no source edit).
 */
'use strict';

const { test, assert, eq } = require('./harness/framework');
const { loadPixelBlock } = require('./harness/sandbox');

const loaded = loadPixelBlock();
const P = loaded.internals || {};
const {
  hostOf,
  matchesTrackerDomain,
  classifyUrl,
  parseSrcset,
  isExcluded,
  defaultSettings,
  normalizeSettings,
  knownLimitations,
  TRACKING_DOMAINS,
  TRANSPARENT_PNG,
  PROVIDER_CONFIG,
  TRACKER_PATH_STRONG,
  TRACKER_QUERY_STRONG,
} = P;

const gmail = (PROVIDER_CONFIG || []).find((p) => p.id === 'gmail');

test('pixelBlock: the Jest-style hook exposes the pure helpers', () => {
  assert(P && typeof P === 'object', '__test object exposed');
  ['classifyUrl', 'matchesTrackerDomain', 'hostOf', 'parseSrcset', 'normalizeSettings'].forEach((k) => {
    assert(typeof P[k] === 'function', k + ' is a function');
  });
  assert(gmail, 'Gmail provider present in PROVIDER_CONFIG');
});

// ── classifyUrl ───────────────────────────────────────────────────
test('classifyUrl: inline refs are allowed; data: is skipped (no network)', () => {
  eq(classifyUrl('cid:abc@mail', gmail), 'allow', 'cid: inline attachment');
  eq(classifyUrl('blob:https://x/y', gmail), 'allow', 'blob: local object URL');
  eq(classifyUrl('data:image/png;base64,AAAA', gmail), 'skip', 'data: makes no request');
});

test('classifyUrl: empty / non-http / unparseable input is skipped', () => {
  eq(classifyUrl('', gmail), 'skip', 'empty');
  eq(classifyUrl(null, gmail), 'skip', 'null');
  eq(classifyUrl('ftp://example.com/p.png', gmail), 'skip', 'non-http(s) protocol');
});

test('classifyUrl: a provider legitimate proxy is allowed (outranks block)', () => {
  // Gmail proxies remote images through googleusercontent - already shielding.
  // The allowlist matches the full proxy host and its subdomains (host === p ||
  // host.endsWith('.' + p)), so derive a real entry rather than guess.
  const proxy = gmail.legitimateProxies[0];
  assert(typeof proxy === 'string' && proxy.length > 0, 'Gmail has a legitimate proxy host');
  eq(classifyUrl('https://' + proxy + '/abc', gmail), 'allow', 'exact proxy host');
  eq(classifyUrl('https://sub.' + proxy + '/abc', gmail), 'allow', 'proxy subdomain');
});

test('classifyUrl: a known tracker domain is blocked', () => {
  const tracker = TRACKING_DOMAINS[0];
  assert(typeof tracker === 'string' && tracker.length > 0, 'have a tracker domain to test');
  eq(classifyUrl('https://' + tracker + '/pixel.png', gmail), 'block', tracker + ' is blocked');
});

test('classifyUrl: an unambiguous tracker path is blocked', () => {
  const strongPath = TRACKER_PATH_STRONG[0]; // e.g. "/track"
  eq(classifyUrl('https://newsletter.example.com' + strongPath + '/x.gif', gmail), 'block', strongPath + ' path');
});

test('classifyUrl: an unambiguous tracker query is blocked', () => {
  const strongQuery = TRACKER_QUERY_STRONG.find((q) => q.indexOf('=') !== -1) || 'mc_eid=';
  const url = 'https://img.example.com/open?' + strongQuery + '123';
  eq(classifyUrl(url, gmail), 'block', strongQuery + ' query');
});

test('classifyUrl: an ordinary unknown image falls through to inspect', () => {
  eq(classifyUrl('https://cdn.example.com/photo.jpg', gmail), 'inspect', 'no strong signal → inspect');
});

// ── matchesTrackerDomain ──────────────────────────────────────────
test('matchesTrackerDomain: exact host and subdomains match; others do not', () => {
  const tracker = TRACKING_DOMAINS[0];
  assert(matchesTrackerDomain(tracker), 'exact tracker host matches');
  assert(matchesTrackerDomain('sub.deep.' + tracker), 'a subdomain of a tracker matches');
  assert(!matchesTrackerDomain('not-a-tracker-9999.example'), 'an unrelated host does not match');
  assert(!matchesTrackerDomain(''), 'empty host does not match');
});

// ── hostOf ─────────────────────────────────────────────────────
test('hostOf: extracts a lowercased hostname', () => {
  eq(hostOf('https://Mail.GOOGLE.com/path?q=1'), 'mail.google.com', 'lowercased host');
  eq(hostOf('ftp://Foo.Example.COM/x'), 'foo.example.com', 'works regardless of scheme');
});

// ── parseSrcset ───────────────────────────────────────────────
test('parseSrcset: extracts candidate URLs, dropping descriptors', () => {
  const out = parseSrcset('a.png 1x, https://x.com/b.png 2x, c.png');
  eq(out.length, 3);
  eq(out[0], 'a.png');
  eq(out[1], 'https://x.com/b.png');
  eq(out[2], 'c.png');
  eq(parseSrcset('').length, 0, 'empty srcset → []');
  eq(parseSrcset(null).length, 0, 'null srcset → []');
});

// ── isExcluded ────────────────────────────────────────────────
test('isExcluded: true only when the element is inside provider UI chrome', () => {
  assert(isExcluded({ closest: () => ({}) }, gmail), 'element inside an excluded region');
  assert(!isExcluded({ closest: () => null }, gmail), 'element not inside any excluded region');
  assert(!isExcluded({ closest: () => ({}) }, { excludeSelectors: [] }), 'no exclude selectors → never excluded');
});

// ── settings ──────────────────────────────────────────────────
test('defaultSettings: protection on globally and per provider', () => {
  const s = defaultSettings();
  eq(s.globalEnabled, true);
  eq(s.providers.gmail, true, 'gmail on by default');
  eq(Object.keys(s.providers).length, PROVIDER_CONFIG.length, 'one toggle per provider - cannot drift');
});

test('normalizeSettings: coerces partial/invalid input, defaulting missing toggles on', () => {
  eq(normalizeSettings(null).globalEnabled, true, 'non-object → defaults (fail-open)');
  const out = normalizeSettings({ globalEnabled: false, providers: { gmail: false, bogusProvider: true } });
  eq(out.globalEnabled, false, 'explicit global off respected');
  eq(out.providers.gmail, false, 'explicit provider off respected');
  eq(out.providers.protonmail, true, 'missing provider defaults on (forward-compatible)');
  assert(!('bogusProvider' in out.providers), 'unknown provider keys are dropped');
  eq(normalizeSettings({ providers: { gmail: 'yes' } }).providers.gmail, true, 'non-boolean toggle ignored');
});

// ── knownLimitations + config sanity ─────────────────────────────────
test('knownLimitations: surfaces iCloud as cross-origin-iframe limited', () => {
  const lim = knownLimitations();
  assert(Array.isArray(lim) && lim.length >= 1, 'at least one known limitation');
  const icloud = lim.find((l) => l.provider === 'icloud');
  assert(icloud, 'iCloud is reported');
  assert(/iframe/i.test(icloud.reason), 'reason explains the cross-origin iframe limit');
});

test('PROVIDER_CONFIG + TRANSPARENT_PNG are well-formed', () => {
  assert(Array.isArray(PROVIDER_CONFIG) && PROVIDER_CONFIG.length > 0, 'non-empty provider list');
  PROVIDER_CONFIG.forEach((p) => {
    assert(typeof p.id === 'string' && p.id.length > 0, 'provider has an id');
    assert(Array.isArray(p.hosts) && p.hosts.length > 0, p.id + ' has hosts');
  });
  assert(typeof TRANSPARENT_PNG === 'string' && /^data:image\//.test(TRANSPARENT_PNG), 'transparent pixel is a data: image');
});

// ── proxy-aware classification (Gmail / Proton / generic proxies) ────────────
// Webmail proxies rewrite remote images but the ORIGINAL url rides inside the
// proxied one; the proxy still pings the tracker at open time (that IS the
// read receipt), so a tracker must stay blocked behind any proxy.

test('extractEmbeddedUrl: fragment (Gmail), encoded query (Proton), path carry', () => {
  const { extractEmbeddedUrl } = P;
  // Gmail: original URL after '#'
  eq(extractEmbeddedUrl('https://ci3.googleusercontent.com/meips/OPQ=s0-d-e1-ft#https://mailtrack.io/trace/mail/a.gif'),
    'https://mailtrack.io/trace/mail/a.gif');
  // Proton: URL-encoded in a query param
  eq(extractEmbeddedUrl('https://mail.proton.me/api/core/v4/images?Url=https%3A%2F%2Fmailtrack.io%2Ftrace%2Fmail%2Fa.gif'),
    'https://mailtrack.io/trace/mail/a.gif');
  // Plain query param carry
  eq(extractEmbeddedUrl('https://proxy.example.com/img?u=https://mailtrack.io/a.gif'),
    'https://mailtrack.io/a.gif');
  // Path carry
  eq(extractEmbeddedUrl('https://proxy.example.com/cache/https://mailtrack.io/a.gif'),
    'https://mailtrack.io/a.gif');
  // Nothing embedded → ''
  eq(extractEmbeddedUrl('https://cdn.example.com/cat.jpg'), '');
  eq(extractEmbeddedUrl('https://cdn.example.com/cat.jpg#section-2'), '');
  eq(extractEmbeddedUrl(null), '');
});

test('classifyUrl: Gmail-proxied TRACKER pixels are blocked (fragment decode)', () => {
  // ci3 is on Gmail's legitimateProxies list - the embedded check must run FIRST.
  eq(classifyUrl('https://ci3.googleusercontent.com/meips/OPQ=s0-d-e1-ft#https://mailtrack.io/trace/mail/a.gif', gmail),
    'block', 'known tracker domain behind the listed proxy');
  // ci6 shard is NOT on the list; decode still catches the tracker.
  eq(classifyUrl('https://ci6.googleusercontent.com/meips/OPQ=s0-d-e1-ft#https://open.mailtrack.io/wf/open?upn=xyz', gmail),
    'block', 'strong tracker path (/wf/open) behind an unlisted shard');
});

test('classifyUrl: legitimate proxied images still load (no false positives)', () => {
  // A real photo behind the Gmail proxy stays allowed.
  eq(classifyUrl('https://ci3.googleusercontent.com/meips/LEGIT#https://example.com/cat-photo.jpg', gmail),
    'allow', 'listed proxy + clean embedded target');
  // Unlisted shard + clean target falls through to inspect/skip - never block.
  const c = classifyUrl('https://ci6.googleusercontent.com/meips/LEGIT#https://example.com/cat-photo.jpg', gmail);
  assert(c !== 'block', 'clean embedded target on unlisted shard is not blocked (got ' + c + ')');
});

test('classifyUrl: Proton-style encoded proxy carries are blocked too', () => {
  const proton = (PROVIDER_CONFIG || []).find((p) => p.id === 'protonmail');
  assert(proton, 'proton provider present');
  eq(classifyUrl('https://mail.proton.me/api/core/v4/images?Url=https%3A%2F%2Fmailtrack.io%2Ftrace%2Fmail%2Fa.gif', proton),
    'block', 'encoded tracker behind the Proton image proxy');
  eq(classifyUrl('https://mail.proton.me/api/core/v4/images?Url=https%3A%2F%2Fexample.com%2Fphoto.jpg', proton) !== 'block', true,
    'clean encoded target not blocked');
});
