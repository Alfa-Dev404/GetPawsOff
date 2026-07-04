// tos-shield.js, PawsOff
//
// Feature 3 of 4: ToS AI Shield, flags predatory clauses in Terms of Service /
// privacy pages and highlights them in place, fully locally.
//
// ─── DESIGN (Path B: generalised on-page analysis, NOT a ToS;DR lookup) ─────
// We do NOT match verbatim third-party quotes. We match MEANING STRUCTURE:
// each pattern is a set of co-occurring token families (anchors + objects)
// scored per clause, with negation handling. The taxonomy is informed by
// CLAUDETTE (unfair-clause types) and OPP-115 (data-practice categories), but
// no external dataset is bundled or called, that avoids ToS;DR's CC BY-SA /
// AGPL licensing entanglement and keeps us fully offline.
//
// ─── PIPELINE ───────────────────────────────────────────────────────────────
//   detect page → extract content root → build text index (offset map) →
//   segment sentences/clauses → token-set matcher (+ negation) → CSS Custom
//   Highlight API → Shadow-DOM summary panel.
//
// ─── HARD RULES (shared across PawsOff) ────────────────────────────────────
//  - IIFE, 'use strict', try/catch around every async fn
//  - window.__pawsOff_* namespace only
//  - po-ts- CSS prefix for any class we introduce
//  - silent failures only: diagnostics → chrome.storage.local, never the page
//  - never log PII (no matched sentence text is ever persisted, panel only)
//  - unique-key chrome.storage writes, no read-modify-write races
//  - never modify DOM we did not create (highlights use the Custom Highlight
//    API, which paints Ranges WITHOUT mutating nodes; the only nodes we add are
//    our own <style> and the Shadow-DOM panel host)
//
// ─── MANIFEST ───────────────────────────────────────────────────────────────
//  - content_scripts: run at document_idle on <all_urls> (ToS lives anywhere);
//    the page-detection gate ensures we only act on real policy pages.
//  - host_permissions MUST include the remote-config origin below, or the
//    cross-origin fetch is blocked. (Alternatively proxy the fetch through the
//    service worker.) The Custom Highlight API requires Chromium 105+.

