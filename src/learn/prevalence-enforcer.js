/* PawsOff, Prevalence Enforcer - service-worker side.
 *
 * Turns the observe-only learner's verdicts into active, self-cleaning
 * declarativeNetRequest rules. The learner only scores; this module decides
 * what to actually do about a 'block' verdict, protecting hard against
 * breakage along the way:
 *   - never touches the bundled ESSENTIAL_DOMAINS safelist, anything already
 *     covered by the static EasyPrivacy ruleset, or a user exception (the
 *     "this broke a site" feedback loop); yellowlisted domains stay
 *     cookieblock, never a hard block
 *   - every sync fully reconciles its own rule band - clears it, re-adds only
 *     what's currently desired - so a decayed score naturally un-blocks with
 *     zero drift between Chrome's rules and our state
 *   - the 30,000 dynamic+session rule cap is shared with allow/pause; budget
 *     is computed from what's actually free, and updateDynamicRules rejects
 *     atomically so a failure never half-applies
 *   - block rules run at priority 1, below the user's own allow rules (2),
 *     so an explicit unbreak always wins with no special-case logic
 *
 * Dormant by default (__pawsOff_pv_enforce_enabled), and even once enabled,
 * shadow mode (__pawsOff_pv_enforce_shadow, default true) computes the plan
 * into storage without applying a single rule - real would-block data before
 * any rollout decision. Warm-up gates hold a stricter bar than the learner's
 * own verdict threshold: a hard block needs score>=5 on >=5 sites known
 * >=7 days, starts beacon-only, adds scripts only at score>=8, and never
 * touches sub_frame/websocket/media. Anything below that bar - plus every
 * yellowlisted verdict - gets cookies stripped instead of blocked, so the
 * resource still loads but the tracker goes anonymous. Pausing a site
 * auto-excepts its flagged domains (self-healing). Candidates are named by
 * joining the hash-only learner store to the radar's plaintext spotted
 * domains, so enforcement always requires fresh local evidence and never
 * needs new plaintext at rest.
 *
 * Requires self.PawsOffPSL and self.__pawsOff_prevalence; background.js
 * loads both first via importScripts. Self-registers its own message +
 * alarm listeners (additive - the main router is undisturbed).
 */
