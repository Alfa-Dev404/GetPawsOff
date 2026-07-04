/* Tests for the v1.1 Prevalence Enforcer (pure logic).
 *
 * The enforcer's chrome-dependent paths self-guard, so requiring the module in
 * Node just gives us its test-export object (module.exports = TESTAPI). We only
 * exercise the PURE functions here: planSync, computeBudget, eligibility, rule
 * shape. Live DNR behaviour (priority, requestDomains matching) is an E2E
 * concern for Playwright.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { test, assert, eq } = require('./harness/framework');

const E = require(path.join(__dirname, '..', 'src', 'learn', 'prevalence-enforcer.js'));

// ── Wiring guard ───────────────────────────────────────────────────────────
// The enforcer is USELESS unless background.js actually importScripts it (it was
// historically never wired, so enforcement could not run at all). It must also
// load AFTER prevalence-learner.js, which it reads as self.__pawsOff_prevalence.
// This pins the wiring so the "never loaded" bug cannot silently return.
test('background.js importScripts the enforcer, after the learner', () => {
  const bg = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'background', 'background.js'), 'utf8');
  const iLearner = bg.indexOf('prevalence-learner.js');
  const iEnforcer = bg.indexOf('prevalence-enforcer.js');
  assert(iEnforcer > -1, 'background.js references prevalence-enforcer.js');
  assert(iLearner > -1, 'background.js references prevalence-learner.js');
  assert(iEnforcer > iLearner, 'enforcer is loaded after the learner it depends on');
});

// [domain, score, verdict, sites?, ageDays?] - sites/age default to values that
// PASS the enforcement warm-up gates so the pre-gate tests keep their meaning.
function rows(list) {
  return list.map((r) => ({
    domain: r[0], score: r[1], verdict: r[2],
    sites: (r[3] === undefined ? 10 : r[3]),
    ageDays: (r[4] === undefined ? 30 : r[4]),
  }));
}

test('computeBudget subtracts headroom + other rules from the shared cap', () => {
  eq(E.computeBudget({ maxDynamic: 30000, headroom: 1000, otherRuleCount: 0, maxLearnRules: 100000 }), 29000);
  eq(E.computeBudget({ maxDynamic: 30000, headroom: 1000, otherRuleCount: 500, maxLearnRules: 100000 }), 28500);
});

test('computeBudget honours the learner self-cap (MAX_LEARN_RULES)', () => {
  eq(E.computeBudget({ maxDynamic: 30000, headroom: 1000, otherRuleCount: 0, maxLearnRules: 5000 }), 5000);
});

test('computeBudget never goes negative', () => {
  eq(E.computeBudget({ maxDynamic: 30000, headroom: 1000, otherRuleCount: 30000, maxLearnRules: 5000 }), 0);
});

test('isEnforceableDomain: essential + covered + exception are all spared', () => {
  const sets = {
    essentialSet: new Set(['stripe.com']),
    coveredSet: new Set(['doubleclick.net']),
    exceptSet: new Set(['mysite-cdn.com'])
  };
  assert(E.isEnforceableDomain('evil-tracker.com', sets) === true, 'unknown tracker is enforceable');
  assert(E.isEnforceableDomain('stripe.com', sets) === false, 'essential safelisted');
  assert(E.isEnforceableDomain('doubleclick.net', sets) === false, 'already covered by EasyPrivacy');
  assert(E.isEnforceableDomain('mysite-cdn.com', sets) === false, 'user exception');
});

test('buildLearnerBlockRule has the right shape + priority 1', () => {
  const r = E.buildLearnerBlockRule('evil-tracker.com', E.LEARN_ID_BASE);
  eq(r.id, E.LEARN_ID_BASE);
  eq(r.priority, 1);
  eq(r.action.type, 'block');
  eq(r.condition.requestDomains[0], 'evil-tracker.com');
  assert(Array.isArray(r.condition.resourceTypes) && r.condition.resourceTypes.length > 0, 'has resource types');
});

test('planSync only blocks verdict==block, skips covered/essential/exception', () => {
  const plan = E.planSync({
    rows: rows([
      ['evil-tracker.com', 9.0, 'block'],
      ['ads-net.com', 7.0, 'block'],
      ['doubleclick.net', 12.0, 'block'],  // covered -> skip
      ['stripe.com', 8.0, 'block'],        // essential -> skip
      ['userbroke.com', 6.0, 'block'],     // exception -> skip
      ['watching.com', 2.0, 'observing'],  // not a block verdict -> skip
      ['fine.com', 0.2, 'allow']
    ]),
    existingLearnerRuleIds: [],
    otherRuleCount: 0,
    coveredSet: new Set(['doubleclick.net']),
    exceptSet: new Set(['userbroke.com'])
  });
  eq(plan.stats.blocked, 2);
  const blocked = plan.addRules.map((r) => r.condition.requestDomains[0]).sort();
  eq(blocked.join(','), 'ads-net.com,evil-tracker.com');
});

test('planSync sorts by score desc and assigns deterministic ids from the band base', () => {
  const plan = E.planSync({
    rows: rows([
      ['low.com', 3.1, 'block'],
      ['high.com', 99.0, 'block'],
      ['mid.com', 50.0, 'block']
    ]),
    existingLearnerRuleIds: [],
    otherRuleCount: 0
  });
  eq(plan.addRules[0].condition.requestDomains[0], 'high.com');
  eq(plan.addRules[0].id, E.LEARN_ID_BASE);
  eq(plan.addRules[1].id, E.LEARN_ID_BASE + 1);
  eq(plan.idMap['high.com'], E.LEARN_ID_BASE);
});

test('planSync respects budget (cap to top offenders)', () => {
  const plan = E.planSync({
    rows: rows([
      ['a.com', 9, 'block'], ['b.com', 8, 'block'], ['c.com', 7, 'block']
    ]),
    existingLearnerRuleIds: [],
    otherRuleCount: 0,
    maxLearnRules: 2
  });
  eq(plan.stats.blocked, 2);
  eq(plan.stats.skipped, 1);
  const kept = plan.addRules.map((r) => r.condition.requestDomains[0]).sort().join(',');
  eq(kept, 'a.com,b.com'); // c.com (lowest score) dropped
});

test('planSync full-reconcile clears the existing band (forgiveness)', () => {
  // A domain previously blocked has now decayed below threshold (not in rows).
  const plan = E.planSync({
    rows: rows([['stillbad.com', 9, 'block']]),
    existingLearnerRuleIds: [E.LEARN_ID_BASE, E.LEARN_ID_BASE + 1, E.LEARN_ID_BASE + 2],
    otherRuleCount: 0
  });
  // every old band id is scheduled for removal...
  assert(plan.removeRuleIds.indexOf(E.LEARN_ID_BASE + 1) >= 0, 'old rule removed');
  assert(plan.removeRuleIds.indexOf(E.LEARN_ID_BASE + 2) >= 0, 'decayed rule removed');
  // ...and only the still-bad domain is re-added.
  eq(plan.addRules.length, 1);
  eq(plan.addRules[0].condition.requestDomains[0], 'stillbad.com');
});

test('planSync removeRuleIds only ever touches the learner band', () => {
  const plan = E.planSync({
    rows: rows([['x.com', 9, 'block']]),
    existingLearnerRuleIds: [9300, 9500, 1, E.LEARN_ID_BASE + 5], // foreign ids must be ignored
    otherRuleCount: 0
  });
  for (const id of plan.removeRuleIds) {
    assert(id >= E.LEARN_ID_BASE && id <= E.LEARN_ID_MAX, 'remove id in band: ' + id);
  }
});

// ── warm-up gates + graduated tiers + cookie-strip (breakage protection) ─────

test('tierFor: hard gates - young or narrow "prevalent" domains are NOT blocked', () => {
  // Fresh CDN pattern: high score but only known 2 days → cookie tier, not block.
  eq(E.tierFor({ domain: 'newcdn.com', score: 6, sites: 8, ageDays: 2, verdict: 'block' }), 'cookie');
  // Seen on too few sites → cookie tier.
  eq(E.tierFor({ domain: 'narrow.com', score: 6, sites: 3, ageDays: 30, verdict: 'block' }), 'cookie');
  // Score below the enforce bar (but above verdict threshold) → cookie tier.
  eq(E.tierFor({ domain: 'warm.com', score: 3.5, sites: 10, ageDays: 30, verdict: 'block' }), 'cookie');
  // All gates passed → beacon block.
  eq(E.tierFor({ domain: 'tracker.com', score: 6, sites: 8, ageDays: 30, verdict: 'block' }), 'block-beacon');
  // Very high score → script tier too.
  eq(E.tierFor({ domain: 'megatracker.com', score: 9, sites: 20, ageDays: 60, verdict: 'block' }), 'block-script');
  // Yellowlisted verdict → cookie tier only, never a hard block.
  eq(E.tierFor({ domain: 'embed.com', score: 12, sites: 30, ageDays: 90, verdict: 'cookieblock' }), 'cookie');
  // Below everything → nothing.
  eq(E.tierFor({ domain: 'quiet.com', score: 1.5, sites: 2, ageDays: 30, verdict: 'observing' }), null);
  // Missing fields fail toward the safer tier (no hard block).
  eq(E.tierFor({ domain: 'nosites.com', score: 9, verdict: 'block' }), 'cookie');
});

test('block rules are beacon-only by default, script tier at high score, thirdParty always', () => {
  const plan = E.planSync({
    rows: rows([
      ['beacon-tracker.com', 6, 'block'],
      ['script-tracker.com', 9, 'block'],
    ]),
    existingLearnerRuleIds: [], otherRuleCount: 0,
  });
  eq(plan.stats.blocked, 2);
  const byDomain = {};
  plan.addRules.forEach((r) => { byDomain[r.condition.requestDomains[0]] = r; });
  eq(byDomain['beacon-tracker.com'].condition.resourceTypes.join(','), 'ping,image,xmlhttprequest');
  eq(byDomain['script-tracker.com'].condition.resourceTypes.join(','), 'ping,image,xmlhttprequest,script');
  // Neither tier may ever block sub_frame/websocket/media (payment/video iframes).
  plan.addRules.forEach((r) => {
    assert(r.condition.resourceTypes.indexOf('sub_frame') < 0, 'no sub_frame blocks');
    assert(r.condition.domainType === 'thirdParty', 'first-party visits are never hit');
  });
});

test('cookie tier: strips cookies without blocking; safelist gates it too (SSO safety)', () => {
  const plan = E.planSync({
    rows: rows([
      ['warmup-tracker.com', 4, 'block'],          // above verdict, below enforce bar
      ['embed-widget.com', 12, 'cookieblock'],     // yellowlisted verdict
      ['google.com', 50, 'cookieblock'],           // essential (SSO) → NOT even cookie-stripped
    ]),
    existingLearnerRuleIds: [], otherRuleCount: 0,
  });
  eq(plan.stats.blocked, 0);
  eq(plan.stats.cookieStripped, 2);
  plan.addRules.forEach((r) => {
    eq(r.action.type, 'modifyHeaders');
    eq(r.action.requestHeaders[0].header, 'cookie');
    eq(r.action.responseHeaders[0].header, 'set-cookie');
    eq(r.condition.domainType, 'thirdParty');
    assert(r.condition.requestDomains[0] !== 'google.com', 'essential domain untouched');
  });
});

test('planSync orders hard blocks before cookie strips within the budget', () => {
  const plan = E.planSync({
    rows: rows([
      ['cookie-high.com', 20, 'cookieblock'],
      ['block-low.com', 6, 'block'],
    ]),
    existingLearnerRuleIds: [], otherRuleCount: 0, maxLearnRules: 1,
  });
  // Only one slot: the hard block wins it even though the cookie row scores higher.
  eq(plan.stats.blocked, 1);
  eq(plan.stats.cookieStripped, 0);
  eq(plan.addRules[0].condition.requestDomains[0], 'block-low.com');
});

test('planSync: dedup keeps the STRONGEST row per base domain, not the first seen', () => {
  // Two hashed learner rows can resolve to the same base domain (e.g. two
  // different subdomains of the same tracker). A weak sighting arriving
  // first in the array must not suppress a later, stronger sighting.
  const weakFirst = E.planSync({
    rows: [
      { domain: 'sneaky.com', score: 2, verdict: 'observing', sites: 1, ageDays: 1 },   // no tier (null) -> ignored
      { domain: 'sneaky.com', score: 3.5, verdict: 'block', sites: 10, ageDays: 30 },    // cookie tier (below hard gates)
      { domain: 'sneaky.com', score: 9, verdict: 'block', sites: 20, ageDays: 60 },      // block-script tier
    ],
    existingLearnerRuleIds: [], otherRuleCount: 0,
  });
  eq(weakFirst.stats.candidates, 1);
  eq(weakFirst.stats.blocked, 1);
  eq(weakFirst.stats.cookieStripped, 0);
  eq(weakFirst.addRules[0].condition.resourceTypes.join(','), 'ping,image,xmlhttprequest,script');

  // Same rows, strongest-first order - result must be identical (order-independent).
  const strongFirst = E.planSync({
    rows: [
      { domain: 'sneaky.com', score: 9, verdict: 'block', sites: 20, ageDays: 60 },
      { domain: 'sneaky.com', score: 3.5, verdict: 'block', sites: 10, ageDays: 30 },
    ],
    existingLearnerRuleIds: [], otherRuleCount: 0,
  });
  eq(strongFirst.stats.blocked, 1);
  eq(strongFirst.addRules[0].condition.resourceTypes.join(','), 'ping,image,xmlhttprequest,script');
});