(function () {
  'use strict';

  // ── Double-run guard ───────────────────────────────────────────────────────
  if (typeof window.__pawsOff_tosShield_init === 'function') return;

  // ── Versioning / remote config endpoints ──────────────────────────────────
  const ENGINE_VERSION = '1.0.0';

  // Remote config fetch + ECDSA-P256 signature verification is owned ENTIRELY by
  // the background service worker (see background.js pawsoff_tosShield_getConfig).
  // The content script never fetches or verifies, and never holds the pinned key
  // or config URLs, those live in exactly one place (background.js) so they can
  // never diverge. We just request the verified result via fetchRemoteConfig().

  // ── Storage keys ───────────────────────────────────────────────────────────
  const SETTINGS_KEY     = '__pawsOff_tosShield_settings';
  const CONFIG_CACHE_KEY = '__pawsOff_tosShield_config';
  const EVENT_PREFIX     = '__pawsOff_tosShield_event_'; // scan results → getStats()
  const LOG_PREFIX       = '__pawsOff_tosShield_log_';   // diagnostics
  const EVENT_MAX        = 500;
  const LOG_MAX          = 200;
  const PRUNE_SAMPLE     = 0.1;
  // Monotonic flagged-clauses counter, never pruned, so popup totals never plateau.
  const TS_TOTAL_KEY     = '__pawsOff_ts_total_flagged';

  // ── Scan limits (keep it lightweight on huge pages) ───────────────────────
  const MAX_TEXT_CHARS = 500_000; // ignore absurdly large documents
  const MAX_SENTENCES  = 4_000;
  const MAX_FINDINGS   = 300;
  const MIN_ROOT_CHARS = 400;     // a real policy page is long
  const READINESS_MS   = 8_000;   // how long to wait for JS-rendered policies
  // Max re-scan rate while the readiness watcher is active. A subtree
  // MutationObserver can fire dozens of times/sec on animation-heavy, lazy-
  // loading or SPA pages; running the full scan pipeline on every batch froze
  // the tab. We coalesce bursts and re-scan at most once per this interval.
  const READINESS_DEBOUNCE_MS = 400;

  const HIGHLIGHT_SEVERITIES = ['high', 'med', 'low'];

  // Block-level tags. buildTextIndex inserts a newline between text nodes that
  // live in different block ancestors, so a heading, list item or numbered
  // sub-clause can never be glued onto its neighbour (the root cause of the
  // cross-clause false positives + wrong snippets). Inline runs (<a>, <strong>,
  // <em>, …) share their block ancestor, so genuine sentences stay intact.
  const BLOCK_TAGS = new Set([
    'P', 'DIV', 'LI', 'UL', 'OL', 'DL', 'DT', 'DD', 'TABLE', 'TR', 'TD', 'TH',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER',
    'MAIN', 'ASIDE', 'NAV', 'BLOCKQUOTE', 'PRE', 'FIGURE', 'FIGCAPTION', 'FORM', 'HR', 'BR',
  ]);

  // ── Bundled default config (offline / first-run authority) ────────────────
  // Patterns are TOKEN SETS, never regex, the engine compiles them, so a
  // poisoned remote config cannot inject executable logic or a ReDoS bomb.
  //   anchors  : the action verbs/nouns that signal the category
  //   objects  : what the action applies to (must co-occur in the same clause)
  //   modifiers: aggravating qualifiers (boost score, never required)
  const DEFAULT_CONFIG = {
    schemaVersion: 1,
    configVersion: '2026.06.26',
    minEngineVersion: '1.0.0',
    locale: 'en',

    pageDetection: {
      urlTokens: ['terms', 'tos', 'eula', 'privacy', 'legal', 'conditions', 'user-agreement', 'cookie-policy', 'data-policy'],
      titleTokens: ['terms of service', 'terms of use', 'terms and conditions', 'privacy policy', 'user agreement', 'cookie policy', 'data policy'],
      legaleseMarkers: ['shall', 'herein', 'hereto', 'you agree', 'we may', 'reserve the right', 'governing law', 'last updated', 'effective date', 'these terms'],
      minWordCount: 400,
      confidenceThreshold: 0.6,
    },

    segmentation: {
      abbreviations: ['inc.', 'ltd.', 'co.', 'corp.', 'e.g.', 'i.e.', 'u.s.', 'u.k.', 'no.', 'art.', 'sec.', 'vs.', 'etc.'],
      clauseDelimiters: [';', ',', 'except', 'unless', 'provided that', 'notwithstanding'],
    },

    negation: {
      cues: ['not', 'never', 'no', 'without', 'except', 'unless', 'nor', 'neither', 'cannot', "won't", "don't", "doesn't", 'do not', 'does not', 'will not', 'prohibited from', 'refrain from'],
      scope: 'clause',
      penalty: 0.3, // multiplier applied to score when negated in the matched clause
    },

    scoring: {
      presentThreshold: 0.5,
      modifierBoost: 1.5,
      aggravatedModifiers: [
        'perpetual', 'irrevocable', 'worldwide', 'at our sole discretion',
        'for any reason', 'at any time', 'indefinitely',
        // "without …" intensifier family (Bug 4 fix). In legal prose "without X"
        // where X is a NOUN almost always INTENSIFIES a predatory action
        // ("share your data without your consent", "retain data without
        // limitation", "license your content without compensation") rather than
        // negating it. Listing them here does two things: (1) they boost the
        // finding to "aggravated" severity, and (2) they are stripped from a
        // clause BEFORE the negation test (see compileConfig/matchSentence), so
        // the bare cue word "without" can no longer flip an otherwise-predatory
        // clause into a false negative. The bare "without" cue is intentionally
        // KEPT for genuine protective phrasing where X is a VERB ("without
        // selling/sharing/disclosing it"), which should still down-weight.
        'without notice', 'without further notice', 'without limitation',
        'without restriction', 'without compensation', 'without your consent',
        'without consent', 'without your knowledge', 'without your permission',
        'without warranty', 'without liability',
      ],
    },

    categories: [
      { id: 'data_sale',                label: 'Sells or rents your data',                  description: 'The service may sell, rent or trade your personal data.',         severity: 'high', defaultEnabled: true },
      { id: 'third_party_sharing',      label: 'Shares data with third parties',            description: 'Your data may be disclosed to partners or third parties.',         severity: 'med',  defaultEnabled: true },
      { id: 'tracking_surveillance',    label: 'Tracks you across sites or devices',        description: 'The service may track activity beyond this site.',                 severity: 'high', defaultEnabled: true },
      { id: 'data_retention',           label: 'Keeps your data indefinitely',              description: 'Personal data may be retained without a clear limit.',            severity: 'med',  defaultEnabled: true },
      { id: 'content_license',          label: 'Claims a licence to your content',          description: 'You may grant a broad licence over content you submit.',          severity: 'high', defaultEnabled: true },
      { id: 'unilateral_change',        label: 'Can change the terms at any time',          description: 'Terms may be changed unilaterally, possibly without notice.',      severity: 'high', defaultEnabled: true },
      { id: 'unilateral_termination',   label: 'Can suspend or delete your account anytime', description: 'Your account or access may be terminated at their discretion.',    severity: 'med',  defaultEnabled: true },
      { id: 'arbitration_classwaiver',  label: 'Forces arbitration / waives class action',  description: 'You may waive court and class-action rights.',                     severity: 'high', defaultEnabled: true },
      { id: 'liability_waiver',         label: 'Disclaims liability',                       description: 'The service disclaims warranties or liability for damages.',       severity: 'low',  defaultEnabled: true },
      { id: 'jurisdiction_choiceoflaw', label: 'Disputes governed by their chosen courts',  description: 'Disputes are bound to a jurisdiction/governing law they pick.',    severity: 'low',  defaultEnabled: true },
      { id: 'consent_by_use',           label: 'You agree just by using the site',          description: 'Continued use is treated as acceptance of the terms.',            severity: 'med',  defaultEnabled: true },
      { id: 'marketing_sharing',        label: 'Uses your data for ads or marketing',       description: 'Your data may be used for advertising or marketing.',             severity: 'low',  defaultEnabled: true },
    ],

    patterns: [
      { id: 'data_sale.core', categoryId: 'data_sale', enabled: true, weight: 1,
        anchors: ['sell', 'sells', 'selling', 'sold', 'sale', 'rent', 'rents', 'lease', 'monetize', 'monetise', 'trade', 'in exchange for'],
        objects: ['personal information', 'personal data', 'your data', 'your information', 'information about you', 'user data'],
        modifiers: ['third parties', 'advertisers', 'for a fee'] },

      { id: 'third_party_sharing.core', categoryId: 'third_party_sharing', enabled: true, weight: 1,
        anchors: ['share', 'shares', 'sharing', 'shared', 'disclose', 'discloses', 'disclosed', 'transfer', 'transfers', 'provide', 'communicate', 'communicates', 'communicated'],
        objects: ['third party', 'third parties', 'partners', 'affiliates', 'advertisers', 'service providers', 'other companies'],
        modifiers: ['for any purpose', 'without your consent'] },

      { id: 'tracking_surveillance.core', categoryId: 'tracking_surveillance', enabled: true, weight: 1,
        anchors: ['track', 'tracks', 'tracking', 'monitor', 'monitors', 'collect', 'collects', 'profile', 'fingerprint'],
        objects: ['across websites', 'across other sites', 'across devices', 'your activity', 'browsing history', 'your location', 'your behaviour', 'your behavior', 'cookies', 'unique identifiers', 'precise location'],
        modifiers: ['continuously', 'in real time'] },

      { id: 'data_retention.core', categoryId: 'data_retention', enabled: true, weight: 1,
        anchors: ['retain', 'retains', 'retained', 'retention', 'keep', 'keeps', 'store', 'stores', 'maintain'],
        objects: ['indefinitely', 'as long as necessary', 'for as long as', 'until you delete', 'for a period', 'after termination', 'after you delete'],
        modifiers: ['indefinitely', 'permanently'] },

      { id: 'content_license.core', categoryId: 'content_license', enabled: true, weight: 1,
        anchors: ['grant', 'grants', 'granting', 'license', 'licence', 'royalty-free', 'sublicensable', 'assign'],
        objects: ['content', 'your content', 'user content', 'materials', 'submissions', 'user-generated content', 'any content you'],
        modifiers: ['perpetual', 'irrevocable', 'worldwide', 'royalty-free', 'transferable'] },

      { id: 'unilateral_change.core', categoryId: 'unilateral_change', enabled: true, weight: 1,
        anchors: ['change', 'changes', 'modify', 'modifies', 'update', 'updates', 'amend', 'amends', 'revise', 'alter'],
        objects: ['these terms', 'this agreement', 'this policy', 'the terms', 'terms of service', 'privacy policy', 'at any time'],
        modifiers: ['without notice', 'at our sole discretion', 'at any time', 'without prior notice'] },

      { id: 'unilateral_termination.core', categoryId: 'unilateral_termination', enabled: true, weight: 1,
        anchors: ['terminate', 'terminates', 'suspend', 'suspends', 'disable', 'restrict', 'delete', 'cancel'],
        objects: ['your account', 'your access', 'the service', 'your profile'],
        modifiers: ['without notice', 'for any reason', 'at our sole discretion', 'at any time'] },

      { id: 'arbitration_classwaiver.core', categoryId: 'arbitration_classwaiver', enabled: true, weight: 1,
        anchors: ['arbitration', 'arbitrate', 'binding arbitration', 'waive', 'waiver', 'class action', 'class-action', 'jury trial'],
        objects: ['dispute', 'disputes', 'claims', 'any claim', 'right to', 'your right'],
        modifiers: ['binding', 'mandatory', 'waive any right'] },

      { id: 'liability_waiver.core', categoryId: 'liability_waiver', enabled: true, weight: 1, ignoreNegation: true,
        anchors: ['disclaim', 'disclaims', 'as is', 'as available', 'no warranty', 'not liable', 'not responsible', 'limitation of liability', 'held liable', 'be liable', 'shall not be liable', 'held responsible'],
        objects: ['damages', 'liability', 'warranties', 'any loss', 'indirect', 'consequential', 'in the event', 'arising', 'resulting from'],
        modifiers: ['to the fullest extent', 'in no event'] },

      { id: 'jurisdiction_choiceoflaw.core', categoryId: 'jurisdiction_choiceoflaw', enabled: true, weight: 1,
        anchors: ['governed by', 'governing law', 'jurisdiction', 'venue', 'courts of', 'exclusive jurisdiction'],
        objects: ['laws of', 'courts', 'state of', 'country', 'these terms', 'this agreement'],
        modifiers: ['exclusive', 'sole'] },

      { id: 'consent_by_use.core', categoryId: 'consent_by_use', enabled: true, weight: 1,
        anchors: ['by using', 'by accessing', 'by continuing', 'continued use', 'your use of'],
        objects: ['you agree', 'you accept', 'you consent', 'constitutes acceptance', 'these terms', 'this agreement'],
        modifiers: [] },

      { id: 'marketing_sharing.core', categoryId: 'marketing_sharing', enabled: true, weight: 1,
        anchors: ['marketing', 'advertising', 'promotional', 'targeted', 'personalized ads', 'personalised ads'],
        objects: ['your data', 'your information', 'your email', 'communications', 'your interests', 'send you', 'personal data', 'personal information'],
        modifiers: ['third parties'] },
    ],
  };

  // ── Runtime state (closure-private) ───────────────────────────────────────
  const state = {
    config: null,
    compiled: null,       // compiled patterns (with regex) - never persisted
    categoryById: null,   // id → category meta
    regex: null,          // shared compiled regexes (negation, aggravated, clause)
    settings: null,
    findings: [],         // current page findings (in-memory only; holds text)
    ranges: null,         // severity → Range[] for the Highlight API
    panelHost: null,      // Shadow-DOM panel host element (ours)
    shadowRoot: null,     // CLOSED shadow root ref (ours) - never exposed on the host
    styleEl: null,        // injected ::highlight() <style> (ours)
    scanned: false,
    scanning: false,
    started: false,
    readinessObserver: null,
    readinessTimer: null,
    readinessDeadline: 0,
  };

  // ─────────────────────────────────────────────────────────────────────────
  //  Small utilities
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Short random suffix for unique storage keys.
   * @returns {string}
   */
  function rand() {
    return Math.random().toString(36).slice(2, 8);
  }

  /**
   * Compare two dotted numeric version strings (e.g. "2026.06.07", "1.0.0").
   * @param {string} a
   * @param {string} b
   * @returns {number} -1 | 0 | 1
   */
  function compareVersions(a, b) {
    const pa = String(a || '').split(/[^0-9]+/).filter(Boolean).map(Number);
    const pb = String(b || '').split(/[^0-9]+/).filter(Boolean).map(Number);
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
      const x = pa[i] || 0;
      const y = pb[i] || 0;
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  }

  /**
   * Decode a base64 string into a Uint8Array. (Kept as a small shared utility;
   * the signature verification that once used it now lives in the background.)
   * @param {string} b64
   * @returns {Uint8Array}
   */
  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /**
   * Build a case-insensitive alternation regex from literal tokens. Tokens are
   * escaped (no remote regex injection) and internal whitespace is made elastic
   * so phrases match across normalised spacing. Boundary lookarounds avoid
   * matching inside larger words (e.g. "sell" not matching "reseller").
   * @param {string[]} tokens
   * @returns {RegExp|null}
   */
  function buildAltRegex(tokens) {
    if (!Array.isArray(tokens) || tokens.length === 0) return null;
    const parts = tokens
      .filter((t) => typeof t === 'string' && t.length)
      .map((t) =>
        t.toLowerCase()
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          .replace(/\s+/g, '\\s+'),
      );
    if (!parts.length) return null;
    try {
      return new RegExp('(?:^|[^a-z0-9])(?:' + parts.join('|') + ')(?:[^a-z0-9]|$)', 'i');
    } catch (_) {
      return null;
    }
  }

  /**
   * Like buildAltRegex but GLOBAL and bare (no boundary groups), for use with
   * String.replace() to delete every occurrence of any phrase from a string.
   * Used to strip aggravator phrases before negation testing (see Option A in
   * compileConfig). Returns null if there are no usable phrases.
   * @param {string[]} tokens
   * @returns {RegExp|null}
   */
  function buildStripRegex(tokens) {
    if (!Array.isArray(tokens) || tokens.length === 0) return null;
    const parts = tokens
      .filter((t) => typeof t === 'string' && t.length)
      .map((t) =>
        t.toLowerCase()
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          .replace(/\s+/g, '\\s+'),
      );
    if (!parts.length) return null;
    try {
      return new RegExp('(?:' + parts.join('|') + ')', 'gi');
    } catch (_) {
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Remote config: fetch + SubtleCrypto verify + validate (fail-closed)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Structural validation of a config object before we trust it.
   * @param {*} cfg
   * @returns {boolean}
   */
  /** The page's engine is too old for this config's minimum. */
  function engineTooOld(cfg) {
    return cfg.minEngineVersion && compareVersions(ENGINE_VERSION, cfg.minEngineVersion) < 0;
  }
  /** Config must carry both the categories and patterns arrays. */
  function hasRequiredArrays(cfg) {
    return Array.isArray(cfg.categories) && Array.isArray(cfg.patterns);
  }
  /** Config must carry all four behavioural sections. */
  function hasRequiredSections(cfg) {
    return !!(cfg.pageDetection && cfg.segmentation && cfg.negation && cfg.scoring);
  }
  function validateConfig(cfg) {
    try {
      if (!cfg || typeof cfg !== 'object') return false;
      if (cfg.schemaVersion !== DEFAULT_CONFIG.schemaVersion) return false;
      if (typeof cfg.configVersion !== 'string') return false;
      if (engineTooOld(cfg)) return false;
      if (!hasRequiredArrays(cfg)) return false;
      if (!hasRequiredSections(cfg)) return false;
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Ask the background service worker for the signed + verified config. The
   * background is the ONLY component that fetches and SubtleCrypto-verifies it:
   * a content-script fetch is subject to the host page's CORS in MV3 and the
   * pinned key must live in exactly one place. On any failure (no SW, not yet
   * fetched, invalid signature, malformed) we return null and the caller keeps
   * the cached/bundled config. ConsentGhost uses the identical pattern.
   * @returns {Promise<Object|null>}
   */
  /** True when we can message the background service worker. */
  function canMessageBackground() {
    return !!(chrome.runtime && chrome.runtime.sendMessage);
  }
  /** background returns { ok, config } only when the signed config verified. */
  function isConfigResponseOk(resp) {
    return !!resp && !!resp.ok && !!resp.config;
  }
  async function fetchRemoteConfig() {
    try {
      if (!canMessageBackground()) return null;
      const resp = await chrome.runtime.sendMessage({ type: 'pawsoff_tosShield_getConfig' });
      if (!isConfigResponseOk(resp)) return null;
      const cfg = resp.config;
      return validateConfig(cfg) ? cfg : null;
    } catch (_) {
      return null; // background unavailable / blocked → caller falls back
    }
  }

  /**
   * Resolve the active config: cached (if valid) or bundled default, then try a
   * verified remote refresh and adopt it only if strictly newer.
   * @returns {Promise<Object>}
   */
  async function loadConfig() {
    let cached = null;
    try {
      const s = await chrome.storage.local.get(CONFIG_CACHE_KEY);
      if (s && validateConfig(s[CONFIG_CACHE_KEY])) cached = s[CONFIG_CACHE_KEY];
    } catch (_) { /* ignore */ }

    let active = cached || DEFAULT_CONFIG;

    const remote = await fetchRemoteConfig();
    if (remote && compareVersions(remote.configVersion, active.configVersion) > 0) {
      active = remote;
      try { await chrome.storage.local.set({ [CONFIG_CACHE_KEY]: remote }); } catch (_) { /* ignore */ }
    }
    return active;
  }

  /**
   * Compile a config into runtime matchers. Compiled regexes are never written
   * to storage (config stays pure data on disk).
   * @param {Object} cfg
   */
  function compileConfig(cfg) {
    state.config = cfg;
    state.categoryById = {};
    for (const c of cfg.categories) state.categoryById[c.id] = c;

    state.compiled = [];
    for (const p of cfg.patterns) {
      if (p.enabled === false) continue;
      const anchorRe = buildAltRegex(p.anchors);
      const objectRe = buildAltRegex(p.objects);
      if (!anchorRe || !objectRe) continue; // a pattern needs both halves
      state.compiled.push({
        id: p.id,
        categoryId: p.categoryId,
        weight: typeof p.weight === 'number' ? p.weight : 1,
        anchorRe,
        objectRe,
        modifierRe: buildAltRegex(p.modifiers),
        // Some categories are NEGATIVE-FORM by nature: a liability waiver IS the
        // sentence "we are NOT liable / in NO event / in NO way held liable".
        // For those, the embedded "no/not" is the adverse signal itself, so the
        // negation down-weight must not apply or the clause silently vanishes.
        ignoreNegation: p.ignoreNegation === true,
      });
    }

    state.regex = {
      negation: buildAltRegex(cfg.negation.cues),
      aggravated: buildAltRegex(cfg.scoring.aggravatedModifiers),
      // Global-flag stripper for the SAME aggravator phrases. Used to remove
      // phrases like "without notice" / "without your consent" from a clause
      // BEFORE the negation test runs, so the bare cue "without" inside an
      // aggravator can't be misread as negating the clause (the "without notice"
      // false-negative). Aggravators are intensifiers, never negations.
      aggravatedStrip: buildStripRegex(cfg.scoring.aggravatedModifiers),
      clause: buildClauseSplitter(cfg.segmentation.clauseDelimiters),
    };
    state.abbrev = new Set((cfg.segmentation.abbreviations || []).map((a) => a.toLowerCase()));
  }

  /**
   * Build a regex used to split a sentence into clauses.
   * @param {string[]} delimiters
   * @returns {RegExp}
   */
  function buildClauseSplitter(delimiters) {
    const parts = [];
    for (const d of delimiters || []) {
      if (/^[^a-z0-9]+$/i.test(d)) parts.push(d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      else parts.push('\\b' + d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+') + '\\b');
    }
    try {
      return new RegExp(parts.length ? parts.join('|') : '[;,]', 'i');
    } catch (_) {
      return /[;,]/;
    }
  }

  // ───────���─────────────────────────────────────────────────────────────────
  //  Settings
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Default settings: enabled, every category on. Derived from config so they
   * cannot drift.
   * @param {Object} cfg
   * @returns {{enabled: boolean, categories: Object<string, boolean>}}
   */
  function defaultSettings(cfg) {
    const categories = {};
    for (const c of cfg.categories) categories[c.id] = c.defaultEnabled !== false;
    return { enabled: true, categories };
  }

  /**
   * Normalise a stored settings object against the active config.
   * @param {*} raw
   * @param {Object} cfg
   * @returns {{enabled: boolean, categories: Object<string, boolean>}}
   */
  function normalizeSettings(raw, cfg) {
    const base = defaultSettings(cfg);
    if (!raw || typeof raw !== 'object') return base;
    const out = { enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true, categories: { ...base.categories } };
    if (raw.categories && typeof raw.categories === 'object') {
      for (const id of Object.keys(out.categories)) {
        if (typeof raw.categories[id] === 'boolean') out.categories[id] = raw.categories[id];
      }
    }
    return out;
  }

  /**
   * Load settings, persisting first-run defaults. Fail-open (enabled) for a
   * protection feature.
   * @param {Object} cfg
   * @returns {Promise<Object>}
   */
  async function loadSettings(cfg) {
    try {
      const stored = await chrome.storage.local.get(SETTINGS_KEY);
      const existing = stored && stored[SETTINGS_KEY];
      if (!existing) {
        const defaults = defaultSettings(cfg);
        await chrome.storage.local.set({ [SETTINGS_KEY]: defaults });
        return defaults;
      }
      return normalizeSettings(existing, cfg);
    } catch (_) {
      // Stand down on read/persist failure: run with the feature OFF rather than
      // scan a page whose user settings we couldn't load (principle #3).
      return Object.assign(defaultSettings(cfg), { enabled: false });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Storage writes (unique-key, race-free) + stats
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Write a record under a unique key (no shared mutable array → no lost-update
   * across frames/tabs).
   * @param {string} prefix
   * @param {Object} record
   * @param {string} prunePrefix
   * @param {number} max
   * @returns {Promise<void>}
   */
  /**
   * One-way, synchronous digest of a hostname for LOCAL log de-identification.
   * Logs never leave the device, but we also don't want stored diagnostics to
   * read as a plaintext browsing history, so the visited host is reduced to an
   * FNV-1a/32 token. This is a privacy de-identifier, NOT a security primitive.
   * Returns 'h:' + 8 hex chars, or null for empty input.
   * @param {string} host
   * @returns {string|null}
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

  async function writeRecord(prefix, record, prunePrefix, max) {
    try {
      const key = prefix + Date.now() + '_' + rand();
      await chrome.storage.local.set({ [key]: record });
      if (Math.random() < PRUNE_SAMPLE) await pruneByPrefix(prunePrefix, max);
    } catch (_) { /* silent */ }
  }

  /**
   * Record a completed scan. Stores ONLY non-PII aggregates: domain, per-category
   * counts/levels. The matched sentence text is NEVER persisted.
   * @param {string[]} categoryIds
   * @param {Object} byCategory
   * @returns {Promise<void>}
   */
  function logScanEvent(categoryIds, byCategory) {
    return writeRecord(
      EVENT_PREFIX,
      { ts: Date.now(), domain: hashHost(location.hostname), categories: categoryIds, byCategory, total: state.findings.length },
      EVENT_PREFIX,
      EVENT_MAX,
    );
  }

  /**
   * Record a diagnostic/status note (separate prefix so getStats ignores it).
   * @param {string} status
   * @param {Object} [extra]
   * @returns {Promise<void>}
   */
  function logStatus(status, extra) {
    return writeRecord(LOG_PREFIX, { ts: Date.now(), status, domain: hashHost(location.hostname), ...(extra || {}) }, LOG_PREFIX, LOG_MAX);
  }

  /**
   * Trim oldest entries of a prefix to `max` (remove() of distinct keys is
   * concurrency-safe).
   * @param {string} prefix
   * @param {number} max
   * @returns {Promise<void>}
   */
  async function pruneByPrefix(prefix, max) {
    try {
      const all = await chrome.storage.local.get(null);
      const keys = Object.keys(all).filter((k) => k.startsWith(prefix));
      if (keys.length <= max) return;
      keys.sort((a, b) => ((all[a] && all[a].ts) || 0) - ((all[b] && all[b].ts) || 0));
      await chrome.storage.local.remove(keys.slice(0, keys.length - max));
    } catch (_) { /* silent */ }
  }

  /**
   * Increment a monotonic aggregate counter (read-modify-write, best-effort).
   * scanNow() runs at most once per page view, so races are negligible.
   * @param {string} key
   * @param {number} [by]
   */
  async function incrementTotal(key, by) {
    try {
      const s = await chrome.storage.local.get(key);
      const cur = (s && typeof s[key] === 'number') ? s[key] : 0;
      await chrome.storage.local.set({ [key]: cur + (by || 1) });
    } catch (_) { /* silent */ }
  }

  /**
   * Aggregate scan stats for the popup.
   * @returns {Promise<{totalFlagged: number, byCategory: Object, lastScan: number}>}
   */
  async function getStats() {
    const result = { totalFlagged: 0, byCategory: {}, lastScan: 0 };
    try {
      const all = await chrome.storage.local.get(null);
      for (const k of Object.keys(all)) {
        if (!k.startsWith(EVENT_PREFIX)) continue;
        const e = all[k];
        if (!e) continue;
        result.totalFlagged += e.total || 0;
        if (e.byCategory) {
          for (const id of Object.keys(e.byCategory)) {
            result.byCategory[id] = (result.byCategory[id] || 0) + e.byCategory[id];
          }
        }
        if (e.ts && e.ts > result.lastScan) result.lastScan = e.ts;
      }
      // Per-event records get pruned; prefer the monotonic counter when higher.
      const mono = all[TS_TOTAL_KEY];
      if (typeof mono === 'number' && mono > result.totalFlagged) result.totalFlagged = mono;
    } catch (_) { /* silent */ }
    return result;
  }

  // ──────────────────────────────────────�����──────────────────────────────────
  //  Content extraction + text index
  // ─────────────────────────────────────────────────────────────────���───────

  // Ancestors whose text is page chrome / non-prose and must never be analysed.
  const EXCLUDE_SELECTOR =
    'script,style,noscript,template,textarea,nav,header,footer,aside,' +
    '[contenteditable="true"],.po-ts-root';

  /**
   * Pick the main content root. Prefer semantic landmarks; fall back to body.
   * (Lightweight by design, TODO(v2): readability-style largest-block scoring.)
   * @returns {Element|null}
   */
  /** A landmark element is a usable root only if it holds enough prose. */
  function isSubstantialRoot(el) {
    return !!el && (el.textContent || '').length >= MIN_ROOT_CHARS;
  }
  function findContentRoot() {
    try {
      const landmarks = ['main', 'article', '[role="main"]'];
      for (const sel of landmarks) {
        const el = document.querySelector(sel);
        if (isSubstantialRoot(el)) return el;
      }
      return document.body || document.documentElement;
    } catch (_) {
      return document.body || null;
    }
  }

  /**
   * Build a flat text string of the root's visible prose plus an offset map back
   * to the live text nodes (so any char span can become a DOM Range). Excludes
   * chrome and our own nodes.
   * @param {Element} root
   * @returns {{text: string, entries: Array<{node: Text, start: number, len: number}>}}
   */
  /** A text node is indexable only if it has non-whitespace content and is not
   *  inside an excluded (chrome / our own) subtree. */
  function isIndexableText(node) {
    const v = node.nodeValue;
    if (!v || !v.trim()) return false;
    const parent = node.parentElement;
    if (!parent || (parent.closest && parent.closest(EXCLUDE_SELECTOR))) return false;
    return true;
  }
  /** Nearest block-level ancestor element of a text node (for boundary detection). */
  function blockAncestorOf(node) {
    let el = node.parentElement;
    while (el) {
      if (BLOCK_TAGS.has(el.tagName)) return el;
      el = el.parentElement;
    }
    return node.parentElement;
  }
  function buildTextIndex(root) {
    const entries = [];
    let text = '';
    let prevBlock = null;
    try {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          return isIndexableText(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
      });
      let n;
      while ((n = walker.nextNode())) {
        const v = n.nodeValue;
        // Insert a hard boundary when we cross into a different block element so
        // segmentSentences() can never merge a heading / list item / numbered
        // sub-clause into an adjacent sentence. The separator is NOT owned by any
        // entry, so flat-string offsets for real text nodes stay exact.
        const block = blockAncestorOf(n);
        if (prevBlock && block !== prevBlock && text.length && text[text.length - 1] !== '\n') {
          text += '\n';
        }
        prevBlock = block;
        entries.push({ node: n, start: text.length, len: v.length });
        text += v;
        if (text.length >= MAX_TEXT_CHARS) break; // hard cap on huge pages
      }
    } catch (_) { /* silent */ }
    return { text, entries };
  }

  /**
   * Map a flat-string char index to a live DOM position via binary search.
   * @param {Array} entries
   * @param {number} idx
   * @param {boolean} isEnd treat idx as an exclusive end boundary
   * @returns {{node: Text, offset: number}|null}
   */
  function mapCharToDom(entries, idx, isEnd) {
    if (!entries.length) return null;
    let lo = 0;
    let hi = entries.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const e = entries[mid];
      const within = isEnd ? (idx > e.start && idx <= e.start + e.len) : (idx >= e.start && idx < e.start + e.len);
      if (within) return { node: e.node, offset: idx - e.start };
      if (idx < e.start) hi = mid - 1;
      else lo = mid + 1;
    }
    const last = entries[entries.length - 1];
    return { node: last.node, offset: last.len }; // clamp to end
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Segmentation + matching
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Split flat text into sentence spans (offsets into the flat string), guarding
   * common abbreviations so "Inc." etc. don't break a sentence.
   * @param {string} text
   * @returns {Array<{start: number, end: number, raw: string}>}
   */
  function segmentSentences(text) {
    const out = [];
    try {
      // Split on sentence punctuation OR a hard block boundary (the newline that
      // buildTextIndex inserts between block elements). The newline arm has no
      // preceding-punctuation requirement, so an un-punctuated heading or list
      // item ("…privacy@politico.eu" \n "WHAT HAPPENS…") is still cut cleanly.
      const boundary = /(?:[.!?]["')\]]?\s+|\s*\n\s*)/g;
      let last = 0;
      let m;
      while ((m = boundary.exec(text)) && out.length < MAX_SENTENCES) {
        const end = m.index + m[0].length;
        const beforePunct = text.slice(last, m.index + 1);
        const lastWord = ((beforePunct.match(/(\S+)$/) || [''])[0] || '').toLowerCase();
        if (state.abbrev && state.abbrev.has(lastWord)) continue; // not a real boundary
        out.push({ start: last, end, raw: text.slice(last, end) });
        last = end;
      }
      if (last < text.length && out.length < MAX_SENTENCES) {
        out.push({ start: last, end: text.length, raw: text.slice(last) });
      }
    } catch (_) { /* silent */ }
    return out;
  }

  /**
   * Normalise a sentence for matching (lowercase + collapse whitespace). Used
   * for boolean detection only, highlight ranges use raw flat-string offsets.
   * @param {string} raw
   * @returns {string}
   */
  function normalizeForMatch(raw) {
    return raw.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  /**
   * Heuristic: is this segment a heading or a section question rather than an
   * obligation-bearing clause? Such segments routinely contain category anchors
   * ("…CHANGE…POLICY?") but impose nothing, so matching them yields noise.
   * Conservative by design: only fires on clear headings/questions to avoid
   * dropping real clauses (a genuine predatory clause virtually never ends in
   * "?" nor is set entirely in capitals).
   * @param {string} raw
   * @returns {boolean}
   */
  function isLikelyHeadingOrQuestion(raw) {
    const t = (raw || '').trim();
    if (!t) return true;
    if (t.endsWith('?')) return true; // question heading
    const letters = t.replace(/[^A-Za-z]/g, '');
    // Short, all-uppercase line → section heading ("DATA CONTROLLER", "SECURITY").
    if (letters.length >= 2 && t.length <= 120 && letters === letters.toUpperCase()) return true;
    return false;
  }

  /**
   * Evaluate one normalised sentence against all compiled patterns.
   * @param {string} norm
   * @returns {Array<{categoryId: string, level: string, score: number}>}
   */
  function matchSentence(norm) {
    const hits = [];
    if (!norm) return hits;
    const cfg = state.config;
    const clauses = norm.split(state.regex.clause);

    for (const p of state.compiled) {
      // Respect per-category toggle.
      if (state.settings.categories[p.categoryId] === false) continue;

      let matched = false;
      let negated = true; // assume negated until a clean (non-negated) clause matches
      let matchedClause = '';
      let matchedIndex = -1;
      for (let ci = 0; ci < clauses.length; ci++) {
        const clause = clauses[ci];
        if (p.anchorRe.test(clause) && p.objectRe.test(clause)) {
          matched = true;
          if (matchedIndex === -1) { matchedClause = clause; matchedIndex = ci; }
          // Strip aggravator phrases (e.g. "without notice", "without your
          // consent") BEFORE the negation test so their embedded cue word
          // ("without") cannot falsely negate an otherwise-predatory clause.
          const clauseForNegation = state.regex.aggravatedStrip
            ? clause.replace(state.regex.aggravatedStrip, ' ')
            : clause;
          const clauseNegated = (!p.ignoreNegation && state.regex.negation) ? state.regex.negation.test(clauseForNegation) : false;
          if (!clauseNegated) { negated = false; matchedClause = clause; matchedIndex = ci; break; } // strongest evidence wins
        }
      }
      if (!matched) continue;

      // Severity + modifier boost are bound to the MATCHED CLAUSE, not the whole
      // sentence, so an aggravator ("without your consent", "at any time") that
      // belongs to a DIFFERENT clause can no longer escalate this finding to
      // "severe". That cross-clause bleed was the cause of the bogus "(severe)".
      const hasModifier = p.modifierRe ? p.modifierRe.test(matchedClause) : false;
      const clauseAggravated = state.regex.aggravated ? state.regex.aggravated.test(matchedClause) : false;
      let score = p.weight * (hasModifier ? cfg.scoring.modifierBoost : 1);
      // Negation is a confidence REDUCER, not a hard veto, a missed double
      // negative should down-weight, never silently clear a real clause.
      if (negated) score *= cfg.negation.penalty;

      if (score >= cfg.scoring.presentThreshold) {
        hits.push({
          categoryId: p.categoryId,
          level: clauseAggravated ? 'aggravated' : 'present',
          score,
          clauseIndex: matchedIndex, // lets the caller show the matched clause, not the whole sentence
        });
      }
    }
    return hits;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Page detection gate
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Cheap pre-gate: does the URL or the title/first-heading contain a policy
   * token? These are the only two signals worth ~0.5 / ~0.3; without at least
   * one of them pageConfidence can never reach the 0.6 threshold, so scanNow()
   * uses this to skip the expensive text-index build on ordinary pages.
   * @returns {boolean}
   */
  function hasUrlOrTitleSignal() {
    try {
      const pd = state.config.pageDetection;
      const url = location.href.toLowerCase();
      if (pd.urlTokens.some((t) => url.includes(t))) return true;
      const title = (document.title || '').toLowerCase();
      const heading = ((document.querySelector('h1, h2') || {}).textContent || '').toLowerCase();
      return pd.titleTokens.some((t) => title.includes(t) || heading.includes(t));
    } catch (_) {
      return false;
    }
  }

  /**
   * Confidence (0..~1.2) that this is a ToS/privacy page.
   * @param {string} flatText
   * @returns {number}
   */
  function pageConfidence(flatText) {
    try {
      const pd = state.config.pageDetection;
      const url = location.href.toLowerCase();
      const title = (document.title || '').toLowerCase();
      const heading = ((document.querySelector('h1, h2') || {}).textContent || '').toLowerCase();

      let score = 0;
      if (pd.urlTokens.some((t) => url.includes(t))) score += 0.5;
      if (pd.titleTokens.some((t) => title.includes(t) || heading.includes(t))) score += 0.3;

      const words = flatText ? flatText.split(/\s+/).filter(Boolean).length : 0;
      if (words >= pd.minWordCount) {
        const lower = flatText.toLowerCase();
        let markers = 0;
        for (const mk of pd.legaleseMarkers) if (lower.includes(mk)) markers += 1;
        score += markers >= 3 ? 0.4 : markers >= 1 ? 0.2 : 0;
      } else {
        score -= 0.3; // too short to be a real policy
      }
      return score;
    } catch (_) {
      return 0;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Highlighting (CSS Custom Highlight API, zero DOM mutation)
  // ──────────────────────────��──────────────────────────────────────────────

  /**
   * Inject (or refresh) our ::highlight() style rules. The <style> element is
   * ours, we never touch page-authored nodes.
   */
  function injectHighlightStyles() {
    try {
      if (state.styleEl && state.styleEl.isConnected) return;
      const style = document.createElement('style');
      style.id = 'po-ts-highlight-style';
      // Brand severity tints (translucent, so the site's own text stays readable
      // on light OR dark pages): orange (high), amber (med), teal (low).
      style.textContent =
        '::highlight(po-ts-high){background-color:rgba(232,92,58,.30);text-decoration:underline wavy rgba(232,92,58,.95);}' +
        '::highlight(po-ts-med){background-color:rgba(240,180,41,.36);}' +
        '::highlight(po-ts-low){background-color:rgba(45,128,120,.24);}';
      (document.head || document.documentElement).appendChild(style);
      state.styleEl = style;
    } catch (_) { /* silent */ }
  }

  /**
   * Paint the collected ranges with the CSS Custom Highlight API (zero DOM
   * mutation). The API is guaranteed by manifest minimum_chrome_version 105, so
   * there is no legacy <mark> fallback to maintain.
   * @param {Object<string, Range[]>} rangesBySeverity
   */
  /** The CSS Custom Highlight API must exist before we can paint ranges. */
  function highlightApiAvailable() {
    return typeof Highlight !== 'undefined' && typeof CSS !== 'undefined' && !!CSS.highlights;
  }
  /** True when a severity bucket actually holds ranges to paint. */
  function hasRanges(ranges) {
    return !!ranges && ranges.length > 0;
  }
  function applyHighlights(rangesBySeverity) {
    try {
      if (!highlightApiAvailable()) return;
      injectHighlightStyles();
      for (const sev of HIGHLIGHT_SEVERITIES) CSS.highlights.delete('po-ts-' + sev);
      for (const sev of HIGHLIGHT_SEVERITIES) {
        const ranges = rangesBySeverity[sev];
        if (hasRanges(ranges)) CSS.highlights.set('po-ts-' + sev, new Highlight(...ranges));
      }
    } catch (_) { /* silent */ }
  }

  /**
   * Remove all highlights and our injected style element (our nodes only).
   */
  function clearHighlights() {
    try {
      if (typeof CSS !== 'undefined' && CSS.highlights) {
        for (const sev of HIGHLIGHT_SEVERITIES) CSS.highlights.delete('po-ts-' + sev);
      }
      if (state.styleEl && state.styleEl.parentNode) state.styleEl.parentNode.removeChild(state.styleEl);
      state.styleEl = null;
    } catch (_) { /* silent */ }
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Shadow-DOM summary panel (style-isolated, po-ts- prefixed)
  // ─────────────────────────────────────────────────────────────────────────

  // Styled to the PawsOff DARK brand (same tokens as the popup): deep pine
  // surfaces, warm paper text, icon-orange accent, hard offset shadows.
  // Deliberately a FIXED palette (no page/dark-mode inheritance) so it stays
  // high-contrast and readable on top of any site, light or dark. Tokens are
  // redeclared on :host because the closed shadow root can't inherit page CSS.
  const PANEL_CSS =
    ':host{all:initial;' +
    '--paper:#101613;--card:#1c2722;--ink:#f2ede3;--soft:#a7b0a5;--edge:#0a0d0c;' +
    '--accent:#ff5e3a;--teal:#3fa89e;--head:#223129;--amber:#f5c518;' +
    '--shadow:4px 5px 0 var(--edge);--radius:16px;' +
    '--font:"Plus Jakarta Sans","Segoe UI",system-ui,-apple-system,Roboto,sans-serif;}' +
    '.po-ts-card{position:fixed;right:16px;bottom:16px;z-index:2147483647;width:332px;max-height:62vh;' +
    'display:flex;flex-direction:column;font:13px/1.45 var(--font);' +
    'color:var(--ink);background:var(--card);border:2px solid var(--edge);border-radius:var(--radius);box-shadow:var(--shadow);overflow:hidden;}' +
    '.po-ts-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:11px 13px;background:var(--head);color:var(--ink);border-bottom:2px solid var(--edge);}' +
    '.po-ts-title{font-weight:800;font-size:13.5px;letter-spacing:-0.015em;display:flex;align-items:center;gap:7px;}' +
    '.po-ts-title::before{content:"";flex:0 0 auto;width:11px;height:11px;border-radius:50%;background:var(--accent);border:2px solid var(--edge);}' +
    '.po-ts-actions button{all:unset;cursor:pointer;color:var(--ink);opacity:.6;font-size:18px;line-height:1;padding:1px 6px;border-radius:8px;}' +
    '.po-ts-actions button:hover{opacity:1;background:rgba(242,237,227,.12);}' +
    '.po-ts-list{overflow-y:auto;padding:7px;background:var(--paper);}' +
    '.po-ts-item{display:flex;gap:9px;padding:9px;border-radius:12px;cursor:pointer;border:2px solid transparent;transition:transform .08s ease,box-shadow .08s ease;}' +
    '.po-ts-item:hover{background:var(--card);border-color:var(--edge);box-shadow:3px 3px 0 var(--edge);transform:translate(-1px,-1px);}' +
    '.po-ts-dot{flex:0 0 auto;width:11px;height:11px;border-radius:50%;margin-top:3px;border:1.5px solid var(--edge);}' +
    '.po-ts-dot.high{background:var(--accent);}.po-ts-dot.med{background:var(--amber);}.po-ts-dot.low{background:var(--teal);}' +
    '.po-ts-cat{font-weight:800;letter-spacing:-0.01em;}' +
    '.po-ts-snip{color:var(--soft);font-size:12px;margin-top:2px;}' +
    '.po-ts-foot{display:flex;align-items:center;gap:6px;padding:9px 13px;font-size:11px;color:var(--soft);border-top:2px solid var(--edge);background:var(--card);}' +
    '.po-ts-empty{padding:16px;color:var(--soft);}';

  /**
   * Remove the panel host (ours).
   */
  function removePanel() {
    try {
      if (state.panelHost && state.panelHost.parentNode) state.panelHost.parentNode.removeChild(state.panelHost);
      state.panelHost = null;
      state.shadowRoot = null;
    } catch (_) { /* silent */ }
  }

  /**
   * Render the findings summary inside an isolated Shadow DOM. All untrusted
   * text (the matched sentence) is inserted via textContent, never innerHTML.
   * @param {Array} findings  current-page findings (with .range)
   */
  function renderPanel(findings) {
    try {
      removePanel();
      if (!findings.length) return;

      const host = document.createElement('div');
      host.className = 'po-ts-root'; // also keeps our node out of the text index
      // CLOSED shadow root: host.shadowRoot returns null, so neither the page nor
      // any other installed extension's content script can reach our findings via
      // the shared DOM. The ONLY reference lives in this isolated-world closure
      // (state.shadowRoot), never on the host element.
      const shadow = host.attachShadow({ mode: 'closed' });
      state.shadowRoot = shadow;

      const style = document.createElement('style');
      style.textContent = PANEL_CSS;
      shadow.appendChild(style);

      const card = document.createElement('div');
      card.className = 'po-ts-card';

      // Header
      const head = document.createElement('div');
      head.className = 'po-ts-head';
      const title = document.createElement('span');
      title.className = 'po-ts-title';
      title.textContent = 'GetPawsOff · ' + findings.length + ' clause' + (findings.length === 1 ? '' : 's') + ' flagged';
      const actions = document.createElement('span');
      actions.className = 'po-ts-actions';
      const closeBtn = document.createElement('button');
      closeBtn.setAttribute('aria-label', 'Dismiss');
      closeBtn.textContent = '\u00d7';
      closeBtn.addEventListener('click', () => { clearHighlights(); removePanel(); });
      actions.appendChild(closeBtn);
      head.appendChild(title);
      head.appendChild(actions);
      card.appendChild(head);

      // List
      const list = document.createElement('div');
      list.className = 'po-ts-list';
      for (const f of findings) {
        const cat = state.categoryById[f.categoryId] || { label: f.categoryId, severity: 'low' };
        const item = document.createElement('div');
        item.className = 'po-ts-item';

        const dot = document.createElement('span');
        dot.className = 'po-ts-dot ' + cat.severity;
        item.appendChild(dot);

        const body = document.createElement('div');
        const catEl = document.createElement('div');
        catEl.className = 'po-ts-cat';
        catEl.textContent = cat.label + (f.level === 'aggravated' ? ' (severe)' : '');
        const snip = document.createElement('div');
        snip.className = 'po-ts-snip';
        snip.textContent = truncate(f.text, 160); // untrusted page text → textContent
        body.appendChild(catEl);
        body.appendChild(snip);
        item.appendChild(body);

        // Jump to the highlighted clause on the page.
        item.addEventListener('click', () => scrollToFinding(f));
        list.appendChild(item);
      }
      card.appendChild(list);

      const foot = document.createElement('div');
      foot.className = 'po-ts-foot';
      foot.textContent = 'Informational only, not legal advice. Analysed locally on your device.';
      card.appendChild(foot);

      shadow.appendChild(card);
      // Attach to <html> so page CSS resets on <body> cannot affect the host.
      (document.documentElement || document.body).appendChild(host);
      state.panelHost = host;
    } catch (err) {
      logStatus('panel_error', { message: err && err.message });
    }
  }

  /**
   * Truncate text for display.
   * @param {string} s
   * @param {number} n
   * @returns {string}
   */
  function truncate(s, n) {
    const t = (s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '\u2026' : t;
  }

  /**
   * Scroll a finding's clause into view.
   * @param {Object} f
   */
  function scrollToFinding(f) {
    try {
      if (!f.range) return;
      const node = f.range.startContainer;
      const el = node.nodeType === 1 ? node : node.parentElement;
      if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (_) { /* silent */ }
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Scan orchestration
  // ───���─────────────────────────────────────────────────────────────────────

  /**
   * Run the full pipeline once. Returns true if the page was analysed (passed
   * the detection gate), regardless of whether any clause was flagged.
   * @returns {boolean}
   */
  function scanNow() {
    if (state.scanning || state.scanned) return state.scanned;
    state.scanning = true;
    try {
      if (!state.settings.enabled) return false;

      // Cheap pre-gate before the expensive text-index walk. With the current
      // scoring, a page that matches NEITHER a URL token (+0.5) nor a title
      // token (+0.3) can reach at most 0.4 from legalese markers, below the
      // 0.6 threshold. So if neither signal is present, this page can never
      // qualify and we skip building the index entirely. This script runs on
      // every http/https page, so avoiding the TreeWalker here is a real win.
      if (!hasUrlOrTitleSignal()) return false;

      const root = findContentRoot();
      if (!root) return false;

      const index = buildTextIndex(root);
      if (!index.text || index.text.length < MIN_ROOT_CHARS) return false;

      if (pageConfidence(index.text) < state.config.pageDetection.confidenceThreshold) {
        return false; // not a policy page - stand down silently
      }

      const sentences = segmentSentences(index.text);
      const findings = [];
      const seen = new Set(); // dedupe per (sentence,category)
      const rangesBySeverity = { high: [], med: [], low: [] };

      for (const s of sentences) {
        if (findings.length >= MAX_FINDINGS) break;
        // Skip segments that are headings or section questions, not clauses.
        // Legal docs use ALL-CAPS headings ("DATA CONTROLLER") and question
        // headings ("WHAT HAPPENS IF WE CHANGE THE POLICY?") that match anchors
        // but impose no obligation. Matching them produced false positives.
        if (isLikelyHeadingOrQuestion(s.raw)) continue;
        const norm = normalizeForMatch(s.raw);
        const hits = matchSentence(norm);
        if (!hits.length) continue;

        // Original-case clauses, aligned 1:1 with the normalised clauses inside
        // matchSentence (same delimiter regex, same order), so we can surface the
        // exact clause that matched instead of the whole sentence.
        const rawClauses = s.raw.split(state.regex.clause);

        for (const hit of hits) {
          const key = s.start + ':' + hit.categoryId;
          if (seen.has(key)) continue;
          seen.add(key);

          const range = buildRange(index.entries, s.start, s.end);
          const cat = state.categoryById[hit.categoryId] || { severity: 'low' };
          if (range) {
            (rangesBySeverity[cat.severity] || rangesBySeverity.low).push(range);
          }
          const clauseText =
            (hit.clauseIndex != null && hit.clauseIndex >= 0 && rawClauses[hit.clauseIndex] != null)
              ? rawClauses[hit.clauseIndex].trim()
              : s.raw;
          findings.push({
            categoryId: hit.categoryId,
            level: hit.level,
            score: hit.score,
            text: clauseText || s.raw, // matched clause (in-memory only; never persisted)
            range,
          });
        }
      }

      state.findings = findings;
      state.scanned = true;

      if (findings.length) {
        applyHighlights(rangesBySeverity);
        renderPanel(findings);
      }

      // Persist NON-PII aggregates only.
      const byCategory = {};
      for (const f of findings) byCategory[f.categoryId] = (byCategory[f.categoryId] || 0) + 1;
      logScanEvent(Object.keys(byCategory), byCategory);
      // PawsOff catch feed (popup "Today's catch"), one entry per flagged
      // category. Non-PII: the clause TEXT is never persisted, only the category.
      try {
        if (window.PawsOffCatch) {
          Object.keys(byCategory).forEach(function (cid) {
            window.PawsOffCatch.recordClause(cid);
          });
        }
      } catch (_) { /* silent */ }
      // Increment the monotonic total so the popup counter never plateaus.
      if (findings.length > 0) incrementTotal(TS_TOTAL_KEY, findings.length);

      return true;
    } catch (err) {
      logStatus('scan_error', { message: err && err.message });
      return false;
    } finally {
      state.scanning = false;
    }
  }

  /**
   * Build a DOM Range for a flat-string [start,end) span.
   * @param {Array} entries
   * @param {number} start
   * @param {number} end
   * @returns {Range|null}
   */
  function buildRange(entries, start, end) {
    try {
      const a = mapCharToDom(entries, start, false);
      const b = mapCharToDom(entries, end, true);
      if (!a || !b) return null;
      const range = document.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
      return range;
    } catch (_) {
      return null;
    }
  }

  // ─────────────────────��───────────────────────────────────────────────────
  //  Readiness: handle policies rendered by JS after load
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * If the first scan didn't find a policy page, watch briefly for late-rendered
   * content, then give up. Content-script setTimeout/observer are legitimate
   * (page process). Disconnects on first success or after READINESS_MS.
   */
  function startReadinessWatch() {
    try {
      if (state.readinessObserver || !document.body) return;
      state.readinessDeadline = Date.now() + READINESS_MS;

      // Trailing-edge debounce. The observer below can fire many times per
      // second on dynamic pages. Running scanNow() (a full DOM TreeWalker over
      // up to MAX_TEXT_CHARS + confidence regex) directly inside the callback on
      // every batch saturates the main thread and freezes the tab. Instead each
      // burst of mutations schedules at most ONE scanNow() per
      // READINESS_DEBOUNCE_MS, which always sees the latest DOM when it runs.
      const runScan = () => {
        state.readinessDebounceTimer = null;
        try {
          if (state.scanned) { stopReadinessWatch(); return; }
          if (Date.now() > state.readinessDeadline) { stopReadinessWatch(); return; }
          if (scanNow()) stopReadinessWatch();
        } catch (_) { /* silent */ }
      };

      const observer = new MutationObserver(() => {
        // Cheap guards only, never scan synchronously here.
        if (state.scanned || Date.now() > state.readinessDeadline) {
          stopReadinessWatch();
          return;
        }
        if (state.readinessDebounceTimer) return; // a scan is already queued
        state.readinessDebounceTimer = setTimeout(runScan, READINESS_DEBOUNCE_MS);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      state.readinessObserver = observer;

      // Hard stop so we never observe forever on a non-policy SPA.
      state.readinessTimer = setTimeout(stopReadinessWatch, READINESS_MS);
    } catch (_) { /* silent */ }
  }

  /**
   * Tear down the readiness watcher.
   */
  function stopReadinessWatch() {
    try {
      if (state.readinessObserver) { state.readinessObserver.disconnect(); state.readinessObserver = null; }
      if (state.readinessTimer) { clearTimeout(state.readinessTimer); state.readinessTimer = null; }
      if (state.readinessDebounceTimer) { clearTimeout(state.readinessDebounceTimer); state.readinessDebounceTimer = null; }
    } catch (_) { /* silent */ }
  }

  /**
   * Reset all page-scoped state and UI (for SPA navigation / disable).
   */
  function resetPageState() {
    try {
      stopReadinessWatch();
      clearHighlights();
      removePanel();
      state.findings = [];
      state.scanned = false;
      state.scanning = false;
    } catch (_) { /* silent */ }
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Initialise ToS Shield: load config + settings, then analyse the page.
   * @returns {Promise<void>}
   */
  window.__pawsOff_tosShield_init = async function () {
    try {
      // Run only in the top frame, policies are top-level documents, and this
      // avoids duplicate panels from same-origin iframes.
      if (window.top !== window) return;

      const cfg = await loadConfig();
      compileConfig(cfg);
      state.settings = await loadSettings(cfg);
      state.started = true;

      if (!state.settings.enabled) return;

      // Only watch for late-rendered policies on pages that ALREADY look like a
      // policy/terms page (URL or title signal). On an ordinary page this avoids
      // attaching a long-lived MutationObserver that can never qualify.
      if (!scanNow() && hasUrlOrTitleSignal()) startReadinessWatch();
    } catch (err) {
      try { await logStatus('init_error', { message: err && err.message }); } catch (_) { /* silent */ }
    }
  };

  /**
   * Update settings from the popup without reloading the tab. `categories` is
   * merged, not replaced.
   * @param {Object} patch
   * @returns {Promise<Object|null>}
   */
  window.__pawsOff_tosShield_updateSettings = async function (patch) {
    try {
      const current = state.settings || defaultSettings(state.config || DEFAULT_CONFIG);
      const next = normalizeSettings(
        {
          enabled: patch && typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
          categories: { ...current.categories, ...((patch && patch.categories) || {}) },
        },
        state.config || DEFAULT_CONFIG,
      );
      state.settings = next;
      await chrome.storage.local.set({ [SETTINGS_KEY]: next });

      // Re-apply: disabled → tear down; enabled → fresh scan.
      resetPageState();
      if (next.enabled) { if (!scanNow()) startReadinessWatch(); }
      return next;
    } catch (err) {
      await logStatus('update_settings_error', { message: err && err.message });
      return null;
    }
  };

  /**
   * Current-page findings for the popup (no DOM Range objects, no persistence).
   * @returns {Array<{categoryId: string, label: string, severity: string, level: string, text: string}>}
   */
  window.__pawsOff_tosShield_getFindings = function () {
    try {
      return state.findings.map((f) => {
        const cat = state.categoryById[f.categoryId] || { label: f.categoryId, severity: 'low' };
        return { categoryId: f.categoryId, label: cat.label, severity: cat.severity, level: f.level, text: f.text };
      });
    } catch (_) {
      return [];
    }
  };

  /**
   * Aggregate stats across scans for the popup badge.
   * @returns {Promise<Object>}
   */
  window.__pawsOff_tosShield_getStats = function () {
    return getStats();
  };

  // ──────────────────────────────────────────��──────────────────────────────
  //  React to settings changes from the popup in real time
  // ─────────────────────────────────────────────────────────────────────────
  try {
    if (chrome && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        try {
          if (area !== 'local' || !changes[SETTINGS_KEY] || !state.started) return;
          state.settings = normalizeSettings(changes[SETTINGS_KEY].newValue, state.config || DEFAULT_CONFIG);
          resetPageState();
          if (state.settings.enabled) { if (!scanNow()) startReadinessWatch(); }
        } catch (_) { /* silent */ }
      });
    }
  } catch (_) { /* silent */ }

  // ─────────────────────────────────────────────────────────────────────────
  //  SPA navigation reset (Navigation API, Chrome 102+)
  // ──────────────────────────────────────────────────────────��──────────────
  /**
   * Re-run analysis when the user navigates to another in-app route (e.g. from
   * /terms to /privacy in a docs SPA).
   */
  function resetForNavigation() {
    try {
      resetPageState();
      if (state.settings && state.settings.enabled) { if (!scanNow()) startReadinessWatch(); }
    } catch (err) {
      try { logStatus('spa_reset_error', { message: err && err.message }); } catch (_) { /* silent */ }
    }
  }

  if (typeof navigation !== 'undefined') {
    try {
      // TODO(v2): guard on event.navigationType / event.destination to skip
      //   hash-only and replaceState query syncs on chatty SPAs.
      navigation.addEventListener('navigate', resetForNavigation);
    } catch (_) { /* silent */ }
  }

  // ── Auto-invoke ───────────────────────��────────────────────────────────────
  window.__pawsOff_tosShield_init();

  // ── Test-only export (NO-OP in Chrome; see consent-ghost.js note) ───────────
  // Exposes pure helpers + compileConfig/state so tests can compile DEFAULT_CONFIG
  // and exercise matchSentence/pageConfidence without the live DOM/storage.
  try {
    if (typeof module !== 'undefined' && module.exports) {
      module.exports.__test = {
        compareVersions, buildAltRegex, validateConfig, normalizeSettings,
        defaultSettings, segmentSentences, normalizeForMatch, matchSentence,
        pageConfidence, compileConfig, base64ToBytes,
        DEFAULT_CONFIG, getState: () => state,
      };
    }
  } catch (_) { /* ignore */ }

}());
