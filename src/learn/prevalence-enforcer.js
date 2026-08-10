/* PawsOff, Prevalence Enforcer — service-worker side.
 *
 * Turns the observe-only learner's verdicts into active, self-cleaning
 * declarativeNetRequest rules. The learner only scores; this module decides
 * what to actually do about a 'block' verdict, protecting hard against
 * breakage along the way:
 *   - never touches the bundled ESSENTIAL_DOMAINS safelist, anything already
 *     covered by the static EasyPrivacy ruleset, or a user exception (the
 *     "this broke a site" feedback loop); yellowlisted domains stay
 *     cookieblock, never a hard block
 *   - every sync fully reconciles its own rule band — clears it, re-adds only
 *     what's currently desired — so a decayed score naturally un-blocks with
 *     zero drift between Chrome's rules and our state
 *   - the 30,000 dynamic+session rule cap is shared with allow/pause; budget
 *     is computed from what's actually free, and updateDynamicRules rejects
 *     atomically so a failure never half-applies
 *   - block rules run at priority 1, below the user's own allow rules (2),
 *     so an explicit unbreak always wins with no special-case logic
 *
 * Dormant by default (__pawsOff_pv_enforce_enabled), and even once enabled,
 * shadow mode (__pawsOff_pv_enforce_shadow, default true) computes the plan
 * into storage without applying a single rule — real would-block data before
 * any rollout decision. Warm-up gates hold a stricter bar than the learner's
 * own verdict threshold: a hard block needs score>=8 on >=10 sites known
 * >=14 days, starts beacon-only, adds scripts only at score>=15, and never
 * touches sub_frame/websocket/media. Anything below that bar — plus every
 * yellowlisted verdict — gets cookies stripped instead of blocked, so the
 * resource still loads but the tracker goes anonymous. Pausing a site
 * auto-excepts its flagged domains (self-healing). Candidates are named by
 * joining hash-only radar entries to the learner's memory-only live labels,
 * so enforcement requires fresh local evidence and stores no browsing labels.
 *
 * Requires self.PawsOffPSL and self.__pawsOff_prevalence; background.js
 * loads both first via importScripts. Self-registers its own message +
 * alarm listeners (additive — the main router is undisturbed).
 */
