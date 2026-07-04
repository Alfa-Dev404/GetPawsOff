// popup.js, PawsOff "Today's catch" popup.
//
// Reads/writes chrome.storage.local only (same keys the content scripts use);
// the content scripts apply toggle changes live via their storage.onChanged
// listeners. The per-site feed is read from the __pawsOff_catch_* entries that
// po-catch.js writes, filtered to the active tab's hashed origin. No inline
// handlers (extension-page CSP). The popup must never throw visibly.
(function () {
  'use strict';

  // ── storage keys (mirror content scripts / background) ──
  var PB_SETTINGS = '__pawsOff_pixelBlock_settings';
  var TS_SETTINGS = '__pawsOff_tosShield_settings';
  var CG_DISABLED = '__pawsOff_consentGhost_disabled';
  var MASTER_KEY  = '__pawsOff_master_enabled';

  var CG_TOTAL = '__pawsOff_cg_total_rejected';
  var PB_TOTAL = '__pawsOff_pb_total_blocked';
  var TS_TOTAL = '__pawsOff_ts_total_flagged';
  // EasyPrivacy network tier (DNR), written by background.reconcileDnrMatches.
  // Disjoint from PB_TOTAL (DOM/pixel tier).
  var NET_TOTAL = '__pawsOff_net_total_blocked';

  var CATCH_PREFIX      = '__pawsOff_catch_';
  // Per-site pause lives in the allow-list (ALLOW_KEY) and is enforced at the
  // network (DNR) + DOM tiers.
  var RADAR_PREFIX      = '__pawsOff_radar_';

  // Per-site allow-list: { v:1, sites:{ [originHash]:{ paused, domains } } }.
  // The shared model lives in src/lib/po-allow.js (window.PawsOffAllow); the
  // popup falls back to local pure helpers when that global isn't present.
  var ALLOW_KEY = '__pawsOff_allowlist';
  var ALLOW = (typeof window !== 'undefined' && window.PawsOffAllow) ? window.PawsOffAllow : null;

  // feature flags mirror the same storage keys the content scripts read.
  var FEATS = ['banner', 'tracker', 'terms'];

  var state = { originHash: null, host: '', filter: 'all', catches: [], allow: { v: 1, sites: {} }, features: { banner: true, tracker: true, terms: true }, _lastAll: {}, _learnedAvgKB: 0, _tabDnrBlocked: 0 };

  // ── storage helpers ──
  function getAll() {
    return new Promise(function (resolve) {
      try { chrome.storage.local.get(null, function (r) { resolve(r || {}); }); }
      catch (_) { resolve({}); }
    });
  }
  function setKeys(obj) {
    return new Promise(function (resolve) {
      try { chrome.storage.local.set(obj, function () { resolve(); }); } catch (_) { resolve(); }
    });
  }
  function removeKeys(keys) {
    return new Promise(function (resolve) {
      try { chrome.storage.local.remove(keys, function () { resolve(); }); } catch (_) { resolve(); }
    });
  }

  /** Same FNV-1a/32 host digest the content scripts + po-catch.js use. */
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

  function activeTab() {
    return new Promise(function (resolve) {
      try {
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
          resolve(tabs && tabs[0] ? tabs[0] : null);
        });
      } catch (_) { resolve(null); }
    });
  }

  function el(id) { return document.getElementById(id); }
  function setText(id, v) { var e = el(id); if (e) e.textContent = (typeof v === 'number') ? v.toLocaleString() : v; }
  function num(v) { return typeof v === 'number' ? v : 0; }

  // Human bandwidth estimate, uses REAL learned average transfer size per
  // third-party request, observed from the Performance API across browsing.
  // Falls back to 0 (no fake number) until enough data is learned.
  var FALLBACK_AVG_KB = 0;  // no fake estimate - show 0 until we have real data
  function formatSaved(kb) {
    if (!(kb > 0)) return '0 KB';
    if (kb >= 1024) return '~' + (kb / 1024).toFixed(1) + ' MB';
    if (kb >= 100) return '~' + Math.round(kb) + ' KB';
    return '~' + kb.toFixed(1) + ' KB';
  }
  // Headline numbers for the main stats strip. This reflects the CURRENT SITE
  // only (as labeled in the HTML). Blocked = real-time DNR requests for this tab
  // + DOM/pixel tier blocks from state.catches.
  function computeHeadline() {
    var dnrBlocked = num(state._tabDnrBlocked);
    var domBlocked = 0;
    var banners = 0;
    (state.catches || []).forEach(function (c) {
      if (!c || c.wall) return;
      if (c.feature === 'banner') banners++;
      // DOM/pixel tier only. Exclude network blocks (DNR), they're already in
      // the real-time _tabDnrBlocked count. Real DNR records are tagged
      // source:'dnr'; the legacy `network:true` flag is still honoured.
      if (c.feature === 'tracker' && !c.network && c.source !== 'dnr') domBlocked++;
    });
    var blocked = dnrBlocked + domBlocked;
    var avgKB = state._learnedAvgKB || FALLBACK_AVG_KB;
    return { blocked: blocked, banners: banners, saved: formatSaved(blocked * avgKB) };
  }

  // ── activity donut (this site only) ──────────────────────────────────────
  // PURE helpers so the chart logic is testable without a DOM. Colors are CSS
  // custom properties (var(--dn-*)) resolved by the stylesheet, so the gradient
  // string itself stays theme-agnostic.
  function donutSegments(catches, dnrBlocked) {
    var trackers = num(dnrBlocked), banners = 0, terms = 0;
    (catches || []).forEach(function (c) {
      if (!c) return;
      if (c.feature === 'banner') { if (!c.wall) banners++; return; }
      if (c.feature === 'terms') { terms++; return; }
      // DOM/pixel tier only; network blocks are already in dnrBlocked.
      if (c.feature === 'tracker' && !c.network && c.source !== 'dnr') trackers++;
    });
    return [
      { key: 'tracker', label: 'Trackers blocked', count: trackers, varName: '--dn-tracker' },
      { key: 'banner', label: 'Banners handled', count: banners, varName: '--dn-banner' },
      { key: 'terms', label: 'Terms flags', count: terms, varName: '--dn-terms' },
    ];
  }
  function donutTotal(segments) {
    var t = 0; (segments || []).forEach(function (s) { t += (s && s.count > 0) ? s.count : 0; });
    return t;
  }
  /** conic-gradient string for the ring; '' when there is nothing to draw. */
  function donutGradient(segments) {
    var total = donutTotal(segments);
    if (!total) return '';
    var deg = 0; var parts = [];
    (segments || []).forEach(function (s) {
      if (!s || !(s.count > 0)) return;
      var end = deg + (s.count / total) * 360;
      parts.push('var(' + s.varName + ') ' + deg.toFixed(2) + 'deg ' + end.toFixed(2) + 'deg');
      deg = end;
    });
    // pin the final stop to exactly 360deg so float drift never leaves a sliver
    parts[parts.length - 1] = parts[parts.length - 1].replace(/[\d.]+deg$/, '360deg');
    return 'conic-gradient(' + parts.join(', ') + ')';
  }
  /** Screen-reader summary; the visible legend carries the same numbers. */
  function donutAriaLabel(segments, host) {
    var total = donutTotal(segments);
    var where = host ? ' on ' + host : '';
    if (!total) return 'No activity recorded' + where + ' yet';
    var bits = [];
    (segments || []).forEach(function (s) {
      if (s && s.count > 0) bits.push(s.count + ' ' + s.label.toLowerCase());
    });
    return 'Activity' + where + ': ' + bits.join(', ');
  }

  // ── anonymous site report (user-sent email) ──────────────────────────────
  // Builds a mailto: draft the user's OWN mail app opens; every line is visible
  // and editable before they choose to send. No identifiers, no network call
  // from the extension itself.
  var REPORT_EMAIL = 'report@getpawsoff.app';
  function buildReportMailto(info) {
    info = info || {};
    var subject = 'GetPawsOff report: ' + (info.host || 'site issue');
    var lines = [
      'Site: ' + (info.host || 'unknown'),
      'Extension: GetPawsOff ' + (info.version || '?'),
      'Browser: ' + (info.ua || 'unknown'),
      'Features on: ' + (info.features || 'none'),
      'Blocked on this page: ' + (info.blocked == null ? '?' : info.blocked),
      '',
      'What went wrong (add anything you want us to know):',
      '',
    ];
    return 'mailto:' + REPORT_EMAIL +
      '?subject=' + encodeURIComponent(subject) +
      '&body=' + encodeURIComponent(lines.join('\n'));
  }

  // ── allow-list helpers (per-site pause + per-tracker allow) ──────────────
  // Prefer the shared model in window.PawsOffAllow; fall back to local pure
  // implementations so the popup still works if that script failed to load.
  function normDomain(input) {
    if (ALLOW && typeof ALLOW.normDomain === 'function') { try { return ALLOW.normDomain(input); } catch (_) {} }
    if (!input || typeof input !== 'string') return '';
    var s = input.trim().toLowerCase().replace(/^[a-z][a-z0-9+.\-]*:\/\//, '').replace(/^[^@\/]*@/, '');
    s = s.split('/')[0].split('?')[0].split('#')[0].split(':')[0].replace(/^www\./, '');
    if (!/^[a-z0-9.\-]+$/.test(s) || s.indexOf('.') < 0) return '';
    if (s.charAt(0) === '.' || s.charAt(s.length - 1) === '.' || s.indexOf('..') >= 0) return '';
    return s;
  }
  // The tracker domain a catch row represents, for non-wall tracker catches
  // only. DNR-sourced catches carry only an EasyPrivacy url-filter pattern
  // (e.g. "gtagv4.js"), not a usable domain, so those get the static badge too.
  function trackerDomainOf(e) {
    if (!e || e.wall || e.feature !== 'tracker') return '';
    if (e.source === 'dnr') return '';
    return normDomain(e.detail || e.label || '');
  }

  // ── Readable tracker names ─────────────────────────────────────────────────
  // DNR/EasyPrivacy gives only a url-filter substring, so a catch label is often
  // a bare filename like "gtagv4.js". This bundled map turns the common ones
  // into a company name + coarse type; unknown ones fall back to the domain
  // (if present) or "Tracker". [substringToMatch, friendlyName, type]
  var TRACKER_NAMES = [
    ['clarity', 'Microsoft Clarity', 'Session'],
    ['gtag', 'Google Analytics', 'Analytics'],
    ['analytics.js', 'Google Analytics', 'Analytics'],
    ['/ga.js', 'Google Analytics', 'Analytics'],
    ['gtm.js', 'Google Tag Manager', 'Analytics'],
    ['doubleclick', 'Google Ads', 'Ads'],
    ['googlesyndication', 'Google Ads', 'Ads'],
    ['googleadservices', 'Google Ads', 'Ads'],
    ['fbevents', 'Meta Pixel', 'Ads'],
    ['connect.facebook', 'Meta Pixel', 'Ads'],
    ['facebook', 'Meta Pixel', 'Ads'],
    ['hotjar', 'Hotjar', 'Session'],
    ['fullstory', 'FullStory', 'Session'],
    ['mouseflow', 'Mouseflow', 'Session'],
    ['segment', 'Segment', 'Analytics'],
    ['chartbeat', 'Chartbeat', 'Analytics'],
    ['scorecardresearch', 'Comscore', 'Analytics'],
    ['comscore', 'Comscore', 'Analytics'],
    ['quantserve', 'Quantcast', 'Ads'],
    ['quantcast', 'Quantcast', 'Ads'],
    ['criteo', 'Criteo', 'Ads'],
    ['taboola', 'Taboola', 'Ads'],
    ['outbrain', 'Outbrain', 'Ads'],
    ['bat.bing', 'Microsoft Ads', 'Ads'],
    ['linkedin', 'LinkedIn Insight', 'Ads'],
    ['ads-twitter', 'Twitter/X Ads', 'Ads'],
    ['tiktok', 'TikTok', 'Ads'],
    ['snapchat', 'Snapchat', 'Ads'],
    ['pinterest', 'Pinterest', 'Ads'],
    ['demdex', 'Adobe Analytics', 'Analytics'],
    ['omtrdc', 'Adobe Analytics', 'Analytics'],
    ['adobedtm', 'Adobe Analytics', 'Analytics'],
    ['newrelic', 'New Relic', 'Error'],
    ['nr-data', 'New Relic', 'Error'],
    ['yandex', 'Yandex Metrica', 'Analytics'],
    ['matomo', 'Matomo', 'Analytics'],
    ['piwik', 'Matomo', 'Analytics'],
    ['didomi', 'Didomi', 'Consent'],
    ['onetrust', 'OneTrust', 'Consent'],
    ['cookiebot', 'Cookiebot', 'Consent']
  ];
  function trackerMatch(e) {
    if (!e) return null;
    var hay = (String(e.detail || '') + ' ' + String(e.label || '')).toLowerCase();
    for (var i = 0; i < TRACKER_NAMES.length; i++) {
      if (hay.indexOf(TRACKER_NAMES[i][0]) >= 0) return TRACKER_NAMES[i];
    }
    return null;
  }
  // Human-friendly name for any catch row.
  function trackerLabel(e) {
    if (!e) return 'Tracker';
    if (e.feature === 'banner') return e.label || (e.wall ? 'Cookie wall' : 'Cookie banner');
    if (e.feature === 'terms') return e.label || 'Risky clause';
    var m = trackerMatch(e);
    if (m) return m[1];
    var dom = normDomain(e.detail || e.label || '');
    if (dom && dom.indexOf('.') >= 0) return dom.replace(/^www\./, '');
    return 'Tracker';
  }
  // Coarse type badge, or '' when unknown - never guess a category.
  function trackerType(e) {
    var m = trackerMatch(e);
    if (m) return m[2];
    if (e && e.category && e.category !== 'Tracker') return e.category;
    return '';
  }
  // Group identical catches (same feature + friendly name) into one row with a
  // count and the most-recent timestamp. Kills the "gtagv4.js × 60" flood.
  function groupCatches(rows) {
    var groups = [];
    var byKey = {};
    (rows || []).forEach(function (e) {
      if (!e) return;
      var name = trackerLabel(e);
      var key = e.feature + '|' + (e.wall ? 'w' : '') + (e.seen ? 's' : '') + '|' + name;
      var g = byKey[key];
      if (!g) { g = { rep: e, name: name, count: 0, ts: 0 }; byKey[key] = g; groups.push(g); }
      g.count++;
      if ((e.ts || 0) >= g.ts) { g.ts = e.ts || 0; g.rep = e; }
    });
    groups.sort(function (a, b) { return b.ts - a.ts; });
    return groups;
  }
  function normalizeAllow(raw) {
    if (ALLOW && typeof ALLOW.normalizeState === 'function') { try { return ALLOW.normalizeState(raw); } catch (_) {} }
    var st = { v: 1, sites: {} };
    if (!raw || typeof raw !== 'object' || !raw.sites || typeof raw.sites !== 'object') return st;
    Object.keys(raw.sites).forEach(function (oh) {
      var src = raw.sites[oh]; if (!oh || !src || typeof src !== 'object') return;
      var paused = (typeof src.paused === 'number' && src.paused > 0) ? src.paused : 0;
      var pausedUntil = (typeof src.pausedUntil === 'number' && src.pausedUntil > 0) ? src.pausedUntil : 0;
      var domains = {};
      var dsrc = (src.domains && typeof src.domains === 'object') ? src.domains : {};
      Object.keys(dsrc).forEach(function (k) { var nd = normDomain(k); if (nd && typeof dsrc[k] === 'number' && dsrc[k] > 0) domains[nd] = dsrc[k]; });
      if (!paused && Object.keys(domains).length === 0) return;
      st.sites[oh] = { paused: paused, pausedUntil: paused ? pausedUntil : 0, domains: domains };
    });
    return st;
  }
  // Expiry-aware: a lapsed TIMED pause reads as not paused the moment it ends.
  function isSitePaused(allow, oh) {
    if (ALLOW && typeof ALLOW.isPaused === 'function') { try { return ALLOW.isPaused(allow, oh); } catch (_) {} }
    var s = (allow && allow.sites && oh) ? allow.sites[oh] : null;
    if (!s || !(s.paused > 0)) return false;
    return !(s.pausedUntil > 0) || s.pausedUntil > Date.now();
  }
  /** Remaining pause ms: 0 = not paused, -1 = indefinite, else ms left. */
  function pauseLeftMs(allow, oh) {
    if (ALLOW && typeof ALLOW.pauseRemainingMs === 'function') { try { return ALLOW.pauseRemainingMs(allow, oh); } catch (_) {} }
    var s = (allow && allow.sites && oh) ? allow.sites[oh] : null;
    if (!s || !(s.paused > 0)) return 0;
    if (!(s.pausedUntil > 0)) return -1;
    var left = s.pausedUntil - Date.now();
    return left > 0 ? left : 0;
  }
  /** "14m left" / "1h 5m left"; '' for none/indefinite. */
  function pauseLeftLabel(ms) {
    if (ALLOW && typeof ALLOW.formatPauseLeft === 'function') { try { return ALLOW.formatPauseLeft(ms); } catch (_) {} }
    if (typeof ms !== 'number' || ms <= 0) return '';
    var mins = Math.ceil(ms / 60000);
    if (mins < 60) return mins + 'm left';
    var h = Math.floor(mins / 60), m = mins % 60;
    return m ? (h + 'h ' + m + 'm left') : (h + 'h left');
  }
  /** PURE: pause expiry from a duration choice; 0 minutes = indefinite. */
  function pauseUntilFromChoice(mins, now) {
    var t = (typeof now === 'number') ? now : Date.now();
    return (typeof mins === 'number' && mins > 0) ? t + mins * 60000 : 0;
  }
  function isDomAllowed(allow, oh, domain) {
    var s = (allow && allow.sites && oh) ? allow.sites[oh] : null;
    var nd = normDomain(domain);
    return !!(s && nd && s.domains && s.domains[nd] > 0);
  }
  function isLetThrough(allow, oh, domain) {
    return isSitePaused(allow, oh) || isDomAllowed(allow, oh, domain);
  }
  // Distinct tracker domains seen on this site, split by allowed vs blocked.
  function siteCounts(catches, allow, oh) {
    var seen = {};
    (catches || []).forEach(function (e) { var d = trackerDomainOf(e); if (d) seen[d] = true; });
    var allowed = 0, blocked = 0;
    Object.keys(seen).forEach(function (d) { if (isLetThrough(allow, oh, d)) allowed++; else blocked++; });
    return { allowed: allowed, blocked: blocked };
  }
  function allowedDomainList(allow, oh) {
    if (ALLOW && typeof ALLOW.allowedDomains === 'function') { try { return ALLOW.allowedDomains(allow, oh); } catch (_) {} }
    var s = (allow && allow.sites && oh) ? allow.sites[oh] : null;
    return (s && s.domains) ? Object.keys(s.domains) : [];
  }
  function applyPaused(allow, oh, on, until) {
    if (ALLOW && typeof ALLOW.setPaused === 'function') { try { return ALLOW.setPaused(allow, oh, on, until); } catch (_) {} }
    var st = normalizeAllow(allow);
    if (!oh) return st;
    if (on) {
      var e = st.sites[oh] || { paused: 0, pausedUntil: 0, domains: {} };
      e.paused = Date.now();
      e.pausedUntil = (typeof until === 'number' && until > 0) ? until : 0;
      st.sites[oh] = e;
    } else if (st.sites[oh]) {
      st.sites[oh].paused = 0;
      st.sites[oh].pausedUntil = 0;
      if (Object.keys(st.sites[oh].domains).length === 0) delete st.sites[oh];
    }
    return st;
  }
  function applyDomain(allow, oh, domain, on) {
    if (ALLOW && typeof ALLOW.setDomain === 'function') { try { return ALLOW.setDomain(allow, oh, domain, on); } catch (_) {} }
    var st = normalizeAllow(allow);
    var nd = normDomain(domain);
    if (!oh || !nd) return st;
    if (on) { var e = st.sites[oh] || { paused: 0, domains: {} }; e.domains[nd] = Date.now(); st.sites[oh] = e; }
    else if (st.sites[oh] && st.sites[oh].domains) { delete st.sites[oh].domains[nd]; if (!st.sites[oh].paused && Object.keys(st.sites[oh].domains).length === 0) delete st.sites[oh]; }
    return st;
  }
  function clearSiteAllow(allow, oh) {
    if (ALLOW && typeof ALLOW.clearSite === 'function') { try { return ALLOW.clearSite(allow, oh); } catch (_) {} }
    var st = normalizeAllow(allow);
    if (oh && st.sites[oh]) delete st.sites[oh];
    return st;
  }
  // Tell the background service worker to add/remove the matching DNR allow
  // rule. Best-effort; storage is the source of truth, this just keeps the
  // network tier in sync. lastError is swallowed (SW may be asleep).
  function msgBg(obj) {
    return new Promise(function (resolve) {
      try { chrome.runtime.sendMessage(obj, function (resp) { void chrome.runtime.lastError; resolve(resp); }); }
      catch (_) { resolve(); }
    });
  }
  async function toggleDomain(domain) {
    var oh = state.originHash; if (!oh) return;
    var nd = normDomain(domain); if (!nd) return;
    var wasAllowed = isDomAllowed(state.allow, oh, nd);
    state.allow = applyDomain(state.allow, oh, nd, !wasAllowed);
    await setKeys({ [ALLOW_KEY]: state.allow });
    await msgBg({ type: 'pawsoff_allow_apply', op: wasAllowed ? 'blockDomain' : 'allowDomain', site: state.host, domain: nd });
    renderFeed();
  }
  function renderUnbreak() {
    var btn = el('btn-unbreak'); if (!btn) return;
    var paused = isSitePaused(state.allow, state.originHash);
    btn.classList.toggle('is-paused', paused);
    if (paused) {
      var left = pauseLeftMs(state.allow, state.originHash);
      btn.textContent = (left === -1) ? 'Resume · paused here' : 'Resume · ' + pauseLeftLabel(left);
      btn.setAttribute('aria-expanded', 'false');
    } else {
      btn.textContent = 'Pause on this site';
    }
    var menu = el('pause-menu');
    if (menu && paused) menu.hidden = true;
  }

  function renderDonut() {
    var ring = el('donut'); if (!ring) return;
    var segs = donutSegments(state.catches, state._tabDnrBlocked);
    var g = donutGradient(segs);
    ring.classList.toggle('is-empty', !g);
    ring.style.background = g || '';
    ring.setAttribute('aria-label', donutAriaLabel(segs, state.host));
    setText('donut-total', String(donutTotal(segs)));
    var legend = el('donut-legend');
    if (legend) {
      legend.textContent = '';
      segs.forEach(function (s) {
        var li = document.createElement('li');
        li.className = 'legend-row';
        var sw = document.createElement('span'); sw.className = 'legend-swatch'; sw.style.background = 'var(' + s.varName + ')';
        sw.setAttribute('aria-hidden', 'true');
        var lb = document.createElement('span'); lb.className = 'legend-label'; lb.textContent = s.label;
        var ct = document.createElement('span'); ct.className = 'legend-count'; ct.textContent = String(s.count);
        li.appendChild(sw); li.appendChild(lb); li.appendChild(ct);
        legend.appendChild(li);
      });
    }
  }

  function featureEnabled(all, feat) {
    if (feat === 'banner') return all[CG_DISABLED] !== true;
    if (feat === 'tracker') {
      var pb = all[PB_SETTINGS];
      return !pb || pb.globalEnabled !== false;
    }
    if (feat === 'terms') {
      var ts = all[TS_SETTINGS];
      return !ts || ts.enabled !== false;
    }
    return true;
  }

  function renderGuard(all) {
    var button = el('guard-status');
    var dot = el('guard-dot');
    var label = el('guard-text');
    if (!button || !label || !dot) return;
    var everyOn = FEATS.every(function (feat) { return featureEnabled(all, feat); });
    button.classList.toggle('is-paused', !everyOn);
    dot.className = everyOn ? 'guard-dot' : 'guard-dot guard-dot--paused';
    label.textContent = everyOn ? 'Active' : 'Paused';
  }

  // ── per-site counts and headline values ──
  function renderStats() {
    var banners = 0;
    state.catches.forEach(function (e) {
      if (e && !e.wall && e.feature === 'banner') banners++;
    });
    setText('stat-banners', banners);
  }
  function renderHeadline() {
    var h = computeHeadline();
    setText('stat-blocked', h.blocked);
    setText('stat-saved', h.saved);
    renderDonut(); // same data feeds the chart, so they always agree
  }
  function renderAllTime(all) {
    void all;
  }

  function renderToggles(all) {
    state.features = {
      banner: featureEnabled(all, 'banner'),
      tracker: featureEnabled(all, 'tracker'),
      terms: featureEnabled(all, 'terms')
    };
    renderGuard(all);
    // Dedicated per-feature pills mirror the same global toggles.
    FEATS.forEach(function (feat) {
      var b = el('feat-' + feat);
      if (!b) return;
      var on = state.features[feat] !== false;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.classList.toggle('is-off', !on);
    });
  }

  async function persistFeat(feat, on) {
    if (feat === 'banner') {
      await setKeys({ [CG_DISABLED]: !on });
    } else if (feat === 'tracker') {
      var all = await getAll();
      var pb = (all[PB_SETTINGS] && typeof all[PB_SETTINGS] === 'object') ? all[PB_SETTINGS] : { providers: {} };
      pb.globalEnabled = on;
      await setKeys({ [PB_SETTINGS]: pb });
    } else if (feat === 'terms') {
      var all2 = await getAll();
      var ts = (all2[TS_SETTINGS] && typeof all2[TS_SETTINGS] === 'object') ? all2[TS_SETTINGS] : { categories: {} };
      ts.enabled = on;
      await setKeys({ [TS_SETTINGS]: ts });
    }
  }

  async function setGuard(on) {
    await Promise.all(FEATS.map(function (f) { return persistFeat(f, on); }));
    await setKeys({ [MASTER_KEY]: on });
    state.features = { banner: on, tracker: on, terms: on };
    state._lastAll = await getAll();
    renderToggles(state._lastAll);
  }

  // ── feed ──
  /** A catch entry belongs to a different site than the one being viewed, so the
   *  per-site popup must skip it (no originHash filter => show everything). */
  function isFromOtherOrigin(e) {
    if (!state.originHash) return false; // no active site (loadCatches bails separately)
    // Once we know the active site, a catch must carry a MATCHING origin hash.
    // Origin-less (unattributable) records are excluded too, they could belong
    // to any site, so showing them here would mis-attribute another site's data.
    return !e.originHash || e.originHash !== state.originHash;
  }
  function loadCatches(all) {
    // No active-site hash (chrome://, extension pages, unparseable tab URL) →
    // show nothing. Without this, the per-site filter is a no-op and the popup
    // would dump EVERY stored catch, a cross-site browsing-history leak.
    if (!state.originHash) { state.catches = []; return; }
    var items = [];
    Object.keys(all).forEach(function (k) {
      if (k.indexOf(CATCH_PREFIX) !== 0) return;
      var e = all[k]; if (!e) return;
      if (isFromOtherOrigin(e)) return;
      items.push(e);
    });
    items.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    // Keep EVERY banner/terms catch (rare + the point of the popup) and cap only
    // the high-volume trackers. A flat top-N slice would let dozens of newer
    // tracker records push a page's lone banner out of view → "0 banners".
    var kept = [];
    var trackerBudget = 80;
    for (var i = 0; i < items.length; i++) {
      var e2 = items[i];
      if (e2.feature === 'tracker') { if (trackerBudget > 0) { kept.push(e2); trackerBudget--; } }
      else { kept.push(e2); }
    }
    state.catches = kept;
  }

  function catColor(e) {
    if (e.wall) return 'c-wall';
    if (e.feature === 'banner') return 'c-banner';
    if (e.feature === 'terms') return 'c-terms';
    var cat = (e.category || '').toLowerCase();
    if (cat.indexOf('ad') >= 0) return 'c-ad';
    if (cat.indexOf('social') >= 0) return 'c-social';
    if (cat.indexOf('finger') >= 0) return 'c-finger';
    if (cat.indexOf('session') >= 0) return 'c-session';
    return 'c-analytics';
  }
  function actClass(e) { return e.wall ? 'wall' : (e.feature === 'banner' ? (e.seen ? 'detected' : 'rejected') : (e.feature === 'terms' ? 'flagged' : 'blocked')); }
  function actLabel(e) { return e.wall ? 'Wall' : (e.feature === 'banner' ? (e.seen ? 'Detected' : 'Rejected') : (e.feature === 'terms' ? 'Flagged' : 'Blocked')); }
  function ago(ts) {
    var s = Math.max(0, Math.floor((Date.now() - (ts || 0)) / 1000));
    if (s < 60) return s + 's ago';
    var m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }

  function renderFeed() {
    var feed = el('trackers-list');
    if (!feed) return;
    var rows = state.catches.filter(function (e) {
      var featOn = state.features ? state.features[e.feature] !== false : true;
      if (!featOn) return false;
      if (state.filter === 'all') return true;
      return catColor(e) === state.filter;
    });
    feed.textContent = '';
    if (!rows.length) {
      var empty = document.createElement('li');
      empty.className = 'tracker-empty';
      empty.textContent = 'Nothing blocked here yet.';
      feed.appendChild(empty);
      return;
    }
    // Collapse duplicates (same friendly name) into one row with a × count.
    groupCatches(rows).forEach(function (g) {
      var e = g.rep;
      var row = document.createElement('li');
      row.className = 'tracker-row';
      var dot = document.createElement('span');
      dot.className = 'tracker-dot ' + catColor(e);
      var body = document.createElement('div'); body.className = 'tracker-body';
      var l1 = document.createElement('div'); l1.className = 'tracker-topline';
      var nm = document.createElement('span'); nm.className = 'tracker-company'; nm.textContent = g.name;
      l1.appendChild(nm);
      if (g.count > 1) {
        var cnt = document.createElement('span'); cnt.className = 'tracker-count'; cnt.textContent = '×' + g.count; l1.appendChild(cnt);
      }
      var type = trackerType(e);
      if (e.mayBreak) {
        var mb = document.createElement('span'); mb.className = 'tracker-maybreak'; mb.textContent = 'May break'; l1.appendChild(mb);
      } else if (type) {
        var ct = document.createElement('span'); ct.className = 'tracker-badge ' + catColor(e); ct.textContent = type; l1.appendChild(ct);
      }
      var l2 = document.createElement('div'); l2.className = 'tracker-meta';
      l2.textContent = ago(g.ts);
      body.appendChild(l1); body.appendChild(l2);
      // Tracker rows with a real domain get a working Allow/Block toggle;
      // everything else (banners/terms/walls and DNR rows) keeps the static
      // action badge. A paused site disables the toggles until re-enabled.
      var dom = trackerDomainOf(e);
      var act;
      if (dom) {
        var allowed = isLetThrough(state.allow, state.originHash, dom);
        var paused = isSitePaused(state.allow, state.originHash);
        act = document.createElement('button');
        act.className = 'tracker-action ' + (allowed ? 'is-allowed' : 'is-blocked');
        act.setAttribute('role', 'switch');
        act.setAttribute('aria-checked', allowed ? 'true' : 'false');
        act.textContent = allowed ? 'Allowed' : 'Blocked';
        if (paused) {
          act.disabled = true;
          act.classList.add('is-disabled');
          act.title = 'Protection is paused here. Resume it to manage individual trackers.';
        } else {
          (function (d) { act.addEventListener('click', function (ev) { ev.stopPropagation(); toggleDomain(d); }); })(dom);
        }
      } else {
        act = document.createElement('span'); act.className = 'tracker-action ' + actClass(e); act.textContent = actLabel(e);
      }
      row.appendChild(dot); row.appendChild(body); row.appendChild(act);
      feed.appendChild(row);
    });
  }

  // Category-based filter chips (Analytics / Ad network / Social / Fingerprint /
  // Session rec), plus Banners + Terms for the popup's non-tracker catches. Built
  // dynamically from what's on the page, keyed by the same catColor() class the
  // dots + chips use, so a chip only appears when there's something behind it.
  var CAT_ORDER = ['c-analytics', 'c-ad', 'c-social', 'c-finger', 'c-session', 'c-banner', 'c-terms'];
  var CAT_LABEL = {
    'c-analytics': 'Analytics', 'c-ad': 'Ad network', 'c-social': 'Social',
    'c-finger': 'Fingerprint', 'c-session': 'Session rec', 'c-banner': 'Banners', 'c-terms': 'Terms',
  };
  function renderFilters() {
    var wrap = el('filters-container');
    if (!wrap) return;
    var counts = {}; var total = 0;
    state.catches.forEach(function (e) {
      if (!e || e.wall) return;
      total++;
      var k = catColor(e);
      counts[k] = (counts[k] || 0) + 1;
    });
    // If the active filter's category is no longer present, fall back to All.
    if (state.filter !== 'all' && !counts[state.filter]) state.filter = 'all';
    var filters = [{ id: 'all', label: 'All', count: total }];
    CAT_ORDER.forEach(function (k) {
      if (counts[k]) filters.push({ id: k, label: CAT_LABEL[k], count: counts[k] });
    });
    wrap.textContent = '';
    filters.forEach(function (f) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'filter-chip' + (state.filter === f.id ? ' is-active' : '');
      btn.textContent = f.label + ' ' + f.count;
      btn.addEventListener('click', function () {
        state.filter = f.id;
        renderFeed();
        renderFilters();
      });
      wrap.appendChild(btn);
    });
  }

  // ── radar (OBSERVE-ONLY "spotted on this site", never counted as blocked) ──
  function radarVerdictLabel(v) {
    if (v === 'block') return 'Tracker';
    if (v === 'cookieblock') return 'Cookie tracker';
    return 'Watching';
  }
  function radarVerdictClass(v) {
    if (v === 'block') return 'rv-track';
    if (v === 'cookieblock') return 'rv-cookie';
    return 'rv-watch';
  }
  function renderRadar(all) {
    var wrap = el('radar');
    var list = el('radar-list');
    if (!wrap || !list) return;
    var rec = state.originHash ? all[RADAR_PREFIX + state.originHash] : null;
    var spotted = (rec && Array.isArray(rec.spotted)) ? rec.spotted : [];
    // Hide the panel when the Trackers feature is paused or nothing was spotted.
    if (!spotted.length || !featureEnabled(all, 'tracker')) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'block';
    setText('radar-count', spotted.length);
    list.textContent = '';
    spotted.slice(0, 12).forEach(function (s) {
      var row = document.createElement('div'); row.className = 'rrow';
      var body = document.createElement('div'); body.className = 'rbody';
      var nm = document.createElement('span'); nm.className = 'rnm';
      nm.textContent = (s.domain || '').replace(/^www\./, '') || 'third party';
      var meta = document.createElement('span'); meta.className = 'rmeta';
      meta.textContent = (s.sites && s.sites > 1) ? ('seen on ' + s.sites + ' sites') : 'first sighting';
      body.appendChild(nm); body.appendChild(meta);
      var chip = document.createElement('span');
      chip.className = 'rchip ' + radarVerdictClass(s.verdict);
      chip.textContent = radarVerdictLabel(s.verdict);
      row.appendChild(body); row.appendChild(chip);
      list.appendChild(row);
    });
    var more = el('radar-more');
    if (more) {
      if (spotted.length > 12) { more.style.display = 'block'; more.textContent = '+ ' + (spotted.length - 12) + ' more watching'; }
      else more.style.display = 'none';
    }
  }

  // ── wiring ──
  function onActivate(node, handler) {
    node.addEventListener('click', handler);
    // Native <button> already fires click on Enter/Space, synthesizing it again
    // would double-run the handler (re-toggle). Only add key handling for
    // non-button elements that lack built-in keyboard activation.
    if (node.tagName !== 'BUTTON') {
      node.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); handler(ev); }
      });
    }
  }

  function wire() {
    var guard = el('guard-status');
    if (guard) onActivate(guard, async function () {
      var turnOn = guard.classList.contains('is-paused');
      await setGuard(turnOn);
      renderToggles(state._lastAll || {});
      renderFeed();
      renderFilters();
    });

    // Pause: choosing a duration pauses; the same button resumes when paused.
    async function doPause(mins) {
      var oh = state.originHash; if (!oh) return;
      var until = pauseUntilFromChoice(mins);
      state.allow = applyPaused(state.allow, oh, true, until);
      await setKeys({ [ALLOW_KEY]: state.allow });
      await msgBg({ type: 'pawsoff_allow_apply', op: 'pauseSite', site: state.host, until: until });
      var menu0 = el('pause-menu'); if (menu0) menu0.hidden = true;
      renderUnbreak();
      renderFeed();
      // Reload so already-loaded trackers actually stop/resume on the page.
      var tab = await activeTab();
      try { if (tab && tab.id != null) chrome.tabs.reload(tab.id); } catch (_) {}
    }
    async function doResume() {
      var oh = state.originHash; if (!oh) return;
      state.allow = applyPaused(state.allow, oh, false);
      await setKeys({ [ALLOW_KEY]: state.allow });
      await msgBg({ type: 'pawsoff_allow_apply', op: 'unpauseSite', site: state.host });
      renderUnbreak();
      renderFeed();
      var tab = await activeTab();
      try { if (tab && tab.id != null) chrome.tabs.reload(tab.id); } catch (_) {}
    }
    var unbreak = el('btn-unbreak');
    if (unbreak) unbreak.addEventListener('click', function () {
      if (isSitePaused(state.allow, state.originHash)) { doResume(); return; }
      var menu = el('pause-menu');
      if (menu) {
        menu.hidden = !menu.hidden;
        unbreak.setAttribute('aria-expanded', menu.hidden ? 'false' : 'true');
        if (!menu.hidden) { var first = menu.querySelector('button'); if (first) first.focus(); }
      }
    });
    var pauseMenu = el('pause-menu');
    if (pauseMenu) {
      Array.prototype.forEach.call(pauseMenu.querySelectorAll('button[data-mins]'), function (b) {
        onActivate(b, function () { doPause(parseInt(b.getAttribute('data-mins'), 10) || 0); });
      });
      pauseMenu.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') {
          pauseMenu.hidden = true;
          if (unbreak) { unbreak.setAttribute('aria-expanded', 'false'); unbreak.focus(); }
        }
      });
      // Clicking ANY other control (a feature pill, a filter chip, Reset...)
      // while the menu is open must close it too - otherwise it stays visibly
      // stuck open once focus leaves it (Escape only helps if focus is inside).
      document.addEventListener('click', function (ev) {
        if (pauseMenu.hidden) return;
        if (ev.target === unbreak || pauseMenu.contains(ev.target)) return;
        pauseMenu.hidden = true;
        if (unbreak) unbreak.setAttribute('aria-expanded', 'false');
      });
    }

    // Dedicated per-feature pills (global toggles, same keys as Settings).
    FEATS.forEach(function (feat) {
      var b = el('feat-' + feat);
      if (b) onActivate(b, async function () {
        var on = b.getAttribute('aria-pressed') !== 'true';
        await persistFeat(feat, on);
        state._lastAll = await getAll();
        renderToggles(state._lastAll);
        renderFeed();
        renderFilters();
      });
    });

    // Anonymous report: mailto: needs a registered OS/browser mail handler,
    // which many desktop setups lack, so this covers both paths - copy the
    // report to the clipboard (always works) and also try to open the draft.
    var report = el('btn-report');
    if (report) onActivate(report, function () {
      var ver = '';
      try { ver = chrome.runtime.getManifest().version; } catch (_) {}
      var feats = FEATS.filter(function (f) { return state.features && state.features[f] !== false; }).join(', ') || 'none';
      var href = buildReportMailto({
        host: state.host,
        version: ver,
        ua: (typeof navigator !== 'undefined' && navigator.userAgent) || '',
        features: feats,
        blocked: computeHeadline().blocked,
      });
      // 1) Clipboard: the report text + address, so sending ALWAYS has a path.
      try {
        var text = decodeURIComponent(href.split('&body=')[1] || '');
        navigator.clipboard.writeText('To: ' + REPORT_EMAIL + '\n\n' + text).then(function () {
          report.textContent = 'Copied for ' + REPORT_EMAIL;
        }, function () { /* clipboard denied → mailto attempt below still runs */ });
      } catch (_) { /* silent */ }
      // 2) mailto via a real, user-activated anchor click - the standard way
      // to trigger a protocol handler from a page; a no-op if no mail handler
      // is registered, so this never leaves a dead tab behind.
      try {
        var a = document.createElement('a');
        a.href = href;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
      } catch (_) { /* silent */ }
    });

    var reset = el('btn-reset');
    if (reset) onActivate(reset, async function () {
      var all = await getAll();
      var keys = Object.keys(all).filter(function (k) {
        return k.indexOf(CATCH_PREFIX) === 0 && (!state.originHash || (all[k] && all[k].originHash === state.originHash));
      });
      if (state.originHash) keys.push(RADAR_PREFIX + state.originHash);
      await removeKeys(keys);
      // Also clear this site's allow-list entry (pause + per-domain) and drop
      // the matching DNR allow rules so Reset truly starts the site fresh.
      if (state.originHash) {
        var domains = allowedDomainList(state.allow, state.originHash);
        state.allow = clearSiteAllow(state.allow, state.originHash);
        await setKeys({ [ALLOW_KEY]: state.allow });
        await msgBg({ type: 'pawsoff_allow_apply', op: 'clearSite', site: state.host, domains: domains });
      }
      state.catches = [];
      state._tabDnrBlocked = 0; // reset local real-time counter
      renderFilters(); renderStats(); renderFeed(); renderUnbreak(); renderHeadline();
      var fresh = await getAll(); renderRadar(fresh);
      
      // Reload the tab so the browser's native declarativeNetRequest tab block
      // counter is actually reset to 0 for this session.
      var tab = await activeTab();
      try { if (tab && tab.id != null) chrome.tabs.reload(tab.id); } catch (_) {}
    });

    var opt = el('open-options');
    if (opt) onActivate(opt, function () { try { chrome.runtime.openOptionsPage(); } catch (_) {} });
  }

  // ── live sync: re-render whenever storage changes so catches tick up in real time ──
  var refreshTimer = null;
  function liveRefresh() {
    getAll().then(function (all) {
      state._lastAll = all;
      state.allow = normalizeAllow(all[ALLOW_KEY]);
      loadCatches(all);
      renderToggles(all);
      renderFilters();
      renderStats();
      renderHeadline(all);
      renderAllTime(all);
      renderFeed();
      renderRadar(all);
      renderUnbreak();
    });
  }
  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(function () { refreshTimer = null; liveRefresh(); }, 150);
  }

  async function init() {
    try {
      wire();
      try {
        chrome.storage.onChanged.addListener(function (changes, area) {
          if (area === 'local') scheduleRefresh();
        });
      } catch (_) {}
      // catch the latest snapshot each time the popup regains focus
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') scheduleRefresh();
      });
      var tab = await activeTab();
      if (tab && tab.url) {
        try { state.host = new URL(tab.url).hostname; } catch (_) { state.host = ''; }
      }
      state.originHash = state.host ? hashHost(state.host) : null;
      setText('site-url', state.host || 'this page');
      var all = await getAll();
      state._lastAll = all;
      state.allow = normalizeAllow(all[ALLOW_KEY]);
      loadCatches(all);
      renderToggles(all);
      renderFilters();
      renderStats();
      renderHeadline();
      renderAllTime(all);
      renderFeed();
      renderRadar(all);
      renderUnbreak();

      // Flush pending DNR catches NOW so the popup shows the latest tracker
      // blocks for this site. The background writes catch records from DNR
      // matches on a 1-minute alarm, but the popup may open between ticks.
      // After the flush completes, re-render so new catches appear instantly.
      try {
        msgBg({ type: 'pawsoff_reconcile_now' }).then(function () {
          scheduleRefresh();
        });
      } catch (_) {}

      // Fetch the learned average transfer size from the prevalence learner
      // (real data from the Performance/Resource Timing API, not an estimate).
      try {
        msgBg({ type: 'pawsoff_prevalence_getSizeEstimate' }).then(function (resp) {
          if (resp && resp.ok && resp.estimate && resp.estimate.avgBytes > 0) {
            state._learnedAvgKB = resp.estimate.avgBytes / 1024;
          }
          // Re-render headline with the learned (or fallback) average.
          renderHeadline();
        });
      } catch (_) {}

      // Poll real-time DNR block counts for the current tab while the popup is
      // open (served from an in-memory per-tab counter, no quota/storage cost).
      // The interval dies with the popup page.
      if (tab && tab.id != null) {
        var pullTabStats = function () {
          try {
            msgBg({ type: 'pawsoff_getDnrStats', tabId: tab.id }).then(function (resp) {
              if (resp && resp.ok && typeof resp.count === 'number' && resp.count !== state._tabDnrBlocked) {
                state._tabDnrBlocked = resp.count;
                renderHeadline();
              }
            });
          } catch (_) {}
        };
        pullTabStats();
        // Same 1s tick also advances the pause countdown label; when a timed
        // pause lapses while the popup is open, isSitePaused flips on its own
        // and this re-render shows "Pause on this site" again.
        try { setInterval(function () { pullTabStats(); renderUnbreak(); }, 1000); } catch (_) {}
      }
    } catch (_) { /* silent - never throw visibly */ }
  }

  // ── Test-only export ──────────────────────────────────────────────────────
  // Inert in the browser (extension pages have no CommonJS `module`); the Node
  // test harness injects a `module` object to read these pure helpers without
  // touching the DOM. Mirrors the content scripts' existing __test hook.
  try {
    if (typeof module !== 'undefined' && module.exports) {
      module.exports.__test = {
        hashHost: hashHost,
        num: num,
        formatSaved: formatSaved,
        computeHeadline: computeHeadline,
        NET_TOTAL: NET_TOTAL,
        ago: ago,
        catColor: catColor,
        actClass: actClass,
        actLabel: actLabel,
        isFromOtherOrigin: isFromOtherOrigin,
        loadCatches: loadCatches,
        radarVerdictLabel: radarVerdictLabel,
        radarVerdictClass: radarVerdictClass,
        getState: function () { return state; },
        CATCH_PREFIX: CATCH_PREFIX,
        ALLOW_KEY: ALLOW_KEY,
        normDomain: normDomain,
        trackerDomainOf: trackerDomainOf,
        trackerLabel: trackerLabel,
        trackerType: trackerType,
        groupCatches: groupCatches,
        normalizeAllow: normalizeAllow,
        isSitePaused: isSitePaused,
        isDomAllowed: isDomAllowed,
        isLetThrough: isLetThrough,
        siteCounts: siteCounts,
        allowedDomainList: allowedDomainList,
        applyPaused: applyPaused,
        applyDomain: applyDomain,
        clearSiteAllow: clearSiteAllow,
        pauseLeftMs: pauseLeftMs,
        pauseLeftLabel: pauseLeftLabel,
        pauseUntilFromChoice: pauseUntilFromChoice,
        donutSegments: donutSegments,
        donutTotal: donutTotal,
        donutGradient: donutGradient,
        donutAriaLabel: donutAriaLabel,
        buildReportMailto: buildReportMailto,
        REPORT_EMAIL: REPORT_EMAIL
      };
    }
  } catch (_) { /* ignore */ }

  document.addEventListener('DOMContentLoaded', init);
}());
