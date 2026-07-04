/* PawsOff - EasyPrivacy DELTA feed: unit tests for the pure logic (v1.0).
 *
 * The delta feed is a signed, live top-up of tracker domains applied as a
 * small, quota-bounded set of DYNAMIC DNR rules - for trackers that emerge
 * BETWEEN refreshes of the bundled static ruleset (which can only ever be
 * updated via an ordinary extension release, never a live fetch). This file
 * covers the PURE functions only: schema validation, budget math, and rule
 * planning. Live chrome.declarativeNetRequest behaviour (actually applying a
 * rule, priority ordering against real DNR state) is an E2E concern.
 *
 * DORMANT BY DESIGN, same as the prevalence enforcer: __pawsOff_ep_delta_enabled
 * defaults false and no shipped UI flips it - these tests pin the SAFETY
 * properties (budget respected, id band collision-free, dedup against the
 * bundled list, shadow mode applies nothing) that must hold before anyone
 * ever turns this on.
 */
'use strict';
const path = require('path');
const { test, assert, eq } = require('./harness/framework');
const { loadBackground } = require('./harness/sandbox');

const loaded = loadBackground();
const I = loaded.internals || {};
const {
  validateDeltaConfig,
  computeDeltaBudget,
  planDeltaRules,
  DELTA_ID_BASE,
  DELTA_ID_MAX,
  DELTA_PRIORITY,
  MAX_DELTA_RULES,
  DELTA_RESOURCE_TYPES,
  DELTA_ALLOWED_RESOURCE_TYPES,
  DNR_ID_MIN,
  DNR_ID_MAX,
  ALLOW_PAUSE_ID_BASE,
  ALLOW_PAUSE_ID_SPAN,
  ALLOW_DOMAIN_ID_BASE,
  ALLOW_DOMAIN_ID_SPAN,
} = I;

// Enforcer TESTAPI is available via plain require() (module.exports = TESTAPI
// when loaded outside the SW sandbox) - see tests/prevalence-enforcer.test.js.
const E = require(path.join(__dirname, '..', 'src', 'learn', 'prevalence-enforcer.js'));

test('easyprivacy-delta: the guarded test hook exposes the pure helpers', () => {
  ['validateDeltaConfig', 'computeDeltaBudget', 'planDeltaRules'].forEach((k) => {
    assert(typeof I[k] === 'function', k + ' is a function');
  });
});

// ── id band: collision-free against every other DNR band in the extension ────
test('DELTA id band (20000-29999) does not collide with any existing band', () => {
  eq(DELTA_ID_BASE, 20000);
  eq(DELTA_ID_MAX, 29999);
  const bands = [
    ['PixelBlock', DNR_ID_MIN, DNR_ID_MAX],
    ['site-pause', ALLOW_PAUSE_ID_BASE, ALLOW_PAUSE_ID_BASE + ALLOW_PAUSE_ID_SPAN - 1],
    ['per-domain allow', ALLOW_DOMAIN_ID_BASE, ALLOW_DOMAIN_ID_BASE + ALLOW_DOMAIN_ID_SPAN - 1],
    ['prevalence-enforcer/learner', E.LEARN_ID_BASE, E.LEARN_ID_MAX],
  ];
  for (const [name, lo, hi] of bands) {
    const overlaps = lo <= DELTA_ID_MAX && DELTA_ID_BASE <= hi;
    assert(!overlaps, 'delta band must not overlap ' + name + ' (' + lo + '-' + hi + ')');
  }
  // Self-cap stays comfortably inside the band's own span.
  assert(MAX_DELTA_RULES <= (DELTA_ID_MAX - DELTA_ID_BASE + 1), 'self-cap fits the band span');
});

test('DELTA_PRIORITY stays below the user allow-list priority (2), same as the enforcer', () => {
  eq(DELTA_PRIORITY, 1);
  eq(DELTA_PRIORITY, E.LEARN_PRIORITY); // both dynamic-block tiers sit below user allow
});

// ── validateDeltaConfig ────────────────────────────────────────────────────
test('validateDeltaConfig: accepts a well-formed feed, rejects everything else', () => {
  assert(validateDeltaConfig({
    schemaVersion: 1, configVersion: '2026-07-02.1',
    domains: [{ domain: 'newtracker.example' }, { domain: 'sneaky.io', resourceTypes: ['ping'] }],
  }), 'valid feed accepted');
  assert(!validateDeltaConfig(null), 'null rejected');
  assert(!validateDeltaConfig('not an object'), 'string rejected');
  assert(!validateDeltaConfig({ schemaVersion: 2, configVersion: '1', domains: [] }), 'wrong schema version rejected');
  assert(!validateDeltaConfig({ schemaVersion: 1, configVersion: 5, domains: [] }), 'non-string configVersion rejected');
  assert(!validateDeltaConfig({ schemaVersion: 1, configVersion: '1', domains: 'nope' }), 'domains must be an array');
  assert(!validateDeltaConfig({ schemaVersion: 1, configVersion: '1', domains: [{ domain: '' }] }), 'empty domain string rejected');
  assert(!validateDeltaConfig({ schemaVersion: 1, configVersion: '1', domains: [{}] }), 'missing domain field rejected');
  assert(!validateDeltaConfig({ schemaVersion: 1, configVersion: '1', domains: [{ domain: 'x.com', resourceTypes: 'ping' }] }),
    'resourceTypes must be an array, not a string');
  assert(validateDeltaConfig({ schemaVersion: 1, configVersion: '1', domains: [] }), 'empty domains list is still valid (nothing to add)');
});