'use strict';
(function (root) {
  var NS = {};
  try { root.__pawsOff_enforcer = NS; } catch (_) { /* ignore */ }

  // ── Storage keys ─────────────────────────────────────────────────────
  var ENABLED_KEY = '__pawsOff_pv_enforce_enabled'; // boolean, default false
  var SHADOW_KEY  = '__pawsOff_pv_enforce_shadow';  // boolean, default TRUE: compute, never apply
  var IDMAP_KEY   = '__pawsOff_pv_enforce_idmap';   // legacy key, overwritten with an empty object
  var EXCEPT_KEY  = '__pawsOff_pv_enforce_except';   // { hashHost(domain): ts } user exceptions
  var META_KEY    = '__pawsOff_pv_enforce_meta';     // { updated, blocked, budget, candidates }
  var MASTER_KEY  = '__pawsOff_master_enabled';
  var TRACKER_SETTINGS_KEY = '__pawsOff_pixelBlock_settings';
  var RADAR_PREFIX = '__pawsOff_radar_';             // collector snapshots (hash-only spotted domains)
  var ENFORCE_ALARM = 'pawsoff_pv_enforce';
  var ENFORCE_SOON_ALARM = 'pawsoff_pv_enforce_soon';

  // ── Warm-up gates (breakage protection) ─────────────────────────────
  // Stricter than the learner's own BLOCK_THRESHOLD (3), so a merely-popular
  // newcomer (a fresh CDN) never gets blocked outright.
  var ENFORCE_MIN_SCORE    = 8;
  var ENFORCE_MIN_SITES    = 10;
  var ENFORCE_MIN_AGE_DAYS = 14;
  var SCRIPT_TIER_SCORE    = 15;
  var COOKIE_MIN_SCORE     = 3;   // matches the learner's verdict threshold
  var MAX_EXCEPTIONS       = 500; // LRU cap on the "this broke a site" list

  // ── Rule band + tuning ───────────────────────────────────────────
  // Learner band 40000–69999 is well clear of the existing PawsOff bands:
  //   9100–9199 pixel-block providers, 9300–9499 site-pause, 9500–9999 allow.
  var LEARN_ID_BASE = 40000;
  var LEARN_ID_MAX  = 69999;            // span 30000
  var LEARN_PRIORITY = 1;               // MUST stay below ALLOW_PRIORITY (2)
  var MAX_DYNAMIC = 30000;              // chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES
  try {
    if (root.chrome && chrome.declarativeNetRequest &&
        typeof chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES === 'number') {
      MAX_DYNAMIC = chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES;
    }
  } catch (_) { /* ignore */ }
  var BUDGET_HEADROOM = 1000;           // never claim the last 1000 slots
  var MAX_LEARN_RULES = 5000;           // sane self-cap, far under the shared budget
  var GET_STATS_TOPN = 100000;          // pull the full scored list from the learner

  // Beacon carriers only by default: the request types trackers ride and pages
  // almost never need from a third party. Scripts join only at the high tier;
  // sub_frame / websocket / media are NEVER auto-blocked (payment + video
  // iframes are where breakage lives).
  var BEACON_RESOURCE_TYPES = ['ping', 'image', 'xmlhttprequest'];
  var SCRIPT_RESOURCE_TYPES = ['ping', 'image', 'xmlhttprequest', 'script'];
  // Cookie-strip applies broadly: removing cookies never stops a resource from
  // loading, so the wider net costs nothing functionally.
  var COOKIE_RESOURCE_TYPES = [
    'script', 'xmlhttprequest', 'image', 'ping', 'media', 'websocket', 'sub_frame', 'other'
  ];

  // ── ESSENTIAL_DOMAINS safelist (base domains, NEVER auto-blocked) ──────────
  // Infrastructure that appears on many sites but is needed for them to work.
  // Extend/replace later via signed remote config (same channel as the lists).
  var ESSENTIAL_DOMAINS = new Set([
    // CDNs / fonts / libraries
    'gstatic.com', 'googleapis.com', 'googleusercontent.com', 'ggpht.com', 'gvt1.com', 'gvt2.com',
    'cloudflare.com', 'cloudfront.net', 'fastly.net', 'akamai.net', 'akamaihd.net', 'akamaized.net',
    'jsdelivr.net', 'unpkg.com', 'jquery.com', 'bootstrapcdn.com', 'fontawesome.com', 'typekit.net',
    // Payments
    'stripe.com', 'stripe.network', 'paypal.com', 'paypalobjects.com', 'braintreegateway.com',
    'braintree-api.com', 'adyen.com', 'checkout.com', 'squareup.com', 'square.com', 'klarna.com',
    // Captcha / human-check
    'recaptcha.net', 'hcaptcha.com', 'arkoselabs.com', 'funcaptcha.com',
    // Auth / SSO
    'google.com', 'apple.com', 'microsoftonline.com', 'auth0.com', 'okta.com', 'onelogin.com',
    'gravatar.com',
    // Video / media players
    'youtube.com', 'ytimg.com', 'vimeo.com', 'vimeocdn.com', 'brightcove.net', 'jwpcdn.com', 'jwplayer.com'
  ]);

  // ── base-domain helper (uses PSL-lite when present) ───────────────────────
  function pslBase(host) {
    try {
      if (root.PawsOffPSL) return root.PawsOffPSL.getBaseDomain(host) || host;
    } catch (_) { /* ignore */ }
    return host;
  }

  function validBaseHost(host) {
    if (host.indexOf('.') < 0) return false;
    return /^[a-z0-9.\-]+$/.test(host);
  }

  function normBase(host) {
    if (typeof host !== 'string') return '';
    if (!host) return '';
    var h = pslBase(host.toLowerCase().trim());
    h = (h || '').toLowerCase().trim().replace(/\.$/, '');
    return validBaseHost(h) ? h : '';
  }

  function setContains(set, domain) {
    return !!set && set.has(domain);
  }

  // ── PURE: is this domain eligible for an auto-block rule? ──────────────────
  function isEnforceableDomain(domain, sets) {
    if (!domain) return false;
    sets = sets || {};
    if (setContains(sets.essentialSet, domain)) return false;
    if (setContains(sets.coveredSet, domain)) return false;
    if (setContains(sets.exceptSet, domain)) return false;
    if (setContains(sets.exceptSet, hashHost(domain))) return false;
    return true;
  }

  // ── PURE: how many learner rules may we add right now? ─────────────────────
  function computeBudget(o) {
    o = o || {};
    var maxDynamic   = typeof o.maxDynamic === 'number' ? o.maxDynamic : MAX_DYNAMIC;
    var headroom     = typeof o.headroom === 'number' ? o.headroom : BUDGET_HEADROOM;
    var otherRules   = typeof o.otherRuleCount === 'number' ? o.otherRuleCount : 0;
    var selfCap      = typeof o.maxLearnRules === 'number' ? o.maxLearnRules : MAX_LEARN_RULES;
    var spanCap      = (LEARN_ID_MAX - LEARN_ID_BASE) + 1;
    var available    = maxDynamic - headroom - otherRules;
    var budget = Math.min(selfCap, spanCap, available);
    return budget > 0 ? budget : 0;
  }

  // ── PURE: build one block rule ──────────────────────────────────────
  // requestDomains:[base] also matches subdomains, so one rule covers the
  // registrable domain. priority 1 keeps it below the user's allow rules (2).
  // domainType 'thirdParty' guarantees the rule can never fire when the user
  // VISITS the domain itself (first-party is never the learner's business).
  function buildLearnerBlockRule(domain, id, resourceTypes) {
    return {
      id: id,
      priority: LEARN_PRIORITY,
      action: { type: 'block' },
      condition: {
        requestDomains: [domain],
        domainType: 'thirdParty',
        resourceTypes: (resourceTypes || BEACON_RESOURCE_TYPES).slice()
      }
    };
  }
  // ── PURE: build one cookie-strip rule ────────────────────────────────
  // modifyHeaders (possible since the manifest gained http/https host
  // permissions): the resource still loads so nothing breaks, but the request
  // carries no cookies and the response can't set any — the tracker sees an
  // anonymous fetch. Used for yellowlisted/cookieblock verdicts and for block
  // candidates still inside their warm-up window.
  function buildCookieStripRule(domain, id) {
    return {
      id: id,
      priority: LEARN_PRIORITY,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'cookie', operation: 'remove' }],
        responseHeaders: [{ header: 'set-cookie', operation: 'remove' }]
      },
      condition: {
        requestDomains: [domain],
        domainType: 'thirdParty',
        resourceTypes: COOKIE_RESOURCE_TYPES.slice()
      }
    };
  }
  // ── PURE: which enforcement tier does a scored row earn? ─────────────
  // Returns 'block-script' | 'block-beacon' | 'cookie' | null. Rows must carry
  // {score, sites, ageDays, verdict}; missing fields fail toward the safer tier.
  function numericRowValue(value) {
    return Number.isFinite(value) ? value : 0;
  }
  function hardBlockTier(score, sites, age) {
    if (score < ENFORCE_MIN_SCORE) return null;
    if (sites < ENFORCE_MIN_SITES) return null;
    if (age < ENFORCE_MIN_AGE_DAYS) return null;
    return score >= SCRIPT_TIER_SCORE ? 'block-script' : 'block-beacon';
  }
  function blockTier(score, sites, age) {
    var hard = hardBlockTier(score, sites, age);
    if (hard) return hard;
    return score >= COOKIE_MIN_SCORE ? 'cookie' : null;
  }
  function tierFor(row) {
    if (!row) return null;
    var score = numericRowValue(row.score);
    if (row.verdict === 'block') return blockTier(score, numericRowValue(row.sites), numericRowValue(row.ageDays));
    if (row.verdict === 'cookieblock') return score >= COOKIE_MIN_SCORE ? 'cookie' : null;
    return null;
  }

  function tierRank(tier) {
    if (tier === 'block-script') return 3;
    if (tier === 'block-beacon') return 2;
    if (tier === 'cookie') return 1;
    return 0;
  }

  function strongerCandidate(candidate, previous) {
    var candidateRank = tierRank(candidate.tier);
    var previousRank = tierRank(previous.tier);
    if (candidateRank !== previousRank) return candidateRank > previousRank;
    return candidate.score > previous.score;
  }

  function candidateFromRow(row, sets) {
    var tier = tierFor(row);
    if (!tier) return null;
    var domain = normBase(row.domain);
    if (!isEnforceableDomain(domain, sets)) return null;
    return { domain: domain, score: numericRowValue(row.score), tier: tier };
  }

  function dedupeCandidates(rows, sets) {
    var byDomain = {};
    for (var i = 0; i < rows.length; i++) {
      var candidate = candidateFromRow(rows[i], sets);
      if (!candidate) continue;
      var previous = byDomain[candidate.domain];
      if (!previous || strongerCandidate(candidate, previous)) byDomain[candidate.domain] = candidate;
    }
    return Object.keys(byDomain).map(function (domain) { return byDomain[domain]; });
  }

  function blockCandidate(candidate) {
    return candidate.tier.indexOf('block') === 0;
  }

  function sortCandidates(candidates) {
    candidates.sort(function (left, right) {
      var leftBlocks = blockCandidate(left) ? 1 : 0;
      var rightBlocks = blockCandidate(right) ? 1 : 0;
      if (leftBlocks !== rightBlocks) return rightBlocks - leftBlocks;
      return right.score - left.score;
    });
    return candidates;
  }

  function requestedBudget(args) {
    return computeBudget({
      otherRuleCount: numericRowValue(args.otherRuleCount),
      maxDynamic: args.maxDynamic,
      headroom: args.headroom,
      maxLearnRules: args.maxLearnRules
    });
  }

  function candidateRule(candidate, id) {
    if (candidate.tier === 'cookie') return buildCookieStripRule(candidate.domain, id);
    var types = candidate.tier === 'block-script' ? SCRIPT_RESOURCE_TYPES : BEACON_RESOURCE_TYPES;
    return buildLearnerBlockRule(candidate.domain, id, types);
  }

  function buildCandidateRules(desired) {
    var result = { addRules: [], idMap: {}, blocked: 0, cookieStripped: 0 };
    for (var i = 0; i < desired.length; i++) {
      var id = LEARN_ID_BASE + i;
      if (id > LEARN_ID_MAX) break;
      var candidate = desired[i];
      result.addRules.push(candidateRule(candidate, id));
      result.idMap[candidate.domain] = id;
      if (candidate.tier === 'cookie') result.cookieStripped += 1;
      else result.blocked += 1;
    }
    return result;
  }

  function validLearnerRuleId(value) {
    var id = Number(value);
    if (!Number.isInteger(id)) return null;
    if (id < LEARN_ID_BASE) return null;
    if (id > LEARN_ID_MAX) return null;
    return id;
  }

  function removalIds(existingIds, addRules) {
    var removeSet = {};
    for (var i = 0; i < existingIds.length; i++) {
      var id = validLearnerRuleId(existingIds[i]);
      if (id !== null) removeSet[id] = 1;
    }
    for (var j = 0; j < addRules.length; j++) removeSet[addRules[j].id] = 1;
    return Object.keys(removeSet).map(Number);
  }

  // ── PURE: compute the full DNR update from learner scores ──────────────────
  // Full-reconcile strategy: removeRuleIds = everything currently in our band;
  // addRules = the top-scoring desired domains. Deterministic, drift-free.
  function planSync(args) {
    args = args || {};
    var rows = Array.isArray(args.rows) ? args.rows : [];
    var existingLearnerRuleIds = Array.isArray(args.existingLearnerRuleIds) ? args.existingLearnerRuleIds : [];
    var sets = {
      essentialSet: args.essentialSet || ESSENTIAL_DOMAINS,
      coveredSet: args.coveredSet || null,
      exceptSet: args.exceptSet || null
    };

    var candidates = sortCandidates(dedupeCandidates(rows, sets));
    var budget = requestedBudget(args);
    var desired = candidates.slice(0, budget);
    var built = buildCandidateRules(desired);

    return {
      addRules: built.addRules,
      removeRuleIds: removalIds(existingLearnerRuleIds, built.addRules),
      idMap: built.idMap,
      stats: {
        candidates: candidates.length,
        blocked: built.blocked,
        cookieStripped: built.cookieStripped,
        budget: budget,
        skipped: Math.max(0, candidates.length - built.addRules.length)
      }
    };
  }

  // ══════════════════ ASYNC ORCHESTRATION (chrome-dependent) ═════════════════
  var _coveredCache = null; // Set<baseDomain> from packaged easyprivacy-domains.json

  function canLoadCoveredSet() {
    if (!root.chrome) return false;
    if (!chrome.runtime) return false;
    if (!chrome.runtime.getURL) return false;
    return typeof fetch === 'function';
  }

  function coveredSetFromArray(domains) {
    var covered = new Set();
    if (!Array.isArray(domains)) return covered;
    for (var i = 0; i < domains.length; i++) {
      var base = normBase(domains[i]);
      if (base) covered.add(base);
    }
    return covered;
  }

  function loadCoveredSet() {
    if (_coveredCache) return Promise.resolve(_coveredCache);
    try {
      if (!canLoadCoveredSet()) {
        _coveredCache = new Set(); return Promise.resolve(_coveredCache);
      }
      var url = chrome.runtime.getURL('src/rules/easyprivacy-domains.json');
      return fetch(url).then(function (res) { return res.json(); }).then(function (arr) {
        _coveredCache = coveredSetFromArray(arr);
        return _coveredCache;
      }).catch(function () { _coveredCache = new Set(); return _coveredCache; });
    } catch (_) { _coveredCache = new Set(); return Promise.resolve(_coveredCache); }
  }

  function isEnabled() {
    return chrome.storage.local.get(ENABLED_KEY)
      .then(function (r) { return !!(r && r[ENABLED_KEY]); })
      .catch(function () { return false; });
  }
  // Shadow defaults TRUE: even once enforcement is enabled, the first mode is
  // "compute the plan, write it to META, apply NOTHING" so real would-block
  // data exists before a single request is touched.
  function isShadow() {
    return chrome.storage.local.get(SHADOW_KEY)
      .then(function (r) { return !(r && r[SHADOW_KEY] === false); })
      .catch(function () { return true; });
  }

  // The popup's Trackers pill and global guard must stand down every adaptive
  // DNR rule while preserving the user's Standard/Preview/Adaptive selection.
  // Missing state defaults on so a storage read failure does not weaken privacy.
  function trackerProtectionEnabled(stored) {
    if (!stored || typeof stored !== 'object') return true;
    if (stored[MASTER_KEY] === false) return false;
    var trackerSettings = stored[TRACKER_SETTINGS_KEY];
    return !(trackerSettings && typeof trackerSettings === 'object' && trackerSettings.globalEnabled === false);
  }
  function hasLocalStorage() {
    return !!root.chrome && !!chrome.storage && !!chrome.storage.local;
  }
  function isTrackerProtectionEnabled() {
    if (!hasLocalStorage()) return Promise.resolve(false);
    return chrome.storage.local.get([MASTER_KEY, TRACKER_SETTINGS_KEY])
      .then(trackerProtectionEnabled)
      .catch(function () { return false; });
  }

  function modeFromFlags(enabled, shadow) {
    if (!enabled) return 'standard';
    return shadow ? 'preview' : 'adaptive';
  }
  function flagsForMode(mode) {
    if (mode === 'preview') return { enabled: true, shadow: true };
    if (mode === 'adaptive') return { enabled: true, shadow: false };
    return { enabled: false, shadow: true };
  }

  // Same FNV-1a/32 digest the collector/learner use, so radar keys and hashed
  // learner rows can be joined.
  function hashHost(host) {
    if (!host || typeof host !== 'string') return null;
    var h = 0x811c9dc5;
    var s = host.toLowerCase();
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return 'h:' + h.toString(16).padStart(8, '0');
  }

  function isHashKey(value) {
    return typeof value === 'string' && /^h:[0-9a-f]{8}$/.test(value);
  }

  function collectRadarHashes() {
    return chrome.storage.local.get(null).then(function (all) {
      var hashes = {};
      for (var k in all) {
        if (!Object.prototype.hasOwnProperty.call(all, k)) continue;
        if (k.indexOf(RADAR_PREFIX) !== 0) continue;
        addSnapshotHashes(all[k], hashes);
      }
      return hashes;
    }).catch(function () { return {}; });
  }
  function addSnapshotHashes(snapshot, hashes) {
    var spotted = snapshot && snapshot.spotted;
    if (!Array.isArray(spotted)) return;
    for (var i = 0; i < spotted.length; i++) addRadarHash(spotted[i], hashes);
  }
  function addRadarHash(spot, hashes) {
    var key = spot && spot.domainHash;
    if (/^h:[0-9a-f]{8}$/.test(key || '')) hashes[key] = true;
  }
  function collectLiveRadarNames(learner) {
    if (!learner || typeof learner.resolveSpots !== 'function') return Promise.resolve({});
    return collectRadarHashes().then(function (hashes) {
      return learner.resolveSpots(Object.keys(hashes));
    }).catch(function () { return {}; });
  }
  function loadExceptSet() {
    return chrome.storage.local.get(EXCEPT_KEY).then(function (r) {
      var exceptions = sanitizedExceptions(r && r[EXCEPT_KEY]);
      var payload = {};
      payload[EXCEPT_KEY] = exceptions;
      return chrome.storage.local.set(payload).then(function () {
        return new Set(Object.keys(exceptions));
      });
    });
  }

  function getDynamicState() {
    var dnr = (typeof chrome !== 'undefined') && chrome.declarativeNetRequest;
    var pDyn = (dnr && dnr.getDynamicRules) ? dnr.getDynamicRules() : Promise.resolve([]);
    var pSes = (dnr && dnr.getSessionRules) ? dnr.getSessionRules() : Promise.resolve([]);
    return Promise.all([pDyn, pSes]).then(dynamicStateFromRules);
  }

  function dynamicStateFromRules(result) {
    var dynamicRules = Array.isArray(result[0]) ? result[0] : [];
    var sessionRules = Array.isArray(result[1]) ? result[1] : [];
    var state = { bandIds: [], otherRuleCount: sessionRules.length };
    for (var i = 0; i < dynamicRules.length; i++) {
      var id = validLearnerRuleId(dynamicRules[i] && dynamicRules[i].id);
      if (id === null) state.otherRuleCount += 1;
      else state.bandIds.push(id);
    }
    return state;
  }

  function clearBand(bandIds) {
    if (!bandIds || !bandIds.length) return Promise.resolve(true);
    return chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: bandIds, addRules: [] })
      .then(function () { return true; }).catch(function () { return false; });
  }

  function clearAfterLearnerFailure(dyn, reason) {
    return clearBand(dyn.bandIds).then(function (cleared) {
      return { ok: false, reason: cleared ? reason : 'clear_failed' };
    });
  }

  function cleanupCurrentLearnerBand(reason) {
    var dnr = (typeof chrome !== 'undefined') && chrome.declarativeNetRequest;
    if (!dnr || typeof dnr.getDynamicRules !== 'function') {
      return Promise.resolve({ ok: false, reason: 'clear_failed' });
    }
    return dnr.getDynamicRules().then(function (rules) {
      return dynamicStateFromRules([rules, []]);
    }).then(function (dyn) {
      return clearAfterLearnerFailure(dyn, reason);
    }).catch(function () {
      return { ok: false, reason: 'clear_failed' };
    });
  }

  function learnerAvailable(learner) {
    return !!learner && typeof learner.getStats === 'function';
  }

  function saveSuppressedState(enabled, shadow, dyn, protectionEnabled) {
    return clearBand(dyn.bandIds).then(function (cleared) {
      if (!cleared) return { ok: false, reason: 'clear_failed' };
      var mode = modeFromFlags(enabled, shadow);
      var suppressed = enabled && !protectionEnabled;
      var payload = {};
      payload[META_KEY] = {
        updated: Date.now(), mode: mode, shadow: shadow,
        suppressed: suppressed, blocked: 0, cookieStripped: 0
      };
      return chrome.storage.local.set(payload).catch(function () {}).then(function () {
        return {
          ok: true, enabled: enabled, shadow: shadow, mode: mode,
          suppressed: suppressed, blocked: 0
        };
      });
    });
  }

  function namedLearnerRows(stats, names) {
    var hashedRows = Array.isArray(stats.top) ? stats.top : [];
    var rows = [];
    for (var i = 0; i < hashedRows.length; i++) {
      var row = hashedRows[i];
      var name = row && names[row.domain];
      if (!name) continue;
      rows.push({ domain: name, score: row.score, sites: row.sites, ageDays: row.ageDays, verdict: row.verdict });
    }
    return rows;
  }

  function planFromLearnerParts(parts, dyn) {
    var stats = parts[0] || {};
    return planSync({
      rows: namedLearnerRows(stats, parts[3] || {}),
      existingLearnerRuleIds: dyn.bandIds,
      otherRuleCount: dyn.otherRuleCount,
      essentialSet: ESSENTIAL_DOMAINS,
      coveredSet: parts[1],
      exceptSet: parts[2]
    });
  }

  function previewSample(plan) {
    return plan.addRules.slice(0, 50).map(function (rule) {
      var action = rule.action.type === 'block' ? 'block' : 'cookie';
      return { h: hashHost(rule.condition.requestDomains[0]), a: action };
    });
  }

  function savePreviewPlan(plan, dyn) {
    return clearBand(dyn.bandIds).then(function (cleared) {
      if (!cleared) return { ok: false, reason: 'clear_failed' };
      var payload = {};
      payload[META_KEY] = {
        updated: Date.now(), mode: 'preview', shadow: true,
        wouldBlock: plan.stats.blocked,
        wouldCookieStrip: plan.stats.cookieStripped,
        budget: plan.stats.budget,
        candidates: plan.stats.candidates,
        sample: previewSample(plan)
      };
      return chrome.storage.local.set(payload).catch(function () {}).then(function () {
        return {
          ok: true, enabled: true, shadow: true, mode: 'preview',
          wouldBlock: plan.stats.blocked, wouldCookieStrip: plan.stats.cookieStripped
        };
      });
    });
  }

  function saveAdaptivePlan(plan, dyn) {
    return chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: plan.removeRuleIds,
      addRules: plan.addRules
    }).then(function () {
      var payload = {};
      payload[IDMAP_KEY] = {};
      payload[META_KEY] = {
        updated: Date.now(), mode: 'adaptive', shadow: false,
        blocked: plan.stats.blocked, cookieStripped: plan.stats.cookieStripped,
        budget: plan.stats.budget, candidates: plan.stats.candidates
      };
      return chrome.storage.local.set(payload).catch(function () {}).then(function () {
        return {
          ok: true, enabled: true, shadow: false, mode: 'adaptive',
          blocked: plan.stats.blocked, cookieStripped: plan.stats.cookieStripped,
          budget: plan.stats.budget, candidates: plan.stats.candidates
        };
      });
    }).catch(function (err) {
      try { console.warn('[PawsOff] enforcer updateDynamicRules failed:', err && err.message); } catch (_) {}
      return clearAfterLearnerFailure(dyn, 'update_failed');
    });
  }

  function syncEnabledLearner(learner, shadow, dyn) {
    if (!learnerAvailable(learner)) return clearAfterLearnerFailure(dyn, 'no_learner');
    var reads = [
      function () { return learner.getStats(GET_STATS_TOPN); },
      loadCoveredSet,
      loadExceptSet,
      function () { return collectLiveRadarNames(learner); },
    ];
    return Promise.all(reads.map(function (read) { return Promise.resolve().then(read); }))
      .then(function (parts) {
        var plan = planFromLearnerParts(parts, dyn);
        return shadow ? savePreviewPlan(plan, dyn) : saveAdaptivePlan(plan, dyn);
      }).catch(function () {
        return clearAfterLearnerFailure(dyn, 'learner_read_failed');
      });
  }

  function syncFromPreconditions(pre, learner) {
    var enabled = pre[0];
    var shadow = pre[1];
    var protectionEnabled = pre[2];
    var dyn = pre[3];
    if (!enabled) return saveSuppressedState(enabled, shadow, dyn, protectionEnabled);
    if (!protectionEnabled) return saveSuppressedState(enabled, shadow, dyn, protectionEnabled);
    return syncEnabledLearner(learner, shadow, dyn);
  }

  function canUpdateDynamicRules() {
    if (!root.chrome) return false;
    if (!chrome.declarativeNetRequest) return false;
    return !!chrome.declarativeNetRequest.updateDynamicRules;
  }

  function reconcileLearnerRules() {
    var learner = root.__pawsOff_prevalence;
    if (!canUpdateDynamicRules()) {
      return Promise.resolve({ ok: false, reason: 'no_dnr' });
    }
    return Promise.all([isEnabled(), isShadow(), isTrackerProtectionEnabled(), getDynamicState()])
      .then(function (pre) { return syncFromPreconditions(pre, learner); })
      .catch(function () { return cleanupCurrentLearnerBand('state_read_failed'); });
  }

  // The one entry point: serialize and coalesce every alarm, storage, and
  // message-triggered reconciliation so stale cleanup cannot overwrite a newer
  // learner plan.
  var learnerSyncPromise = null;
  var learnerSyncPending = false;
  async function syncLearnerRules() {
    if (learnerSyncPromise) {
      learnerSyncPending = true;
      return learnerSyncPromise;
    }
    learnerSyncPromise = (async function () {
      var result;
      do {
        learnerSyncPending = false;
        result = await reconcileLearnerRules();
      } while (learnerSyncPending);
      return result;
    }());
    try { return await learnerSyncPromise; }
    finally { learnerSyncPromise = null; }
  }

  function setEnabled(on) {
    var payload = {}; payload[ENABLED_KEY] = !!on;
    return persistModeAndSync(payload);
  }
  function persistModeAndSync(payload) {
    return chrome.storage.local.set(payload).then(
      function () { return syncLearnerRules(); },
      function () { return { ok: false, reason: 'storage_failed' }; }
    );
  }
  function setMode(mode) {
    var flags = flagsForMode(mode);
    var payload = {};
    payload[ENABLED_KEY] = flags.enabled;
    payload[SHADOW_KEY] = flags.shadow;
    return persistModeAndSync(payload);
  }
  // User feedback loop: "this broke a site" -> never auto-block it again.
  // Batch form with an LRU cap so the list stays bounded.
  function normalizedExceptionBases(domains) {
    var bases = [];
    (Array.isArray(domains) ? domains : [domains]).forEach(function (domain) {
      var base = normBase(domain);
      if (base && bases.indexOf(base) < 0) bases.push(base);
    });
    return bases;
  }

  function trimExceptions(exceptions) {
    var keys = Object.keys(exceptions);
    if (keys.length <= MAX_EXCEPTIONS) return;
    keys.sort(function (left, right) { return exceptions[left] - exceptions[right]; });
    for (var i = 0; i < keys.length - MAX_EXCEPTIONS; i++) delete exceptions[keys[i]];
  }

  function sanitizedExceptions(value) {
    var source = value && typeof value === 'object' ? value : {};
    var exceptions = {};
    Object.keys(source).forEach(function (key) {
      if (isHashKey(key) && Number.isFinite(source[key])) exceptions[key] = source[key];
    });
    return exceptions;
  }

  function storeExceptionBases(stored, bases) {
    var exceptions = sanitizedExceptions(stored && stored[EXCEPT_KEY]);
    var now = Date.now();
    bases.forEach(function (base) {
      var key = hashHost(base);
      if (key) exceptions[key] = now;
    });
    trimExceptions(exceptions);
    var payload = {};
    payload[EXCEPT_KEY] = exceptions;
    return chrome.storage.local.set(payload);
  }

  function addExceptions(domains) {
    var bases = normalizedExceptionBases(domains);
    if (!bases.length) return Promise.resolve({ ok: false });
    return chrome.storage.local.get(EXCEPT_KEY)
      .then(function (stored) { return storeExceptionBases(stored, bases); })
      .then(function () { return syncLearnerRules(); })
      .catch(function () {
        return getDynamicState().then(function (dyn) {
          return clearAfterLearnerFailure(dyn, 'storage_failed');
        });
      });
  }
  function addException(domain) { return addExceptions([domain]); }

  function storeExceptionHashes(stored, hashes) {
    var exceptions = sanitizedExceptions(stored && stored[EXCEPT_KEY]);
    var now = Date.now();
    hashes.forEach(function (key) {
      if (isHashKey(key)) exceptions[key] = now;
    });
    trimExceptions(exceptions);
    var payload = {};
    payload[EXCEPT_KEY] = exceptions;
    return chrome.storage.local.set(payload);
  }

  function addExceptionHashes(hashes) {
    var valid = Array.from(new Set((hashes || []).filter(isHashKey)));
    if (!valid.length) return Promise.resolve({ ok: false });
    return chrome.storage.local.get(EXCEPT_KEY)
      .then(function (stored) { return storeExceptionHashes(stored, valid); })
      .then(function () { return syncLearnerRules(); })
      .catch(function () {
        return getDynamicState().then(function (dyn) {
          return clearAfterLearnerFailure(dyn, 'storage_failed');
        });
      });
  }

  // Breakage self-healing: pausing a site is the strongest "something here
  // broke" signal the user can send. When it happens, every learner-flagged
  // domain spotted on THAT site (per its radar snapshot) becomes an exception,
  // so the learner backs off without the user ever finding a settings page.
  // Additive listener: background.js owns the pauseSite op itself; we only
  // observe the same message and never call sendResponse for it.
  function isFlaggedRadarSpot(spot) {
    if (!spot) return false;
    if (spot.verdict !== 'block' && spot.verdict !== 'cookieblock') return false;
    return /^h:[0-9a-f]{8}$/.test(spot.domainHash || '');
  }
  function flaggedRadarHashes(spotted) {
    if (!Array.isArray(spotted)) return [];
    return spotted.filter(isFlaggedRadarSpot).map(function (spot) { return spot.domainHash; });
  }
  function exceptSnapshot(snapshot) {
    var flaggedHashes = flaggedRadarHashes(snapshot && snapshot.spotted);
    if (!flaggedHashes.length) return;
    return addExceptionHashes(flaggedHashes);
  }
  function exceptSpottedOnSite(siteHost) {
    try {
      if (!siteHost || typeof siteHost !== 'string') return Promise.resolve();
      var key = RADAR_PREFIX + hashHost(siteHost.toLowerCase());
      return chrome.storage.local.get(key).then(function (r) {
        return exceptSnapshot(r && r[key]);
      }).catch(function () { /* silent */ });
    } catch (_) { return Promise.resolve(); }
  }
  function setShadow(on) {
    var payload = {}; payload[SHADOW_KEY] = !!on;
    return persistModeAndSync(payload);
  }
  function getStatus() {
    return chrome.storage.local.get([ENABLED_KEY, SHADOW_KEY, META_KEY, EXCEPT_KEY]).then(function (r) {
      r = r || {};
      var except = sanitizedExceptions(r[EXCEPT_KEY]);
      return {
        enabled: !!r[ENABLED_KEY],
        shadow: !(r[SHADOW_KEY] === false),
        mode: modeFromFlags(!!r[ENABLED_KEY], !(r[SHADOW_KEY] === false)),
        meta: r[META_KEY] || null,
        exceptions: Object.keys(except).length
      };
    }).catch(function () { return { enabled: false, shadow: true, meta: null, exceptions: 0 }; });
  }
  function reset() {
    return getDynamicState().then(function (dyn) { return clearBand(dyn.bandIds); })
      .then(function () { return chrome.storage.local.remove([IDMAP_KEY, META_KEY]); })
      .then(function () { return { ok: true }; }).catch(function () { return { ok: false }; });
  }

  NS.syncLearnerRules = syncLearnerRules;
  NS.setEnabled = setEnabled;
  NS.setShadow = setShadow;
  NS.setMode = setMode;
  NS.addException = addException;
  NS.addExceptions = addExceptions;
  NS.getStatus = getStatus;
  NS.reset = reset;

  // ── Message listener (additive; coexists with background.js's router) ──────
  // Explicit opt-in control surface. Settings exposes Standard (off), Preview
  // (shadow), and Adaptive (active); the default remains Standard.
  try {
    chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
      try {
        if (!sender || sender.id !== chrome.runtime.id) return false;
        if (!message || typeof message.type !== 'string') return false;
        if (message.type === 'pawsoff_prevalence_observe') {
          scheduleSoon();
          return false; // learner owns and answers this message
        }
        // Passive breakage feedback: observe the popup's pauseSite op (owned +
        // answered by background.js — we never sendResponse for it).
        if (message.type === 'pawsoff_allow_apply' && message.op === 'pauseSite' && typeof message.site === 'string') {
          try { exceptSpottedOnSite(message.site); } catch (_) { /* silent */ }
          return false;
        }
        switch (message.type) {
          case 'pawsoff_pv_enforce_setMode':
            setMode(message.mode).then(function (r) { try { sendResponse(r); } catch (_) {} },
              function () { try { sendResponse({ ok: false }); } catch (_) {} });
            return true;
          case 'pawsoff_pv_enforce_setShadow':
            setShadow(!!message.shadow).then(function (r) { try { sendResponse(r); } catch (_) {} },
              function () { try { sendResponse({ ok: false }); } catch (_) {} });
            return true;
          case 'pawsoff_pv_enforce_sync':
            syncLearnerRules().then(function (r) { try { sendResponse(r); } catch (_) {} },
              function () { try { sendResponse({ ok: false }); } catch (_) {} });
            return true;
          case 'pawsoff_pv_enforce_setEnabled':
            setEnabled(!!message.enabled).then(function (r) { try { sendResponse(r); } catch (_) {} },
              function () { try { sendResponse({ ok: false }); } catch (_) {} });
            return true;
          case 'pawsoff_pv_enforce_addException':
            addException(message.domain).then(function (r) { try { sendResponse(r); } catch (_) {} },
              function () { try { sendResponse({ ok: false }); } catch (_) {} });
            return true;
          case 'pawsoff_pv_enforce_status':
            getStatus().then(function (r) { try { sendResponse({ ok: true, status: r }); } catch (_) {} },
              function () { try { sendResponse({ ok: false }); } catch (_) {} });
            return true;
          case 'pawsoff_pv_enforce_reset':
            reset().then(function (r) { try { sendResponse(r); } catch (_) {} },
              function () { try { sendResponse({ ok: false }); } catch (_) {} });
            return true;
          default:
            return false;
        }
      } catch (_) { try { sendResponse({ ok: false }); } catch (e) {} return false; }
    });
  } catch (_) { /* runtime API unavailable */ }

  // ── Daily reconcile alarm (chrome.alarms only) + sync on SW wake ───────────
  function ensureAlarm() {
    try { chrome.alarms.create(ENFORCE_ALARM, { periodInMinutes: 1440 }); } catch (_) {}
  }
  function scheduleSoon() {
    try { chrome.alarms.create(ENFORCE_SOON_ALARM, { delayInMinutes: 1 }); } catch (_) {}
  }
  try { chrome.runtime.onInstalled.addListener(function () { ensureAlarm(); syncLearnerRules(); }); } catch (_) {}
  try { chrome.runtime.onStartup.addListener(function () { ensureAlarm(); syncLearnerRules(); }); } catch (_) {}
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local') return;
      if (changes[MASTER_KEY] || changes[TRACKER_SETTINGS_KEY]) syncLearnerRules();
    });
  } catch (_) {}
  try {
    chrome.alarms.onAlarm.addListener(function (alarm) {
      try {
        if (alarm && (alarm.name === ENFORCE_ALARM || alarm.name === ENFORCE_SOON_ALARM)) syncLearnerRules();
      } catch (_) {}
    });
  } catch (_) {}

  // ── Test-only export hook (inert in the service worker) ───────────────────
  var TESTAPI = {
    planSync: planSync,
    computeBudget: computeBudget,
    isEnforceableDomain: isEnforceableDomain,
    buildLearnerBlockRule: buildLearnerBlockRule,
    buildCookieStripRule: buildCookieStripRule,
    tierFor: tierFor,
    normBase: normBase,
    ESSENTIAL_DOMAINS: ESSENTIAL_DOMAINS,
    LEARN_ID_BASE: LEARN_ID_BASE,
    LEARN_ID_MAX: LEARN_ID_MAX,
    LEARN_PRIORITY: LEARN_PRIORITY,
    MAX_DYNAMIC: MAX_DYNAMIC,
    BUDGET_HEADROOM: BUDGET_HEADROOM,
    MAX_LEARN_RULES: MAX_LEARN_RULES,
    BEACON_RESOURCE_TYPES: BEACON_RESOURCE_TYPES,
    SCRIPT_RESOURCE_TYPES: SCRIPT_RESOURCE_TYPES,
    COOKIE_RESOURCE_TYPES: COOKIE_RESOURCE_TYPES,
    ENFORCE_MIN_SCORE: ENFORCE_MIN_SCORE,
    ENFORCE_MIN_SITES: ENFORCE_MIN_SITES,
    ENFORCE_MIN_AGE_DAYS: ENFORCE_MIN_AGE_DAYS,
    SCRIPT_TIER_SCORE: SCRIPT_TIER_SCORE,
    COOKIE_MIN_SCORE: COOKIE_MIN_SCORE,
    modeFromFlags: modeFromFlags,
    flagsForMode: flagsForMode,
    trackerProtectionEnabled: trackerProtectionEnabled,
    isTrackerProtectionEnabled: isTrackerProtectionEnabled,
    clearBand: clearBand,
    clearAfterLearnerFailure: clearAfterLearnerFailure,
    cleanupCurrentLearnerBand: cleanupCurrentLearnerBand,
    getDynamicState: getDynamicState,
    syncLearnerRules: syncLearnerRules,
    saveAdaptivePlan: saveAdaptivePlan,
    syncEnabledLearner: syncEnabledLearner,
    previewSample: previewSample,
    sanitizedExceptions: sanitizedExceptions,
    storeExceptionBases: storeExceptionBases,
    storeExceptionHashes: storeExceptionHashes,
    loadExceptSet: loadExceptSet,
    addExceptions: addExceptions,
    addExceptionHashes: addExceptionHashes,
    exceptSnapshot: exceptSnapshot,
    setMode: setMode
  };
  try { if (root.__pawsOff_TEST) root.__pawsOff_enforcerInternals = TESTAPI; } catch (_) {}
  try { if (typeof module !== 'undefined' && module.exports) module.exports = TESTAPI; } catch (_) {}

})(typeof self !== 'undefined' ? self : this);
