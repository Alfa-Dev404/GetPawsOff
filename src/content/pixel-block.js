// pixel-block.js, PawsOff - Multi-provider email tracking-pixel protection.
//
// Finds tracking pixels (usually 1x1 transparent images) inside opened emails
// and stops them phoning home. Two layers:
//   PRIMARY  - declarativeNetRequest blocks known tracker domains at the
//              network level (request never leaves the browser).
//   FALLBACK - DOM rewriting swaps the src of suspected pixels for a local
//              transparent data URI; catches unknown senders DNR can't know
//              about, and is the source of per-block stats DNR can't give us.
//
// Config-driven (same philosophy as CONSENT_CONFIG in consent-ghost.js): one
// PROVIDER_CONFIG array, each provider declares its own email body selectors,
// exclusions, and legitimate image proxies.
//
// Hard rules shared across PawsOff: IIFE + 'use strict' + try/catch every
// async fn; window.__pawsOff_* namespace only; silent failures → diagnostics
// go to chrome.storage.local, never the page; never log PII (no email text,
// subject, sender, or full URLs); unique-key storage writes only; never touch
// DOM nodes we didn't create beyond rewriting <img> src/srcset.
//
// ─── MANIFEST host_permissions REQUIRED ────────────────────────────────────
//   https://mail.google.com/*      https://mail.proton.me/*
//   https://mail.protonmail.com/*  https://mail.zoho.com/*
//   https://mail.zoho.in/*         https://mail.zoho.eu/*
//   https://mail.yahoo.com/*       https://outlook.live.com/*
//   https://outlook.office.com/*   https://app.fastmail.com/*
//   https://app.hey.com/*          https://app.tuta.com/*
//   https://mail.tutanota.com/*    https://www.icloud.com/mail*
//
//   content_scripts entry needs "all_frames": true for same-origin email
//   iframes; does NOT help cross-origin iframes (iCloud - see iframeLimited).
//
// ─── MANIFEST declarativeNetRequest REQUIRED ───────────────────────────────
//   Content scripts can't call the DNR API directly, so PixelBlock builds
//   dynamic rules from TRACKING_DOMAINS and forwards them to the background
//   worker via { type: 'pawsoff_pixelBlock_dnr', op, rules, removeRuleIds },
//   handled with updateDynamicRules({ removeRuleIds, addRules: rules }).
//   Rule IDs 9100+ are reserved for PixelBlock (one per provider).

