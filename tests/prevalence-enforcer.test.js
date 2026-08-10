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
const { loadEnforcer } = require('./harness/sandbox');

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
  const firstImportEnd = bg.indexOf(');', bg.indexOf('importScripts('));
  assert(!bg.slice(bg.indexOf('importScripts('), firstImportEnd).includes('po-allow.js'),
    'pause helpers are isolated from optional prevalence imports');
  assert(bg.indexOf("importScripts('../lib/po-allow.js')") > firstImportEnd,
    'pause helpers load independently');
});

test('enforcer event wiring schedules and reconciles every supported trigger', async () => {
  const loaded = loadEnforcer();
  eq(loaded.messageListeners.length, 1);
  loaded.messageListeners[0](
    { type: 'pawsoff_prevalence_observe' },
    { id: 'pawsoff-test' },
    () => {},
  );
  eq(loaded.alarmCreates[0].name, 'pawsoff_pv_enforce_soon', 'observations schedule a near-term reconcile');

  const beforeAlarms = loaded.getDynamicReads();
  loaded.alarmListeners[0]({ name: 'pawsoff_pv_enforce' });
  loaded.alarmListeners[0]({ name: 'pawsoff_pv_enforce_soon' });
  await new Promise((resolve) => setImmediate(resolve));
  eq(loaded.getDynamicReads(), beforeAlarms + 2, 'daily and near-term alarms both reconcile');

  const beforeStorage = loaded.getDynamicReads();
  loaded.storageListeners[0]({ unrelated: { newValue: true } }, 'local');
  eq(loaded.getDynamicReads(), beforeStorage, 'irrelevant storage changes are ignored');
  loaded.storageListeners[0]({ __pawsOff_master_enabled: { newValue: false } }, 'local');
  loaded.storageListeners[0]({ __pawsOff_pixelBlock_settings: { newValue: {} } }, 'local');
  await new Promise((resolve) => setImmediate(resolve));
  eq(loaded.getDynamicReads(), beforeStorage + 2, 'master and tracker-setting changes reconcile');
});

test('overlapping learner syncs serialize and reconcile the pending state', async () => {
  const loaded = loadEnforcer();
  let reads = 0;
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  loaded.chrome.declarativeNetRequest.getDynamicRules = () => {
    reads += 1;
    if (reads !== 1) return Promise.resolve([]);
    markFirstStarted();
    return new Promise((resolve) => { releaseFirst = resolve; });
  };

  const first = loaded.internals.syncLearnerRules();
  await firstStarted;
  const second = loaded.internals.syncLearnerRules();
  eq(reads, 1, 'overlapping request waits for the active reconciliation');
  releaseFirst([]);
  await Promise.all([first, second]);
  eq(reads, 2, 'pending request reconciles once after the active run');
});

test('pause feedback persists validated radar hashes without resolving plaintext domains', async () => {
  const loaded = loadEnforcer();
  await loaded.internals.exceptSnapshot({
    spotted: [
      { domainHash: 'h:1234abcd', verdict: 'block' },
      { domainHash: 'h:2345bcde', verdict: 'cookieblock' },
      { domainHash: 'h:3456cdef', verdict: 'observing' },
      { domainHash: 'tracker.example', verdict: 'block' },
    ],
  });
  const stored = loaded.getStore().__pawsOff_pv_enforce_except;
  eq(Object.keys(stored).sort().join(','), 'h:1234abcd,h:2345bcde');
  assert(!JSON.stringify(stored).includes('tracker.example'), 'exception feedback remains hash-only');
});

// [domain, score, verdict, sites?, ageDays?] — sites/age default to values that
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
      ['ads-net.com', 10.0, 'block'],
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
      ['low.com', 8.1, 'block'],
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
      ['a.com', 12, 'block'], ['b.com', 10, 'block'], ['c.com', 9, 'block']
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

