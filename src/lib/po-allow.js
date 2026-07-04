/*
 * PawsOff, per-site allow-list model (pure, context-agnostic).
 *
 * Single source of truth for "the user un-broke this site" (pause) and "the user
 * allowed this tracker domain here" (per-domain). Loaded in popup + content
 * scripts as window.PawsOffAllow, and required directly by the Node test harness
 * (module.exports.__test). No load-time side effects; no DOM; no storage writes
 * until read()/write() are called.
 *
 * Storage shape (chrome.storage.local under STORAGE_KEY):
 *   { v: 1, sites: { [originHash]: { paused: <ts|0>, domains: { [domain]: <ts> } } } }
 */
(function () {
  'use strict';
  var G = (typeof self !== 'undefined') ? self
        : (typeof globalThis !== 'undefined') ? globalThis
        : (typeof window !== 'undefined') ? window : this;
  if (G && G.PawsOffAllow) return; // already installed in this realm

  var STORAGE_KEY = '__pawsOff_allowlist';
  var SCHEMA = 1;
  var MAX_SITES = 300;
  var MAX_DOMAINS_PER_SITE = 100;

  // Normalize a host/URL to a bare registrable-ish domain. Only www. is stripped
  //, real subdomains are preserved so allowing a.tracker.com never silently
  // allows the whole of tracker.com. Returns '' for anything that isn't a
  // plausible public domain (no dot, bad chars, localhost, etc.).
  function normDomain(input) {
    if (!input || typeof input !== 'string') return '';
    var s = input.trim().toLowerCase()
      .replace(/^[a-z][a-z0-9+.\-]*:\/\//, '')
      .replace(/^[^@\/]*@/, '');
    s = s.split('/')[0].split('?')[0].split('#')[0].split(':')[0].replace(/^www\./, '');
    if (!/^[a-z0-9.\-]+$/.test(s)) return '';
    if (s.indexOf('.') < 0) return '';
    if (s.charAt(0) === '.' || s.charAt(s.length - 1) === '.' || s.indexOf('..') >= 0) return '';
    return s;
  }

  function emptyState() { return { v: SCHEMA, sites: {} }; }

  function maxTs(domains) {
    var m = 0; if (!domains) return 0;
    Object.keys(domains).forEach(function (k) { if (domains[k] > m) m = domains[k]; });
    return m;
  }

  // A persisted site key must be a hashHost() output ('h:' prefix), never a
  // plaintext hostname (hash-only privacy invariant). Only the sentinel is
  // checked, not an exact length, so tampered/legacy plaintext keys get
  // dropped. The per-site `domains` map stays plaintext on purpose - those
  // are public tracker names the popup shows the user, not site identities.
  function isHashKey(k) { return typeof k === 'string' && k.slice(0, 2) === 'h:' && k.length > 2; }

  // Builds a fresh, validated state from arbitrary input without mutating it -
  // every setter normalizes first, which is what gives them all a no-mutation guarantee.
  function normalizeState(raw) {
    var st = emptyState();
    if (!raw || typeof raw !== 'object' || !raw.sites || typeof raw.sites !== 'object') return st;
    Object.keys(raw.sites).forEach(function (oh) {
      var src = raw.sites[oh];
      if (!isHashKey(oh) || !src || typeof src !== 'object') return; // drop non-hash (plaintext) site keys
      var paused = (typeof src.paused === 'number' && src.paused > 0) ? src.paused : 0;
      // pausedUntil: epoch-ms expiry for a timed pause; 0 = indefinite. A
      // legacy entry (field absent) defaults to 0/indefinite for backward
      // compat, but a field that's present and garbage must NOT collapse to
      // that same value - that would silently turn a broken 15-minute pause
      // permanent. Sentinel 1 keeps it truthy but reads as already-expired,
      // so protection comes back instead of staying off.
      var pausedUntil;
      if (!Object.prototype.hasOwnProperty.call(src, 'pausedUntil')) {
        pausedUntil = 0;
      } else if (typeof src.pausedUntil === 'number' && src.pausedUntil >= 0 && !isNaN(src.pausedUntil)) {
        pausedUntil = src.pausedUntil;
      } else {
        pausedUntil = 1; // present but corrupted → treat as already expired
      }
      var domains = {};
      var dsrc = (src.domains && typeof src.domains === 'object') ? src.domains : {};
      Object.keys(dsrc).forEach(function (k) {
        var nd = normDomain(k);
        var ts = dsrc[k];
        if (nd && typeof ts === 'number' && ts > 0) domains[nd] = ts;
      });
      capDomains(domains);                                       // enforce the per-site cap on load too
      if (!paused && Object.keys(domains).length === 0) return;  // prune empty sites
      st.sites[oh] = { paused: paused, pausedUntil: paused ? pausedUntil : 0, domains: domains };
    });
    capSites(st.sites);
    return st;
  }

  function capDomains(domains) {
    var keys = Object.keys(domains);
    if (keys.length <= MAX_DOMAINS_PER_SITE) return;
    keys.sort(function (a, b) { return domains[a] - domains[b]; }); // oldest first
    for (var i = 0; i < keys.length - MAX_DOMAINS_PER_SITE; i++) delete domains[keys[i]];
  }
  function capSites(sites) {
    var keys = Object.keys(sites);
    if (keys.length <= MAX_SITES) return;
    keys.sort(function (a, b) {
      var ta = Math.max(sites[a].paused || 0, maxTs(sites[a].domains));
      var tb = Math.max(sites[b].paused || 0, maxTs(sites[b].domains));
      return ta - tb; // oldest-touched first
    });
    for (var i = 0; i < keys.length - MAX_SITES; i++) delete sites[keys[i]];
  }

  // Paused = flagged AND not expired. A lapsed timed pause reads as NOT paused
  // everywhere (content scripts included) the instant it expires - protection
  // resumes on its own even before the background alarm cleans up storage.
  function isPaused(state, oh, now) {
    var s = (state && state.sites && oh) ? state.sites[oh] : null;
    if (!s || !(s.paused > 0)) return false;
    var until = (typeof s.pausedUntil === 'number') ? s.pausedUntil : 0;
    return until === 0 || until > (typeof now === 'number' ? now : Date.now());
  }
  /** Remaining pause time: 0 = not paused / expired, -1 = indefinite ("Always"),
   *  else milliseconds left. */
  function pauseRemainingMs(state, oh, now) {
    var s = (state && state.sites && oh) ? state.sites[oh] : null;
    if (!s || !(s.paused > 0)) return 0;
    var until = (typeof s.pausedUntil === 'number') ? s.pausedUntil : 0;
    if (until === 0) return -1;
    var left = until - (typeof now === 'number' ? now : Date.now());
    return left > 0 ? left : 0;
  }
  /** Site hashes whose timed pause has lapsed (for the background sweep). */
  function expiredPauses(state, now) {
    var t = (typeof now === 'number') ? now : Date.now();
    var out = [];
    var sites = (state && state.sites) || {};
    Object.keys(sites).forEach(function (oh) {
      var s = sites[oh];
      if (s && s.paused > 0 && s.pausedUntil > 0 && s.pausedUntil <= t) out.push(oh);
    });
    return out;
  }
  /** Active TIMED pauses as [{oh, until}] (for re-arming alarms on SW start). */
  function timedPauses(state, now) {
    var t = (typeof now === 'number') ? now : Date.now();
    var out = [];
    var sites = (state && state.sites) || {};
    Object.keys(sites).forEach(function (oh) {
      var s = sites[oh];
      if (s && s.paused > 0 && s.pausedUntil > t) out.push({ oh: oh, until: s.pausedUntil });
    });
    return out;
  }
  /** "14m left" / "1h 5m left" for a timed pause; '' for 0 or indefinite (-1). */
  function formatPauseLeft(ms) {
    if (typeof ms !== 'number' || ms <= 0) return '';
    var mins = Math.ceil(ms / 60000);
    if (mins < 60) return mins + 'm left';
    var h = Math.floor(mins / 60), m = mins % 60;
    return m ? (h + 'h ' + m + 'm left') : (h + 'h left');
  }
  function isDomainAllowed(state, oh, domain) {
    var s = (state && state.sites && oh) ? state.sites[oh] : null;
    var nd = normDomain(domain);
    return !!(s && nd && s.domains && s.domains[nd] > 0);
  }
  function isAllowed(state, oh, domain) {
    return isPaused(state, oh) || isDomainAllowed(state, oh, domain);
  }
  function allowedDomains(state, oh) {
    var s = (state && state.sites && oh) ? state.sites[oh] : null;
    return (s && s.domains) ? Object.keys(s.domains) : [];
  }

  // until: epoch-ms expiry for a timed pause; omit/0 for indefinite ("Always").
  function setPaused(state, oh, on, until) {
    var st = normalizeState(state); // fresh clone - input untouched
    // Guard against a caller bug passing a plaintext host: normalizeState
    // only cleans existing entries, so without this a bad `oh` would write a
    // plaintext key straight to storage until the next read/write cycle.
    if (!isHashKey(oh)) return st;
    if (on) {
      var e = st.sites[oh] || { paused: 0, pausedUntil: 0, domains: {} };
      e.paused = Date.now();
      e.pausedUntil = (typeof until === 'number' && until > 0) ? until : 0;
      st.sites[oh] = e;
      capSites(st.sites);
    } else if (st.sites[oh]) {
      st.sites[oh].paused = 0;
      st.sites[oh].pausedUntil = 0;
      if (Object.keys(st.sites[oh].domains).length === 0) delete st.sites[oh];
    }
    return st;
  }
  function setDomain(state, oh, domain, on) {
    var st = normalizeState(state);
    var nd = normDomain(domain);
    if (!oh || !nd) return st;
    if (on) {
      var e = st.sites[oh] || { paused: 0, domains: {} };
      e.domains[nd] = Date.now();
      capDomains(e.domains);
      st.sites[oh] = e;
      capSites(st.sites);
    } else if (st.sites[oh] && st.sites[oh].domains) {
      delete st.sites[oh].domains[nd];
      if (!st.sites[oh].paused && Object.keys(st.sites[oh].domains).length === 0) delete st.sites[oh];
    }
    return st;
  }
  function clearSite(state, oh) {
    var st = normalizeState(state);
    if (oh && st.sites[oh]) delete st.sites[oh];
    return st;
  }
  function prune(state) { return normalizeState(state); }

  // ── async storage helpers (callback-style; safe in MV3 SW + content + popup) ──
  function read(cb) {
    try {
      G.chrome.storage.local.get(STORAGE_KEY, function (r) {
        cb(normalizeState(r && r[STORAGE_KEY]));
      });
    } catch (_) { cb(emptyState()); }
  }
  function write(state, cb) {
    var st = normalizeState(state);
    try {
      var obj = {}; obj[STORAGE_KEY] = st;
      G.chrome.storage.local.set(obj, function () { if (cb) cb(st); });
    } catch (_) { if (cb) cb(st); }
  }

  var api = {
    STORAGE_KEY: STORAGE_KEY,
    SCHEMA: SCHEMA,
    MAX_SITES: MAX_SITES,
    MAX_DOMAINS_PER_SITE: MAX_DOMAINS_PER_SITE,
    normDomain: normDomain,
    isHashKey: isHashKey,
    emptyState: emptyState,
    normalizeState: normalizeState,
    isPaused: isPaused,
    pauseRemainingMs: pauseRemainingMs,
    expiredPauses: expiredPauses,
    timedPauses: timedPauses,
    formatPauseLeft: formatPauseLeft,
    isDomainAllowed: isDomainAllowed,
    isAllowed: isAllowed,
    allowedDomains: allowedDomains,
    setPaused: setPaused,
    setDomain: setDomain,
    clearSite: clearSite,
    prune: prune,
    read: read,
    write: write,
  };

  if (G) G.PawsOffAllow = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
    module.exports.__test = api;
  }
})();