(function () {
  'use strict';

  // ── Double-run guard ───────────────────────────────────────────────────────
  // Per-frame isolated world: if we already initialised in this frame, bail.
  if (typeof window.__pawsOff_pixelBlock_init === 'function') return;

  // ── Transparent 1x1 PNG used to neutralise a tracker src ──────────────────
  // A real, decodable image so layout never breaks and no broken-image icon
  // appears. Local data URI → zero network request.
  const TRANSPARENT_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ' +
    'AAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

  // ── Storage keys ───────────────────────────────────────────────────────────
  const SETTINGS_KEY  = '__pawsOff_pixelBlock_settings';
  const ALLOW_KEY     = '__pawsOff_allowlist'; // per-site pause + per-tracker allow (written by the popup)
  const EVENT_PREFIX  = '__pawsOff_pixelBlock_event_'; // block events → getStats()
  const LOG_PREFIX    = '__pawsOff_pixelBlock_log_';   // errors / status notes
  const EVENT_MAX     = 500;   // retention cap for block events
  const LOG_MAX       = 200;   // retention cap for diagnostic logs
  const PRUNE_SAMPLE  = 0.1;   // prune on ~1 in 10 writes (avoid get(null) spam)
  // Monotonic blocked-pixel counter, never pruned, so popup totals never plateau.
  const PB_TOTAL_KEY  = '__pawsOff_pb_total_blocked';

  // ── declarativeNetRequest rule id space ───────────────────────────────────
  // One dynamic rule per provider, so a per-provider toggle maps to add/remove
  // of a single rule. 9100.. is reserved for PixelBlock.
  const DNR_RULE_ID_BASE = 9100;

  // ── Known tracking domains ───────────────────────────────────────────────
  // Single source of truth for BOTH the DNR ruleset (network block) and the DOM
  // fallback. Matched by exact hostname OR as a parent suffix (host endsWith
  // '.' + entry), so 'klaviyo.com' also catches 'trk.klaviyo.com', etc.
  const TRACKING_DOMAINS = [
    'mailtrack.io', 'sendgrid.net', 'mandrillapp.com', 'list-manage.com',
    'mailchimp.com', 'hubspot.com', 'hs-analytics.net', 'hsforms.com',
    'pardot.com', 'exacttarget.com', 'marketing.adobe.com', 'marketo.net',
    'mktoinsights.com', 'eloqua.com', 'en25.com', 'klaviyo.com',
    'trk.klaviyo.com', 'k.klaviyo.com', 'beehiiv.com',
    'link.mail.beehiiv.com', 'convertkit.com', 'ck.convertkit.com',
    'drip.com', 'getdrip.com', 'activecampaign.com', 'activehosted.com',
    'constantcontact.com', 'rs6.net', 'campaign-archive.com',
    'createsend.com', 'campaign-monitor.com', 'sendinblue.com',
    'brevo.com', 'postmarkapp.com', 'sparkpostmail.com', 'mailgun.org',
    'intercom-mail.com', 'customer.io', 'vero.co', 'getvero.com',
    'lemlist.com', 'yesware.com', 't.yesware.com', 'streak.com',
    'salesloft.com', 'outreach.io', 'reply.io', 'mixmax.com',
    'cirrusinsight.com', 'newtonhq.com', 'track.totalsend.com',
    'boomeranggmail.com', 'omnisend.com', 'mailerlite.com',
    'getresponse.com', 'aweber.com', 'icontact.com',
    'benchmarkemail.com', 'moosend.com', 'mailjet.com',
  ];

  // ── Heuristic patterns (catch unknown senders) ────────────────────────────
  // STRONG signals → block before the request fires (pre-load rewrite); these
  //   path/query tokens are unambiguous tracking endpoints.
  // WEAK signals → too generic to pre-block (would break legitimate images), so
  //   they are deferred to the load-time 1x1 size probe.
  const TRACKER_PATH_STRONG = ['/track', '/wf/open', '/e/open', '/emails/open', '/click/track'];
  const TRACKER_PATH_WEAK   = ['/open', '/pixel', '/t/', '/beacon'];
  const TRACKER_QUERY_STRONG = ['trk=', 'tracking_id=', 'mtm_=', 'mc_eid=', 'mid=email'];
  const TRACKER_QUERY_WEAK   = ['qs=', 'sig='];

  // ── Provider configuration ─────────────────────────────────────────────────
  // id is the slug used for the per-provider settings toggle and for storage.
  const PROVIDER_CONFIG = [
    {
      name: 'Gmail',
      id: 'gmail',
      hosts: ['mail.google.com'],
      emailBodySelectors: ['.ii.gt', '.a3s.aiL', '[data-message-id] .ii'],
      excludeSelectors: ['.aeH', '.G-atb', '.gb_', '[id=":0"]'],
      // Gmail proxies remote images through googleusercontent (server-side,
      // already IP-shielding) - never block these.
      legitimateProxies: [
        'mail-attachment.googleusercontent.com',
        'ci3.googleusercontent.com',
        'lh3.googleusercontent.com',
      ],
    },
    {
      name: 'ProtonMail',
      id: 'protonmail',
      hosts: ['mail.proton.me', 'mail.protonmail.com'],
      emailBodySelectors: [
        '.message-content',
        '.proton-embedded-images',
        '[data-testid="message-content-container"]',
      ],
      excludeSelectors: ['.sidebar', '.toolbar', '.composer'],
      legitimateProxies: [],
      // Proton blocks pixels itself; we scan anyway as a second layer (flagged
      // via nativeProtection in each block event).
      nativeProtection: true,
    },
    {
      name: 'Zoho Mail',
      id: 'zoho',
      hosts: ['mail.zoho.com', 'mail.zoho.in', 'mail.zoho.eu'],
      emailBodySelectors: ['.msgBody', '.readMsgBody', '#msgBodyContent', '.zmail-mail-content'],
      excludeSelectors: ['.zmMailTopBar', '.leftPanel'],
      legitimateProxies: [],
    },
    {
      name: 'Yahoo Mail',
      id: 'yahoo',
      hosts: ['mail.yahoo.com'],
      emailBodySelectors: ['[data-test-id="message-body"]', '.msg-body', '.ReadMsgBody'],
      excludeSelectors: ['[data-test-id="toolbar"]', '.compose-button'],
      legitimateProxies: ['yimg.com'],
    },
    {
      name: 'Outlook',
      id: 'outlook',
      hosts: ['outlook.live.com', 'outlook.office.com', 'hotmail.com'],
      emailBodySelectors: [
        '.ReadingPaneContentsContainer',
        '[aria-label="Message body"]',
        '.allowTextSelection',
        '.rps_4de7',
      ],
      excludeSelectors: ['[role="navigation"]', '.ms-CommandBar'],
      legitimateProxies: ['outlook.com', 'microsoft.com'],
    },
    {
      name: 'Fastmail',
      id: 'fastmail',
      hosts: ['app.fastmail.com'],
      emailBodySelectors: ['.v-MailboxMessage-body', '.js-MessageBody', '[data-component="MessageBody"]'],
      excludeSelectors: ['.v-Toolbar', '.v-Mailbox-header'],
      legitimateProxies: [],
    },
    {
      name: 'HEY',
      id: 'hey',
      hosts: ['app.hey.com'],
      emailBodySelectors: ['.email-body', '.imbox-thread-email-body', '[data-behavior="email-body"]'],
      excludeSelectors: ['.toolbar', '.hey-nav'],
      legitimateProxies: [],
      // HEY ships "Spy Pixel Blocker", same double-protection rationale as Proton.
      nativeProtection: true,
    },
    {
      name: 'Tutanota / Tuta',
      id: 'tutanota',
      hosts: ['app.tuta.com', 'mail.tutanota.com'],
      emailBodySelectors: ['.mail-body', '[data-testid="mail-body"]'],
      excludeSelectors: ['.mail-header', '.button-bar'],
      legitimateProxies: [],
    },
    {
      name: 'iCloud Mail',
      id: 'icloud',
      hosts: ['www.icloud.com'],
      // iCloud renders email in a cross-origin sandboxed iframe - unreachable
      // by a content script or all_frames injection. Detect the host, skip
      // scanning, surface the limitation via getStats().
      emailBodySelectors: [],
      excludeSelectors: [],
      legitimateProxies: [],
      iframeLimited: true,
      limitationReason: 'Email is rendered in a cross-origin sandboxed iframe, which extensions cannot read; tracker blocking is not available here.',
    },
  ];

  // ── Runtime state (closure-private; nothing on window can mutate it) ───────
  const state = {
    provider: null,       // resolved PROVIDER_CONFIG entry for this host
    settings: null,       // last known settings object
    observer: null,       // MutationObserver
    active: false,        // currently scanning + observing
    started: false,       // init has completed at least once
    dnrRegistered: false, // DNR rule currently registered for this provider
    allowState: { v: 1, sites: {} }, // per-site pause + per-tracker allow (mirrors network DNR allow rules)
    allowOriginHash: null,           // FNV digest of this frame's host, for allow lookups
  };

  // Isolated-world WeakSets, not data-pawsoff-* DOM attributes - attributes
  // would announce "this user runs PawsOff" to the page and any other
  // installed extension. WeakSets are invisible to the page and
  // garbage-collect with the element.
  const _blocked = new WeakSet(); // images whose tracker src we already rewrote
  const _probed  = new WeakSet(); // images we already attached a 1x1 size-probe to
  const _scanned = new WeakSet(); // containers we already swept

  // ─────────────────────────────────────────────────────────────────────────
  //  Small utilities
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Generate a short random suffix for unique storage keys.
   * @returns {string}
   */
  function rand() {
    return Math.random().toString(36).slice(2, 8);
  }

  /**
   * De-duplicate an array of strings, preserving order.
   * @param {string[]} arr
   * @returns {string[]}
   */
  function dedupe(arr) {
    return Array.from(new Set(arr.filter(Boolean)));
  }

  /**
   * Extract the lowercased hostname from a URL string for LOGGING ONLY.
   * Hostname carries no subscriber tokens, so it is safe to record; the full URL
   * is never logged because its query string can contain PII / tracking IDs.
   * @param {string} value
   * @returns {string|null}
   */
  function hostOf(value) {
    try {
      return new URL(value, location.href).hostname.toLowerCase();
    } catch (_) {
      return null;
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  //  Allow-list gate (DOM tier), mirrors the network-tier DNR allow rules -
  //  un-breaking a site or allowing a domain in the popup stops this frame
  //  from neutralizing it too. DNR stays authoritative; this is best-effort.
  // ───────────────────────────────────────────────────────────────────────
  function _poAllow() {
    return (typeof window !== 'undefined' && window.PawsOffAllow) ? window.PawsOffAllow : null;
  }
  function _normAllowDomain(input) {
    const A = _poAllow();
    if (A && typeof A.normDomain === 'function') { try { return A.normDomain(input); } catch (_) {} }
    if (!input || typeof input !== 'string') return '';
    let s = input.trim().toLowerCase().replace(/^[a-z][a-z0-9+.\-]*:\/\//, '').replace(/^[^@\/]*@/, '');
    s = s.split('/')[0].split('?')[0].split('#')[0].split(':')[0].replace(/^www\./, '');
    if (!/^[a-z0-9.\-]+$/.test(s) || s.indexOf('.') < 0) return '';
    return s;
  }
  function _coerceAllow(raw) {
    const A = _poAllow();
    if (A && typeof A.normalizeState === 'function') { try { return A.normalizeState(raw); } catch (_) {} }
    return (raw && typeof raw === 'object' && raw.sites && typeof raw.sites === 'object') ? raw : { v: 1, sites: {} };
  }
  async function loadAllowState() {
    try {
      const stored = await chrome.storage.local.get(ALLOW_KEY);
      state.allowState = _coerceAllow(stored && stored[ALLOW_KEY]);
      state.allowOriginHash = hashHost(location.hostname);
    } catch (_) {
      // Fail-open: can't read allow-state → stand down (treat as paused)
      // rather than risk breaking a site the user opted to allow.
      state.allowState = { v: 1, sites: {} };
      state.allowOriginHash = null;
      state.allowReadFailed = true;
    }
  }
  function _siteEntry() {
    const st = state.allowState, oh = state.allowOriginHash;
    return (st && st.sites && oh) ? st.sites[oh] : null;
  }
  function sitePausedHere() {
    if (state.allowReadFailed) return true; // couldn't read state → stand down
    try { const s = _siteEntry(); return !!(s && s.paused > 0); } catch (_) { return false; }
  }
  function hostAllowedHere(host) {
    try {
      if (sitePausedHere()) return true;
      const s = _siteEntry();
      if (!s || !s.domains) return false;
      const nd = _normAllowDomain(host);
      return !!(nd && s.domains[nd] > 0);
    } catch (_) { return false; }
  }

  /**
   * One-way FNV-1a/32 digest of a hostname for local log de-identification -
   * so the event log can't be read back as a plaintext site list. Never
   * transmitted; a privacy de-identifier, not a security primitive.
   * @param {string} host
   * @returns {string|null} 'h:' + 8 hex chars, or null for empty input
   */
  function hashHost(host) {
    if (!host || typeof host !== 'string') return null;
    let h = 0x811c9dc5;
    const s = host.toLowerCase();
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return 'h:' + h.toString(16).padStart(8, '0');
  }

  /**
   * True if hostname equals a tracker domain or is a subdomain of one.
   * @param {string} host
   * @returns {boolean}
   */
  function matchesTrackerDomain(host) {
    if (!host) return false;
    for (const d of TRACKING_DOMAINS) {
      if (host === d || host.endsWith('.' + d)) return true;
    }
    return false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  declarativeNetRequest, PRIMARY (network-level) block layer
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Stable DNR rule id for a provider (one rule per provider).
   * @param {Object} provider
   * @returns {number}
   */
  function dnrRuleIdFor(provider) {
    const idx = PROVIDER_CONFIG.indexOf(provider);
    return DNR_RULE_ID_BASE + (idx >= 0 ? idx : 0);
  }

  /**
   * Build the DNR rule that blocks image requests to any known tracker domain,
   * scoped to this provider's webmail origin so we never alter those domains'
   * behaviour on unrelated sites.
   * @param {Object} provider
   * @returns {Object}
   */
  function buildDnrRule(provider) {
    return {
      id: dnrRuleIdFor(provider),
      priority: 1,
      action: { type: 'block' },
      condition: {
        requestDomains: TRACKING_DOMAINS.slice(),
        initiatorDomains: provider.hosts.slice(),
        resourceTypes: ['image'],
      },
    };
  }

  /** True when the messaging bridge to the background service worker exists. */
  function canMessageBackground() {
    return !!(chrome && chrome.runtime && chrome.runtime.sendMessage);
  }
  /** DNR is only meaningful for a top-frame provider that isn't iframe-limited. */
  function providerSupportsDnr() {
    return !!state.provider && !state.provider.iframeLimited;
  }
  /** Ask the background to register this provider's DNR rule (top frame only -
   *  rules are extension-global, one registration is enough). */
  function registerDnr() {
    try {
      if (window.top !== window) return;
      if (!providerSupportsDnr()) return;
      if (!canMessageBackground()) return;
      const rule = buildDnrRule(state.provider);
      chrome.runtime.sendMessage(
        {
          type: 'pawsoff_pixelBlock_dnr',
          op: 'register',
          rules: [rule],
          removeRuleIds: [rule.id], // replace any stale rule with the same id
        },
        (resp) => {
          // Only mark registered once confirmed - a dropped message must not
          // make us believe DNR is active when only the DOM tier is running.
          if (chrome.runtime.lastError || !resp || !resp.ok) return;
          state.dnrRegistered = true;
        },
      );
    } catch (_) {
      // Silent, DOM fallback still protects.
    }
  }

  /**
   * Ask the service worker to remove this provider's DNR rule (toggle off).
   */
  function unregisterDnr() {
    try {
      if (window.top !== window) return;
      if (!state.provider) return;
      if (!canMessageBackground()) return;
      chrome.runtime.sendMessage(
        {
          type: 'pawsoff_pixelBlock_dnr',
          op: 'unregister',
          removeRuleIds: [dnrRuleIdFor(state.provider)],
        },
        () => { void chrome.runtime.lastError; },
      );
      state.dnrRegistered = false;
    } catch (_) {
      // Silent.
    }
  }

  /**
   * Keep the DNR registration in sync with the current enabled state.
   */
  function syncDnr() {
    if (isEnabledNow()) {
      if (!state.dnrRegistered) registerDnr();
    } else if (state.dnrRegistered) {
      unregisterDnr();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Settings
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Build the first-run default settings: protection globally on, every provider
   * on. Provider keys are derived from PROVIDER_CONFIG so the two can never drift.
   * @returns {{globalEnabled: boolean, providers: Object<string, boolean>}}
   */
  function defaultSettings() {
    const providers = {};
    for (const p of PROVIDER_CONFIG) providers[p.id] = true;
    return { globalEnabled: true, providers };
  }

  /**
   * Coerce a possibly-partial stored settings object into a complete, valid one.
   * Missing provider toggles default to true (forward-compatible when we add new
   * providers in a release without re-running first-run setup).
   * @param {*} raw
   * @returns {{globalEnabled: boolean, providers: Object<string, boolean>}}
   */
  function normalizeSettings(raw) {
    const base = defaultSettings();
    if (!raw || typeof raw !== 'object') return base;
    const out = {
      globalEnabled: typeof raw.globalEnabled === 'boolean' ? raw.globalEnabled : true,
      providers: { ...base.providers },
    };
    if (raw.providers && typeof raw.providers === 'object') {
      for (const id of Object.keys(out.providers)) {
        if (typeof raw.providers[id] === 'boolean') out.providers[id] = raw.providers[id];
      }
    }
    return out;
  }

  /**
   * Load settings from storage, writing first-run defaults if absent.
   * Fail-OPEN: if storage is unreachable we return defaults (protection on),
   * because for a privacy tool the safe failure mode is to keep protecting.
   * @returns {Promise<Object>}
   */
  async function loadSettings() {
    try {
      const stored = await chrome.storage.local.get(SETTINGS_KEY);
      const existing = stored && stored[SETTINGS_KEY];
      if (!existing) {
        const defaults = defaultSettings();
        // First run, persist defaults so the popup has something to render.
        await chrome.storage.local.set({ [SETTINGS_KEY]: defaults });
        return defaults;
      }
      return normalizeSettings(existing);
    } catch (_) {
      return defaultSettings();
    }
  }

  /**
   * True if protection should currently run for this frame's provider.
   * @returns {boolean}
   */
  function isEnabledNow() {
    const s = state.settings;
    const p = state.provider;
    if (!s || !p) return false;
    if (!s.globalEnabled) return false;
    if (p.iframeLimited) return false;           // nothing we can do (iCloud)
    return s.providers[p.id] !== false;          // per-provider toggle
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Storage writes (unique-key, race-free) + stats
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Write one record under a unique key. Unique keys mean concurrent writes from
   * multiple frames/tabs can never clobber each other (no shared mutable array),
   * which is the cross-frame race fix carried over from consent-ghost.js.
   * @param {string} prefix
   * @param {Object} record
   * @param {string} prunePrefix
   * @param {number} max
   * @returns {Promise<void>}
   */
  async function writeRecord(prefix, record, prunePrefix, max) {
    try {
      const key = prefix + Date.now() + '_' + rand();
      await chrome.storage.local.set({ [key]: record });
      // Sampled best-effort retention; over/under-shooting briefly is harmless
      // because every entry is an independent key.
      if (Math.random() < PRUNE_SAMPLE) await pruneByPrefix(prunePrefix, max);
    } catch (_) {
      // Silent (storage may be restricted in private contexts).
    }
  }

  /**
   * Record a pixel-block event. Contains ONLY non-PII aggregates: provider id,
   * count, and one-way hashed hostnames. Never email content, subject, or sender.
   * @param {Object} provider
   * @param {number} count
   * @param {string[]} hosts
   * @returns {Promise<void>}
   */
  function logBlockEvent(provider, count, hosts) {
    // Increment the monotonic total (non-awaited; best-effort for display counter).
    incrementTotal(PB_TOTAL_KEY, count);
    // PawsOff catch feed (popup "Today's catch"), record the tracker host(s)
    // only. Non-PII: the tracker domain we blocked, never email/page content.
    try {
      if (window.PawsOffCatch && Array.isArray(hosts)) {
        dedupe(hosts).slice(0, 5).forEach(function (hh) {
          window.PawsOffCatch.recordTracker(hh, 'Email tracker', false);
        });
      }
    } catch (_) { /* silent */ }
    return writeRecord(
      EVENT_PREFIX,
      {
        ts: Date.now(),
        provider: provider.id,
        blocked_count: count,
        tracking_domains: dedupe(hosts).map(hashHost),
        nativeProtection: provider.nativeProtection === true,
      },
      EVENT_PREFIX,
      EVENT_MAX,
    );
  }

  /**
   * Record a diagnostic / status note (errors, iCloud iframe limitation, etc.).
   * Kept under a separate prefix so getStats() never counts it.
   * @param {string} status
   * @param {Object} [extra]
   * @returns {Promise<void>}
   */
  function logStatus(status, extra) {
    return writeRecord(
      LOG_PREFIX,
      {
        ts: Date.now(),
        status,
        provider: state.provider ? state.provider.id : null,
        ...(extra || {}),
      },
      LOG_PREFIX,
      LOG_MAX,
    );
  }

  /**
   * Trim oldest entries of a given prefix down to `max`. remove() of distinct
   * keys is safe under concurrency (unlike rewriting a shared array).
   * @param {string} prefix
   * @param {number} max
   * @returns {Promise<void>}
   */
  async function pruneByPrefix(prefix, max) {
    try {
      let keys;
      if (typeof chrome.storage.local.getKeys === 'function') {
        keys = (await chrome.storage.local.getKeys()).filter((k) => k.startsWith(prefix));
      } else {
        keys = Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith(prefix));
      }
      if (keys.length <= max) return;
      const entries = await chrome.storage.local.get(keys);
      keys.sort((a, b) => ((entries[a] && entries[a].ts) || 0) - ((entries[b] && entries[b].ts) || 0));
      await chrome.storage.local.remove(keys.slice(0, keys.length - max));
    } catch (_) {
      // Silent.
    }
  }

  let _pendingTotal = 0;
  let _totalTimer = null;

  /**
   * Increment a monotonic aggregate counter (read-modify-write, best-effort).
   * Batched to prevent thrashing storage on multi-tracker emails.
   * @param {string} key
   * @param {number} [by]
   */
  function incrementTotal(key, by) {
    _pendingTotal += (by || 1);
    if (!_totalTimer) {
      _totalTimer = setTimeout(async () => {
        const val = _pendingTotal;
        _pendingTotal = 0;
        _totalTimer = null;
        try {
          const s = await chrome.storage.local.get(key);
          const cur = (s && typeof s[key] === 'number') ? s[key] : 0;
          await chrome.storage.local.set({ [key]: cur + val });
        } catch (_) { /* silent */ }
      }, 2000);
    }
  }

  /**
   * Static list of providers we can only partially support, for the popup.
   * @returns {Array<{provider: string, name: string, reason: string}>}
   */
  function knownLimitations() {
    return PROVIDER_CONFIG
      .filter((p) => p.iframeLimited)
      .map((p) => ({
        provider: p.id,
        name: p.name,
        reason: p.limitationReason || 'Supported with limitations.',
      }));
  }

  /**
   * Aggregate block events for the popup badge.
   * `limitations` lets the popup show e.g. iCloud as "supported with limitations".
   * @returns {Promise<{totalBlocked: number, byProvider: Object<string, number>, lastScan: number, limitations: Array}>}
   */
  async function getStats() {
    const result = { totalBlocked: 0, byProvider: {}, lastScan: 0, limitations: knownLimitations() };
    try {
      const all = await chrome.storage.local.get(null);
      for (const k of Object.keys(all)) {
        if (!k.startsWith(EVENT_PREFIX)) continue;
        const e = all[k];
        if (!e) continue;
        const c = e.blocked_count || 0;
        result.totalBlocked += c;
        if (e.provider) result.byProvider[e.provider] = (result.byProvider[e.provider] || 0) + c;
        if (e.ts && e.ts > result.lastScan) result.lastScan = e.ts;
      }
      // Per-event records get pruned, so their sum undercounts over time. Prefer
      // the monotonic all-time counter when it's higher (it survives pruning).
      const mono = all[PB_TOTAL_KEY];
      if (typeof mono === 'number' && mono > result.totalBlocked) result.totalBlocked = mono;
    } catch (_) {
      // Silent, return whatever we accumulated (possibly zeroes).
    }
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  URL classification + image neutralisation (DOM FALLBACK layer)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Classify a single image URL.
   *   'allow'   → never block (cid:/blob: inline, or a provider's legit proxy)
   *   'skip'    → not network-relevant (data:, non-http(s), unparseable)
   *   'block'   → known tracker / unambiguous endpoint; rewrite before it fires
   *   'inspect' → unknown / weak signal; let it load, confirm via 1x1 size check
   * data: URIs are 'skip' - inline, no network request, blocking buys nothing.
   * @param {string|null} rawUrl
   * @param {Object} provider
   * @returns {'allow'|'skip'|'block'|'inspect'}
   */
  /** Real shielding proxies (e.g. Gmail googleusercontent) outrank block rules. */
  function isLegitimateProxyHost(host, provider) {
    return !!provider.legitimateProxies &&
      provider.legitimateProxies.some((p) => host === p || host.endsWith('.' + p));
  }
  /** Decode a percent-encoded candidate; returns the input unchanged on failure. */
  function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (_) { return s; }
  }
  /**
   * PURE: the original URL embedded inside a webmail image-proxy URL, or ''.
   * Proxies carry the real target in one of three shapes:
   *   fragment (Gmail):   ci3.googleusercontent.com/meips/<opaque>#https://t.io/x.gif
   *   query    (Proton):  mail.proton.me/api/core/v4/images?Url=https%3A%2F%2Ft.io%2Fx.gif
   *   path     (generic): proxy.host/<opaque>/https://t.io/x.gif
   * A tracker stays a tracker behind a proxy - the proxy still pings it at
   * open time - so callers must classify the embedded target too.
   * @param {string|null} rawUrl
   * @returns {string} embedded absolute URL, or ''
   */
  function extractEmbeddedUrl(rawUrl) {
    try {
      if (!rawUrl) return '';
      const u = new URL(String(rawUrl), location.href);
      const hash = u.hash || '';
      if (/^#https?:\/\//i.test(hash)) return hash.slice(1);
      const search = u.search || '';
      let m = /[?&][^=&]*=(https?:\/\/[^&]+)/i.exec(search);
      if (m) return m[1];
      m = /[?&][^=&]*=(https?%3A%2F%2F[^&]+)/i.exec(search);
      if (m) return safeDecode(m[1]);
      const path = u.pathname || '';
      const i = path.search(/\/https?:\/\//i);
      if (i >= 0) return path.slice(i + 1);
      return '';
    } catch (_) { return ''; }
  }
  function classifyUrl(rawUrl, provider) {
    if (!rawUrl) return 'skip';
    const url = String(rawUrl).trim();
    if (!url) return 'skip';
    const lower = url.toLowerCase();

    if (lower.startsWith('cid:')) return 'allow';   // inline attachment reference
    if (lower.startsWith('blob:')) return 'allow';  // local object URL
    if (lower.startsWith('data:')) return 'skip';   // inline, no network request

    let u;
    try {
      u = new URL(url, location.href);
    } catch (_) {
      return 'skip';
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'skip';

    const host = u.hostname.toLowerCase();

    // Proxy-aware check first: classify the embedded target (see
    // extractEmbeddedUrl) with STRONG signals only, so a proxied tracker
    // stays blocked while legitimate proxied images are never broken.
    const embedded = extractEmbeddedUrl(u.href);
    if (embedded) {
      const eh = hostOf(embedded);
      if (eh && !hostAllowedHere(eh)) { // user allow of the TRACKER host wins
        if (matchesTrackerDomain(eh)) return 'block';
        try {
          const eu = new URL(embedded, location.href);
          const ep = eu.pathname.toLowerCase();
          if (TRACKER_PATH_STRONG.some((p) => ep.includes(p))) return 'block';
          const es = eu.search.toLowerCase();
          if (TRACKER_QUERY_STRONG.some((q) => es.includes(q))) return 'block';
        } catch (_) { /* unparseable embedded target → fall through */ }
      }
    }

    // Real proxies already shielding the user's IP outrank any remaining rule.
    if (isLegitimateProxyHost(host, provider)) {
      return 'allow';
    }

    // Known tracker → pre-block (DNR should already have caught it at network
    // level; rewrite too so it's counted in stats even if DNR didn't fire).
    if (matchesTrackerDomain(host)) return 'block';

    // Only unambiguous path/query endpoints pre-block. Generic tokens
    // (TRACKER_PATH_WEAK/QUERY_WEAK) fall through to 'inspect' so the
    // load-time size probe confirms them without risking legitimate images.
    const path = u.pathname.toLowerCase();
    if (TRACKER_PATH_STRONG.some((p) => path.includes(p))) return 'block';

    const search = u.search.toLowerCase();
    if (TRACKER_QUERY_STRONG.some((q) => search.includes(q))) return 'block';

    return 'inspect';
  }

  /**
   * Parse a srcset attribute into candidate URLs (descriptors stripped).
   * Simple parser: adequate for webmail; URLs containing commas (rare data URLs)
   * are not perfectly handled. TODO(v2): full srcset grammar parser.
   * @param {string|null} value
   * @returns {string[]}
   */
  function parseSrcset(value) {
    if (!value) return [];
    return value
      .split(',')
      .map((part) => part.trim().split(/\s+/)[0])
      .filter(Boolean);
  }

  /**
   * True if the element is inside provider UI chrome we must never touch.
   * Checked before ANY DOM operation on the element (hard rule).
   * @param {Element} el
   * @param {Object} provider
   * @returns {boolean}
   */
  function isExcluded(el, provider) {
    try {
      const sel = (provider.excludeSelectors || []).join(',');
      if (!sel) return false;
      return !!(el.closest && el.closest(sel));
    } catch (_) {
      return false;
    }
  }

  /**
   * Per-element record of the original src/srcset/data-src we replaced -
   * isolated-world WeakMap, never written to the page DOM. These values can
   * carry subscriber tokens; a `data-pawsoff-original-*` attribute would leak
   * them to the page and to any other installed extension's content script.
   * WeakMap is unreadable outside this script and GCs with the element. Exists
   * so a future "reveal blocked images" feature can restore sources locally;
   * never read back otherwise, never leaves the device. Keyed by <img>; value
   * is { src?, datasrc?, srcset? }, each kind written at most once.
   */
  const originalSources = new WeakMap();

  /**
   * Remember an element's original attribute value once, in the isolated-world
   * WeakMap. Does NOT touch the page DOM.
   * @param {Element} img
   * @param {'src'|'datasrc'|'srcset'} kind
   * @param {string|null} value
   */
  function rememberOriginal(img, kind, value) {
    try {
      if (value == null || value === '') return;
      let rec = originalSources.get(img);
      if (!rec) { rec = {}; originalSources.set(img, rec); }
      if (rec[kind] === undefined) rec[kind] = value; // write-once per kind
    } catch (_) {
      // Silent.
    }
  }

  function hasWeakTrackerSignal(rawUrl) {
    try {
      if (!rawUrl) return false;
      const u = new URL(rawUrl, location.href);
      const p = u.pathname.toLowerCase(), s = u.search.toLowerCase();
      return TRACKER_PATH_WEAK.some(t => p.includes(t)) || TRACKER_QUERY_WEAK.some(t => s.includes(t));
    } catch (_) { return false; }
  }

  /** Only pin a measured width back onto the element if it isn't already set. */
  function shouldPinWidth(rect, img) {
    return rect.width > 1 && img.style && !img.style.width;
  }
  /** Only pin a measured height back onto the element if it isn't already set. */
  function shouldPinHeight(rect, img) {
    return rect.height > 1 && img.style && !img.style.height;
  }
  function neutralize(img, attr, value) {
    try {
      const r = img.getBoundingClientRect();
      if (shouldPinWidth(r, img)) img.style.width = r.width + 'px';
      if (shouldPinHeight(r, img)) img.style.height = r.height + 'px';
    } catch (_) {}
    rememberOriginal(img, attr === 'data-src' ? 'datasrc' : attr, value);
    img.setAttribute(attr, TRANSPARENT_PNG);
  }

  /**
   * Inspect one <img> and neutralise any tracker-bearing src/srcset/data-src.
   * Runs SYNCHRONOUSLY so the rewrite has the best chance of beating the browser
   * fetch (DNR is the robust network-level layer; this DOM rewrite is the
   * fallback for unknown senders and the source of per-block stats).
   * Layout is preserved (we swap the source, never display:none).
   * @param {HTMLImageElement} img
   * @param {Object} provider
   * @returns {{blocked: boolean, hosts: string[], reason: string}}
   */
  /** Unknown images with a weak tracker signal get a load-time 1x1 size probe. */
  function shouldSizeProbe(inspect, srcVal, dataSrcVal) {
    return inspect && hasWeakTrackerSignal(srcVal || dataSrcVal);
  }
  function processImg(img, provider) {
    try {
      if (!img || _blocked.has(img)) {
        return { blocked: false, hosts: [], reason: 'none' };
      }
      if (isExcluded(img, provider)) return { blocked: false, hosts: [], reason: 'none' };
      // Site un-broken in the popup → leave every pixel alone in this frame.
      if (sitePausedHere()) return { blocked: false, hosts: [], reason: 'none' };

      const hosts = [];
      let blocked = false;
      let inspect = false;
      let reason = 'unknown';

      const srcVal     = img.getAttribute('src');
      const dataSrcVal = img.getAttribute('data-src');   // lazy-loading pattern
      const srcsetVal  = img.getAttribute('srcset');

      // Stats/feed attribute the TRACKER's host: for a proxied pixel that is
      // the embedded target's host (e.g. mailtrack.io), not the proxy's.
      const statsHostOf = (raw) => hostOf(extractEmbeddedUrl(raw) || raw);

      // ── src ──
      const srcClass = classifyUrl(srcVal, provider);
      if (srcClass === 'block' && !hostAllowedHere(hostOf(srcVal))) {
        reason = matchesTrackerDomain(statsHostOf(srcVal)) ? 'domain' : 'path';
        neutralize(img, 'src', srcVal);
        const h = statsHostOf(srcVal); if (h) hosts.push(h);
        blocked = true;
      } else if (srcClass === 'inspect') {
        inspect = true;
      }

      // ── data-src (lazy) ──
      const dataSrcClass = classifyUrl(dataSrcVal, provider);
      if (dataSrcClass === 'block' && !hostAllowedHere(hostOf(dataSrcVal))) {
        if (!blocked) reason = matchesTrackerDomain(statsHostOf(dataSrcVal)) ? 'domain' : 'path';
        neutralize(img, 'data-src', dataSrcVal);
        const h = statsHostOf(dataSrcVal); if (h) hosts.push(h);
        blocked = true;
      } else if (dataSrcClass === 'inspect') {
        inspect = true;
      }

      // ── srcset ──
      if (srcsetVal) {
        const urls = parseSrcset(srcsetVal);
        const trackerUrls = urls.filter((u) => classifyUrl(u, provider) === 'block' && !hostAllowedHere(hostOf(u)));
        if (trackerUrls.length > 0) {
          if (!blocked) reason = matchesTrackerDomain(statsHostOf(trackerUrls[0])) ? 'domain' : 'path';
          neutralize(img, 'srcset', srcsetVal);
          trackerUrls.forEach((u) => { const h = statsHostOf(u); if (h) hosts.push(h); });
          blocked = true;
        }
      }

      if (blocked) {
        _blocked.add(img);
        return { blocked: true, hosts, reason };
      }

      // Unknown / weak-signal image: let it load, then confirm 1x1 dimensions.
      if (shouldSizeProbe(inspect, srcVal, dataSrcVal)) {
        attachSizeProbe(img, provider);
      }
      return { blocked: false, hosts: [], reason: 'none' };
    } catch (_) {
      return { blocked: false, hosts: [], reason: 'none' };
    }
  }

  /**
   * Attach a one-shot load probe that blocks the image if it turns out to be a
   * 1x1 pixel (the canonical tracker shape) from a non-proxy http(s) source.
   * This is the fallback for unknown senders and the demoted weak path/query
   * tokens (/open, /pixel, /t/, /beacon, qs=, sig=) the URL heuristics defer.
   * @param {HTMLImageElement} img
   * @param {Object} provider
   */
  function attachSizeProbe(img, provider) {
    try {
      if (_probed.has(img)) return;
      _probed.add(img);

      const check = () => {
        try {
          if (_blocked.has(img)) return;
          // Our own replacement PNG is 1x1, the blocked guard above prevents a
          // re-processing loop after we rewrite the src.
          if (img.naturalWidth === 1 && img.naturalHeight === 1) {
            const cur = img.getAttribute('src');
            const cls = classifyUrl(cur, provider);
            if (cls === 'allow' || cls === 'skip') return; // don't touch proxies/inline
            const host = hostOf(cur);
            const rect = img.getBoundingClientRect();
            const usedForLayout = rect.width > 2 || rect.height > 2; // stretched spacer
            const weak = hasWeakTrackerSignal(cur);
            const thirdParty = host && host !== location.hostname;
            if (usedForLayout && !weak) return;     // genuine spacer - leave it
            if (!weak && !thirdParty) return;       // no corroboration - leave it
            neutralize(img, 'src', cur);
            _blocked.add(img);
            logBlockEvent(provider, 1, host ? [host] : []);
          }
        } catch (_) {
          // Silent.
        }
      };

      // Cached images may already be complete (no future load event).
      if (img.complete) check();
      else img.addEventListener('load', check, { once: true });
    } catch (_) {
      // Silent.
    }
  }

  /**
   * Process a flat list of <img> elements; returns aggregate block info.
   * @param {Iterable<HTMLImageElement>} imgs
   * @param {Object} provider
   * @returns {{count: number, hosts: string[]}}
   */
  function processImgs(imgs, provider) {
    let count = 0;
    const hosts = [];
    for (const img of imgs) {
      const r = processImg(img, provider);
      const countable = (r.reason !== 'domain') || !state.dnrRegistered;
      if (r.blocked && countable) {
        count += 1;
        for (const h of r.hosts) hosts.push(h);
      }
    }
    return { count, hosts };
  }

  /**
   * Scan a confirmed email body container and neutralise tracker images within.
   * All <img> queries are scoped to the container, never run globally (security).
   * @param {Element} container
   * @param {Object} provider
   */
  function scanEmailBody(container, provider) {
    try {
      if (!container || isExcluded(container, provider)) return;
      if (_scanned.has(container)) return;

      const imgs = container.querySelectorAll('img');
      const { count, hosts } = processImgs(imgs, provider);

      _scanned.add(container);

      if (count > 0) logBlockEvent(provider, count, hosts);
    } catch (err) {
      logStatus('scan_error', { message: err && err.message });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Observation + lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Locate and scan any email bodies already present (initial open / SPA state).
   * The ONLY global query is to find body containers; image inspection stays
   * scoped within each container.
   */
  function scanExisting() {
    try {
      const provider = state.provider;
      const sel = (provider.emailBodySelectors || []).join(',');
      if (!sel) return;
      document.querySelectorAll(sel).forEach((c) => scanEmailBody(c, provider));
    } catch (err) {
      logStatus('scan_existing_error', { message: err && err.message });
    }
  }

  /**
   * Start the MutationObserver. Webmail opens emails without a page reload,
   * so watch document.body for added nodes and scan any email body that
   * appears. No teardown timer - stays alive for the tab's full life,
   * disconnected only on explicit disable (standDown) or navigation reset.
   */
  /** MutationObserver yields all node types; we only scan element nodes. */
  function isElementNode(node) {
    return !!node && node.nodeType === 1;
  }
  /** A node can be descended into only if it actually has queryable children. */
  function canQueryChildren(node) {
    return !!node.querySelectorAll && !!node.children && node.children.length > 0;
  }
  function startObserver() {
    try {
      const provider = state.provider;
      const bodySel = (provider.emailBodySelectors || []).join(',');
      if (!bodySel) return;

      const target = document.querySelector('[role="main"]') || document.body;
      const observer = new MutationObserver((mutations) => {
        try {
          if (!state.active) return;
          for (const m of mutations) {
            for (const node of m.addedNodes) {
              if (!isElementNode(node)) continue; // elements only

              // Case A: a new email body container appeared.
              const containers = [];
              if (node.matches && node.matches(bodySel)) {
                containers.push(node);
              } else if (canQueryChildren(node)) {
                node.querySelectorAll(bodySel).forEach((c) => containers.push(c));
              }
              if (containers.length > 0) {
                for (const c of containers) scanEmailBody(c, provider);
                continue;
              }

              // Case B: images lazily added INTO an already-scanned body (e.g.
              // remote images that load as the user scrolls). The container is
              // marked scanned, so handle these images directly.
              const host = node.closest ? node.closest(bodySel) : null;
              if (host && !isExcluded(host, provider)) {
                const imgs = [];
                if (node.matches && node.matches('img')) imgs.push(node);
                if (node.querySelectorAll) node.querySelectorAll('img').forEach((i) => imgs.push(i));
                if (imgs.length > 0) {
                  const { count, hosts } = processImgs(imgs, provider);
                  if (count > 0) logBlockEvent(provider, count, hosts);
                }
              }
            }
          }
        } catch (err) {
          logStatus('observer_error', { message: err && err.message });
        }
      });

      observer.observe(target, { childList: true, subtree: true });
      state.observer = observer;
    } catch (err) {
      logStatus('observer_init_error', { message: err && err.message });
    }
  }

  /**
   * Begin protection for this frame: scan what's open, then observe for more.
   * Idempotent.
   */
  function start() {
    try {
      if (state.active) return;
      state.active = true;
      scanExisting();
      startObserver();
    } catch (err) {
      logStatus('start_error', { message: err && err.message });
    }
  }

  /**
   * Stop observing. Already-blocked images stay blocked (restoring them is a
   * future "reveal" feature) - a user who just disabled protection mid-email
   * wouldn't want trackers to suddenly fire. Re-enabling re-arms via reevaluate().
   */
  function standDown() {
    try {
      state.active = false;
      if (state.observer) {
        state.observer.disconnect();
        state.observer = null;
      }
    } catch (_) {
      // Silent.
    }
  }

  /**
   * Apply current settings: keep DNR + observer in sync with enabled state.
   * Uses cached state.settings so it is synchronous and safe to call from event
   * handlers (storage.onChanged, navigation).
   */
  function reevaluate() {
    try {
      if (!state.provider) return;
      syncDnr();
      if (isEnabledNow()) {
        if (!state.active) start();
      } else if (state.active) {
        standDown();
      }
    } catch (err) {
      logStatus('reevaluate_error', { message: err && err.message });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Ask the background for the signed+verified PixelBlock remote config and
   * overlay any updated provider DOM selectors onto PROVIDER_CONFIG. This allows
   * emailBodySelectors / excludeSelectors to be patched without a store release
   * (same pipeline as ConsentGhost). Falls back silently to bundled config.
   * @returns {Promise<void>}
   */
  /** background returns { ok, config } only when the signed config verified. */
  function isConfigResponseOk(resp) {
    return !!resp && !!resp.ok && !!resp.config;
  }
  /** A usable remote config must carry a providers array to overlay. */
  function hasProviderList(cfg) {
    return !!cfg && Array.isArray(cfg.providers);
  }
  async function loadRemoteProviderConfig() {
    try {
      if (!canMessageBackground()) return;
      
      // Wrap the message in a timeout so we don't hang if the service worker is idle/killed
      const resp = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ ok: false, config: null }), 2000);
        try {
          chrome.runtime.sendMessage({ type: 'pawsoff_pixelBlock_getConfig' }, (r) => {
            clearTimeout(timer);
            resolve(r || { ok: false, config: null });
          });
        } catch (_) {
          clearTimeout(timer);
          resolve({ ok: false, config: null });
        }
      });
      
      if (!isConfigResponseOk(resp)) return;
      const cfg = resp.config;
      if (!hasProviderList(cfg)) return;
      for (const remote of cfg.providers) {
        if (!remote || typeof remote.id !== 'string') continue;
        const local = PROVIDER_CONFIG.find((p) => p.id === remote.id);
        if (!local) continue;
        // Only overlay non-empty arrays so a sparse remote entry can
        // patch one field without clearing the others.
        if (Array.isArray(remote.emailBodySelectors) && remote.emailBodySelectors.length) {
          local.emailBodySelectors = remote.emailBodySelectors.filter((s) => typeof s === 'string');
        }
        if (Array.isArray(remote.excludeSelectors) && remote.excludeSelectors.length) {
          local.excludeSelectors = remote.excludeSelectors.filter((s) => typeof s === 'string');
        }
        if (Array.isArray(remote.legitimateProxies) && remote.legitimateProxies.length) {
          local.legitimateProxies = remote.legitimateProxies.filter((s) => typeof s === 'string');
        }
      }
    } catch (_) {
      // Silent, bundled PROVIDER_CONFIG stays active.
    }
  }

  /**
   * Initialise PixelBlock for the current frame.
   * @returns {Promise<void>}
   */
  window.__pawsOff_pixelBlock_init = async function () {
    try {
      state.provider = detectProvider();
      if (!state.provider) return;            // not a supported webmail host
      state.settings = await loadSettings();
      await loadAllowState();
      state.started = true;

      // iCloud: cross-origin iframe, record the limitation and do nothing else.
      if (state.provider.iframeLimited) {
        await logStatus('iframe_limited', { reason: state.provider.limitationReason });
        return;
      }

      if (!state.settings.globalEnabled) return;          // global kill switch
      if (state.settings.providers[state.provider.id] === false) return; // per-provider off

      // Overlay remote provider selectors (signed + verified by background).
      // Done before syncDnr/start so any patched selectors are live from the
      // very first scan. Failure falls back to bundled PROVIDER_CONFIG silently.
      loadRemoteProviderConfig().then(() => {
        if (state.started) reevaluate();
      });

      syncDnr();   // PRIMARY: register network-level block rule
      start();     // FALLBACK: scan + observe the DOM
    } catch (err) {
      try {
        await logStatus('init_error', { message: err && err.message });
      } catch (_) {
        // Truly silent.
      }
    }
  };

  /**
   * Push a settings patch from the popup/options page WITHOUT reloading the tab.
   * Accepts a shallow patch; `providers` is merged (not replaced) so a single
   * provider toggle does not wipe the others.
   * @param {Object} patch
   * @returns {Promise<Object|null>} the new settings, or null on failure
   */
  window.__pawsOff_pixelBlock_updateSettings = async function (patch) {
    try {
      const current = state.settings || (await loadSettings());
      const next = normalizeSettings({
        globalEnabled:
          patch && typeof patch.globalEnabled === 'boolean'
            ? patch.globalEnabled
            : current.globalEnabled,
        providers: { ...current.providers, ...((patch && patch.providers) || {}) },
      });
      state.settings = next;
      await chrome.storage.local.set({ [SETTINGS_KEY]: next });
      reevaluate();
      return next;
    } catch (err) {
      await logStatus('update_settings_error', { message: err && err.message });
      return null;
    }
  };

  /**
   * Aggregate block stats for the popup badge.
   * @returns {Promise<{totalBlocked: number, byProvider: Object, lastScan: number, limitations: Array}>}
   */
  window.__pawsOff_pixelBlock_getStats = function () {
    return getStats();
  };

  // ─────────────────────────────────────────────────────────────────────────
  //  Host detection
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Resolve the PROVIDER_CONFIG entry for the current hostname.
   * @returns {Object|null}
   */
  function detectProvider() {
    try {
      const host = location.hostname.toLowerCase();
      return (
        PROVIDER_CONFIG.find((p) =>
          p.hosts.some((h) => host === h || host.endsWith('.' + h)),
        ) || null
      );
    } catch (_) {
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  React to settings changes from the popup in real time
  // ─────────────────────────────────────────────────────────────────────────
  try {
    if (chrome && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        try {
          if (area !== 'local') return;
          // React to allow-list changes (per-site pause / per-tracker allow).
          if (changes[ALLOW_KEY]) {
            state.allowState = _coerceAllow(changes[ALLOW_KEY].newValue);
            if (!state.allowOriginHash) state.allowOriginHash = hashHost(location.hostname);
            if (state.started) reevaluate();
          }
          if (!changes[SETTINGS_KEY]) return;
          state.settings = normalizeSettings(changes[SETTINGS_KEY].newValue);
          // Only act once init has resolved a provider for this frame.
          if (state.started) reevaluate();
        } catch (_) {
          // Silent.
        }
      });
    }
  } catch (_) {
    // Silent, storage API unavailable.
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  SPA navigation reset (Navigation API, Chrome 102+), same pattern as
  //  consent-ghost.js. Re-scan + re-arm when the user switches views.
  // ─────────────────────────────────────────────────────────────────────────
  /**
   * Reset and re-arm on client-side navigation.
   */
  function resetForNavigation() {
    try {
      standDown();
      reevaluate(); // re-starts (scan existing + observe) if still enabled
    } catch (err) {
      try {
        logStatus('spa_reset_error', { message: err && err.message });
      } catch (_) {
        // Silent.
      }
    }
  }

  if (typeof navigation !== 'undefined') {
    try {
      // TODO(v2): navigate also fires on hash changes / replaceState query syncs;
      //   guard on event.navigationType / event.destination to avoid needless
      //   re-scans on chatty webmail SPAs.
      navigation.addEventListener('navigate', (e) => {
        if (e.navigationType === 'push' || e.navigationType === 'replace') {
          if (new URL(e.destination.url).pathname !== location.pathname) {
            resetForNavigation();
          }
        }
      });
    } catch (_) {
      // Silent, older Chromium; the observer still covers in-session email opens.
    }
  }

  // ── Auto-invoke ────────────────────────────────────────────────────────────
  window.__pawsOff_pixelBlock_init();

  // ── Test-only export (NO-OP in Chrome; see consent-ghost.js note) ───────────
  try {
    if (typeof module !== 'undefined' && module.exports) {
      module.exports.__test = {
        hostOf, matchesTrackerDomain, classifyUrl, extractEmbeddedUrl, parseSrcset, isExcluded,
        defaultSettings, normalizeSettings, knownLimitations, rememberOriginal,
        TRACKING_DOMAINS, TRANSPARENT_PNG, PROVIDER_CONFIG,
        TRACKER_PATH_STRONG, TRACKER_PATH_WEAK, TRACKER_QUERY_STRONG, TRACKER_QUERY_WEAK,
      };
    }
  } catch (_) { /* ignore */ }

}());
