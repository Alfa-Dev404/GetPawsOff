/* PawsOff, Prevalence Collector — observe-only, top frame only.
 *
 * Reads the Performance Timeline to learn which third-party domains appear
 * on which first-party sites. Only reads resources the page already loaded —
 * never intercepts, blocks, or initiates a request, so it can't break page
 * behaviour. Reports hostnames only (never full URLs, cookies, or page
 * content) to the background learner; nothing leaves the device.
 *
 * This is the sensor for the local prevalence tier — enforcement (actual
 * blocking) is a separate, later milestone. Nothing here acts on what it sees.
 */
'use strict';
(function () {
  try {
    // Top frame only (manifest is all_frames:false; this is a belt-and-braces guard).
    if (window.top !== window) return;
    var proto = location.protocol;
    if (proto !== 'http:' && proto !== 'https:') return;

    var FIRST_PARTY = location.hostname;
    var PSL = (typeof self !== 'undefined' && self.PawsOffPSL) || null;
    var FIRST_PARTY_BASE = baseDomain(FIRST_PARTY);
    var SNAPSHOT_DELAYS_MS = [4000, 15000, 60000]; // cover initial + delayed/SPA resources
    var MAX_HOSTS = 250;      // cap message size
    var ENABLED_KEY = '__pawsOff_prevalence_enabled';
    var MASTER_KEY = '__pawsOff_master_enabled';
    var RADAR_PREFIX = '__pawsOff_radar_'; // per-origin "spotted here" snapshot for the popup
    var RADAR_MAX = 300;                    // cap distinct sites remembered

    var hosts = new Set();
    var hostSizes = {};  // hostname → total transferSize in bytes (real measurement)
    var stopped = false;
    var observer = null;

    function baseDomain(host) {
      try {
        if (PSL && typeof PSL.getBaseDomain === 'function') return PSL.getBaseDomain(host) || host;
      } catch (_) { /* fall through */ }
      return host;
    }

    function isSameSiteHost(host) {
      return host === FIRST_PARTY || baseDomain(host) === FIRST_PARTY_BASE;
    }

    // One-way FNV-1a/32 host digest — must match po-catch.js + popup.js so the
    // popup can find this site's radar snapshot by its hashed origin.
    function hashHost(host) {
      if (typeof host !== 'string') return null;
      if (!host) return null;
      var h = 0x811c9dc5;
      var s = host.toLowerCase();
      for (var i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
      }
      return 'h:' + h.toString(16).padStart(8, '0');
    }

    // Pure: given a storage snapshot, return the oldest radar keys to evict so we
    // keep at most RADAR_MAX distinct sites ([] when already within budget).
    function radarKeysToEvict(all) {
      var keys = Object.keys(all || {}).filter(function (k) { return k.indexOf(RADAR_PREFIX) === 0; });
      if (keys.length <= RADAR_MAX) return [];
      keys.sort(function (a, b) { return ((all[a] && all[a].ts) || 0) - ((all[b] && all[b].ts) || 0); });
      return keys.slice(0, keys.length - RADAR_MAX);
    }

    function pruneRadar() {
      try {
        chrome.storage.local.get(null, function (all) {
          try {
            var victims = radarKeysToEvict(all);
            if (victims.length) chrome.storage.local.remove(victims);
          } catch (_) { /* silent */ }
        });
      } catch (_) { /* silent */ }
    }

    function recordTransferSize(host, transferSize) {
      if (!Number.isFinite(transferSize)) return;
      if (transferSize <= 0) return;
      hostSizes[host] = (hostSizes[host] || 0) + transferSize;
    }

    function addEntry(u, transferSize) {
      if (!u) return;
      try {
        var h = new URL(u, location.href).hostname;
        if (!h) return;
        if (isSameSiteHost(h)) return;
        if (!hosts.has(h) && hosts.size >= MAX_HOSTS) return;
        hosts.add(h);
        recordTransferSize(h, transferSize);
      } catch (_) { /* ignore malformed URLs (data:, blob:, etc.) */ }
    }

    function harvestExisting() {
      try {
        var entries = performance.getEntriesByType('resource');
        for (var i = 0; i < entries.length; i++) addEntry(entries[i].name, entries[i].transferSize);
      } catch (_) { /* Performance API unavailable */ }
    }

    function startObserver() {
      try {
        observer = new PerformanceObserver(function (list) {
          var es = list.getEntries();
          for (var i = 0; i < es.length; i++) addEntry(es[i].name, es[i].transferSize);
        });
        observer.observe({ type: 'resource', buffered: true });
      } catch (_) { /* fall back to the one-shot harvest above */ }
    }

    function stopObservation() {
      stopped = true;
      try { if (observer) observer.disconnect(); } catch (_) { /* ignore */ }
    }

    function observationPayload() {
      return {
        type: 'pawsoff_prevalence_observe',
        firstParty: FIRST_PARTY,
        hosts: Array.from(hosts),
        hostSizes: Object.keys(hostSizes).length > 0 ? hostSizes : undefined
      };
    }

    function takeObservationPayload() {
      var payload = observationPayload();
      hostSizes = {};
      return payload;
    }

    function sendObservation(payload) {
      try {
        chrome.runtime.sendMessage(payload, function (resp) {
          void chrome.runtime.lastError;
          stashRadarSnapshot(resp);
        });
      } catch (_) { /* extension context invalidated -- ignore */ }
    }

    function flush(stopAfter) {
      if (stopped) return;
      if (stopAfter) stopObservation();
      if (hosts.size === 0) return;
      sendObservation(takeObservationPayload());
    }

    // OBSERVE-ONLY: stash what the radar spotted on THIS site so the popup can
    // show it. Keyed by hashed origin; nothing is blocked or sent off-device.
    function radarSpotsFromResponse(resp) {
      if (!resp) return null;
      if (!resp.ok) return null;
      if (!Array.isArray(resp.spotted)) return null;
      return resp.spotted;
    }

    function storeRadarSnapshot(originHash, spotted) {
      var obj = {};
      obj[RADAR_PREFIX + originHash] = { ts: Date.now(), spotted: spotted };
      chrome.storage.local.set(obj, function () {
        void chrome.runtime.lastError;
        if (Math.random() < 0.1) pruneRadar();
      });
    }

    function stashRadarSnapshot(resp) {
      try {
        var list = radarSpotsFromResponse(resp);
        if (list === null) return;
        var oh = hashHost(FIRST_PARTY);
        if (!oh) return;
        var spotted = sanitizeRadarSpots(list);
        storeRadarSnapshot(oh, spotted);
      } catch (_) { /* ignore */ }
    }

    function sanitizedRadarSpot(spot, allowedVerdicts) {
      if (!spot) return null;
      if (typeof spot.domain !== 'string') return null;
      var domainHash = hashHost(spot.domain);
      if (!domainHash) return null;
      return {
        domainHash: domainHash,
        score: Number.isFinite(spot.score) ? spot.score : 0,
        sites: Number.isFinite(spot.sites) ? Math.max(0, Math.floor(spot.sites)) : 0,
        verdict: allowedVerdicts[spot.verdict] === true ? spot.verdict : 'allow',
      };
    }

    function sanitizeRadarSpots(list) {
      var out = [];
      var allowedVerdicts = { allow: true, observing: true, cookieblock: true, block: true };
      if (!Array.isArray(list)) return out;
      for (var i = 0; i < list.length; i++) {
        if (out.length >= 24) break;
        var sanitized = sanitizedRadarSpot(list[i], allowedVerdicts);
        if (sanitized) out.push(sanitized);
      }
      return out;
    }

    function onVisibilityChange() {
      if (document.visibilityState === 'hidden') flush(false);
    }

    function begin() {
      harvestExisting();
      startObserver();
      // Snapshot several bounded windows so delayed ads, embeds, and SPA loads
      // are learned too. The same first-party sighting never inflates the score;
      // the learner stores one timestamp per site. Stop when the page leaves.
      for (var i = 0; i < SNAPSHOT_DELAYS_MS.length; i++) {
        try { setTimeout(function () { flush(false); }, SNAPSHOT_DELAYS_MS[i]); } catch (_) { /* ignore */ }
      }
      try { window.addEventListener('pagehide', function () { flush(true); }, { once: true }); } catch (_) { /* ignore */ }
      try {
        document.addEventListener('visibilitychange', onVisibilityChange);
      } catch (_) { /* ignore */ }
    }

    // Test-only hook: expose the pure helpers to the Node test harness. Inert
    // in the browser, where self.__pawsOff_TEST is never set.
    try {
      if (typeof self !== 'undefined' && self.__pawsOff_TEST) {
        self.__pawsOff_collectorInternals = {
          hashHost: hashHost,
          isSameSiteHost: isSameSiteHost,
          radarKeysToEvict: radarKeysToEvict,
          radarSpotsFromResponse: radarSpotsFromResponse,
          sanitizeRadarSpots: sanitizeRadarSpots,
          stashRadarSnapshot: stashRadarSnapshot,
          addEntry: addEntry,
          observationPayload: observationPayload,
          takeObservationPayload: takeObservationPayload,
          onVisibilityChange: onVisibilityChange,
          isStopped: function () { return stopped; },
          RADAR_PREFIX: RADAR_PREFIX,
          RADAR_MAX: RADAR_MAX,
          MAX_HOSTS: MAX_HOSTS,
          SNAPSHOT_DELAYS_MS: SNAPSHOT_DELAYS_MS
        };
      }
    } catch (_) { /* ignore */ }

    // Respect the master switch + the per-feature toggle (both default ON).
    try {
      chrome.storage.local.get([ENABLED_KEY, MASTER_KEY], function (res) {
        try {
          if (chrome.runtime.lastError) { begin(); return; }
          var masterOff = res && res[MASTER_KEY] === false;
          var featureOff = res && res[ENABLED_KEY] === false;
          if (masterOff || featureOff) return; // observing disabled by the user
          begin();
        } catch (_) { begin(); }
      });
    } catch (_) { begin(); }
  } catch (_) { /* never throw into the host page */ }
})();