// ── resourceTypes CEILING - the signed feed may pick, never expand, the set
//    of blockable resource types. Without this, feed content alone would
//    decide whether a domain can hit main_frame/sub_frame/websocket/media,
//    defeating the "never auto-blocks a frame/payment/video load" guarantee
//    the whole feature is built around. ─────────────────────────────────────
test('validateDeltaConfig: rejects the WHOLE config if any domain smuggles an out-of-bounds resourceType', () => {
  const smuggled = ['main_frame', 'sub_frame', 'websocket', 'media', 'object', 'csp_report', 'other'];
  for (const t of smuggled) {
    assert(!validateDeltaConfig({
      schemaVersion: 1, configVersion: '1',
      domains: [{ domain: 'fine.com' }, { domain: 'evil.com', resourceTypes: [t] }],
    }), 'rejects resourceTypes containing ' + t);
  }
  // Mixing one allowed + one disallowed type in the SAME array still rejects -
  // partial legitimacy does not launder the disallowed entry through.
  assert(!validateDeltaConfig({
    schemaVersion: 1, configVersion: '1',
    domains: [{ domain: 'x.com', resourceTypes: ['ping', 'sub_frame'] }],
  }), 'one bad type in an otherwise-fine array still rejects the config');
  assert(!validateDeltaConfig({
    schemaVersion: 1, configVersion: '1', domains: [{ domain: 'x.com', resourceTypes: [] }],
  }), 'empty resourceTypes array rejected (ambiguous - omit the field for the default instead)');
});
test('validateDeltaConfig: accepts every type actually in the allow-list', () => {
  for (const t of Array.from(DELTA_ALLOWED_RESOURCE_TYPES)) {
    assert(validateDeltaConfig({
      schemaVersion: 1, configVersion: '1', domains: [{ domain: 'x.com', resourceTypes: [t] }],
    }), t + ' is allowed');
  }
});

// ── computeDeltaBudget - same shared-30k-cap math as the enforcer's, kept
//    independently so neither dormant system can destabilise the other ──────
test('computeDeltaBudget: subtracts headroom + other rules from the shared cap', () => {
  eq(computeDeltaBudget({ maxDynamic: 30000, headroom: 1000, otherRuleCount: 0 }), 2000); // capped by MAX_DELTA_RULES
  eq(computeDeltaBudget({ maxDynamic: 30000, headroom: 1000, otherRuleCount: 0, selfCap: 100000 }), 10000); // capped by span
  // available (9000) now binds instead of spanCap (10000) or selfCap (100000) -
  // proves otherRuleCount genuinely shrinks the budget, not just along for the ride.
  eq(computeDeltaBudget({ maxDynamic: 15000, headroom: 1000, otherRuleCount: 5000, selfCap: 100000 }), 9000);
});
test('computeDeltaBudget: never goes negative', () => {
  eq(computeDeltaBudget({ maxDynamic: 30000, headroom: 1000, otherRuleCount: 30000 }), 0);
});
test('computeDeltaBudget: respects a custom selfCap (MAX_DELTA_RULES default)', () => {
  eq(computeDeltaBudget({ maxDynamic: 30000, headroom: 1000, otherRuleCount: 0, selfCap: 5 }), 5);
});

// ── planDeltaRules ──────────────────────────────────────────────────────────
test('planDeltaRules: builds thirdParty block rules, deterministic ids from DELTA_ID_BASE', () => {
  const domains = [{ domain: 'tracker-a.com' }, { domain: 'tracker-b.com' }];
  const { addRules, idMap } = planDeltaRules(domains, new Set(), 10);
  eq(addRules.length, 2);
  eq(addRules[0].id, DELTA_ID_BASE);
  eq(addRules[1].id, DELTA_ID_BASE + 1);
  eq(addRules[0].priority, DELTA_PRIORITY);
  eq(addRules[0].action.type, 'block');
  eq(addRules[0].condition.requestDomains[0], 'tracker-a.com');
  eq(addRules[0].condition.domainType, 'thirdParty');
  eq(addRules[0].condition.resourceTypes.join(','), DELTA_RESOURCE_TYPES.join(','));
  eq(idMap[DELTA_ID_BASE], 'tracker-a.com');
  eq(idMap[DELTA_ID_BASE + 1], 'tracker-b.com');
});

test('planDeltaRules: an ALLOWED per-domain resourceTypes override is honoured', () => {
  const { addRules } = planDeltaRules([{ domain: 'scripty.com', resourceTypes: ['script', 'ping'] }], new Set(), 10);
  eq(addRules[0].condition.resourceTypes.join(','), 'script,ping');
});

