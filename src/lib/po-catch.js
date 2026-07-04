// po-catch.js, PawsOff shared "catch" recorder.
//
// Loaded FIRST in every feature content-script entry (see manifest) so the
// features can call window.PawsOffCatch.record(...) to log a per-site "catch"
// for the popup's "Today's catch" feed. Context-agnostic; guards re-injection.
//
// The visited host is stored only as a one-way FNV-1a digest (the same
// hashHost the feature scripts use), never plaintext. Catch labels describe
// the tracker/banner/clause-category, never page content. Local-only,
// pruned aggressively, nothing transmitted.
(function () {
  'use strict';
  var G = (typeof self !== 'undefined') ? self : (typeof window !== 'undefined' ? window : globalThis);
  if (G.PawsOffCatch) return; // already defined in this isolated world

  var CATCH_PREFIX   = '__pawsOff_catch_';
  var CATCH_MAX      = 400;   // global cap across all sites
  var PRUNE_SAMPLE   = 0.1;   // sampled prune (matches the feature scripts' style)

  /** One-way FNV-1a/32 host digest. MUST match the feature scripts + popup. */
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

  function rand() { return Math.random().toString(36).slice(2, 8); }

  // Local origin of THIS frame. Used only as a last-resort fallback, a catch
  // made inside a cross-origin frame would be mis-attributed to the frame.
  function currentOriginHash() {
    try { return hashHost((G.location && G.location.hostname) || ''); }
    catch (_) { return null; }
  }

  // Resolve the top-level host synchronously when possible. A catch inside a
  // cross-origin CMP iframe (e.g. Sourcepoint) must attribute to the site the
  // user is visiting, not the iframe's own origin - else the popup's per-site
  // filter hides it. Both signals are browser-populated + read-only, so page
  // script can't spoof them. Returns null for a sandboxed/null-origin frame;
  // the caller falls back to asking the background worker.
  function topHostSync() {
    try {
      if (G.top === G.self) return (G.location && G.location.hostname) || '';
    } catch (_) { /* cross-origin top access - we are in a sub-frame */ }
    try {
      var ao = G.location && G.location.ancestorOrigins;
      if (ao && ao.length) {
        var top = ao[ao.length - 1]; // last ancestor == top-level origin
        if (top && top !== 'null') return new URL(top).hostname;
      }
    } catch (_) { /* ignore */ }
    return null;
  }

  function pruneCatches() {
    try {
      chrome.storage.local.get(null, function (all) {
        try {
          var keys = Object.keys(all || {}).filter(function (k) { return k.indexOf(CATCH_PREFIX) === 0; });
          if (keys.length <= CATCH_MAX) return;
          var toRemove = keys.length - CATCH_MAX;
          var byTs = function (a, b) { return ((all[a] && all[a].ts) || 0) - ((all[b] && all[b].ts) || 0); };
          // Evict oldest TRACKER catches first. Trackers are high-volume; banners
          // and terms are rare + the headline of the popup, so they must NEVER be
          // crowded out of storage by a flood of tracker records.
          var trackers = keys.filter(function (k) { return all[k] && all[k].feature === 'tracker'; }).sort(byTs);
          var removeList = trackers.slice(0, toRemove);
          // Only if there aren't enough trackers to reclaim do we touch the rest.
          if (removeList.length < toRemove) {
            var pick = {};
            for (var i = 0; i < removeList.length; i++) pick[removeList[i]] = 1;
            var rest = keys.filter(function (k) { return !pick[k]; }).sort(byTs);
            removeList = removeList.concat(rest.slice(0, toRemove - removeList.length));
          }
          if (removeList.length) chrome.storage.local.remove(removeList);
        } catch (_) { /* silent */ }
      });
    } catch (_) { /* silent */ }
  }

  /**
   * Record a catch. entry: { feature:'banner'|'tracker'|'terms', label?, category?,
   * detail?, mayBreak?, originHash? }. Unique-key write (no read-modify-write race).
   */
  // Unique-key write (no read-modify-write race), then sampled prune.
  function writeRecord(rec) {
    try {
      var obj = {};
      obj[CATCH_PREFIX + rec.ts + '_' + rand()] = rec;
      chrome.storage.local.set(obj, function () {
        try { void chrome.runtime.lastError; } catch (_) {}
        if (Math.random() < PRUNE_SAMPLE) pruneCatches();
      });
    } catch (_) { /* silent - storage may be restricted in private contexts */ }
  }

  function record(entry) {
    try {
      if (!entry || !entry.feature) return;
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
      var rec = {
        ts: Date.now(),
        originHash: null, // attributed to the TOP-LEVEL site below
        feature: String(entry.feature),
        label: entry.label ? String(entry.label).slice(0, 80) : '',
        category: entry.category ? String(entry.category).slice(0, 40) : '',
        detail: entry.detail ? String(entry.detail).slice(0, 120) : '',
        mayBreak: entry.mayBreak === true,
        wall: entry.wall === true,
        // seen = a consent banner we DETECTED but could not auto-reject (e.g. its
        // reject control lives in the CMP's own cross-origin iframe). Recorded so
        // the popup honestly shows a banner was present instead of a bare 0, and
        // labelled "Detected" (never "Rejected") so we don't claim a block.
        seen: entry.seen === true
      };
      // 1) Explicit caller attribution always wins.
      if (entry.originHash) { rec.originHash = entry.originHash; writeRecord(rec); return; }
      // 2) Fast path: top frame, or a cross-origin frame whose top origin we can
      //    read synchronously via ancestorOrigins. No IPC, no race window.
      var host = topHostSync();
      if (host !== null) { rec.originHash = hashHost(host); writeRecord(rec); return; }
      // 3) Fallback (sandboxed / null-origin frame): ask the worker, which derives
      //    the top host from the browser-trusted sender.tab.url. We only ever
      //    receive the HASH back, the plaintext URL never reaches this frame.
      try {
        chrome.runtime.sendMessage({ type: 'pawsoff_topOriginHash' }, function (resp) {
          try { void chrome.runtime.lastError; } catch (_) {}
          rec.originHash = (resp && resp.originHash) ? resp.originHash : currentOriginHash();
          writeRecord(rec);
        });
      } catch (_) {
        rec.originHash = currentOriginHash();
        writeRecord(rec);
      }
    } catch (_) { /* silent */ }
  }

  function prettyDomain(d) { return d ? String(d).replace(/^www\./, '') : 'Tracker'; }
  function humanize(id) {
    if (!id) return 'Risky clause';
    return String(id).replace(/[_-]+/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  // Convenience wrappers used by the content-script hooks.
  function recordTracker(domain, category, mayBreak) {
    record({ feature: 'tracker', label: prettyDomain(domain), category: category || 'Tracker', detail: domain || '', mayBreak: !!mayBreak });
  }
  function recordBanner(framework) {
    record({ feature: 'banner', label: 'Cookie banner', category: 'Consent', detail: framework ? ('via ' + framework) : 'rejected' });
  }
  // A consent banner we SAW but could not auto-reject (its reject control is in
  // the CMP's own cross-origin iframe, or no free reject exists). Surfaced so the
  // popup never shows 0 when a banner is plainly on screen - flagged seen:true so
  // it renders as "Detected", not "Rejected".
  function recordBannerSeen(framework) {
    record({ feature: 'banner', label: 'Cookie banner', category: 'Consent', detail: framework ? ('detected via ' + framework + ', no auto-reject') : 'detected, no auto-reject', seen: true });
  }
  // Pay-or-consent WALL: we deliberately did NOT act (refusing would cost a paid
  // subscription). Flagged in the popup so the user knows we saw it and why.
  function recordWall(detail) {
    record({ feature: 'banner', label: 'Cookie wall', category: 'Pay-or-consent', detail: detail || 'Refusing requires payment', wall: true });
  }
  function recordClause(categoryId) {
    record({ feature: 'terms', label: humanize(categoryId), category: 'Terms', detail: 'in this page\u2019s policy' });
  }

  G.PawsOffCatch = {
    record: record,
    recordTracker: recordTracker,
    recordBanner: recordBanner,
    recordBannerSeen: recordBannerSeen,
    recordWall: recordWall,
    recordClause: recordClause,
    hashHost: hashHost,
    PREFIX: CATCH_PREFIX
  };

  // Test-only hook (no-op in the extension: content scripts have no CommonJS
  // `module`). Lets the Node harness exercise the prune policy directly.
  try {
    if (typeof module !== 'undefined' && module.exports) {
      module.exports.__test = { pruneCatches: pruneCatches, CATCH_PREFIX: CATCH_PREFIX, CATCH_MAX: CATCH_MAX };
    }
  } catch (_) { /* ignore */ }
}());
