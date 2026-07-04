/* PawsOff, Prevalence Collector - observe-only, top frame only.
 *
 * Reads the Performance Timeline to learn which third-party domains appear
 * on which first-party sites. Only reads resources the page already loaded -
 * never intercepts, blocks, or initiates a request, so it can't break page
 * behaviour. Reports hostnames only (never full URLs, cookies, or page
 * content) to the background learner; nothing leaves the device.
 *
 * This is the sensor for the local prevalence tier - enforcement (actual
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
    var SEND_AFTER_MS = 4000; // batch window after load before the first flush
    var MAX_HOSTS = 250;      // cap message size
    var ENABLED_KEY = '__pawsOff_prevalence_enabled';
    var MASTER_KEY = '__pawsOff_master_enabled';
    var RADAR_PREFIX = '__pawsOff_radar_'; // per-origin "spotted here" snapshot for the popup
    var RADAR_MAX = 300;                    // cap distinct sites remembered

    var hosts = new Set();
    var hostSizes = {};  // hostname → total transferSize in bytes (real measurement)
    var sent = false;
    var observer = null;

    // One-way FNV-1a/32 host digest - must match po-catch.js + popup.js so the
    // popup can find this site's radar snapshot by its hashed origin.
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

    function addEntry(u, transferSize) {
      if (!u || hosts.size >= MAX_HOSTS) return;
      try {
        var h = new URL(u, location.href).hostname;
        if (h && h !== FIRST_PARTY) {
          hosts.add(h);
          // Accumulate real transferSize (bytes over the wire) per host.
          // transferSize is 0 for cache hits and cross-origin opaque resources
          // (CORS blocks the timing data); we only record positive values.
          if (typeof transferSize === 'number' && transferSize > 0) {
            hostSizes[h] = (hostSizes[h] || 0) + transferSize;
          }
        }
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

    function flush() {
      if (sent) return;
      sent = true;
      try { if (observer) observer.disconnect(); } catch (_) { /* ignore */ }
      if (hosts.size === 0) return;
      var payload = {
        type: 'pawsoff_prevalence_observe',
        firstParty: FIRST_PARTY,
        hosts: Array.from(hosts),
        // Real transfer sizes observed from the Performance API. The learner
        // uses these to build per-domain average sizes for honest "bandwidth
        // saved" estimates. Only hosts with measurable transferSize are included.
        hostSizes: Object.keys(hostSizes).length > 0 ? hostSizes : undefined
      };
      try {
        chrome.runtime.sendMessage(payload, function (resp) {
          void chrome.runtime.lastError;
          stashRadarSnapshot(resp);
        });
      } catch (_) { /* extension context invalidated -- ignore */ }
    }

    // OBSERVE-ONLY: stash what the radar spotted on THIS site so the popup can
    // show it. Keyed by hashed origin; nothing is blocked or sent off-device.
    function stashRadarSnapshot(resp) {
      try {
        var list = (resp && resp.ok && Array.isArray(resp.spotted)) ? resp.spotted : null;
        if (!list || list.length === 0) return;
        var oh = hashHost(FIRST_PARTY);
        if (!oh) return;
        var rec = { ts: Date.now(), spotted: list.slice(0, 24) };
        var obj = {};
        obj[RADAR_PREFIX + oh] = rec;
        chrome.storage.local.set(obj, function () {
          void chrome.runtime.lastError;
          if (Math.random() < 0.1) pruneRadar();
        });
      } catch (_) { /* ignore */ }
    }

    function begin() {
      harvestExisting();
      startObserver();
      // Flush on a short timer, and again when the user navigates away / hides
      // the tab (captures late-loading resources). setTimeout is fine in a
      // content script -- the no-timer rule only applies to the service worker.
      try { setTimeout(flush, SEND_AFTER_MS); } catch (_) { /* ignore */ }
      try { window.addEventListener('pagehide', flush, { once: true }); } catch (_) { /* ignore */ }
      try {
        document.addEventListener('visibilitychange', function () {
          if (document.visibilityState === 'hidden') flush();
        });
      } catch (_) { /* ignore */ }
    }

    // Test-only hook: expose the pure helpers to the Node test harness. Inert
    // in the browser, where self.__pawsOff_TEST is never set.
    try {
      if (typeof self !== 'undefined' && self.__pawsOff_TEST) {
        self.__pawsOff_collectorInternals = {
          hashHost: hashHost,
          radarKeysToEvict: radarKeysToEvict,
          RADAR_PREFIX: RADAR_PREFIX,
          RADAR_MAX: RADAR_MAX,
          MAX_HOSTS: MAX_HOSTS
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