test('planDeltaRules: defense-in-depth - an out-of-bounds override falls back to the safe default, never through', () => {
  // validateDeltaConfig should already reject this config upstream, but
  // planDeltaRules is independently callable and must not trust its input.
  const { addRules } = planDeltaRules(
    [{ domain: 'evil.com', resourceTypes: ['sub_frame', 'websocket', 'main_frame'] }], new Set(), 10,
  );
  eq(addRules[0].condition.resourceTypes.join(','), DELTA_RESOURCE_TYPES.join(','));
  addRules[0].condition.resourceTypes.forEach((t) => {
    assert(DELTA_ALLOWED_RESOURCE_TYPES.has(t), t + ' is within the allowed ceiling');
  });
});

test('planDeltaRules: EVERY produced rule stays within the allowed resourceTypes ceiling, regardless of input', () => {
  const domains = [
    { domain: 'a.com', resourceTypes: ['sub_frame'] },
    { domain: 'b.com' }, // no override -> default
    { domain: 'c.com', resourceTypes: ['script'] }, // legal override
    { domain: 'd.com', resourceTypes: ['media', 'websocket'] },
  ];
  const { addRules } = planDeltaRules(domains, new Set(), 10);
  eq(addRules.length, 4);
  addRules.forEach((r) => {
    r.condition.resourceTypes.forEach((t) => {
      assert(DELTA_ALLOWED_RESOURCE_TYPES.has(t), 'rule for ' + r.condition.requestDomains[0] + ' stays in bounds: ' + t);
    });
  });
});

test('planDeltaRules: skips domains already covered by the bundled static list', () => {
  const covered = new Set(['already-blocked.com']);
  const { addRules } = planDeltaRules(
    [{ domain: 'already-blocked.com' }, { domain: 'new-one.com' }], covered, 10,
  );
  eq(addRules.length, 1);
  eq(addRules[0].condition.requestDomains[0], 'new-one.com');
});

test('planDeltaRules: dedupes repeated/case-varied domains within the same feed', () => {
  const { addRules } = planDeltaRules(
    [{ domain: 'Tracker.com' }, { domain: 'tracker.com' }, { domain: 'TRACKER.COM' }], new Set(), 10,
  );
  eq(addRules.length, 1);
});

test('planDeltaRules: stops at the budget, never exceeds it', () => {
  const domains = Array.from({ length: 20 }, (_, i) => ({ domain: 't' + i + '.example' }));
  const { addRules } = planDeltaRules(domains, new Set(), 5);
  eq(addRules.length, 5);
});

test('planDeltaRules: garbage/empty domain entries are skipped, never throw', () => {
  const { addRules } = planDeltaRules(
    [{ domain: '' }, { domain: null }, {}, { domain: '  ' }, { domain: 'real.com' }], new Set(), 10,
  );
  eq(addRules.length, 1);
  eq(addRules[0].condition.requestDomains[0], 'real.com');
});

test('planDeltaRules: empty input produces an empty plan, not a throw', () => {
  const { addRules, idMap } = planDeltaRules([], new Set(), 10);
  eq(addRules.length, 0);
  eq(Object.keys(idMap).length, 0);
});

// ── syncEasyPrivacyDeltaRules: a real DNR removal failure must be reported,
//    never swallowed as ok:true (CodeRabbit finding, 2026-07-03) ────────────
// Both the "disabled/master-off" and "shadow" branches clear the delta band
// via updateDynamicRules before returning. If that call throws, the failure
// must propagate to the outer catch (ok:false) - reporting ok:true while a
// removal silently failed would misrepresent "protection stood down" as true
// when old block rules could still be live.
test('syncEasyPrivacyDeltaRules: a DNR removal failure while disabled is reported, not swallowed', async () => {
  const { internals: I, chrome } = loadBackground();
  chrome.declarativeNetRequest.getDynamicRules = () => Promise.resolve([{ id: 20005 }]); // a stale delta rule
  chrome.declarativeNetRequest.updateDynamicRules = () => Promise.reject(new Error('quota exceeded'));
  // DELTA_ENABLED_KEY unset -> defaults to disabled -> takes the removal path.
  const res = await I.syncEasyPrivacyDeltaRules();
  eq(res.ok, false);
});

test('syncEasyPrivacyDeltaRules: a DNR removal failure entering shadow mode is reported, not swallowed', async () => {
  const { internals: I, chrome } = loadBackground();
  chrome.storage.local.set({ __pawsOff_ep_delta_enabled: true }); // shadow defaults true when enabled
  chrome.declarativeNetRequest.getDynamicRules = () => Promise.resolve([{ id: 20005 }]);
  chrome.declarativeNetRequest.updateDynamicRules = () => Promise.reject(new Error('quota exceeded'));
  const res = await I.syncEasyPrivacyDeltaRules();
  eq(res.ok, false);
});

test('syncEasyPrivacyDeltaRules: succeeds normally when DNR calls succeed (sanity)', async () => {
  const { internals: I, chrome } = loadBackground();
  const res = await I.syncEasyPrivacyDeltaRules(); // disabled by default, nothing to remove
  eq(res.ok, true);
  eq(res.enabled, false);
});
