/* PawsOff, Prevalence Learner - observe-only, service-worker side.
 *
 * A Privacy Badger-style local learner, re-derived from the method only
 * (clean-room, no Privacy Badger code). A third party showing up across many
 * unrelated first-party sites is almost certainly a tracker: we count, per
 * third-party registrable domain, the distinct first-party sites it appears
 * on with a per-sighting timestamp, and derive a time-decayed prevalence
 * score → verdict (allow / observing / would-cookieblock / would-block).
 *
 * Differences from the classic algorithm: half-life decay instead of a flat
 * lifetime count, first-party sets (same-owner domains aren't third-party to
 * each other), yellowlist → cookieblock instead of a full block for
 * site-critical domains, and bounded storage (per-tracker site cap + global
 * cap + TTL decay).
 *
 * Observe-only - this file scores, never blocks/cookieblocks/redirects, and
 * writes no declarativeNetRequest rule. Enforcement lives elsewhere.
 *
 * Requires self.PawsOffPSL; background.js loads psl-lite.js first via
 * importScripts. Self-registers its own message + alarm listeners
 * (additive - doesn't disturb the main router).
 */
'use strict';
(function (root) {
  var NS = {};
  try { root.__pawsOff_prevalence = NS; } catch (_) { /* ignore */ }

  var SNITCH_KEY = '__pawsOff_pv_snitch';
  var META_KEY = '__pawsOff_pv_meta';
  var SIZES_KEY = '__pawsOff_pv_sizes';   // per-domain learned transfer sizes
  var DECAY_ALARM = 'pawsoff_pv_decay';

  // ── Tuning ────────────────────────────────────────────────────────────────
  var HALF_LIFE_DAYS = 30;        // a sighting loses half its weight every 30 days
  var BLOCK_THRESHOLD = 3;        // decayed score at/above which we'd act
  var OBSERVE_FLOOR = 1;          // below this = effectively "allow"
  var MAX_SITES_PER_TRACKER = 64; // cap distinct first-parties stored per tracker
  var MAX_TRACKERS = 6000;        // cap total tracked third parties
  var SITE_TTL_DAYS = 180;        // forget a single sighting after this long
  var DAY_MS = 86400000;

  function today() { return Math.floor(Date.now() / DAY_MS); }

  function baseOf(host) {
    try { return root.PawsOffPSL ? root.PawsOffPSL.getBaseDomain(host) : (host || ''); }
    catch (_) { return host || ''; }
  }

  // One-way FNV-1a/32 host digest, byte-identical to the collector/po-catch/
  // popup copies (pinned by tests/hashhost-consistency.test.js). Everything
  // the learner persists - tracker and first-party alike - is hashed, never
  // plaintext. The popup radar still shows real tracker names because
  // spotted() derives them live from the page, not from storage.
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
  function isHashKey(k) { return typeof k === 'string' && /^h:[0-9a-f]{8}$/.test(k); }
  // A legacy plaintext-keyed store predates hashing; since this is observe-only
  // data we just discard it rather than re-key - the learner rebuilds from scratch.
  function migrateHashedKeys(raw) {
    if (!raw || typeof raw !== 'object') return { data: {}, changed: false };
    var keys = Object.keys(raw);
    for (var i = 0; i < keys.length; i++) {
      if (!isHashKey(keys[i])) return { data: {}, changed: true }; // legacy → discard
    }
    return { data: raw, changed: false };
  }

  // ── First-party sets: domains owned by the same entity are NOT third-party to
  //    each other. Tiny seed; extend later via signed remote config. ──────────
  var FIRST_PARTY_SETS = [
    ['google.com', 'google.co.uk', 'youtube.com', 'gstatic.com', 'googleusercontent.com', 'withgoogle.com', 'goo.gl'],
    ['microsoft.com', 'live.com', 'office.com', 'microsoftonline.com', 'bing.com', 'msn.com', 'azureedge.net'],
    ['apple.com', 'icloud.com', 'cdn-apple.com'],
    ['amazon.com', 'media-amazon.com', 'ssl-images-amazon.com', 'amazonaws.com'],
    ['facebook.com', 'fbcdn.net', 'instagram.com', 'whatsapp.com']
  ];
  var _ownerOf = {};
  (function indexOwners() {
    for (var i = 0; i < FIRST_PARTY_SETS.length; i++) {
      var set = FIRST_PARTY_SETS[i];
      for (var j = 0; j < set.length; j++) _ownerOf[set[j]] = i;
    }
  })();
  function sameOwner(a, b) {
    if (a === b) return true;
    var oa = _ownerOf[a];
    var ob = _ownerOf[b];
    return (oa !== undefined && oa === ob);
  }

  // ── Yellowlist: domains commonly needed for a site to function. When such a
  //    tracker crosses threshold we'd COOKIEBLOCK (strip its cookies) rather
  //    than fully BLOCK. Seed; replace/extend via signed remote config. ───────
  var BUNDLED_YELLOWLIST = new Set([
    'youtube.com', 'vimeo.com', 'gstatic.com', 'googleapis.com', 'googleusercontent.com',
    'cloudflare.com', 'cloudfront.net', 'jsdelivr.net', 'jquery.com', 'bootstrapcdn.com',
    'gravatar.com', 'wp.com', 'fbcdn.net', 'akamaihd.net', 'typekit.net', 'fontawesome.com',
    'disqus.com', 'stripe.com', 'paypal.com', 'recaptcha.net', 'google.com'
  ]);
  function isYellow(base) { return BUNDLED_YELLOWLIST.has(base); }
  // Hashed mirror of the yellowlist so getStats() can apply the site-critical
  // downgrade using a hashed tracker KEY (the plaintext domain is not persisted).
  // Without this, yellowlisted infra (stripe.com, youtube.com, google.com) would
  // misclassify as 'block' and the enforcer could hard-block payments/video/SSO.
  var _yellowHash = null;
  function isYellowKey(key) {
    if (!_yellowHash) {
      _yellowHash = new Set();
      BUNDLED_YELLOWLIST.forEach(function (d) { var h = hashHost(d); if (h) _yellowHash.add(h); });
    }
    return _yellowHash.has(key);
  }

  // ── Serialized mutation queue (no read-modify-write races in the SW) ───────
  var _cache = null;            // in-memory snitch map (rehydrated on demand)
  var _sizeCache = null;        // in-memory per-domain size map { domain: { total, count } }
  var _chain = Promise.resolve();

  function load() {
    if (_cache) return Promise.resolve(_cache);
    return chrome.storage.local.get(SNITCH_KEY).then(function (res) {
      var raw = (res && res[SNITCH_KEY] && typeof res[SNITCH_KEY] === 'object') ? res[SNITCH_KEY] : {};
      var m = migrateHashedKeys(raw);
      _cache = m.data;
      if (m.changed) { // PERSIST the purge now, so legacy plaintext can't linger on disk
        var p = {}; p[SNITCH_KEY] = _cache;
        return chrome.storage.local.set(p).then(function () { return _cache; }, function () { return _cache; });
      }
      return _cache;
    }).catch(function () { _cache = {}; return _cache; });
  }
  function save() {
    var payload = {};
    payload[SNITCH_KEY] = _cache;
    payload[META_KEY] = { updated: Date.now(), trackers: Object.keys(_cache).length };
    if (_sizeCache) payload[SIZES_KEY] = _sizeCache;
    return chrome.storage.local.set(payload).catch(function () { /* silent */ });
  }
  function enqueue(fn) { _chain = _chain.then(fn).catch(function () { /* silent */ }); return _chain; }

  // ── Scoring ───────────────────────────────────────────────────────────────
  function scoreEntry(entry, t) {
    if (!entry || !entry.s) return 0;
    var score = 0;
    var sites = entry.s;
    for (var site in sites) {
      if (!Object.prototype.hasOwnProperty.call(sites, site)) continue;
      var age = t - sites[site];
      if (age <= 0) { score += 1; continue; }
      score += Math.pow(0.5, age / HALF_LIFE_DAYS);
    }
    return score;
  }
  function verdictWith(isYel, score) {
    if (score >= BLOCK_THRESHOLD) return isYel ? 'cookieblock' : 'block';
    if (score >= OBSERVE_FLOOR) return 'observing';
    return 'allow';
  }
  // For callers that hold the plaintext base (getVerdict / spotted).
  function verdictFor(base, score) { return verdictWith(isYellow(base), score); }

  // ── Record a batch from the collector ──────────────────────────────────────
  // We can only record a sighting when we know the first-party host and were
  // given at least one observed third-party host to attribute to it.
  function hasReportableHosts(firstPartyHost, hostList) {
    return !!firstPartyHost && Array.isArray(hostList) && hostList.length > 0;
  }

  function record(firstPartyHost, hostList) {
    return enqueue(function () {
      if (!hasReportableHosts(firstPartyHost, hostList)) return Promise.resolve();
      var fpBase = baseOf(firstPartyHost);
      if (!fpBase) return Promise.resolve();
      var t = today();
      var fpKey = hashHost(fpBase);
      if (!fpKey) return Promise.resolve();
      return load().then(function (snitch) {
        var seen = new Set();
        for (var i = 0; i < hostList.length; i++) {
          var tBase = baseOf(hostList[i]);
          if (!tBase || tBase === fpBase) continue;     // first-party
          if (sameOwner(tBase, fpBase)) continue;       // same-owner first-party set
          if (seen.has(tBase)) continue;                // dedupe within this page
          seen.add(tBase);
          var tKey = hashHost(tBase);                   // hashed KEY (no plaintext)
          if (!tKey) continue;
          var entry = snitch[tKey];
          if (!entry) { entry = snitch[tKey] = { s: {}, first: t, last: t }; }
          entry.s[fpKey] = t;                            // hashed first-party site KEY
          entry.last = t;
          // cap distinct sites per tracker -- drop the oldest sightings
          var siteKeys = Object.keys(entry.s);
          if (siteKeys.length > MAX_SITES_PER_TRACKER) {
            siteKeys.sort(function (a, b) { return entry.s[a] - entry.s[b]; });
            var dropN = siteKeys.length - MAX_SITES_PER_TRACKER;
            for (var d = 0; d < dropN; d++) delete entry.s[siteKeys[d]];
          }
        }
        // global cap -- evict lowest-score trackers if oversized
        var keys = Object.keys(snitch);
        if (keys.length > MAX_TRACKERS) {
          keys.sort(function (a, b) { return scoreEntry(snitch[a], t) - scoreEntry(snitch[b], t); });
          var gDrop = keys.length - MAX_TRACKERS;
          for (var g = 0; g < gDrop; g++) delete snitch[keys[g]];
        }
        return save();
      });
    });
  }

  // ── Transfer size learning ────────────────────────────────────────────────
  // Build a running per-domain average of real transferSize bytes observed from
  // the Performance API. Each domain stores { total: bytes, count: observations,
  // avg: bytes }. This data powers the honest "bandwidth saved" estimate in the
  // popup, replacing the old hardcoded 4.2 KB fiction.
  function loadSizes() {
    if (_sizeCache) return Promise.resolve(_sizeCache);
    return chrome.storage.local.get(SIZES_KEY).then(function (res) {
      var raw = (res && res[SIZES_KEY] && typeof res[SIZES_KEY] === 'object') ? res[SIZES_KEY] : {};
      var m = migrateHashedKeys(raw);
      _sizeCache = m.data;
      if (m.changed) { // PERSIST the purge now
        var p = {}; p[SIZES_KEY] = _sizeCache;
        return chrome.storage.local.set(p).then(function () { return _sizeCache; }, function () { return _sizeCache; });
      }
      return _sizeCache;
    }).catch(function () { _sizeCache = {}; return _sizeCache; });
  }

  function recordSizes(hostSizes) {
    return enqueue(function () {
      if (!hostSizes || typeof hostSizes !== 'object') return Promise.resolve();
      return loadSizes().then(function (sizes) {
        for (var host in hostSizes) {
          if (!Object.prototype.hasOwnProperty.call(hostSizes, host)) continue;
          var bytes = hostSizes[host];
          if (typeof bytes !== 'number' || bytes <= 0) continue;
          var tBase = baseOf(host);
          if (!tBase) continue;
          var tKey = hashHost(tBase); // hashed KEY; size aggregate ignores identity
          if (!tKey) continue;
          var entry = sizes[tKey];
          if (!entry) { entry = sizes[tKey] = { total: 0, count: 0 }; }
          entry.total += bytes;
          entry.count += 1;
          entry.avg = Math.round(entry.total / entry.count);
        }
        // Cap learned domains to MAX_TRACKERS (reuse the same bound)
        var keys = Object.keys(sizes);
        if (keys.length > MAX_TRACKERS) {
          keys.sort(function (a, b) { return (sizes[a].count || 0) - (sizes[b].count || 0); });
          var drop = keys.length - MAX_TRACKERS;
          for (var i = 0; i < drop; i++) delete sizes[keys[i]];
        }
        // save() already includes _sizeCache in the payload
        return save();
      });
    });
  }

  // Return the overall average bytes per blocked third-party request, computed
  // from all learned domains. Returns { avgBytes, domainCount, totalObservations }
  // so the popup can show honest data with confidence metadata. Falls back to
  // null when no data has been learned yet.
  function getSizeEstimate() {
    return loadSizes().then(function (sizes) {
      var totalBytes = 0, totalCount = 0, domainCount = 0;
      for (var domain in sizes) {
        if (!Object.prototype.hasOwnProperty.call(sizes, domain)) continue;
        var e = sizes[domain];
        if (!e || !e.total || !e.count) continue;
        totalBytes += e.total;
        totalCount += e.count;
        domainCount++;
      }
      if (totalCount === 0) return null;
      return {
        avgBytes: Math.round(totalBytes / totalCount),
        domainCount: domainCount,
        totalObservations: totalCount
      };
    });
  }

  // ── Daily decay / compaction ───────────────────────────────────────────────
  function compact() {
    return enqueue(function () {
      var t = today();
      return load().then(function (snitch) {
        for (var tracker in snitch) {
          if (!Object.prototype.hasOwnProperty.call(snitch, tracker)) continue;
          var entry = snitch[tracker];
          var sites = entry.s || {};
          for (var site in sites) {
            if (!Object.prototype.hasOwnProperty.call(sites, site)) continue;
            if (t - sites[site] > SITE_TTL_DAYS) delete sites[site];
          }
          if (Object.keys(sites).length === 0) delete snitch[tracker];
        }
        return save();
      });
    });
  }

  // ── Read APIs (for popup / options / diagnostics / SW console) ─────────────
  function getStats(topN) {
    var t = today();
    return load().then(function (snitch) {
      var blockCount = 0, cookieCount = 0, observeCount = 0;
      var rows = [];
      for (var tracker in snitch) {
        if (!Object.prototype.hasOwnProperty.call(snitch, tracker)) continue;
        var entry = snitch[tracker];
        var score = scoreEntry(entry, t);
        // tracker is the HASHED key; use the hashed yellowlist for the downgrade.
        var v = verdictWith(isYellowKey(tracker), score);
        if (v === 'block') blockCount++;
        else if (v === 'cookieblock') cookieCount++;
        else if (v === 'observing') observeCount++;
        rows.push({
          domain: tracker,                             // hashed key (no plaintext stored)
          score: Math.round(score * 100) / 100,
          sites: Object.keys(entry.s || {}).length,
          verdict: v,
          // Age in days since first sighting: the enforcer's minimum-observation
          // gate needs it (a young "prevalent" domain may just be a new CDN).
          ageDays: (typeof entry.first === 'number') ? Math.max(0, t - entry.first) : 0
        });
      }
      rows.sort(function (a, b) { return b.score - a.score; });
      return {
        mode: 'observe-only',
        totalTrackers: rows.length,
        wouldBlock: blockCount,
        wouldCookieblock: cookieCount,
        observing: observeCount,
        top: rows.slice(0, topN || 25)
      };
    });
  }
  function getVerdict(host) {
    var t = today();
    var base = baseOf(host);
    return load().then(function (snitch) {
      var entry = base ? snitch[hashHost(base)] : null;
      var score = entry ? scoreEntry(entry, t) : 0;
      return { domain: base, score: Math.round(score * 100) / 100, verdict: verdictFor(base, score) };
    });
  }
  // Trackers SPOTTED on a given page right now (observe-only snapshot for the
  // popup's per-site Radar panel). Returns the deduped third-party base domains
  // with their current cross-site score + verdict. Records nothing here.
  function spotted(firstPartyHost, hostList) {
    var t = today();
    var fpBase = baseOf(firstPartyHost);
    return load().then(function (snitch) {
      var out = [];
      if (!fpBase || !Array.isArray(hostList)) return out;
      var seen = {};
      for (var i = 0; i < hostList.length; i++) {
        var tBase = baseOf(hostList[i]);
        if (!tBase || tBase === fpBase) continue;     // first-party
        if (sameOwner(tBase, fpBase)) continue;       // same-owner first-party set
        if (seen[tBase]) continue;                    // dedupe within this page
        seen[tBase] = 1;
        var entry = snitch[hashHost(tBase)];
        var score = entry ? scoreEntry(entry, t) : 0;
        out.push({
          domain: tBase,
          score: Math.round(score * 100) / 100,
          sites: entry ? Object.keys(entry.s || {}).length : 0,
          verdict: verdictFor(tBase, score)
        });
      }
      out.sort(function (a, b) { return b.score - a.score; });
      return out;
    });
  }
  function reset() {
    _cache = {};
    return chrome.storage.local.remove([SNITCH_KEY, META_KEY])
      .then(function () { return { ok: true }; })
      .catch(function () { return { ok: false }; });
  }

  NS.record = record;
  NS.recordSizes = recordSizes;
  NS.compact = compact;
  NS.getStats = getStats;
  NS.getVerdict = getVerdict;
  NS.spotted = spotted;
  NS.getSizeEstimate = getSizeEstimate;
  NS.reset = reset;
  NS.hashHost = hashHost; // exposed so callers/tests can derive the hashed storage keys

  // ── Message listener (additive; coexists with background.js's own router) ──
  try {
    chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
      try {
        if (!sender || sender.id !== chrome.runtime.id) return false;
        if (!message || typeof message.type !== 'string') return false;
        switch (message.type) {
          case 'pawsoff_prevalence_observe':
            record(message.firstParty, message.hosts).then(function () {
              // Also learn transfer sizes if the collector sent them.
              if (message.hostSizes) recordSizes(message.hostSizes);
              return spotted(message.firstParty, message.hosts);
            }).then(
              function (list) { try { sendResponse({ ok: true, spotted: list }); } catch (_) {} },
              function () { try { sendResponse({ ok: false, spotted: [] }); } catch (_) {} }
            );
            return true;
          case 'pawsoff_prevalence_getStats':
            getStats(message.topN).then(
              function (stats) { try { sendResponse({ ok: true, stats: stats }); } catch (_) {} },
              function () { try { sendResponse({ ok: false, stats: null }); } catch (_) {} }
            );
            return true;
          case 'pawsoff_prevalence_getVerdict':
            getVerdict(message.host).then(
              function (v) { try { sendResponse({ ok: true, verdict: v }); } catch (_) {} },
              function () { try { sendResponse({ ok: false, verdict: null }); } catch (_) {} }
            );
            return true;
          case 'pawsoff_prevalence_reset':
            reset().then(
              function (r) { try { sendResponse(r); } catch (_) {} },
              function () { try { sendResponse({ ok: false }); } catch (_) {} }
            );
            return true;
          case 'pawsoff_prevalence_getSizeEstimate':
            getSizeEstimate().then(
              function (est) { try { sendResponse({ ok: true, estimate: est }); } catch (_) {} },
              function () { try { sendResponse({ ok: false, estimate: null }); } catch (_) {} }
            );
            return true;
          default:
            return false;
        }
      } catch (_) {
        try { sendResponse({ ok: false }); } catch (e) { /* ignore */ }
        return false;
      }
    });
  } catch (_) { /* runtime API unavailable */ }

  // ── Daily decay alarm (chrome.alarms only -- never setInterval in the SW) ──
  function ensureAlarm() {
    try { chrome.alarms.create(DECAY_ALARM, { periodInMinutes: 1440 }); } catch (_) { /* ignore */ }
  }
  try { chrome.runtime.onInstalled.addListener(ensureAlarm); } catch (_) { /* ignore */ }
  try { chrome.runtime.onStartup.addListener(ensureAlarm); } catch (_) { /* ignore */ }
  try {
    chrome.alarms.onAlarm.addListener(function (alarm) {
      try { if (alarm && alarm.name === DECAY_ALARM) compact(); } catch (_) { /* ignore */ }
    });
  } catch (_) { /* ignore */ }

})(typeof self !== 'undefined' ? self : this);