'use strict';
(function (root) {
  var NS = {};
  try { root.__pawsOff_enforcer = NS; } catch (_) { /* ignore */ }

  // ── Storage keys ─────────────────────────────────────────────────────
  var ENABLED_KEY = '__pawsOff_pv_enforce_enabled'; // boolean, default false
  var SHADOW_KEY  = '__pawsOff_pv_enforce_shadow';  // boolean, default TRUE: compute, never apply
  var IDMAP_KEY   = '__pawsOff_pv_enforce_idmap';   // { domain: ruleId } (debug/stability)
  var EXCEPT_KEY  = '__pawsOff_pv_enforce_except';   // { domain: ts } user exceptions
  var META_KEY    = '__pawsOff_pv_enforce_meta';     // { updated, blocked, budget, candidates }
  var RADAR_PREFIX = '__pawsOff_radar_';             // collector snapshots (plaintext spotted domains)
  var ENFORCE_ALARM = 'pawsoff_pv_enforce';

  // ── Warm-up gates (breakage protection) ─────────────────────────────
  // Stricter than the learner's own BLOCK_THRESHOLD (3), so a merely-popular
  // newcomer (a fresh CDN) never gets blocked outright.
  var ENFORCE_MIN_SCORE    = 5;
  var ENFORCE_MIN_SITES    = 5;
  var ENFORCE_MIN_AGE_DAYS = 7;
  var SCRIPT_TIER_SCORE    = 8;
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
  function normBase(host) {
    if (!host || typeof host !== 'string') return '';
    var h = host.toLowerCase().trim();
    try { if (root.PawsOffPSL) h = root.PawsOffPSL.getBaseDomain(h) || h; } catch (_) { /* ignore */ }
    h = (h || '').toLowerCase().trim().replace(/\.$/, '');
    if (h.indexOf('.') < 0) return '';            // not a registrable domain
    if (!/^[a-z0-9.\-]+$/.test(h)) return '';
    return h;
  }

  // ── PURE: is this domain eligible for an auto-block rule? ──────────────────
  function isEnforceableDomain(domain, sets) {
    if (!domain) return false;
    var essential = sets && sets.essentialSet;
    var covered   = sets && sets.coveredSet;
    var except    = sets && sets.exceptSet;
    if (essential && essential.has(domain)) return false;  // safelist
    if (covered && covered.has(domain)) return false;       // already blocked by EasyPrivacy (dedup)
    if (except && except.has(domain)) return false;         // user said "don't block this"
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
  // carries no cookies and the response can't set any - the tracker sees an
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
  function tierFor(row) {
    if (!row) return null;
    var score = typeof row.score === 'number' ? row.score : 0;
    var sites = typeof row.sites === 'number' ? row.sites : 0;
    var age   = typeof row.ageDays === 'number' ? row.ageDays : 0;
    if (row.verdict === 'block') {
      var hard = score >= ENFORCE_MIN_SCORE && sites >= ENFORCE_MIN_SITES && age >= ENFORCE_MIN_AGE_DAYS;
      if (hard) return score >= SCRIPT_TIER_SCORE ? 'block-script' : 'block-beacon';
      return score >= COOKIE_MIN_SCORE ? 'cookie' : null; // warm-up: strip cookies meanwhile
    }
    if (row.verdict === 'cookieblock') {
      return score >= COOKIE_MIN_SCORE ? 'cookie' : null;
    }
    return null;
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

    // 1) tier every eligible row, dedupe base domains keeping the STRONGEST
    //    row per domain (hashed rows can resolve to the same base domain from
    //    several subdomains; a weak sighting must not suppress a stronger one
    //    seen later). The essential/covered/except sets gate both tiers -
    //    cookie-stripping an SSO or payment domain breaks logins too.
    function tierRank(t) {
      if (t === 'block-script') return 3;
      if (t === 'block-beacon') return 2;
      if (t === 'cookie') return 1;
      return 0;
    }
    function strongerCandidate(a, b) {
      var ar = tierRank(a.tier), br = tierRank(b.tier);
      if (ar !== br) return ar > br;
      return a.score > b.score;
    }
    var byDomain = {};
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var tier = tierFor(r);
      if (!tier) continue;
      var d = normBase(r.domain);
      if (!d) continue;
      if (!isEnforceableDomain(d, sets)) continue;
      var cand = { domain: d, score: typeof r.score === 'number' ? r.score : 0, tier: tier };
      if (!byDomain[d] || strongerCandidate(cand, byDomain[d])) byDomain[d] = cand;
    }
    var candidates = Object.keys(byDomain).map(function (d) { return byDomain[d]; });

    // 2) worst offenders first; blocks before cookie-strips at equal urgency
    candidates.sort(function (a, b) {
      var ab = a.tier.indexOf('block') === 0 ? 1 : 0;
      var bb = b.tier.indexOf('block') === 0 ? 1 : 0;
      if (ab !== bb) return bb - ab;
      return b.score - a.score;
    });

    // 3) budget (shared 30k cap minus everyone else)
    var budget = computeBudget({
      otherRuleCount: typeof args.otherRuleCount === 'number' ? args.otherRuleCount : 0,
      maxDynamic: args.maxDynamic,
      headroom: args.headroom,
      maxLearnRules: args.maxLearnRules
    });

    var desired = candidates.slice(0, budget);

    // 4) deterministic ids + rules per tier
    var addRules = [];
    var idMap = {};
    var blockedN = 0, cookieN = 0;
    for (var j = 0; j < desired.length; j++) {
      var id = LEARN_ID_BASE + j;
      if (id > LEARN_ID_MAX) break;
      var c = desired[j];
      if (c.tier === 'cookie') {
        addRules.push(buildCookieStripRule(c.domain, id));
        cookieN++;
      } else {
        addRules.push(buildLearnerBlockRule(c.domain, id,
          c.tier === 'block-script' ? SCRIPT_RESOURCE_TYPES : BEACON_RESOURCE_TYPES));
        blockedN++;
      }
      idMap[c.domain] = id;
    }

    // 5) clear the whole band first (idempotent; also reclaims decayed domains)
    var removeSet = {};
    for (var k = 0; k < existingLearnerRuleIds.length; k++) {
      var rid = Number(existingLearnerRuleIds[k]);
      if (Number.isInteger(rid) && rid >= LEARN_ID_BASE && rid <= LEARN_ID_MAX) removeSet[rid] = 1;
    }
    // also clear the ids we are about to (re)add, so remove-then-add is clean
    for (var a = 0; a < addRules.length; a++) removeSet[addRules[a].id] = 1;
    var removeRuleIds = Object.keys(removeSet).map(Number);

    return {
      addRules: addRules,
      removeRuleIds: removeRuleIds,
      idMap: idMap,
      stats: {
        candidates: candidates.length,
        blocked: blockedN,
        cookieStripped: cookieN,
        budget: budget,
        skipped: Math.max(0, candidates.length - addRules.length)
      }
    };
  }

  // ══════════════════ ASYNC ORCHESTRATION (chrome-dependent) ═════════════════
  var _coveredCache = null; // Set<baseDomain> from packaged easyprivacy-domains.json

  function loadCoveredSet() {
    if (_coveredCache) return Promise.resolve(_coveredCache);
    try {
      if (!(root.chrome && chrome.runtime && chrome.runtime.getURL && typeof fetch === 'function')) {
        _coveredCache = new Set(); return Promise.resolve(_coveredCache);
      }
      var url = chrome.runtime.getURL('src/rules/easyprivacy-domains.json');
      return fetch(url).then(function (res) { return res.json(); }).then(function (arr) {
        var s = new Set();
        if (Array.isArray(arr)) { for (var i = 0; i < arr.length; i++) { var b = normBase(arr[i]); if (b) s.add(b); } }
        _coveredCache = s; return s;
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

  // The learner's persisted map is hash-only (privacy invariant), so it cannot
  // name a domain for a DNR rule. The collector's radar snapshots ALREADY hold
  // the plaintext spotted-tracker names per (hashed) site - public third-party
  // domains, never the user's own sites. Joining radar names to hashed learner
  // rows gives the enforcer its candidates WITHOUT adding any new plaintext at
  // rest, and doubles as a freshness gate: a tracker the user hasn't actually
  // encountered recently (no radar entry) simply cannot be enforced yet.
  function collectRadarNames() {
    return chrome.storage.local.get(null).then(function (all) {
      var names = {}; // hashKey -> plaintext base domain
      for (var k in all) {
        if (!Object.prototype.hasOwnProperty.call(all, k)) continue;
        if (k.indexOf(RADAR_PREFIX) !== 0) continue;
        var spotted = all[k] && all[k].spotted;
        if (!Array.isArray(spotted)) continue;
        for (var i = 0; i < spotted.length; i++) {
          var d = spotted[i] && spotted[i].domain;
          var b = normBase(d);
          if (!b) continue;
          var hk = hashHost(b);
          if (hk && !names[hk]) names[hk] = b;
        }
      }
      return names;
    }).catch(function () { return {}; });
  }
  function loadExceptSet() {
    return chrome.storage.local.get(EXCEPT_KEY).then(function (r) {
      var obj = (r && r[EXCEPT_KEY]) || {};
      var s = new Set();
      for (var d in obj) { if (Object.prototype.hasOwnProperty.call(obj, d)) { var b = normBase(d); if (b) s.add(b); } }
      return s;
    }).catch(function () { return new Set(); });
  }

  function getDynamicState() {
    var dnr = root.chrome && chrome.declarativeNetRequest;
    var pDyn = (dnr && dnr.getDynamicRules) ? dnr.getDynamicRules() : Promise.resolve([]);
    var pSes = (dnr && dnr.getSessionRules) ? dnr.getSessionRules() : Promise.resolve([]);
    return Promise.all([pDyn, pSes]).then(function (res) {
      var dyn = Array.isArray(res[0]) ? res[0] : [];
      var ses = Array.isArray(res[1]) ? res[1] : [];
      var bandIds = [];
      var other = 0;
      for (var i = 0; i < dyn.length; i++) {
        var id = Number(dyn[i] && dyn[i].id);
        if (id >= LEARN_ID_BASE && id <= LEARN_ID_MAX) bandIds.push(id);
        else other++;
      }
      other += ses.length; // session rules also count against the shared cap
      return { bandIds: bandIds, otherRuleCount: other };
    }).catch(function () { return { bandIds: [], otherRuleCount: 0 }; });
  }

  function clearBand(bandIds) {
    if (!bandIds || !bandIds.length) return Promise.resolve(true);
    return chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: bandIds, addRules: [] })
      .then(function () { return true; }).catch(function () { return false; });
  }

  // The one entry point: reconcile our DNR band to the learner's current scores.
  function syncLearnerRules() {
    var learner = root.__pawsOff_prevalence;
    if (!(root.chrome && chrome.declarativeNetRequest && chrome.declarativeNetRequest.updateDynamicRules)) {
      return Promise.resolve({ ok: false, reason: 'no_dnr' });
    }
    return Promise.all([isEnabled(), isShadow(), getDynamicState()]).then(function (pre) {
      var enabled = pre[0];
      var shadow = pre[1];
      var dyn = pre[2];
      if (!enabled) {
        // OFF: make sure no learner rules linger.
        return clearBand(dyn.bandIds).then(function () {
          return { ok: true, enabled: false, blocked: 0 };
        });
      }
      if (!learner || typeof learner.getStats !== 'function') {
        return { ok: false, reason: 'no_learner' };
      }
      return Promise.all([learner.getStats(GET_STATS_TOPN), loadCoveredSet(), loadExceptSet(), collectRadarNames()])
        .then(function (parts) {
          var stats = parts[0] || {};
          var hashedRows = Array.isArray(stats.top) ? stats.top : [];
          var names = parts[3] || {};
          // Join: learner rows are hash-keyed; the radar supplies the plaintext
          // name. Unnamed rows (not spotted on any recent site) cannot be
          // enforced - by design, enforcement requires fresh local evidence.
          var rows = [];
          for (var i = 0; i < hashedRows.length; i++) {
            var r = hashedRows[i];
            var name = r && names[r.domain];
            if (!name) continue;
            rows.push({ domain: name, score: r.score, sites: r.sites, ageDays: r.ageDays, verdict: r.verdict });
          }
          var plan = planSync({
            rows: rows,
            existingLearnerRuleIds: dyn.bandIds,
            otherRuleCount: dyn.otherRuleCount,
            essentialSet: ESSENTIAL_DOMAINS,
            coveredSet: parts[1],
            exceptSet: parts[2]
          });
          if (shadow) {
            // SHADOW: apply nothing (and clear any leftovers), but persist the
            // would-plan so the rollout decision is made on real local data.
            return clearBand(dyn.bandIds).then(function () {
              var sample = plan.addRules.slice(0, 50).map(function (rl) {
                return { d: rl.condition.requestDomains[0], a: rl.action.type === 'block' ? 'block' : 'cookie' };
              });
              var payload = {};
              payload[META_KEY] = {
                updated: Date.now(),
                shadow: true,
                wouldBlock: plan.stats.blocked,
                wouldCookieStrip: plan.stats.cookieStripped,
                budget: plan.stats.budget,
                candidates: plan.stats.candidates,
                sample: sample
              };
              return chrome.storage.local.set(payload).catch(function () {}).then(function () {
                return { ok: true, enabled: true, shadow: true, wouldBlock: plan.stats.blocked, wouldCookieStrip: plan.stats.cookieStripped };
              });
            });
          }
          return chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: plan.removeRuleIds,
            addRules: plan.addRules
          }).then(function () {
            var payload = {};
            payload[IDMAP_KEY] = plan.idMap;
            payload[META_KEY] = {
              updated: Date.now(),
              shadow: false,
              blocked: plan.stats.blocked,
              cookieStripped: plan.stats.cookieStripped,
              budget: plan.stats.budget,
              candidates: plan.stats.candidates
            };
            return chrome.storage.local.set(payload).catch(function () {}).then(function () {
              return { ok: true, enabled: true, shadow: false, blocked: plan.stats.blocked, cookieStripped: plan.stats.cookieStripped, budget: plan.stats.budget, candidates: plan.stats.candidates };
            });
          }).catch(function (err) {
            // updateDynamicRules rejects atomically -> nothing applied. Don't crash.
            try { console.warn('[PawsOff] enforcer updateDynamicRules failed:', err && err.message); } catch (_) {}
            return { ok: false, reason: 'update_failed', error: err && err.message };
          });
        });
    }).catch(function (err) {
      return { ok: false, reason: 'sync_error', error: err && err.message };
    });
  }

  function setEnabled(on) {
    var payload = {}; payload[ENABLED_KEY] = !!on;
    return chrome.storage.local.set(payload).catch(function () {}).then(function () { return syncLearnerRules(); });
  }
  // User feedback loop: "this broke a site" -> never auto-block it again.
  // Batch form with an LRU cap so the list stays bounded.
  function addExceptions(domains) {
    var bases = [];
    (Array.isArray(domains) ? domains : [domains]).forEach(function (d) {
      var b = normBase(d);
      if (b && bases.indexOf(b) < 0) bases.push(b);
    });
    if (!bases.length) return Promise.resolve({ ok: false });
    return chrome.storage.local.get(EXCEPT_KEY).then(function (r) {
      var obj = (r && r[EXCEPT_KEY]) || {};
      var now = Date.now();
      bases.forEach(function (b) { obj[b] = now; });
      var keys = Object.keys(obj);
      if (keys.length > MAX_EXCEPTIONS) { // LRU: drop the oldest feedback
        keys.sort(function (a, b2) { return obj[a] - obj[b2]; });
        for (var i = 0; i < keys.length - MAX_EXCEPTIONS; i++) delete obj[keys[i]];
      }
      var payload = {}; payload[EXCEPT_KEY] = obj;
      return chrome.storage.local.set(payload);
    }).catch(function () {}).then(function () { return syncLearnerRules(); });
  }
  function addException(domain) { return addExceptions([domain]); }

  // Breakage self-healing: pausing a site is the strongest "something here
  // broke" signal the user can send. When it happens, every learner-flagged
  // domain spotted on THAT site (per its radar snapshot) becomes an exception,
  // so the learner backs off without the user ever finding a settings page.
  // Additive listener: background.js owns the pauseSite op itself; we only
  // observe the same message and never call sendResponse for it.
  function exceptSpottedOnSite(siteHost) {
    try {
      if (!siteHost || typeof siteHost !== 'string') return Promise.resolve();
      var key = RADAR_PREFIX + hashHost(siteHost.toLowerCase());
      return chrome.storage.local.get(key).then(function (r) {
        var spotted = r && r[key] && r[key].spotted;
        if (!Array.isArray(spotted)) return;
        var flagged = [];
        for (var i = 0; i < spotted.length; i++) {
          var s = spotted[i];
          if (s && (s.verdict === 'block' || s.verdict === 'cookieblock') && s.domain) flagged.push(s.domain);
        }
        if (flagged.length) return addExceptions(flagged);
      }).catch(function () { /* silent */ });
    } catch (_) { return Promise.resolve(); }
  }
  function setShadow(on) {
    var payload = {}; payload[SHADOW_KEY] = !!on;
    return chrome.storage.local.set(payload).catch(function () {}).then(function () { return syncLearnerRules(); });
  }
  function getStatus() {
    return chrome.storage.local.get([ENABLED_KEY, SHADOW_KEY, META_KEY, EXCEPT_KEY]).then(function (r) {
      r = r || {};
      var except = r[EXCEPT_KEY] || {};
      return {
        enabled: !!r[ENABLED_KEY],
        shadow: !(r[SHADOW_KEY] === false),
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
  NS.addException = addException;
  NS.addExceptions = addExceptions;
  NS.getStatus = getStatus;
  NS.reset = reset;

  // ── Message listener (additive; coexists with background.js's router) ──────
  // DORMANT-BY-DESIGN: this is the OPT-IN control surface for enforcement. No
  // shipped UI sends any of these messages - they are reachable only from the
  // service-worker console (or a future, deliberately-gated enable UI). The
  // enforcer stays inert until pawsoff_pv_enforce_setEnabled is called AND
  // __pawsOff_pv_enforce_enabled is true. These handlers are NOT dead code; do
  // not remove them - see src/learn/README.md ("Enforcement (wired but DORMANT)").
  try {
    chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
      try {
        if (!sender || sender.id !== chrome.runtime.id) return false;
        if (!message || typeof message.type !== 'string') return false;
        // Passive breakage feedback: observe the popup's pauseSite op (owned +
        // answered by background.js - we never sendResponse for it).
        if (message.type === 'pawsoff_allow_apply' && message.op === 'pauseSite' && typeof message.site === 'string') {
          try { exceptSpottedOnSite(message.site); } catch (_) { /* silent */ }
          return false;
        }
        switch (message.type) {
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
  try { chrome.runtime.onInstalled.addListener(function () { ensureAlarm(); syncLearnerRules(); }); } catch (_) {}
  try { chrome.runtime.onStartup.addListener(function () { ensureAlarm(); syncLearnerRules(); }); } catch (_) {}
  try {
    chrome.alarms.onAlarm.addListener(function (alarm) {
      try { if (alarm && alarm.name === ENFORCE_ALARM) syncLearnerRules(); } catch (_) {}
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
    COOKIE_MIN_SCORE: COOKIE_MIN_SCORE
  };
  try { if (root.__pawsOff_TEST) root.__pawsOff_enforcerInternals = TESTAPI; } catch (_) {}
  try { if (typeof module !== 'undefined' && module.exports) module.exports = TESTAPI; } catch (_) {}

})(typeof self !== 'undefined' ? self : this);