test('tierFor: hard gates — young or narrow "prevalent" domains are NOT blocked', () => {
  // Fresh CDN pattern: high score but only known 2 days → cookie tier, not block.
  eq(E.tierFor({ domain: 'newcdn.com', score: 9, sites: 12, ageDays: 2, verdict: 'block' }), 'cookie');
  // Seen on too few sites → cookie tier.
  eq(E.tierFor({ domain: 'narrow.com', score: 9, sites: 3, ageDays: 30, verdict: 'block' }), 'cookie');
  // Score below the enforce bar (but above verdict threshold) → cookie tier.
  eq(E.tierFor({ domain: 'warm.com', score: 3.5, sites: 10, ageDays: 30, verdict: 'block' }), 'cookie');
  // All gates passed → beacon block.
  eq(E.tierFor({ domain: 'tracker.com', score: 9, sites: 12, ageDays: 30, verdict: 'block' }), 'block-beacon');
  // Very high score → script tier too.
  eq(E.tierFor({ domain: 'megatracker.com', score: 16, sites: 20, ageDays: 60, verdict: 'block' }), 'block-script');
  // Yellowlisted verdict → cookie tier only, never a hard block.
  eq(E.tierFor({ domain: 'embed.com', score: 12, sites: 30, ageDays: 90, verdict: 'cookieblock' }), 'cookie');
  // Below everything → nothing.
  eq(E.tierFor({ domain: 'quiet.com', score: 1.5, sites: 2, ageDays: 30, verdict: 'observing' }), null);
  // Missing fields fail toward the safer tier (no hard block).
  eq(E.tierFor({ domain: 'nosites.com', score: 9, verdict: 'block' }), 'cookie');
  eq(E.tierFor({ domain: 'nan.com', score: NaN, sites: 10, ageDays: 30, verdict: 'block' }), null);
});

test('block rules are beacon-only by default, script tier at high score, thirdParty always', () => {
  const plan = E.planSync({
    rows: rows([
      ['beacon-tracker.com', 9, 'block'],
      ['script-tracker.com', 16, 'block'],
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
      ['block-low.com', 9, 'block'],
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
      { domain: 'sneaky.com', score: 16, verdict: 'block', sites: 20, ageDays: 60 },     // block-script tier
    ],
    existingLearnerRuleIds: [], otherRuleCount: 0,
  });
  eq(weakFirst.stats.candidates, 1);
  eq(weakFirst.stats.blocked, 1);
  eq(weakFirst.stats.cookieStripped, 0);
  eq(weakFirst.addRules[0].condition.resourceTypes.join(','), 'ping,image,xmlhttprequest,script');

  // Same rows, strongest-first order — result must be identical (order-independent).
  const strongFirst = E.planSync({
    rows: [
      { domain: 'sneaky.com', score: 16, verdict: 'block', sites: 20, ageDays: 60 },
      { domain: 'sneaky.com', score: 3.5, verdict: 'block', sites: 10, ageDays: 30 },
    ],
    existingLearnerRuleIds: [], otherRuleCount: 0,
  });
  eq(strongFirst.stats.blocked, 1);
  eq(strongFirst.addRules[0].condition.resourceTypes.join(','), 'ping,image,xmlhttprequest,script');
});

test('mode mapping: standard is safe default, preview shadows, adaptive applies', () => {
  eq(E.modeFromFlags(false, false), 'standard');
  eq(E.modeFromFlags(true, true), 'preview');
  eq(E.modeFromFlags(true, false), 'adaptive');
  const standard = E.flagsForMode('unknown');
  assert(!standard.enabled && standard.shadow, 'unknown mode fails to Standard');
  const preview = E.flagsForMode('preview');
  assert(preview.enabled && preview.shadow, 'preview computes only');
  const adaptive = E.flagsForMode('adaptive');
  assert(adaptive.enabled && !adaptive.shadow, 'adaptive is explicit active mode');
});

test('setMode persists both mode flags before asking for a rule sync', async () => {
  const previousChrome = global.chrome;
  const writes = [];
  const reads = [];
  let releaseWrite;
  const heldWrite = new Promise((resolve) => { releaseWrite = resolve; });
  global.chrome = {
    storage: {
      local: {
        set: (payload) => { writes.push(payload); return heldWrite; },
        get: (keys) => { reads.push(keys); return Promise.resolve({}); },
      },
    },
    declarativeNetRequest: {
      getDynamicRules: () => Promise.resolve([]),
      getSessionRules: () => Promise.resolve([]),
      updateDynamicRules: () => Promise.resolve(),
    },
  };
  try {
    let settled = false;
    const pending = E.setMode('adaptive').then((result) => { settled = true; return result; });
    await Promise.resolve();
    eq(writes.length, 1, 'mode flags are written together');
    assert(writes[0].__pawsOff_pv_enforce_enabled, 'adaptive enables enforcement');
    assert(!writes[0].__pawsOff_pv_enforce_shadow, 'adaptive leaves preview mode');
    assert(!settled, 'setMode remains pending until persistence completes');
    eq(reads.length, 0, 'synchronization has not started before persistence');
    releaseWrite();
    const result = await pending;
    eq(result.reason, 'no_dnr', 'synchronization runs only after persistence is released');
  } finally {
    if (previousChrome === undefined) delete global.chrome;
    else global.chrome = previousChrome;
  }
});

test('setMode reports persistence failure without synchronizing old state', async () => {
  const previousChrome = global.chrome;
  let reads = 0;
  global.chrome = {
    storage: { local: {
      set: () => Promise.reject(new Error('disk unavailable')),
      get: () => { reads += 1; return Promise.resolve({}); },
    } },
    declarativeNetRequest: { updateDynamicRules: () => Promise.resolve() },
  };
  try {
    const result = await E.setMode('adaptive');
    assert(!result.ok, 'failure is surfaced');
    eq(result.reason, 'storage_failed');
    eq(reads, 0, 'old persisted mode is never synchronized');
  } finally {
    if (previousChrome === undefined) delete global.chrome;
    else global.chrome = previousChrome;
  }
});

test('learner failures clear stale adaptive rules', async () => {
  const previousChrome = global.chrome;
  const removals = [];
  global.chrome = {
    declarativeNetRequest: {
      updateDynamicRules: (update) => { removals.push(update.removeRuleIds); return Promise.resolve(); },
    },
  };
  try {
    let result = await E.syncEnabledLearner(null, false, { bandIds: [E.LEARN_ID_BASE] });
    eq(result.reason, 'no_learner');
    eq(removals.length, 1, 'unavailable learner clears its old band');

    const brokenLearner = {
      getStats: () => Promise.reject(new Error('unreadable')),
      resolveSpots: () => Promise.resolve({}),
    };
    result = await E.syncEnabledLearner(brokenLearner, false, { bandIds: [E.LEARN_ID_BASE + 1], otherRuleCount: 0 });
    eq(result.reason, 'learner_read_failed');
    eq(removals.length, 2, 'failed learner read also clears its old band');
  } finally {
    if (previousChrome === undefined) delete global.chrome;
    else global.chrome = previousChrome;
  }
});

test('exception storage failures clear stale adaptive rules', async () => {
  const previousChrome = global.chrome;
  const removals = [];
  global.chrome = {
    storage: {
      local: {
        get: () => Promise.reject(new Error('unreadable')),
        set: () => Promise.reject(new Error('unwritable')),
      },
    },
    declarativeNetRequest: {
      getDynamicRules: () => Promise.resolve([{ id: E.LEARN_ID_BASE }]),
      getSessionRules: () => Promise.resolve([]),
      updateDynamicRules: (update) => { removals.push(update.removeRuleIds); return Promise.resolve(); },
    },
  };
  try {
    let rejected = false;
    try { await E.loadExceptSet(); } catch (_) { rejected = true; }
    assert(rejected, 'exception reads fail closed instead of returning an empty allow set');

    const result = await E.addExceptions(['tracker.example']);
    eq(result.reason, 'storage_failed');
    eq(removals.length, 1, 'failed exception persistence removes the learner rule band');
    eq(removals[0][0], E.LEARN_ID_BASE);
  } finally {
    if (previousChrome === undefined) delete global.chrome;
    else global.chrome = previousChrome;
  }
});

test('unreadable protection state stands adaptive enforcement down', async () => {
  const previousChrome = global.chrome;
  global.chrome = { storage: { local: { get: () => Promise.reject(new Error('unreadable')) } } };
  try {
    assert(!(await E.isTrackerProtectionEnabled()), 'storage rejection is fail-open for the page');
  } finally {
    if (previousChrome === undefined) delete global.chrome;
    else global.chrome = previousChrome;
  }
});

test('persisted learner metadata and exceptions contain hashes only', async () => {
  const sample = E.previewSample({ addRules: [{
    action: { type: 'block' },
    condition: { requestDomains: ['tracker.example'] },
  }] });
  assert(!JSON.stringify(sample).includes('tracker.example'), 'preview sample is hash-only');
  assert(/^h:[0-9a-f]{8}$/.test(sample[0].h), 'preview carries the canonical host hash');

  const previousChrome = global.chrome;
  let written;
  global.chrome = { storage: { local: { set: (payload) => { written = payload; return Promise.resolve(); } } } };
  try {
    await E.storeExceptionBases({
      __pawsOff_pv_enforce_except: { 'legacy-plaintext.example': 1 },
    }, ['tracker.example']);
    const serialized = JSON.stringify(written);
    assert(!serialized.includes('tracker.example'), 'new exception hostname is not persisted');
    assert(!serialized.includes('legacy-plaintext.example'), 'legacy plaintext exception is purged');
    const stored = written.__pawsOff_pv_enforce_except;
    assert(Object.keys(stored).every((key) => /^h:[0-9a-f]{8}$/.test(key)), 'exception keys are hashes');
  } finally {
    if (previousChrome === undefined) delete global.chrome;
    else global.chrome = previousChrome;
  }
});

test('tracker protection: global pause or Trackers off suppresses adaptive enforcement', () => {
  assert(E.trackerProtectionEnabled({}), 'missing state defaults to protection on');
  assert(E.trackerProtectionEnabled({ __pawsOff_pixelBlock_settings: { globalEnabled: true } }), 'Trackers on');
  assert(!E.trackerProtectionEnabled({ __pawsOff_master_enabled: false }), 'master pause suppresses rules');
  assert(!E.trackerProtectionEnabled({ __pawsOff_pixelBlock_settings: { globalEnabled: false } }), 'Trackers off suppresses rules');
});

test('adaptive enforcement reports a stale-rule removal failure', async () => {
  const previousChrome = global.chrome;
  global.chrome = {
    declarativeNetRequest: {
      updateDynamicRules: () => Promise.reject(new Error('quota exceeded')),
    },
  };
  try {
    assert(!(await E.clearBand([E.LEARN_ID_BASE])), 'failed removal is surfaced');
  } finally {
    if (previousChrome === undefined) delete global.chrome;
    else global.chrome = previousChrome;
  }
});

test('dynamic-state reads fail closed instead of impersonating an empty ruleset', async () => {
  const previousChrome = global.chrome;
  global.chrome = {
    declarativeNetRequest: {
      getDynamicRules: () => Promise.reject(new Error('unreadable')),
      getSessionRules: () => Promise.resolve([]),
    },
  };
  try {
    let rejected = false;
    try { await E.getDynamicState(); } catch (_) { rejected = true; }
    assert(rejected, 'DNR read failure is preserved');
  } finally {
    if (previousChrome === undefined) delete global.chrome;
    else global.chrome = previousChrome;
  }
});

test('adaptive update failures explicitly clear the stale learner band', async () => {
  const previousChrome = global.chrome;
  const updates = [];
  global.chrome = {
    declarativeNetRequest: {
      updateDynamicRules: (update) => {
        updates.push(update);
        return updates.length === 1
          ? Promise.reject(new Error('reconcile failed'))
          : Promise.resolve();
      },
    },
  };
  try {
    const plan = {
      removeRuleIds: [E.LEARN_ID_BASE],
      addRules: [],
      stats: { blocked: 0, cookieStripped: 0, budget: 0, candidates: 0 },
    };
    const result = await E.saveAdaptivePlan(plan, { bandIds: [E.LEARN_ID_BASE] });
    eq(result.reason, 'update_failed');
    eq(updates.length, 2, 'failed reconcile is followed by explicit cleanup');
    eq(updates[1].removeRuleIds[0], E.LEARN_ID_BASE);
  } finally {
    if (previousChrome === undefined) delete global.chrome;
    else global.chrome = previousChrome;
  }
});

test('adaptive cleanup failures are surfaced as clear_failed', async () => {
  const previousChrome = global.chrome;
  global.chrome = {
    declarativeNetRequest: {
      updateDynamicRules: () => Promise.reject(new Error('unavailable')),
    },
  };
  try {
    const plan = {
      removeRuleIds: [E.LEARN_ID_BASE],
      addRules: [],
      stats: { blocked: 0, cookieStripped: 0, budget: 0, candidates: 0 },
    };
    const result = await E.saveAdaptivePlan(plan, { bandIds: [E.LEARN_ID_BASE] });
    eq(result.reason, 'clear_failed');
  } finally {
    if (previousChrome === undefined) delete global.chrome;
    else global.chrome = previousChrome;
  }
});
