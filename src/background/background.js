// Prevalence tier, loaded first so its listeners register alongside the main
// ones. Order matters: psl-lite.js (self.PawsOffPSL) → prevalence-learner.js
// (self.__pawsOff_prevalence) → prevalence-enforcer.js.
//
// The learner only observes; it never blocks. The enforcer can turn 'block'
// verdicts into dynamic DNR rules but stays dormant by default
// (__pawsOff_pv_enforce_enabled defaults false, no UI flips it yet).
try {
  importScripts(
    '../learn/psl-lite.js',
    '../learn/prevalence-learner.js',
    '../learn/prevalence-enforcer.js',
    '../lib/po-allow.js', // self.PawsOffAllow - timed-pause expiry updates the allowlist
  );
} catch (e) { /* prevalence tier optional */ }

// background.js, PawsOff
//
// Shared Manifest V3 service worker that ties the three content-script features
// together: ConsentGhost, PixelBlock, and ToS Shield.
//
// RESPONSIBILITIES
//  1. PixelBlock, register declarativeNetRequest rules that block image
//     requests to every known email-tracker domain, scoped to supported webmail
//     origins. Done on install/update (and re-asserted on startup) so the
//     network-level block is live before any content script runs.
//  2. Message router for all three content scripts (DNR toggles, ToS config,
//     diagnostics, ping).
//  3. ToS Shield, fetch + SubtleCrypto-verify + cache the signed remote
//     patterns.json from our Cloudflare Pages host (content scripts can only do
//     cross-origin fetches awkwardly; the worker is the right place, and it
//     caches into the same storage key the content script already reads).
//  4. Error logging to chrome.storage.local (unique-key writes).
//
// HARD RULES (shared across PawsOff)
//  - NO setTimeout / setInterval in the service worker. Periodic work uses
//    chrome.alarms (the MV3-correct, eviction-safe mechanism).
//  - try/catch around everything; silent failures only (diagnostics → storage).
//  - Namespaced globals only. A service worker has no `window`; we expose the
//    minimal namespace on `self.__pawsOff_background` (self/globalThis is the SW
//    global, the analogue of window).
//  - Unique-key chrome.storage writes, no read-modify-write races.
//
// REQUIRED MANIFEST BITS
//  - "permissions": ["declarativeNetRequest", "storage", "alarms"]
//  - "host_permissions" must include "https://config.getpawsoff.app/*" for the ToS
//    config fetch (DNR blocking itself needs no host permission).
//  - "background": { "service_worker": "src/background/background.js" }

(function () {
  'use strict';

  const VERSION = '1.0.0';

  // Minimal namespaced global (SW analogue of window.__pawsOff_*).
  try { self.__pawsOff_background = { version: VERSION }; } catch (_) { /* ignore */ }

  // ── Storage keys / tuning ──────────────────────────────────────────────────
  const LOG_PREFIX       = '__pawsOff_background_log_';
  const LOG_MAX          = 200;
  const PRUNE_SAMPLE     = 0.1;
  const TOS_CONFIG_CACHE_KEY = '__pawsOff_tosShield_config'; // SAME key ToS Shield reads
  const TOS_SCHEMA_VERSION   = 1;
  // PixelBlock settings, the SAME key pixel-block.js / popup / options write.
  // The background reads it so DNR baseline rules respect the user's toggles
  // across browser restarts (otherwise blocking silently persists when off).
  const PB_SETTINGS_KEY  = '__pawsOff_pixelBlock_settings';
  const MASTER_KEY       = '__pawsOff_master_enabled';
  const ALLOW_KEY        = '__pawsOff_allowlist';
  const CG_DISABLED_KEY  = '__pawsOff_consentGhost_disabled';
  // ConsentGhost shares the SAME signed-config machinery as ToS Shield. Its
  // cache key is read indirectly by consent-ghost.js via the getConfig message
  // (the content script never touches storage for this, background owns the
  // verify path). Schema is { schemaVersion, configVersion, frameworks[] }.
  const CG_CONFIG_CACHE_KEY  = '__pawsOff_consentGhost_config';
  const CG_SCHEMA_VERSION    = 1;

  // ── PixelBlock remote config (provider DOM selectors, same signing key) ────
  // Schema: { schemaVersion:1, configVersion:string, providers:[{id, emailBodySelectors?,
  // excludeSelectors?, legitimateProxies?}] }. Allows selector patches without a
  // store release. Does NOT carry tracking domains (those live in the static DNR
  // ruleset + the bundled TRACKING_DOMAINS constant which background owns).
  const PB_CONFIG_URL       = 'https://config.getpawsoff.app/pixel-block/pixel-config.json';
  const PB_CONFIG_SIG_URL   = 'https://config.getpawsoff.app/pixel-block/pixel-config.json.sig';
  const PB_CONFIG_CACHE_KEY = '__pawsOff_pixelBlock_config';
  const PB_SCHEMA_VERSION   = 1;

  // ── ToS Shield remote config (our own host; NEVER tosdr.org) ──────────────
  const CONFIG_URL     = 'https://config.getpawsoff.app/tos-shield/patterns.json';
  const CONFIG_SIG_URL = 'https://config.getpawsoff.app/tos-shield/patterns.json.sig';
  const CONFIG_ALARM   = 'pawsoff_tos_config_refresh';
  const CONFIG_REFRESH_MINUTES = 1440; // once a day

  // ── ConsentGhost remote config (same host, same signing key) ──────────────
  const CG_CONFIG_URL     = 'https://config.getpawsoff.app/consent-ghost/consent-config.json';
  const CG_CONFIG_SIG_URL = 'https://config.getpawsoff.app/consent-ghost/consent-config.json.sig';

  // ── EasyPrivacy DELTA: signed live top-up feed for freshly-emerging trackers ─
  // The bundled static ruleset (src/rules/easyprivacy.json) only refreshes via
  // an extension update - Chrome has no API to replace a static DNR ruleset's
  // contents over the network. This feed fills the gap between updates: a
  // small, signed, quota-bounded domain list applied as dynamic DNR rules,
  // same trust model as the 3 configs above (fail-open, never "block
  // everything"). Dedups against easyprivacy-domains.json. Dormant + shadow by
  // default (DELTA_ENABLED_KEY/DELTA_SHADOW_KEY), same rollout as the enforcer.
  const DELTA_CONFIG_URL     = 'https://config.getpawsoff.app/easyprivacy-delta/domains.json';
  const DELTA_CONFIG_SIG_URL = 'https://config.getpawsoff.app/easyprivacy-delta/domains.json.sig';
  const DELTA_CONFIG_CACHE_KEY = '__pawsOff_ep_delta_config';
  const DELTA_SCHEMA_VERSION = 1;
  const DELTA_ENABLED_KEY = '__pawsOff_ep_delta_enabled'; // boolean, default false
  const DELTA_SHADOW_KEY  = '__pawsOff_ep_delta_shadow';  // boolean, default TRUE
  const DELTA_META_KEY    = '__pawsOff_ep_delta_meta';    // {updated, shadow, applied/wouldApply, candidates}
  // Rule id band: clear of PixelBlock (9100-9199), site-pause (9300-9499),
  // per-domain allow (9500-9999), and the prevalence-enforcer/learner
  // (40000-69999). All dynamic+session rules across every band share Chrome's
  // single 30,000-rule MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES cap.
  const DELTA_ID_BASE = 20000;
  const DELTA_ID_MAX  = 29999;   // span 10000
  const DELTA_PRIORITY = 1;      // MUST stay below ALLOW_PRIORITY (2) - user allow always wins
  const DELTA_HEADROOM = 1000;   // never claim the last 1000 of the shared 30k
  const MAX_DELTA_RULES = 2000;  // self-cap, far under the shared budget
  const DELTA_RESOURCE_TYPES = ['ping', 'image', 'xmlhttprequest']; // beacon carriers only
  // Ceiling, not just a default: a per-domain override from the signed feed
  // may only pick from this set. Without it, feed content alone would decide
  // whether a domain can hit main_frame/sub_frame/websocket/media - a
  // compromised key or bad feed edit must not grant a broader block than this.
  const DELTA_ALLOWED_RESOURCE_TYPES = new Set(['ping', 'image', 'xmlhttprequest', 'script', 'stylesheet', 'font']);

  // Pinned ECDSA P-256 public key (JWK), the counterpart to the private key at
  // .keys/config-signing-key.jwk (gitignored). Generated via
  // tools/gen-config-key.mjs; also committed at tools/config-signing-public-key.json,
  // which the signing tools verify against before writing a signature. Every
  // consumer below fails open to the bundled/cached copy on any fetch,
  // signature, or key failure - an unpublished feed just 404s harmlessly.
  const PINNED_PUBLIC_KEY_JWK = {
    kty: 'EC',
    crv: 'P-256',
    x: '4fDL20b_S9gr9ieY4K5tE502h_ZedTrZizcIU7fFnww',
    y: 'BIWrF4Tb5XzDQl0tXKc-4tbu-TCXxVR1bvXljNk0FGY',
  };

  // ── PixelBlock: tracker domains (canonical copy for the NETWORK layer) ────
  // Keep in sync with pixel-block.js (its copy drives the DOM fallback). If a
  // build step is ever added, generate both from one source.
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

  // ── PixelBlock: webmail providers → DNR rule ids ──────────────────────────
  // Order/ids MUST match pixel-block.js (DNR_RULE_ID_BASE + index). iCloud is
  // intentionally absent: it renders in a cross-origin iframe, so DNR initiator
  // scoping does not help and DOM scanning is impossible there.
  const DNR_RULE_ID_BASE = 9100;
  const PIXELBLOCK_PROVIDERS = [
    { id: 'gmail',      dnrIndex: 0, hosts: ['mail.google.com'] },
    { id: 'protonmail', dnrIndex: 1, hosts: ['mail.proton.me', 'mail.protonmail.com'] },
    { id: 'zoho',       dnrIndex: 2, hosts: ['mail.zoho.com', 'mail.zoho.in', 'mail.zoho.eu'] },
    { id: 'yahoo',      dnrIndex: 3, hosts: ['mail.yahoo.com'] },
    { id: 'outlook',    dnrIndex: 4, hosts: ['outlook.live.com', 'outlook.office.com', 'hotmail.com'] },
    { id: 'fastmail',   dnrIndex: 5, hosts: ['app.fastmail.com'] },
    { id: 'hey',        dnrIndex: 6, hosts: ['app.hey.com'] },
    { id: 'tutanota',   dnrIndex: 7, hosts: ['app.tuta.com', 'mail.tutanota.com'] },
  ];
  const DNR_ID_MIN = DNR_RULE_ID_BASE;
  const DNR_ID_MAX = DNR_RULE_ID_BASE + 99; // reserved range for PixelBlock

  // ── EasyPrivacy network tier (static declarativeNetRequest ruleset) ───────
  // Generated by tools/easyprivacy-to-dnr.js from the public EasyPrivacy list
  // and declared in manifest.declarative_net_request. Toggled by the master
  // switch; matches are surfaced in the per-site catch feed via an id→label map.
  const EASYPRIVACY_RULESET_ID = 'easyprivacy';
  const NET_TOTAL_KEY = '__pawsOff_net_total_blocked';
  let _epMeta = null; // lazy id→label map (fetched once from the packaged json)
  let _epById = null; // lazy id→domain-index map for per-tracker badge dedup

  // FNV-1a/32, identical to po-catch.hashHost so background-written catches
  // share the same hashed-origin space the popup filters on.
  function fnvHash(host) {
    if (!host || typeof host !== 'string') return null;
    let h = 0x811c9dc5;
    const str = host.toLowerCase();
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return 'h:' + h.toString(16).padStart(8, '0');
  }

  // Derive the hashed TOP-LEVEL origin for a content-script sender. sender.tab.url
  // is the tab's top-level URL and is populated by the browser (never by page
  // script), so a catch recorded inside a hostile third-party iframe still gets
  // attributed to the site the user is actually visiting, and cannot be spoofed.
  // Returns ONLY the hash; the plaintext URL never leaves the worker.
  function topOriginHashFromSender(sender) {
    try {
      const url = (sender && sender.tab && sender.tab.url) || '';
      if (!url) return null;
      return fnvHash(new URL(url).hostname);
    } catch (_) { return null; }
  }

  async function loadEpMeta() {
    if (_epMeta) return _epMeta;
    try {
      const res = await fetch(chrome.runtime.getURL('src/rules/easyprivacy-meta.json'));
      _epMeta = await res.json();
    } catch (_) { _epMeta = {}; }
    return _epMeta;
  }

  // Lazy rule-id → base-domain index, built offline by tools/easyprivacy-byid.mjs
  // and packaged alongside the rules. Lets the badge count a tracker COMPANY once
  // even when it trips several EasyPrivacy rules on the page. Fail-open: a missing
  // or unparseable file → empty map → the badge falls back to per-rule counting.
  async function loadEpById() {
    if (_epById) return _epById;
    try {
      const res = await fetch(chrome.runtime.getURL('src/rules/easyprivacy-byid.json'));
      _epById = await res.json();
    } catch (_) { _epById = { d: [], byId: [] }; }
    return _epById;
  }

  // Enable/disable the static ruleset to follow the master switch (fail-open:
  // unknown state → enabled, the privacy-protective default).
  async function syncEasyPrivacyRuleset() {
    try {
      if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateEnabledRulesets) return;
      let masterOff = false;
      try {
        const s = await chrome.storage.local.get(MASTER_KEY);
        masterOff = s && s[MASTER_KEY] === false;
      } catch (_) { /* fail-open */ }
      if (masterOff) {
        await chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: [EASYPRIVACY_RULESET_ID] });
      } else {
        await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: [EASYPRIVACY_RULESET_ID] });
      }
    } catch (err) {
      await logRecord('ep_ruleset_sync_error', { message: err && err.message });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  EasyPrivacy DELTA: fetch/verify (mirrors ToS/ConsentGhost/PixelBlock),
  //  then reconcile a bounded dynamic-rule band. See the constants block above
  //  for the full rationale.
  // ─────────────────────────────────────────────────────────────────────────
  let _deltaDomainIndex = null; // in-memory id -> domain, rebuilt each sync (for badge/catch-feed labels)

  /** Structural validation before we trust a fetched delta config at all. */
  function validateDeltaConfig(cfg) {
    try {
      if (!cfg || typeof cfg !== 'object') return false;
      if (cfg.schemaVersion !== DELTA_SCHEMA_VERSION) return false;
      if (typeof cfg.configVersion !== 'string') return false;
      if (!Array.isArray(cfg.domains)) return false;
      for (const d of cfg.domains) {
        if (!d || typeof d.domain !== 'string' || !d.domain) return false;
        if (d.resourceTypes !== undefined) {
          // Reject the whole config if any entry smuggles a type outside
          // DELTA_ALLOWED_RESOURCE_TYPES - a feed can pick, never expand, the ceiling.
          if (!Array.isArray(d.resourceTypes) || d.resourceTypes.length === 0) return false;
          if (d.resourceTypes.some((t) => !DELTA_ALLOWED_RESOURCE_TYPES.has(t))) return false;
        }
      }
      return true;
    } catch (_) {
      return false;
    }
  }
  async function getCachedDeltaConfig() {
    try {
      const s = await chrome.storage.local.get(DELTA_CONFIG_CACHE_KEY);
      const c = s && s[DELTA_CONFIG_CACHE_KEY];
      return validateDeltaConfig(c) ? c : null;
    } catch (_) {
      return null;
    }
  }
  /** Fetch + verify + cache the delta feed. Fail-open: any failure returns
   *  null, leaves the cache (and therefore the currently-applied rules)
   *  untouched. On a successfully adopted config, reconciles the DNR band. */
  async function refreshEasyPrivacyDelta(force) {
    try {
      if (!PINNED_PUBLIC_KEY_JWK) return null;
      const [cfgRes, sigRes] = await Promise.all([
        fetch(DELTA_CONFIG_URL, { cache: 'no-cache', credentials: 'omit' }),
        fetch(DELTA_CONFIG_SIG_URL, { cache: 'no-cache', credentials: 'omit' }),
      ]);
      if (!bothResponsesOk(cfgRes, sigRes)) return null;

      const text = await cfgRes.text();
      const sig = await sigRes.text();
      if (!(await verifyConfigSignature(text, sig))) {
        await logRecord('ep_delta_sig_invalid');
        return null;
      }

      let parsed;
      try { parsed = JSON.parse(text); } catch (_) { await logRecord('ep_delta_parse_error'); return null; }
      if (!validateDeltaConfig(parsed)) { await logRecord('ep_delta_invalid'); return null; }

      const cached = await getCachedDeltaConfig();
      if (shouldAdoptConfig(force, cached, parsed)) {
        await chrome.storage.local.set({ [DELTA_CONFIG_CACHE_KEY]: parsed });
        await syncEasyPrivacyDeltaRules();
      }
      return parsed;
    } catch (err) {
      await logRecord('ep_delta_fetch_error', { message: err && err.message });
      return null;
    }
  }

  /** Base domains already covered by the bundled static ruleset - never
   *  duplicate a block the packaged list already does. Same source file the
   *  prevalence enforcer already loads for the identical purpose. */
  let _deltaCoveredCache = null;
  async function loadDeltaCoveredSet() {
    if (_deltaCoveredCache) return _deltaCoveredCache;
    try {
      const res = await fetch(chrome.runtime.getURL('src/rules/easyprivacy-domains.json'));
      const arr = await res.json();
      _deltaCoveredCache = new Set(Array.isArray(arr) ? arr.map((d) => String(d).toLowerCase()) : []);
    } catch (_) { _deltaCoveredCache = new Set(); }
    return _deltaCoveredCache;
  }
  /** PURE: how many delta rules may we add right now, given everything else
   *  sharing the same 30,000-rule dynamic+session cap. Same formula as the
   *  prevalence enforcer's computeBudget (kept independent rather than
   *  imported, so neither dormant system can destabilise the other). */
  function computeDeltaBudget(o) {
    o = o || {};
    const maxDynamic = typeof o.maxDynamic === 'number' ? o.maxDynamic : 30000;
    const headroom = typeof o.headroom === 'number' ? o.headroom : DELTA_HEADROOM;
    const otherRuleCount = typeof o.otherRuleCount === 'number' ? o.otherRuleCount : 0;
    const selfCap = typeof o.selfCap === 'number' ? o.selfCap : MAX_DELTA_RULES;
    const spanCap = (DELTA_ID_MAX - DELTA_ID_BASE) + 1;
    const available = maxDynamic - headroom - otherRuleCount;
    const budget = Math.min(selfCap, spanCap, available);
    return budget > 0 ? budget : 0;
  }
  /** Current dynamic+session rule state, split into "our band" vs "everyone
   *  else" - mirrors prevalence-enforcer.js's getDynamicState() so the two
   *  independent budget calculations can never double-count each other. */
  async function getDeltaDynamicState() {
    const dnr = chrome.declarativeNetRequest;
    if (!dnr || !dnr.getDynamicRules) return { bandIds: [], otherRuleCount: 0 };
    try {
      const [dyn, ses] = await Promise.all([
        dnr.getDynamicRules(),
        dnr.getSessionRules ? dnr.getSessionRules() : Promise.resolve([]),
      ]);
      const bandIds = [];
      let other = 0;
      for (const r of (Array.isArray(dyn) ? dyn : [])) {
        const id = Number(r && r.id);
        if (id >= DELTA_ID_BASE && id <= DELTA_ID_MAX) bandIds.push(id);
        else other++;
      }
      other += (Array.isArray(ses) ? ses.length : 0);
      return { bandIds, otherRuleCount: other };
    } catch (_) {
      return { bandIds: [], otherRuleCount: 0 };
    }
  }
  /** PURE: build the desired rule set from a verified config + the covered
   *  set + a budget. Deterministic ids from DELTA_ID_BASE, worst-first by
   *  array order (the feed itself is expected to list newest-first). */
  function planDeltaRules(domains, coveredSet, budget) {
    const idMap = {}; // id -> domain, for badge/catch-feed labels
    const addRules = [];
    const seen = new Set();
    let i = 0;
    for (const d of (Array.isArray(domains) ? domains : [])) {
      if (addRules.length >= budget) break;
      const domain = (d && String(d.domain || '').toLowerCase().trim()) || '';
      if (!domain || seen.has(domain)) continue;
      if (coveredSet && coveredSet.has(domain)) continue; // already blocked by the bundled list
      seen.add(domain);
      const id = DELTA_ID_BASE + i;
      if (id > DELTA_ID_MAX) break;
      // Defense-in-depth: this function is independently callable, so it
      // re-enforces the ceiling itself rather than trusting the caller. Any
      // disallowed type in the override falls back to the safe default whole.
      const requested = (Array.isArray(d.resourceTypes) && d.resourceTypes.length) ? d.resourceTypes : null;
      const resourceTypes = (requested && requested.every((t) => DELTA_ALLOWED_RESOURCE_TYPES.has(t)))
        ? requested : DELTA_RESOURCE_TYPES;
      addRules.push({
        id,
        priority: DELTA_PRIORITY,
        action: { type: 'block' },
        condition: { requestDomains: [domain], domainType: 'thirdParty', resourceTypes: resourceTypes.slice() },
      });
      idMap[id] = domain;
      i++;
    }
    return { addRules, idMap };
  }
  /** Reconcile the delta DNR band to the cached config. Full-reconcile (clear
   *  the whole band, re-add what's currently desired), same pattern as the
   *  enforcer. Shadow mode (default true) computes the plan into
   *  DELTA_META_KEY but applies nothing. */
  async function syncEasyPrivacyDeltaRules() {
    const dnr = chrome.declarativeNetRequest;
    if (!dnr || !dnr.updateDynamicRules) return { ok: false, reason: 'no_dnr' };
    try {
      const s = await chrome.storage.local.get([DELTA_ENABLED_KEY, DELTA_SHADOW_KEY, MASTER_KEY]);
      const masterOff = s && s[MASTER_KEY] === false;
      const enabled = !!(s && s[DELTA_ENABLED_KEY]) && !masterOff; // master switch always wins
      const shadow = !(s && s[DELTA_SHADOW_KEY] === false); // default true
      const dyn = await getDeltaDynamicState();

      if (!enabled) {
        // OFF: make sure no delta rules linger, clear the label map too. A
        // removal failure propagates to the outer catch (ok:false) instead of
        // being swallowed here - reporting ok:true while blocking rules are
        // still live would misrepresent master-off/disable as fully honored.
        if (dyn.bandIds.length) {
          await dnr.updateDynamicRules({ removeRuleIds: dyn.bandIds, addRules: [] });
        }
        _deltaDomainIndex = null;
        return { ok: true, enabled: false };
      }

      const cached = await getCachedDeltaConfig();
      const domains = (cached && cached.domains) || [];
      const covered = await loadDeltaCoveredSet();
      const budget = computeDeltaBudget({ otherRuleCount: dyn.otherRuleCount });
      const plan = planDeltaRules(domains, covered, budget);

      if (shadow) {
        // Compute what WOULD happen, apply nothing (and clear any leftovers
        // from a prior non-shadow run) - a removal failure here must propagate
        // to the outer catch, not report shadow success while old non-shadow
        // block rules are still silently live.
        if (dyn.bandIds.length) {
          await dnr.updateDynamicRules({ removeRuleIds: dyn.bandIds, addRules: [] });
        }
        _deltaDomainIndex = null;
        await chrome.storage.local.set({
          [DELTA_META_KEY]: {
            updated: Date.now(), shadow: true,
            wouldApply: plan.addRules.length, candidates: domains.length, budget,
            sample: plan.addRules.slice(0, 50).map((r) => r.condition.requestDomains[0]),
          },
        });
        return { ok: true, enabled: true, shadow: true, wouldApply: plan.addRules.length };
      }

      const removeSet = new Set(dyn.bandIds);
      for (const r of plan.addRules) removeSet.add(r.id); // remove-then-add same ids, clean
      await dnr.updateDynamicRules({ removeRuleIds: Array.from(removeSet), addRules: plan.addRules });
      _deltaDomainIndex = plan.idMap;
      await chrome.storage.local.set({
        [DELTA_META_KEY]: { updated: Date.now(), shadow: false, applied: plan.addRules.length, candidates: domains.length, budget },
      });
      return { ok: true, enabled: true, shadow: false, applied: plan.addRules.length };
    } catch (err) {
      await logRecord('ep_delta_sync_error', { message: err && err.message });
      return { ok: false, reason: 'sync_error', error: err && err.message };
    }
  }
  async function setDeltaEnabled(on) {
    await chrome.storage.local.set({ [DELTA_ENABLED_KEY]: !!on });
    return syncEasyPrivacyDeltaRules();
  }
  async function setDeltaShadow(on) {
    await chrome.storage.local.set({ [DELTA_SHADOW_KEY]: !!on });
    return syncEasyPrivacyDeltaRules();
  }
  async function getDeltaStatus() {
    try {
      const s = await chrome.storage.local.get([DELTA_ENABLED_KEY, DELTA_SHADOW_KEY, DELTA_META_KEY]);
      return {
        enabled: !!(s && s[DELTA_ENABLED_KEY]),
        shadow: !(s && s[DELTA_SHADOW_KEY] === false),
        meta: (s && s[DELTA_META_KEY]) || null,
      };
    } catch (_) {
      return { enabled: false, shadow: true, meta: null };
    }
  }

  // Surface network-blocked trackers in the per-site catch feed, hashed-origin
  // only and capped per poll. Best-effort: any failure is swallowed silently.
  async function writeNetworkCatches(epByTab) {
    const meta = await loadEpMeta();
    const idMap = await loadEpById();
    for (const [tabId, ruleIds] of epByTab.entries()) {
      const epoch0 = tabEpoch(tabId); // captured before any await in this iteration
      let originHash = null;
      try {
        if (tabId >= 0 && chrome.tabs && chrome.tabs.get) {
          const tab = await chrome.tabs.get(tabId);
          if (tab && tab.url) originHash = fnvHash(new URL(tab.url).hostname);
        }
      } catch (_) { /* tab gone - leave originHash null */ }
      const writes = {};
      for (const id of ruleIds) {
        // Delta-band ids have no entry in the static id→label map (that map
        // only covers the bundled ruleset's 1-13823 range); the domain itself
        // IS the label there - same plaintext-tracker-name precedent as
        // easyprivacy-meta.json's labels, never a first-party host.
        const deltaLabel = _deltaDomainIndex && _deltaDomainIndex[id];
        const label = deltaLabel ? String(deltaLabel) : ((meta && meta[id]) ? String(meta[id]) : 'tracker');
        const key = '__pawsOff_catch_' + Date.now() + '_' + rand();
        writes[key] = {
          ts: Date.now(), originHash: originHash, feature: 'tracker',
          label: label.slice(0, 80), category: 'Tracker',
          detail: label.slice(0, 120), mayBreak: false, wall: false, source: 'dnr',
        };
      }
      // Toolbar badge: accumulate DISTINCT blocked trackers per tab. The
      // build-time id→domain map (easyprivacy-byid.json) collapses one tracker
      // company's many rules to a single count; rules with no domain fall back
      // to per-rule counting. In-memory only - no page host is ever stored.
      if (tabId >= 0 && tabEpoch(tabId) === epoch0) { // tab hasn't navigated since we started
        const keys = [];
        for (const id of ruleIds) keys.push(dedupKeyForRule(idMap, id));
        addTrackers(_tabTrackers, tabId, keys);
        refreshBadge(tabId);
        persistTabBadge(tabId); // mirror to storage.session so it survives SW eviction
      }
      try { if (Object.keys(writes).length) await chrome.storage.local.set(writes); } catch (_) { /* silent */ }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Per-tab "trackers blocked here" toolbar badge (an "it works"
  //  signal). Distinct tracker count for the CURRENT page, reset on navigation.
  //  In-memory only (Map<tabId, Set<label>>): labels are public tracker names,
  //  never a user host, and nothing is persisted. Needs no extra permission.
  // ─────────────────────────────────────────────────────────────────────────
  const _tabTrackers = new Map(); // tabId -> Set<dedup-key> of blocks on the live page
  const _tabBlockedReqs = new Map(); // tabId -> COUNT of blocked requests (popup stats)
  // Per-tab navigation generation: badge-mutating async work can still be in
  // flight when the user navigates away, so a slow block from the OLD page
  // could get miscounted onto the NEW one. Bumped on navigation start;
  // callers capture the epoch before their awaits and discard if it moved.
  const _tabNavEpoch = new Map();
  function tabEpoch(tabId) { return _tabNavEpoch.get(tabId) || 0; }
  function bumpTabEpoch(tabId) { const n = tabEpoch(tabId) + 1; _tabNavEpoch.set(tabId, n); return n; }
  const BADGE_COLOR = '#3c4043';       // dark grey background - white count pops
  const BADGE_TEXT_COLOR = '#ffffff';  // white count text (forced, not auto-picked)
  const BADGE_SESSION_PREFIX = '__pawsOff_badge_'; // session-storage mirror key per tab

  /** PURE: badge string for a count. Always shows a number ("0" baseline so the
   *  badge sits at 0 and ticks up on detection); caps huge counts at "99+". */
  function badgeText(n) {
    n = n | 0;
    if (n < 0) n = 0;
    return n > 99 ? '99+' : String(n);
  }
  /** PURE: dedup key for a blocked rule id. Domain-mapped rules collapse to an
   *  opaque index key ('d'+idx) so a tracker company counts once and no domain
   *  string is ever stored (~300 EasyPrivacy rules are first-party, so a
   *  domain key could be the visited page's own host). The webRequest tier
   *  derives the same key, so the two tiers never double-count. Unmapped
   *  rules stay per-rule ('r'+id). idMap = {d, byId}. */
  function dedupKeyForRule(idMap, id) {
    const byId = idMap && idMap.byId;
    if (byId && id >= 0 && id < byId.length) {
      const di = byId[id];
      if (di >= 0) return 'd' + di;
    }
    return 'r' + id;
  }
  /** PURE: badge key for a BLOCKED request URL - 'd'+idx if its registrable
   *  domain is in our tracker index (Map domain → idx into the byid d array),
   *  else '' (not ours to count: some other extension's block, or a non-tracker
   *  failure). The URL/domain is reduced to the opaque index and discarded.
   *  getBase is injected so the helper stays pure/testable. */
  function blockedKeyForUrl(url, domainIndex, getBase) {
    try {
      const host = new URL(url).hostname;
      const base = (getBase && getBase(host)) || '';
      if (!base || !domainIndex) return '';
      const di = domainIndex.get(base);
      return (di === undefined) ? '' : 'd' + di;
    } catch (_) { return ''; }
  }
  /** PURE: add labels to a tab's distinct-set; returns the new distinct count. */
  function addTrackers(setMap, tabId, labels) {
    let s = setMap.get(tabId);
    if (!s) { s = new Set(); setMap.set(tabId, s); }
    for (const l of (labels || [])) { if (l) s.add(String(l)); }
    return s.size;
  }
  function tabBadgeCount(tabId) { const s = _tabTrackers.get(tabId); return s ? s.size : 0; }
  /** PURE: bump a tab's blocked-request counter; returns the new count. */
  function bumpBlockedReqs(countMap, tabId) {
    const n = ((countMap.get(tabId) | 0) + 1);
    countMap.set(tabId, n);
    return n;
  }

  async function setBadge(tabId, text) {
    try { if (chrome.action && chrome.action.setBadgeText) await chrome.action.setBadgeText({ tabId, text }); }
    catch (_) { /* tab likely closed */ }
  }
  // Refresh a tab's badge from its accumulated count. Master switch OFF → blank
  // (protection stood down). Fail-open: any error just leaves the badge as-is.
  async function refreshBadge(tabId) {
    try {
      if (tabId == null || tabId < 0) return;
      const s = await chrome.storage.local.get(MASTER_KEY);
      if (s && s[MASTER_KEY] === false) { await setBadge(tabId, ''); return; }
      await setBadge(tabId, badgeText(tabBadgeCount(tabId)));
    } catch (_) { /* silent */ }
  }
  // New page in a tab → drop its count and reset the badge to "0"; the next
  // reconcile ticks it up from that page's own blocks. (refreshBadge is
  // master-switch-aware, so a paused suite still shows blank, not "0".)
  function resetTabBadge(tabId) {
    try {
      bumpTabEpoch(tabId); // fence off any in-flight block that belonged to the old page
      _tabTrackers.delete(tabId); _tabBlockedReqs.delete(tabId); clearTabBadgeSession(tabId); refreshBadge(tabId);
    } catch (_) { /* silent */ }
  }

  // ── Resilience: mirror per-tab counts to chrome.storage.session ────────────
  // MV3 evicts idle service workers; a plain in-memory Map would reset the
  // badge on wake. storage.session survives eviction (cleared only on browser
  // close / reload). Stores only dedup keys, never a user host. Fail-open: no
  // session API → resilience is lost, never correctness.
  function persistTabBadge(tabId) {
    try {
      if (tabId == null || tabId < 0) return;
      if (!chrome.storage || !chrome.storage.session || !chrome.storage.session.set) return;
      const s = _tabTrackers.get(tabId);
      // {k: distinct dedup keys (badge), n: blocked-request count (popup stats)}
      chrome.storage.session.set({ [BADGE_SESSION_PREFIX + tabId]: {
        k: s ? Array.from(s) : [], n: _tabBlockedReqs.get(tabId) | 0,
      } });
    } catch (_) { /* silent */ }
  }
  function clearTabBadgeSession(tabId) {
    try {
      if (!chrome.storage || !chrome.storage.session || !chrome.storage.session.remove) return;
      chrome.storage.session.remove(BADGE_SESSION_PREFIX + tabId);
    } catch (_) { /* silent */ }
  }
  // On SW cold start (incl. wake from eviction): rebuild the in-memory counts from
  // the session mirror and repaint each still-open tab's badge. Prunes entries for
  // tabs that closed while the worker was dead.
  async function rehydrateBadges() {
    try {
      if (!chrome.storage || !chrome.storage.session || !chrome.storage.session.get) return;
      const all = await chrome.storage.session.get(null);
      if (!all) return;
      let openIds = null;
      try {
        if (chrome.tabs && chrome.tabs.query) {
          const tabs = await chrome.tabs.query({});
          openIds = new Set((tabs || []).map(function (t) { return t && t.id; }));
        }
      } catch (_) { openIds = null; } // can't enumerate → skip pruning, keep counts
      const stale = [];
      for (const k of Object.keys(all)) {
        if (k.indexOf(BADGE_SESSION_PREFIX) !== 0) continue;
        const tabId = parseInt(k.slice(BADGE_SESSION_PREFIX.length), 10);
        if (!Number.isInteger(tabId)) continue;
        if (openIds && !openIds.has(tabId)) { stale.push(k); continue; }
        const v = all[k];
        const keys = Array.isArray(v) ? v : (v && Array.isArray(v.k) ? v.k : []);
        if (v && typeof v.n === 'number' && v.n > 0) _tabBlockedReqs.set(tabId, v.n | 0);
        if (keys.length) {
          addTrackers(_tabTrackers, tabId, keys);
          refreshBadge(tabId);
        }
      }
      if (stale.length && chrome.storage.session.remove) {
        try { await chrome.storage.session.remove(stale); } catch (_) { /* silent */ }
      }
    } catch (_) { /* fail-open: no rehydration */ }
  }
  // Set the badge grey background + white text once per service-worker start
  // (both guarded: setBadgeTextColor needs Chrome 110+, absent in the test stub).
  try {
    if (chrome.action && chrome.action.setBadgeBackgroundColor) {
      chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
    }
    if (chrome.action && chrome.action.setBadgeTextColor) {
      chrome.action.setBadgeTextColor({ color: BADGE_TEXT_COLOR });
    }
  } catch (_) { /* silent */ }

  // ── Toolbar icon follows the master switch ────────────────────────────────
  // Full-color icon while protecting; greyed variant when the user disables
  // everything, so the "off" state is visible at a glance. Global swap (not
  // per-tab). Guarded + fail-open: any failure keeps the colored icon.
  const ICONS_ON  = { 16: 'icons/icon16.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' };
  const ICONS_OFF = { 16: 'icons/icon16-off.png', 48: 'icons/icon48-off.png', 128: 'icons/icon128-off.png' };
  async function syncActionIcon() {
    try {
      if (!chrome.action || !chrome.action.setIcon) return;
      let off = false;
      try {
        const s = await chrome.storage.local.get(MASTER_KEY);
        off = !!(s && s[MASTER_KEY] === false);
      } catch (_) { /* fail-open: keep the colored icon */ }
      await chrome.action.setIcon({ path: off ? ICONS_OFF : ICONS_ON });
      // Master off → blank every OPEN tab's badge too; back on → repaint.
      // _tabTrackers only holds tabs with a nonzero count, so a freshly-
      // navigated tab at "0" would be missed - query all open tabs instead.
      const tabIds = new Set(_tabTrackers.keys());
      try {
        if (chrome.tabs && chrome.tabs.query) {
          const tabs = await chrome.tabs.query({});
          for (const tab of (tabs || [])) {
            if (tab && typeof tab.id === 'number') tabIds.add(tab.id);
          }
        }
      } catch (_) { /* fall back to the known counted tabs */ }
      for (const tabId of tabIds) refreshBadge(tabId);
    } catch (_) { /* silent */ }
  }
  try { syncActionIcon(); } catch (_) { /* silent */ } // every SW start

  // ─────────────────────────────────────────────────────────────────────────
  //  Utilities
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Short random suffix for unique storage keys.
   * @returns {string}
   */
  function rand() {
    return Math.random().toString(36).slice(2, 8);
  }

  /**
   * Compare two dotted numeric version strings.
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
   * Decode base64 to a Uint8Array.
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
   * Unique-key diagnostic write (silent). Sampled prune to bound storage.
   * @param {string} status
   * @param {Object} [extra]
   * @returns {Promise<void>}
   */
  // Redact anything that could carry a plaintext URL/host or PII out of a
  // diagnostic extra before it is persisted (hash-only privacy model). String
  // values are URL-stripped and length-capped; only primitives are kept.
  function sanitizeExtra(extra) {
    const out = {};
    if (!extra || typeof extra !== 'object') return out;
    let n = 0;
    for (const k of Object.keys(extra)) {
      if (n++ >= 12) break; // bound the key count
      const v = extra[k];
      if (typeof v === 'string') {
        out[k] = v.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]').slice(0, 200);
      } else if (typeof v === 'number' || typeof v === 'boolean' || v == null) {
        out[k] = v;
      } // objects/arrays are dropped - could nest a URL/host
    }
    return out;
  }
  async function logRecord(status, extra) {
    try {
      const key = LOG_PREFIX + Date.now() + '_' + rand();
      await chrome.storage.local.set({ [key]: { ts: Date.now(), source: 'background', status, ...sanitizeExtra(extra) } });
      if (Math.random() < PRUNE_SAMPLE) await pruneLogs();
    } catch (_) { /* silent */ }
  }

  /**
   * Trim oldest diagnostic entries to LOG_MAX (remove() of distinct keys is
   * concurrency-safe).
   * @returns {Promise<void>}
   */
  async function pruneLogs() {
    try {
      const all = await chrome.storage.local.get(null);
      const keys = Object.keys(all).filter((k) => k.startsWith(LOG_PREFIX));
      if (keys.length <= LOG_MAX) return;
      keys.sort((a, b) => ((all[a] && all[a].ts) || 0) - ((all[b] && all[b].ts) || 0));
      await chrome.storage.local.remove(keys.slice(0, keys.length - LOG_MAX));
    } catch (_) { /* silent */ }
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  PixelBlock, declarativeNetRequest
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Build the block rule for one provider: block image requests to any tracker
   * domain, but only when initiated from that provider's webmail origin (so we
   * never alter those domains' behaviour on unrelated sites).
   * @param {Object} provider
   * @returns {Object}
   */
  function buildProviderRule(provider) {
    return {
      id: DNR_RULE_ID_BASE + provider.dnrIndex,
      priority: 1,
      action: { type: 'block' },
      condition: {
        requestDomains: TRACKING_DOMAINS.slice(),
        initiatorDomains: provider.hosts.slice(),
        resourceTypes: ['image'],
      },
    };
  }

  /**
   * Register/refresh the baseline DNR ruleset, respecting stored settings and
   * the master switch. Always removes the full id range first, then re-adds
   * only enabled providers, so this is idempotent across install/startup and
   * toggle changes. Fail-open: unreadable settings enable everything.
   * @returns {Promise<void>}
   */
  async function syncBaselineRules() {
    try {
      if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateDynamicRules) return;

      let settings = null;
      let masterOff = false;
      try {
        const stored = await chrome.storage.local.get([PB_SETTINGS_KEY, MASTER_KEY]);
        settings = stored && stored[PB_SETTINGS_KEY];
        masterOff = stored && stored[MASTER_KEY] === false;
      } catch (_) { /* fail-open below */ }

      const globalOff = masterOff || (settings && settings.globalEnabled === false);
      const providerOn = (id) => {
        if (globalOff) return false;
        if (!settings || !settings.providers) return true; // no settings yet → on
        return settings.providers[id] !== false;
      };

      // Always clear our whole id range, then add back only enabled providers.
      const removeRuleIds = PIXELBLOCK_PROVIDERS.map((p) => DNR_RULE_ID_BASE + p.dnrIndex);
      const addRules = PIXELBLOCK_PROVIDERS.filter((p) => providerOn(p.id)).map(buildProviderRule);
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
    } catch (err) {
      await logRecord('dnr_sync_error', { message: err && err.message });
    }
  }

  /**
   * Sanitise rules arriving via message before applying them. Even though the
   * sender is our own content script, we defensively force `block` actions and
   * clamp ids to our reserved range, never apply a redirect/header-modify rule
   * or touch ids outside PixelBlock's space.
   * @param {Array} rules
   * @returns {Array}
   */
  /** A dynamic DNR rule id must be an integer inside our reserved id band. */
  function isValidRuleId(id) {
    return Number.isInteger(id) && id >= DNR_ID_MIN && id <= DNR_ID_MAX;
  }
  function sanitizeRules(rules) {
    const out = [];
    for (const r of (Array.isArray(rules) ? rules : [])) {
      try {
        const id = Number(r && r.id);
        if (!isValidRuleId(id)) continue;
        const cond = (r && r.condition) || {};
        out.push({
          id,
          priority: 1,
          action: { type: 'block' }, // force block - never redirect/modifyHeaders
          condition: {
            requestDomains: Array.isArray(cond.requestDomains) ? cond.requestDomains : TRACKING_DOMAINS.slice(),
            initiatorDomains: Array.isArray(cond.initiatorDomains) ? cond.initiatorDomains : undefined,
            resourceTypes: ['image'],
          },
        });
      } catch (_) { /* skip malformed rule */ }
    }
    return out;
  }

  /**
   * Apply a DNR toggle requested by pixel-block.js.
   * @param {Object} message {op, rules, removeRuleIds}
   * @returns {Promise<{ok: boolean}>}
   */
  async function handleDnrMessage(message) {
    try {
      if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateDynamicRules) return { ok: false };
      const removeRuleIds = (Array.isArray(message.removeRuleIds) ? message.removeRuleIds : [])
        .map(Number)
        .filter((id) => isValidRuleId(id));
      const addRules = message.op === 'register' ? sanitizeRules(message.rules) : [];
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
      return { ok: true };
    } catch (err) {
      await logRecord('dnr_message_error', { message: err && err.message });
      return { ok: false };
    }
  }

  // ──────────────────────────────────────────────────────────────────
  //  Allow-list → DNR allow rules (network tier)
  //
  //  Mirrors the popup's per-site pause / per-tracker allow into dynamic DNR
  //  rules at a higher priority than the block rules. Pause = one
  //  allowAllRequests rule scoped to the site's frames; per-domain = a
  //  narrower rule keyed on requestDomains + initiatorDomains. Ids are
  //  deterministic, so updates are idempotent (remove-then-add the same id).
  // ──────────────────────────────────────────────────────────────────
  const ALLOW_PRIORITY       = 2;     // must beat the priority-1 block rules
  const ALLOW_PAUSE_ID_BASE  = 9300;  // site-pause rules live in 9300–9499
  const ALLOW_PAUSE_ID_SPAN  = 200;
  const ALLOW_DOMAIN_ID_BASE = 9500;  // per-domain allow rules live in 9500–9999
  const ALLOW_DOMAIN_ID_SPAN = 500;
  const ALLOW_RESOURCE_TYPES = ['script', 'image', 'xmlhttprequest', 'sub_frame', 'ping', 'media', 'font', 'stylesheet', 'object', 'other'];

  function normAllowHost(input) {
    if (!input || typeof input !== 'string') return '';
    let s = input.trim().toLowerCase()
      .replace(/^[a-z][a-z0-9+.\-]*:\/\//, '')
      .replace(/^[^@\/]*@/, '');
    s = s.split('/')[0].split('?')[0].split('#')[0].split(':')[0].replace(/^www\./, '');
    if (!/^[a-z0-9.\-]+$/.test(s) || s.indexOf('.') < 0) return '';
    if (s.charAt(0) === '.' || s.charAt(s.length - 1) === '.' || s.indexOf('..') >= 0) return '';
    return s;
  }

  // Numeric FNV-1a/32, distinct from fnvHash(), which returns a 'h:'-prefixed
  // STRING that cannot be used as a numeric DNR rule id.
  function allowRuleHash(str) {
    let h = 0x811c9dc5;
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }

  function sitePauseRuleId(host) {
    const h = normAllowHost(host);
    if (!h) return null;
    return ALLOW_PAUSE_ID_BASE + (allowRuleHash('pause|' + h) % ALLOW_PAUSE_ID_SPAN);
  }
  function domainAllowRuleId(host, domain) {
    const h = normAllowHost(host);
    const d = normAllowHost(domain);
    if (!h || !d) return null;
    return ALLOW_DOMAIN_ID_BASE + (allowRuleHash('allow|' + h + '|' + d) % ALLOW_DOMAIN_ID_SPAN);
  }

  // ── Collision-free rule-id allocation ──────────────────────────────────────
  // sitePauseRuleId()/domainAllowRuleId() give a preferred slot from the host
  // hash, but hash%span collides (birthday: >50% at ~17 paused sites), and a
  // collision would silently clobber an earlier paused site. A persisted map
  // assigns a stable, unique id per site instead - starting at the preferred
  // slot and linear-probing to the next free id. Keys are fnvHash digests
  // (no plaintext host persisted); freed on unpause/clear.
  const ID_MAP_KEY = '__pawsOff_allow_idmap';
  function keyForHost(host) { const h = normAllowHost(host); return h ? fnvHash(h) : null; }
  function keyForDomain(host, domain) {
    const h = normAllowHost(host), d = normAllowHost(domain);
    return (h && d) ? (fnvHash(h) + '|' + fnvHash(d)) : null;
  }
  function normalizeIdMap(raw) {
    const m = (raw && typeof raw === 'object') ? raw : {};
    // pauseMeta: mapKey -> { u: expiry epoch-ms, oh: allowlist hash } for TIMED
    // pauses only. Links the DNR pause rule to its allowlist entry at expiry
    // (the two hashes differ when normAllowHost strips "www."). Hash-only.
    const metaSrc = (m.pauseMeta && typeof m.pauseMeta === 'object') ? m.pauseMeta : {};
    const pauseMeta = {};
    Object.keys(metaSrc).forEach((k) => {
      const e = metaSrc[k];
      if (e && typeof e.u === 'number' && e.u > 0 && typeof e.oh === 'string') {
        pauseMeta[k] = { u: e.u, oh: e.oh };
      }
    });
    return {
      v: 1,
      pause: (m.pause && typeof m.pause === 'object') ? m.pause : {},
      domain: (m.domain && typeof m.domain === 'object') ? m.domain : {},
      pauseMeta: pauseMeta,
    };
  }
  // PURE: stable, unique id in [base, base+span) for `key`, assigned into
  // bandMap on first use. Probes forward from `preferred`, wrapping within the
  // band. Returns null only when the band is full (caller refuses rather than
  // clobber a live rule); never returns an id held by a different key.
  function allocateRuleId(bandMap, base, span, key, preferred) {
    if (!key) return null;
    const inBand = (id) => Number.isInteger(id) && id >= base && id < base + span;
    if (inBand(bandMap[key])) return bandMap[key];  // stable: reuse this key's VALID id
    if (bandMap[key] != null) delete bandMap[key];   // drop a corrupt/out-of-band entry
    const used = new Set();
    for (const k in bandMap) {
      if (!Object.prototype.hasOwnProperty.call(bandMap, k)) continue;
      if (inBand(bandMap[k])) used.add(bandMap[k]); else delete bandMap[k]; // prune junk
    }
    const start = (typeof preferred === 'number') ? preferred : base;
    for (let i = 0; i < span; i++) {
      const id = base + (((start - base) % span + span) % span + i) % span;
      if (!used.has(id)) { bandMap[key] = id; return id; }
    }
    return null; // band full → caller stands down (never clobbers a live rule)
  }
  async function loadIdMap() {
    // Return null on read failure so the caller STANDS DOWN - proceeding with an
    // empty map could reuse ids of live rules whose mappings we simply couldn't read.
    try { const r = await chrome.storage.local.get(ID_MAP_KEY); return normalizeIdMap(r && r[ID_MAP_KEY]); }
    catch (_) { return null; }
  }
  async function saveIdMap(map) {
    try { await chrome.storage.local.set({ [ID_MAP_KEY]: map }); return true; }
    catch (_) { return false; }
  }

  function buildSitePauseRule(host, idOverride) {
    const h = normAllowHost(host);
    const id = (typeof idOverride === 'number') ? idOverride : sitePauseRuleId(h);
    if (!h || id == null) return null;
    return {
      id,
      priority: ALLOW_PRIORITY,
      action: { type: 'allowAllRequests' },
      condition: { requestDomains: [h], resourceTypes: ['main_frame', 'sub_frame'] },
    };
  }
  function buildDomainAllowRule(host, domain, idOverride) {
    const h = normAllowHost(host);
    const d = normAllowHost(domain);
    const id = (typeof idOverride === 'number') ? idOverride : domainAllowRuleId(h, d);
    if (!h || !d || id == null) return null;
    return {
      id,
      priority: ALLOW_PRIORITY,
      action: { type: 'allow' },
      condition: { requestDomains: [d], initiatorDomains: [h], resourceTypes: ALLOW_RESOURCE_TYPES },
    };
  }

  async function applyAllowRules(removeRuleIds, addRules) {
    if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateDynamicRules) return false;
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: (removeRuleIds || []).filter((n) => typeof n === 'number'),
      addRules: (addRules || []).filter(Boolean),
    });
    return true;
  }

  // Serialize allow-list mutations: concurrent pause/allow messages must not each
  // load the same id-map, allocate independently, and last-write-wins on save
  // (which would orphan a live rule and let its id be reused/clobbered later).
  let _allowChain = Promise.resolve();
  function handleAllowMessage(message) {
    const run = () => _handleAllowMessageImpl(message);
    _allowChain = _allowChain.then(run, run);
    return _allowChain;
  }
  async function _handleAllowMessageImpl(message) {
    try {
      const op = message && message.op;
      const site = message && message.site;
      const domain = message && message.domain;
      const map = await loadIdMap();
      if (!map) return { ok: false }; // storage read failed → stand down, touch no DNR
      // Persist the (mutated) map BEFORE changing DNR; if the write fails we abort
      // and leave DNR untouched, so the map always reflects the live rule set.
      const commit = async (removeIds, addRules) => {
        if (!(await saveIdMap(map))) return { ok: false };
        await applyAllowRules(removeIds, addRules);
        return { ok: true };
      };
      switch (op) {
        case 'pauseSite': {
          const h = normAllowHost(site);
          if (!h) return { ok: false };
          const key = keyForHost(site);
          const id = allocateRuleId(map.pause, ALLOW_PAUSE_ID_BASE, ALLOW_PAUSE_ID_SPAN, key, sitePauseRuleId(site));
          if (id == null) { await logRecord('allow_id_band_full', { band: 'pause' }); return { ok: false }; }
          const rule = buildSitePauseRule(h, id);
          if (!rule) return { ok: false };
          // Timed pause: remember expiry + the allowlist hash (fnv of the RAW
          // host - the popup's key, which differs from `key` for www hosts) and
          // arm a per-site alarm so protection auto-resumes even if the popup
          // never reopens. until<=0 = indefinite ("Always"): no meta, no alarm.
          const until = (message && typeof message.until === 'number' && message.until > 0) ? message.until : 0;
          if (until > 0) map.pauseMeta[key] = { u: until, oh: fnvHash(String(site || '').trim().toLowerCase()) };
          else delete map.pauseMeta[key];
          const res = await commit([id], [rule]); // remove-then-add same id
          if (res.ok) {
            try {
              if (until > 0) chrome.alarms.create(pauseAlarmName(key), { when: until });
              else chrome.alarms.clear(pauseAlarmName(key));
            } catch (_) { /* alarm best-effort; expiry sweep is the fail-safe */ }
          }
          return res;
        }
        case 'unpauseSite': {
          const h = normAllowHost(site);
          if (!h) return { ok: false };
          const key = keyForHost(site);
          const id = (map.pause[key] != null) ? map.pause[key] : sitePauseRuleId(site);
          if (id == null) return { ok: false };
          delete map.pause[key];
          delete map.pauseMeta[key];
          try { chrome.alarms.clear(pauseAlarmName(key)); } catch (_) { /* silent */ }
          return commit([id], []);
        }
        case 'allowDomain': {
          const h = normAllowHost(site), d = normAllowHost(domain);
          if (!h || !d) return { ok: false };
          const id = allocateRuleId(map.domain, ALLOW_DOMAIN_ID_BASE, ALLOW_DOMAIN_ID_SPAN, keyForDomain(site, domain), domainAllowRuleId(site, domain));
          if (id == null) { await logRecord('allow_id_band_full', { band: 'domain' }); return { ok: false }; }
          const rule = buildDomainAllowRule(h, d, id);
          if (!rule) return { ok: false };
          return commit([id], [rule]);
        }
        case 'blockDomain': {
          const h = normAllowHost(site), d = normAllowHost(domain);
          if (!h || !d) return { ok: false };
          const key = keyForDomain(site, domain);
          const id = (map.domain[key] != null) ? map.domain[key] : domainAllowRuleId(site, domain);
          if (id == null) return { ok: false };
          delete map.domain[key];
          return commit([id], []);
        }
        case 'clearSite': {
          const ids = [];
          const pkey = keyForHost(site);
          const pid = (map.pause[pkey] != null) ? map.pause[pkey] : sitePauseRuleId(site);
          if (pid != null) { ids.push(pid); delete map.pause[pkey]; }
          delete map.pauseMeta[pkey];
          try { chrome.alarms.clear(pauseAlarmName(pkey)); } catch (_) { /* silent */ }
          const domains = Array.isArray(message && message.domains) ? message.domains : [];
          domains.forEach((dom) => {
            const dkey = keyForDomain(site, dom);
            const did = (map.domain[dkey] != null) ? map.domain[dkey] : domainAllowRuleId(site, dom);
            if (did != null) { ids.push(did); delete map.domain[dkey]; }
          });
          if (ids.length === 0) return { ok: true };
          return commit(ids, []);
        }
        default:
          return { ok: false };
      }
    } catch (err) {
      await logRecord('allow_message_error', { message: err && err.message });
      return { ok: false };
    }
  }

  // ── Timed-pause expiry ─────────────────────────────────────────────────────
  // A timed pause ends in three cooperating places, all fail-safe toward
  // "protection back on": (1) po-allow's isPaused treats a lapsed pause as not
  // paused the moment it expires (content scripts resume with no help); (2) a
  // per-site chrome.alarm wakes the SW to remove the DNR allow rule + clear the
  // allowlist flag; (3) sweepExpiredPauses() at startup catches anything a lost
  // alarm missed and re-arms alarms for still-future expiries.
  const PAUSE_ALARM_PREFIX = 'pawsoff_pause_';
  /** PURE: alarm name for a pause-map key (a hash - never a plaintext host). */
  function pauseAlarmName(key) { return PAUSE_ALARM_PREFIX + key; }

  function expireSitePause(key) { // serialized on _allowChain: no popup-op races
    const run = () => _expireSitePauseImpl(key);
    _allowChain = _allowChain.then(run, run);
    return _allowChain;
  }
  async function _expireSitePauseImpl(key) {
    try {
      const map = await loadIdMap();
      if (!map) return;
      const meta = map.pauseMeta[key];
      if (!meta) return; // already resumed, or an indefinite pause (no meta)
      if (meta.u > Date.now() + 1000) { // fired early → re-arm and wait
        try { chrome.alarms.create(pauseAlarmName(key), { when: meta.u }); } catch (_) { /* silent */ }
        return;
      }
      const id = (map.pause[key] != null) ? map.pause[key] : null;
      // Remove the live DNR rule BEFORE persisting the metadata deletion - if
      // this throws after the map is saved, the rule would stay live with
      // nothing left to find and clean it up. This ordering means a failure
      // here leaves pauseMeta intact, so the retry alarm tries again.
      try {
        if (id != null) await applyAllowRules([id], []);
      } catch (err) {
        try { chrome.alarms.create(pauseAlarmName(key), { when: Date.now() + 60000 }); } catch (_) { /* silent */ }
        await logRecord('pause_expire_dnr_error', { message: err && err.message });
        return;
      }
      delete map.pause[key];
      delete map.pauseMeta[key];
      if (!(await saveIdMap(map))) {
        // DNR is already clear; only the bookkeeping write failed. Re-arm so
        // the next attempt can retry the (now idempotent) storage write.
        try { chrome.alarms.create(pauseAlarmName(key), { when: Date.now() + 60000 }); } catch (_) { /* silent */ }
        return;
      }
      unpauseAllowlistEntry(meta.oh);
    } catch (err) {
      await logRecord('pause_expire_error', { message: err && err.message });
    }
  }
  // Clear the allowlist pause flag for an EXPIRED timed pause only - an
  // indefinite ("Always") pause is the user's explicit choice and is never
  // touched. The write fires storage.onChanged, so popup + content scripts see
  // the resume immediately.
  function unpauseAllowlistEntry(oh) {
    try {
      const A = (typeof self !== 'undefined') && self.PawsOffAllow;
      if (!A || !oh) return;
      A.read(function (state) {
        try {
          const s = state && state.sites && state.sites[oh];
          if (!s || !(s.paused > 0)) return;
          if (!(s.pausedUntil > 0) || s.pausedUntil > Date.now()) return;
          A.write(A.setPaused(state, oh, false));
        } catch (_) { /* silent */ }
      });
    } catch (_) { /* silent */ }
  }
  function sweepExpiredPauses() { // startup fail-safe, serialized like the rest
    const run = () => _sweepExpiredPausesImpl();
    _allowChain = _allowChain.then(run, run);
    return _allowChain;
  }
  async function _sweepExpiredPausesImpl() {
    try {
      const map = await loadIdMap();
      if (!map) return;
      const now = Date.now();
      const removeIds = [];
      const lapsedOh = [];
      let dirty = false;
      for (const key of Object.keys(map.pauseMeta)) {
        const meta = map.pauseMeta[key];
        if (meta.u <= now) { // lapsed while we were away → clean up fully
          if (map.pause[key] != null) removeIds.push(map.pause[key]);
          delete map.pause[key];
          delete map.pauseMeta[key];
          dirty = true;
          lapsedOh.push(meta.oh);
        } else { // still running → make sure its alarm survived the restart
          try { chrome.alarms.create(pauseAlarmName(key), { when: meta.u }); } catch (_) { /* silent */ }
        }
      }
      if (dirty) {
        // Same ordering as _expireSitePauseImpl: remove DNR rules before
        // persisting the metadata deletion, so a failure leaves pauseMeta
        // intact for the next sweep to retry.
        if (removeIds.length) {
          try { await applyAllowRules(removeIds, []); }
          catch (err) { await logRecord('pause_sweep_dnr_error', { message: err && err.message }); return; }
        }
        if (!(await saveIdMap(map))) return;
        lapsedOh.forEach((oh) => unpauseAllowlistEntry(oh));
      }
      // Belt-and-braces: clear any expired flags that live only in the
      // allowlist (e.g. the popup wrote it but its background message failed).
      try {
        const A = (typeof self !== 'undefined') && self.PawsOffAllow;
        if (A && A.expiredPauses) {
          A.read(function (state) {
            try {
              const ex = A.expiredPauses(state);
              if (!ex.length) return;
              let st = state;
              ex.forEach(function (oh) { st = A.setPaused(st, oh, false); });
              A.write(st);
            } catch (_) { /* silent */ }
          });
        }
      } catch (_) { /* silent */ }
    } catch (err) {
      await logRecord('pause_sweep_error', { message: err && err.message });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  ToS Shield, signed remote config fetch / verify / cache
  // ────────────────────────────────────────────────────────────────────������───

  /**
   * Structural validation before trusting a fetched config.
   * @param {*} cfg
   * @returns {boolean}
   */
  /** A defined, non-null object value. */
  function isPlainObject(v) {
    return !!v && typeof v === 'object';
  }
  /** ToS config must carry both the categories and patterns arrays. */
  function hasRequiredArrays(cfg) {
    return Array.isArray(cfg.categories) && Array.isArray(cfg.patterns);
  }
  /** ToS config must carry all four behavioural sections. */
  function hasRequiredSections(cfg) {
    return !!(cfg.pageDetection && cfg.segmentation && cfg.negation && cfg.scoring);
  }
  function validateConfig(cfg) {
    try {
      if (!isPlainObject(cfg)) return false;
      if (cfg.schemaVersion !== TOS_SCHEMA_VERSION) return false;
      if (typeof cfg.configVersion !== 'string') return false;
      if (!hasRequiredArrays(cfg)) return false;
      if (!hasRequiredSections(cfg)) return false;
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Verify a detached signature (raw ECDSA P-256 r||s, base64) over raw config
   * bytes using the pinned public key.
   * @param {string} rawText
   * @param {string} sigB64
   * @returns {Promise<boolean>}
   */
  /** Signature verification needs the pinned key and a SubtleCrypto impl. */
  function canVerifySignatures() {
    return !!PINNED_PUBLIC_KEY_JWK && !!self.crypto && !!self.crypto.subtle;
  }
  async function verifyConfigSignature(rawText, sigB64) {
    try {
      if (!canVerifySignatures()) return false;
      const key = await self.crypto.subtle.importKey(
        'jwk',
        PINNED_PUBLIC_KEY_JWK,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      );
      const sig = base64ToBytes(String(sigB64).trim());
      const data = new TextEncoder().encode(rawText);
      return await self.crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, data);
    } catch (_) {
      return false;
    }
  }

  /**
   * Read the currently cached, valid config (or null).
   * @returns {Promise<Object|null>}
   */
  async function getCachedConfig() {
    try {
      const s = await chrome.storage.local.get(TOS_CONFIG_CACHE_KEY);
      const c = s && s[TOS_CONFIG_CACHE_KEY];
      return validateConfig(c) ? c : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Fetch + verify the remote config; cache it if strictly newer (or forced).
   * Fail-closed: returns null on any failure and leaves the cache untouched.
   * @param {boolean} force
   * @returns {Promise<Object|null>}
   */
  /** Both the config body and its detached signature must fetch successfully. */
  function bothResponsesOk(cfgRes, sigRes) {
    return !!cfgRes && cfgRes.ok && !!sigRes && sigRes.ok;
  }
  /** Adopt a freshly verified config when forced, uncached, or strictly newer. */
  function shouldAdoptConfig(force, cached, parsed) {
    return force || !cached || compareVersions(parsed.configVersion, cached.configVersion) > 0;
  }

  /**
   * Shared fetch→verify→parse→validate→cache-if-newer flow for all signed
   * remote configs (ToS Shield, ConsentGhost, PixelBlock - same pinned key,
   * same ECDSA-P256/SHA-256 signature path). Fail-closed: any failure returns
   * null and leaves the cache untouched.
   * @param {{cfgUrl: string, sigUrl: string, cacheKey: string, validate: Function, getCached: Function, logPrefix: string, force: boolean}} opts
   * @returns {Promise<Object|null>}
   */
  async function fetchSignedConfig({ cfgUrl, sigUrl, cacheKey, validate, getCached, logPrefix, force }) {
    try {
      if (!PINNED_PUBLIC_KEY_JWK) return null; // remote disabled until key pinned
      const [cfgRes, sigRes] = await Promise.all([
        fetch(cfgUrl, { cache: 'no-cache', credentials: 'omit' }),
        fetch(sigUrl, { cache: 'no-cache', credentials: 'omit' }),
      ]);
      if (!bothResponsesOk(cfgRes, sigRes)) return null;

      const text = await cfgRes.text();
      const sig = await sigRes.text();
      if (!(await verifyConfigSignature(text, sig))) {
        await logRecord(`${logPrefix}_config_sig_invalid`);
        return null;
      }

      let parsed;
      try { parsed = JSON.parse(text); } catch (_) { await logRecord(`${logPrefix}_config_parse_error`); return null; }
      if (!validate(parsed)) { await logRecord(`${logPrefix}_config_invalid`); return null; }

      const cached = await getCached();
      if (shouldAdoptConfig(force, cached, parsed)) {
        await chrome.storage.local.set({ [cacheKey]: parsed });
      }
      return parsed;
    } catch (err) {
      await logRecord(`${logPrefix}_config_fetch_error`, { message: err && err.message });
      return null;
    }
  }

  async function refreshTosConfig(force) {
    return fetchSignedConfig({
      cfgUrl: CONFIG_URL,
      sigUrl: CONFIG_SIG_URL,
      cacheKey: TOS_CONFIG_CACHE_KEY,
      validate: validateConfig,
      getCached: getCachedConfig,
      logPrefix: 'tos',
      force,
    });
  }

  /**
   * Message handler: return a verified config (cached, else fetch once).
   * @returns {Promise<{ok: boolean, config: Object|null}>}
   */
  async function handleGetTosConfig() {
    let cfg = await getCachedConfig();
    if (!cfg) cfg = await refreshTosConfig(false);
    return { ok: !!cfg, config: cfg || null };
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  ConsentGhost, signed remote consent-config.json (same crypto path)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Structural validation of a ConsentGhost config before we trust it. Distinct
   * shape from ToS Shield: { schemaVersion, configVersion, frameworks[] }.
   * @param {*} cfg
   * @returns {boolean}
   */
  function validateConsentConfig(cfg) {
    try {
      if (!cfg || typeof cfg !== 'object') return false;
      if (cfg.schemaVersion !== CG_SCHEMA_VERSION) return false;
      if (typeof cfg.configVersion !== 'string') return false;
      if (!Array.isArray(cfg.frameworks) || cfg.frameworks.length === 0) return false;
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Read the cached, valid ConsentGhost config (or null).
   * @returns {Promise<Object|null>}
   */
  async function getCachedConsentConfig() {
    try {
      const s = await chrome.storage.local.get(CG_CONFIG_CACHE_KEY);
      const c = s && s[CG_CONFIG_CACHE_KEY];
      return validateConsentConfig(c) ? c : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Fetch + verify + cache the ConsentGhost config. Reuses the exact same
   * verifyConfigSignature() (same pinned key, same ECDSA-P256/SHA-256) as ToS
   * Shield. Fail-closed: any failure returns null and leaves the cache untouched
   * (the content script then keeps its bundled config, fail-open at that layer).
   * @param {boolean} force
   * @returns {Promise<Object|null>}
   */
  async function refreshConsentConfig(force) {
    return fetchSignedConfig({
      cfgUrl: CG_CONFIG_URL,
      sigUrl: CG_CONFIG_SIG_URL,
      cacheKey: CG_CONFIG_CACHE_KEY,
      validate: validateConsentConfig,
      getCached: getCachedConsentConfig,
      logPrefix: 'cg',
      force,
    });
  }

  /**
   * Message handler: return a verified ConsentGhost config (cached, else fetch).
   * @returns {Promise<{ok: boolean, config: Object|null}>}
   */
  async function handleGetConsentConfig() {
    let cfg = await getCachedConsentConfig();
    if (!cfg) cfg = await refreshConsentConfig(false);
    return { ok: !!cfg, config: cfg || null };
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  PixelBlock, signed remote pixel-config.json (same crypto path)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Structural validation of a PixelBlock config.
   * Shape: { schemaVersion, configVersion, providers[] }
   * @param {*} cfg
   * @returns {boolean}
   */
  function validatePixelBlockConfig(cfg) {
    try {
      if (!cfg || typeof cfg !== 'object') return false;
      if (cfg.schemaVersion !== PB_SCHEMA_VERSION) return false;
      if (typeof cfg.configVersion !== 'string') return false;
      if (!Array.isArray(cfg.providers)) return false;
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Read the cached, valid PixelBlock config (or null).
   * @returns {Promise<Object|null>}
   */
  async function getCachedPixelBlockConfig() {
    try {
      const s = await chrome.storage.local.get(PB_CONFIG_CACHE_KEY);
      const c = s && s[PB_CONFIG_CACHE_KEY];
      return validatePixelBlockConfig(c) ? c : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Fetch + verify + cache the PixelBlock remote config. Reuses the same
   * verifyConfigSignature() (same pinned key, same ECDSA-P256/SHA-256).
   * Fail-closed: any failure returns null and leaves the cache untouched.
   * @param {boolean} force
   * @returns {Promise<Object|null>}
   */
  async function refreshPixelBlockConfig(force) {
    return fetchSignedConfig({
      cfgUrl: PB_CONFIG_URL,
      sigUrl: PB_CONFIG_SIG_URL,
      cacheKey: PB_CONFIG_CACHE_KEY,
      validate: validatePixelBlockConfig,
      getCached: getCachedPixelBlockConfig,
      logPrefix: 'pb',
      force,
    });
  }

  /**
   * Message handler: return a verified PixelBlock config (cached, else fetch).
   * @returns {Promise<{ok: boolean, config: Object|null}>}
   */
  async function handleGetPixelBlockConfig() {
    let cfg = await getCachedPixelBlockConfig();
    if (!cfg) cfg = await refreshPixelBlockConfig(false);
    return { ok: !!cfg, config: cfg || null };
  }

  // Inject the CMP API tier into the page's MAIN world only after the isolated
  // content script has checked the user's toggle and requested it. Keeping this
  // out of manifest.content_scripts prevents a disabled feature from continuing
  // to reject consent and avoids persistent, page-visible extension globals.
  async function handleConsentMainInjection(sender) {
    try {
      if (!sender || !sender.tab || sender.tab.id == null || !chrome.scripting) return { ok: false };
      if (typeof sender.frameId === 'number' && sender.frameId !== 0) return { ok: false };
      const pageUrl = sender.url || sender.tab.url || '';
      const host = new URL(pageUrl).hostname;
      const originHash = fnvHash(host);
      const stored = await chrome.storage.local.get([CG_DISABLED_KEY, ALLOW_KEY]);
      if (stored && stored[CG_DISABLED_KEY] === true) return { ok: false, disabled: true };
      const allow = stored && stored[ALLOW_KEY];
      const site = allow && allow.sites && originHash ? allow.sites[originHash] : null;
      if (site && site.paused > 0) return { ok: false, paused: true };
      await chrome.scripting.executeScript({
        target: { tabId: sender.tab.id, frameIds: [0] },
        world: 'MAIN',
        files: ['src/content/cmp-api-main.js'],
      });
      return { ok: true };
    } catch (err) {
      await logRecord('cmp_main_inject_error', { message: err && err.message });
      return { ok: false };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Message router, serves all three content scripts
  // ─────────────────────────────────────────────────────────────────────────
  //
  // Protocol: { type: string, ... }. Async handlers return a Promise and we
  // keep the channel open by returning `true` from the listener.
  try {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      try {
        // Only trust messages from our own extension's contexts.
        if (!sender || sender.id !== chrome.runtime.id) return false;
        if (!message || typeof message.type !== 'string') return false;

        switch (message.type) {
          // PixelBlock, add/remove DNR rules for a provider toggle.
          case 'pawsoff_pixelBlock_dnr':
            handleDnrMessage(message).then(sendResponse, () => sendResponse({ ok: false }));
            return true;

          // Allow-list, apply per-site pause / per-tracker allow as DNR allow rules.
          case 'pawsoff_allow_apply':
            handleAllowMessage(message).then(sendResponse, () => sendResponse({ ok: false }));
            return true;

          // ToS Shield, hand back a verified, cached config.
          case 'pawsoff_tosShield_getConfig':
            handleGetTosConfig().then(sendResponse, () => sendResponse({ ok: false, config: null }));
            return true;

          // ConsentGhost, hand back a verified, cached consent-config.json.
          case 'pawsoff_consentGhost_getConfig':
            handleGetConsentConfig().then(sendResponse, () => sendResponse({ ok: false, config: null }));
            return true;

          case 'pawsoff_consentGhost_runMain':
            handleConsentMainInjection(sender).then(sendResponse, () => sendResponse({ ok: false }));
            return true;

          // PixelBlock, hand back the verified provider-selector config.
          case 'pawsoff_pixelBlock_getConfig':
            handleGetPixelBlockConfig().then(sendResponse, () => sendResponse({ ok: false, config: null }));
            return true;
            
          // Fetch native DNR block stats, optionally filtered to a single tab.
          // When message.tabId is provided, answers from the webRequest tier's
          // in-memory per-tab counter: instant, quota-free, and not limited to
          // getMatchedRules' ~5-minute retention (which made long-lived tabs
          // UNDER-report). The popup polls this while open for its live stats.
          // Without a tabId, returns the global count (legacy PixelBlock
          // behavior) via getMatchedRules.
          case 'pawsoff_getDnrStats':
            // Per-tab ALWAYS answers from the in-memory counter - the popup
            // polls this every 1s while open, so it must never fall through to
            // quota-billed getMatchedRules (20 calls/10min would be gone in 20s).
            if (typeof message.tabId === 'number' && message.tabId >= 0) {
              sendResponse({ ok: true, count: _tabBlockedReqs.get(message.tabId) | 0 });
              return false;
            }
            if (chrome.declarativeNetRequest && chrome.declarativeNetRequest.getMatchedRules) {
              var filter = {};
              if (typeof message.tabId === 'number' && message.tabId >= 0) filter.tabId = message.tabId;
              chrome.declarativeNetRequest.getMatchedRules(filter).then((rules) => {
                sendResponse({ ok: true, count: rules && rules.rulesMatchedInfo ? rules.rulesMatchedInfo.length : 0 });
              }).catch(() => sendResponse({ ok: false, count: 0 }));
            } else {
              sendResponse({ ok: false, count: 0 });
            }
            return true;

          // Any feature (ConsentGhost / PixelBlock / ToS Shield) can forward a
          // diagnostic for the worker to persist.
          // NOTE: no caller yet - nothing in the shipped content scripts sends
          // this today (features write diagnostics to chrome.storage directly).
          // Kept as a deliberate forward-compat / SW-console sink, not dead code.
          case 'pawsoff_diag':
            logRecord(typeof message.status === 'string' ? message.status : 'diag', message.extra);
            sendResponse({ ok: true });
            return false;

          // Attribute an in-frame catch to the top-level site. po-catch.js uses
          // this only as a fallback when a sandboxed / null-origin frame cannot
          // read location.ancestorOrigins. Spoof-proof (derived from sender);
          // returns the hash alone so no plaintext URL leaves the worker.
          case 'pawsoff_topOriginHash': {
            const topHash = topOriginHashFromSender(sender);
            sendResponse({ ok: !!topHash, originHash: topHash });
            return false;
          }

          // Lightweight liveness/handshake for any content script.
          // NOTE: no caller yet - nothing in the shipped code sends this today.
          // Kept as a deliberate forward-compat / SW-console handshake, not dead
          // code (reachable only from the service-worker console).
          case 'pawsoff_ping':
            sendResponse({ ok: true, version: VERSION, feature: message.feature || null });
            return false;

          // Popup-triggered DNR reconciliation: flush pending network-blocked
          // trackers into catch records immediately so the popup shows them on
          // open, not after the next 1-minute alarm. Without this, visiting a
          // new site and opening the popup within the alarm window shows 0
          // catches even though DNR already blocked requests.
          case 'pawsoff_reconcile_now':
            // force=true: popup open is a user gesture (quota-exempt), and the
            // user is actively looking - skip the 45s poll spacing.
            reconcileDnrMatches(true).then(function () { sendResponse({ ok: true }); }, function () { sendResponse({ ok: false }); });
            return true;

          // EasyPrivacy delta feed - DORMANT-BY-DESIGN opt-in control surface
          // (mirrors the prevalence enforcer's pawsoff_pv_enforce_* messages).
          // No shipped UI sends these yet; reachable only from the
          // service-worker console or a future gated enable UI.
          case 'pawsoff_ep_delta_setEnabled':
            setDeltaEnabled(!!message.enabled).then(function (r) { sendResponse(r); }, function () { sendResponse({ ok: false }); });
            return true;
          case 'pawsoff_ep_delta_setShadow':
            setDeltaShadow(!!message.shadow).then(function (r) { sendResponse(r); }, function () { sendResponse({ ok: false }); });
            return true;
          case 'pawsoff_ep_delta_sync':
            syncEasyPrivacyDeltaRules().then(function (r) { sendResponse(r); }, function () { sendResponse({ ok: false }); });
            return true;
          case 'pawsoff_ep_delta_status':
            getDeltaStatus().then(function (r) { sendResponse({ ok: true, status: r }); }, function () { sendResponse({ ok: false }); });
            return true;

          default:
            return false;
        }
      } catch (err) {
        try { sendResponse({ ok: false }); } catch (_) { /* ignore */ }
        logRecord('message_router_error', { message: err && err.message });
        return false;
      }
    });
  } catch (_) { /* silent - runtime API unavailable */ }

  // ─────────────────────────────────────────────────────────────────────────
  //  Lifecycle, install / startup / periodic refresh
  // ─────────────────────────────────────────────────────────────────────────
  // Listeners are registered SYNCHRONOUSLY at top level so MV3 can wake the
  // worker to deliver these events.

  try {
    chrome.runtime.onInstalled.addListener(() => {
      // Bring the network-level block online immediately, fetch config once, and
      // schedule periodic refresh (chrome.alarms, never setInterval).
      syncBaselineRules();
      syncEasyPrivacyRuleset();
      sweepExpiredPauses(); // clean up lapsed timed pauses + re-arm their alarms
      refreshTosConfig(true);
      refreshConsentConfig(true);
      refreshPixelBlockConfig(true);
      refreshEasyPrivacyDelta(true);
      try {
        chrome.alarms.create(CONFIG_ALARM, { periodInMinutes: CONFIG_REFRESH_MINUTES });
        chrome.alarms.create('pawsoff_pb_dnr_reconcile', { periodInMinutes: 1 });
      } catch (_) { /* ignore */ }
    });
  } catch (_) { /* silent */ }

  try {
    chrome.runtime.onStartup.addListener(() => {
      // Dynamic rules persist across restarts, but re-asserting is cheap and
      // self-heals if they were ever cleared. Crucially this also re-applies the
      // user's PixelBlock toggle state (syncBaselineRules reads settings), so a
      // disabled provider does NOT silently keep blocking after a restart.
      syncBaselineRules();
      syncEasyPrivacyRuleset();
      syncEasyPrivacyDeltaRules(); // dynamic rules persist, but re-reconcile in case enabled/shadow changed
      sweepExpiredPauses(); // clean up lapsed timed pauses + re-arm their alarms
      try {
        chrome.alarms.create(CONFIG_ALARM, { periodInMinutes: CONFIG_REFRESH_MINUTES });
        chrome.alarms.create('pawsoff_pb_dnr_reconcile', { periodInMinutes: 1 });
      } catch (_) { /* ignore */ }
    });
  } catch (_) { /* silent */ }

  // Re-sync DNR whenever the PixelBlock settings or master switch change, so the
  // network-level block follows the toggle live (not just on restart).
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      try {
        if (area !== 'local') return;
        if (changes[PB_SETTINGS_KEY] || changes[MASTER_KEY]) syncBaselineRules();
        if (changes[MASTER_KEY]) { syncEasyPrivacyRuleset(); syncActionIcon(); syncEasyPrivacyDeltaRules(); }
        if (changes[DELTA_ENABLED_KEY] || changes[DELTA_SHADOW_KEY]) syncEasyPrivacyDeltaRules();
      } catch (err) {
        logRecord('dnr_onchanged_error', { message: err && err.message });
      }
    });
  } catch (_) { /* silent */ }

  // ── Tab activation → pre-flush DNR catches ────────────────────────────────
  // When the user switches to a tab, reconcile network-blocked trackers NOW so
  // the catch feed is populated before they open the popup. Without this, DNR
  // blocks only surface on the next alarm tick (up to 1 minute later) and the
  // popup shows 0 catches on a freshly-visited site. Debounced via timestamp
  // (NO setTimeout, MV3 service worker rule).
  try {
    let _lastTabActivation = 0;
    chrome.tabs.onActivated.addListener(function (activeInfo) {
      try {
        // Repaint the switched-to tab from its (possibly rehydrated) count first,
        // so a badge shows immediately even when reconcile finds no new blocks.
        if (activeInfo && typeof activeInfo.tabId === 'number') refreshBadge(activeInfo.tabId);
        var now = Date.now();
        if (now - _lastTabActivation < 500) return; // debounce rapid switches
        _lastTabActivation = now;
        reconcileDnrMatches();
      } catch (_) { /* silent */ }
    });
  } catch (_) { /* silent */ }

  // ── Toolbar badge lifecycle ────────────────────────────────────────────────
  // Reset the per-tab count on navigation (new page = fresh number) and
  // repopulate once the page finishes loading; clean up when a tab closes.
  try {
    chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
      try {
        if (changeInfo && (changeInfo.url || changeInfo.status === 'loading')) resetTabBadge(tabId);
        if (changeInfo && changeInfo.status === 'complete') reconcileDnrMatches();
      } catch (_) { /* silent */ }
    });
  } catch (_) { /* silent */ }
  try {
    chrome.tabs.onRemoved.addListener(function (tabId) {
      try { _tabTrackers.delete(tabId); _tabBlockedReqs.delete(tabId); _tabNavEpoch.delete(tabId); clearTabBadgeSession(tabId); } catch (_) { /* silent */ }
    });
  } catch (_) { /* silent */ }
  // SW cold start / wake from eviction → restore per-tab counts from the session
  // mirror so already-open tabs keep their badge (fire-and-forget, guarded).
  try { rehydrateBadges(); } catch (_) { /* silent */ }

  // ── Instant badge tier: observational webRequest ───────────────────────────
  // getMatchedRules is quota-limited and only retains matches ~5 minutes, so
  // polling alone is laggy and lossy. A DNR block surfaces to webRequest as
  // onErrorOccurred/ERR_BLOCKED_BY_CLIENT instantly and with no quota. Counted
  // only if the domain is in our bundled tracker map, deduped by the same
  // opaque 'd'+idx key the reconcile path emits (no domain string stored).
  // Observation only - no webRequest API → the reconcile tier still feeds the
  // badge, just slower.
  let _epDomainIndex = null; // lazy Map: tracker base domain → index into byid d
  async function loadEpDomainIndex() {
    if (_epDomainIndex) return _epDomainIndex;
    const idMap = await loadEpById();
    const m = new Map();
    const d = (idMap && idMap.d) || [];
    for (let i = 0; i < d.length; i++) m.set(d[i], i);
    _epDomainIndex = m;
    return _epDomainIndex;
  }
  async function onBlockedRequest(tabId, url) {
    try {
      const epoch0 = tabEpoch(tabId); // captured before any await
      const psl = (typeof self !== 'undefined') && self.PawsOffPSL;
      if (!psl || !psl.getBaseDomain) return; // PSL not loaded → stand down
      const idx = await loadEpDomainIndex();
      const key = blockedKeyForUrl(url, idx, psl.getBaseDomain);
      if (!key) return;
      // The request may have been in flight for the PREVIOUS page - if the tab
      // navigated while we awaited the domain index, this block belongs to a
      // page that's no longer showing; don't let it bump the new page's count.
      if (tabEpoch(tabId) !== epoch0) return;
      bumpBlockedReqs(_tabBlockedReqs, tabId); // every blocked REQUEST (popup stats)
      const before = tabBadgeCount(tabId);
      const after = addTrackers(_tabTrackers, tabId, [key]);
      if (after !== before) refreshBadge(tabId); // repaint only on DISTINCT change
      persistTabBadge(tabId); // counter moved every time → always mirror
    } catch (_) { /* silent */ }
  }
  try {
    if (chrome.webRequest && chrome.webRequest.onErrorOccurred) {
      chrome.webRequest.onErrorOccurred.addListener(function (details) {
        try {
          if (!details || details.error !== 'net::ERR_BLOCKED_BY_CLIENT') return;
          if (typeof details.tabId !== 'number' || details.tabId < 0) return;
          onBlockedRequest(details.tabId, details.url);
        } catch (_) { /* silent */ }
      }, { urls: ['http://*/*', 'https://*/*'] });
    }
  } catch (_) { /* silent */ }

  let _lastDnrPoll = 0;
  let _reconcileInFlight = null;
  // Chrome quota: getMatchedRules allows only 20 calls per 10 minutes (user-
  // gesture calls exempt); past it every call fails. 45s spacing caps unforced
  // polls at ~13/10min, leaving headroom for popup-forced (gesture) calls. The
  // badge no longer depends on this poll (webRequest tier is instant) - this
  // paces the catch-feed/counter reconcile.
  const DNR_POLL_MIN_MS = 45000;
  // Serialize: alarm + tab-switch + popup can all trigger a reconcile at once.
  // Concurrent runs would double-read getMatchedRules and race _lastDnrPoll /
  // the counter writes. Coalesce overlapping calls onto one in-flight promise.
  // `force` (popup open - a user gesture, quota-exempt) bypasses the spacing.
  function reconcileDnrMatches(force) {
    if (_reconcileInFlight) return _reconcileInFlight;
    if (!force && _lastDnrPoll && Date.now() - _lastDnrPoll < DNR_POLL_MIN_MS) return Promise.resolve();
    _reconcileInFlight = _reconcileDnrMatchesImpl().finally(function () { _reconcileInFlight = null; });
    return _reconcileInFlight;
  }
  async function _reconcileDnrMatchesImpl() {
    try {
      if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.getMatchedRules) return;
      const { rulesMatchedInfo = [] } = await chrome.declarativeNetRequest.getMatchedRules({ minTimeStamp: _lastDnrPoll });
      _lastDnrPoll = Date.now();
      const perProvider = {};
      let dnrTotal = 0;
      const epByTab = new Map(); // EasyPrivacy network-tier matches grouped by tab
      let epTotal = 0;
      for (const m of rulesMatchedInfo) {
        const id = m.rule.ruleId;
        if (m.rule.rulesetId === EASYPRIVACY_RULESET_ID) {
          epTotal += 1;
          const tabId = (typeof m.tabId === 'number') ? m.tabId : -1;
          if (!epByTab.has(tabId)) epByTab.set(tabId, new Set());
          const set = epByTab.get(tabId);
          if (set.size < 12) set.add(id); // cap distinct labels written per poll
          continue;
        }
        // EasyPrivacy DELTA (dynamic band 20000-29999): same tier as the
        // static ruleset above, just a live-sourced rule instead of a bundled
        // one - without this branch a delta match falls through to the
        // PixelBlock check below (id - DNR_RULE_ID_BASE never matches a
        // provider) and silently vanishes from the badge/catch-feed even
        // though DNR already blocked it.
        if (id >= DELTA_ID_BASE && id <= DELTA_ID_MAX) {
          epTotal += 1;
          const tabId = (typeof m.tabId === 'number') ? m.tabId : -1;
          if (!epByTab.has(tabId)) epByTab.set(tabId, new Set());
          const set = epByTab.get(tabId);
          if (set.size < 12) set.add(id);
          continue;
        }
        if (id < DNR_RULE_ID_BASE) continue;
        const provider = PIXELBLOCK_PROVIDERS.find((p) => p.dnrIndex === id - DNR_RULE_ID_BASE);
        if (provider) { perProvider[provider.id] = (perProvider[provider.id] || 0) + 1; dnrTotal += 1; }
      }

      // EasyPrivacy network tier: bump the all-time counter and surface each
      // blocked tracker in the per-site catch feed (hashed origin only).
      if (epTotal) {
        try {
          const s = await chrome.storage.local.get(NET_TOTAL_KEY);
          const cur = (s && typeof s[NET_TOTAL_KEY] === 'number') ? s[NET_TOTAL_KEY] : 0;
          await chrome.storage.local.set({ [NET_TOTAL_KEY]: cur + epTotal });
        } catch (_) { /* silent */ }
        try { await writeNetworkCatches(epByTab); } catch (_) { /* silent */ }
      }
      if (!dnrTotal) return;

      // Network-level (DNR) blocks feed the same monotonic counter the popup
      // displays and the DOM tier increments (__pawsOff_pb_total_blocked). The
      // two tiers are disjoint - the DOM tier stops counting a domain once its
      // DNR rule is registered - so summing them can't double-count.
      try {
        const s = await chrome.storage.local.get('__pawsOff_pb_total_blocked');
        const cur = (s && typeof s['__pawsOff_pb_total_blocked'] === 'number') ? s['__pawsOff_pb_total_blocked'] : 0;
        await chrome.storage.local.set({ '__pawsOff_pb_total_blocked': cur + dnrTotal });
      } catch (_) { /* silent */ }

      // Per-provider breakdown under the canonical event prefix getStats() reads,
      // so the per-provider view reflects DNR blocks too.
      for (const [providerId, count] of Object.entries(perProvider)) {
        const key = '__pawsOff_pixelBlock_event_' + Date.now() + '_' + rand();
        await chrome.storage.local.set({ [key]: { ts: Date.now(), provider: providerId, blocked_count: count, source: 'dnr', tracking_domains: [] } });
      }
    } catch (_) { /* silent - feedback API/permission unavailable */ }
  }

  // (Data-removal / push-rescan monitoring is not part of this free extension.)

  try {
    chrome.alarms.onAlarm.addListener((alarm) => {
      try {
        if (alarm && alarm.name === CONFIG_ALARM) {
          refreshTosConfig(false);
          refreshConsentConfig(false);    // shares the same daily refresh alarm
          refreshPixelBlockConfig(false); // provider selectors, same cadence
          refreshEasyPrivacyDelta(false); // live tracker-domain top-up, same cadence
        } else if (alarm && alarm.name === 'pawsoff_pb_dnr_reconcile') {
          reconcileDnrMatches();
        } else if (alarm && typeof alarm.name === 'string' && alarm.name.indexOf(PAUSE_ALARM_PREFIX) === 0) {
          expireSitePause(alarm.name.slice(PAUSE_ALARM_PREFIX.length)); // timed pause lapsed
        }
      } catch (err) {
        logRecord('alarm_error', { message: err && err.message });
      }
    });
  } catch (_) { /* silent */ }

  // ── Test-only export hook (inert in the service worker) ──────────────────
  // Mirrors the consent-ghost / collector pattern: exposes pure, side-effect-
  // free helpers to the Node test harness ONLY when self.__pawsOff_TEST is set.
  // The real MV3 service worker never sets that flag, so this is dead weight in
  // production and changes no shipping behaviour.
  try {
    if (typeof self !== 'undefined' && self.__pawsOff_TEST) {
      self.__pawsOff_backgroundInternals = {
        compareVersions: compareVersions,
        base64ToBytes: base64ToBytes,
        buildProviderRule: buildProviderRule,
        isValidRuleId: isValidRuleId,
        sanitizeRules: sanitizeRules,
        isPlainObject: isPlainObject,
        hasRequiredArrays: hasRequiredArrays,
        hasRequiredSections: hasRequiredSections,
        validateConfig: validateConfig,
        validateConsentConfig: validateConsentConfig,
        validatePixelBlockConfig: validatePixelBlockConfig,
        canVerifySignatures: canVerifySignatures,
        PINNED_PUBLIC_KEY_JWK: PINNED_PUBLIC_KEY_JWK,
        shouldAdoptConfig: shouldAdoptConfig,
        validateDeltaConfig: validateDeltaConfig,
        computeDeltaBudget: computeDeltaBudget,
        planDeltaRules: planDeltaRules,
        DELTA_ID_BASE: DELTA_ID_BASE,
        DELTA_ID_MAX: DELTA_ID_MAX,
        DELTA_PRIORITY: DELTA_PRIORITY,
        MAX_DELTA_RULES: MAX_DELTA_RULES,
        DELTA_RESOURCE_TYPES: DELTA_RESOURCE_TYPES,
        DELTA_ALLOWED_RESOURCE_TYPES: DELTA_ALLOWED_RESOURCE_TYPES,
        syncEasyPrivacyDeltaRules: syncEasyPrivacyDeltaRules,
        bothResponsesOk: bothResponsesOk,
        fnvHash: fnvHash,
        topOriginHashFromSender: topOriginHashFromSender,
        normAllowHost: normAllowHost,
        allowRuleHash: allowRuleHash,
        sitePauseRuleId: sitePauseRuleId,
        domainAllowRuleId: domainAllowRuleId,
        buildSitePauseRule: buildSitePauseRule,
        buildDomainAllowRule: buildDomainAllowRule,
        handleAllowMessage: handleAllowMessage,
        allocateRuleId: allocateRuleId,
        keyForHost: keyForHost,
        keyForDomain: keyForDomain,
        badgeText: badgeText,
        addTrackers: addTrackers,
        dedupKeyForRule: dedupKeyForRule,
        blockedKeyForUrl: blockedKeyForUrl,
        bumpBlockedReqs: bumpBlockedReqs,
        pauseAlarmName: pauseAlarmName,
        tabEpoch: tabEpoch,
        bumpTabEpoch: bumpTabEpoch,
        normalizeIdMap: normalizeIdMap,
        ALLOW_PRIORITY: ALLOW_PRIORITY,
        ALLOW_PAUSE_ID_BASE: ALLOW_PAUSE_ID_BASE,
        ALLOW_PAUSE_ID_SPAN: ALLOW_PAUSE_ID_SPAN,
        ALLOW_DOMAIN_ID_BASE: ALLOW_DOMAIN_ID_BASE,
        ALLOW_DOMAIN_ID_SPAN: ALLOW_DOMAIN_ID_SPAN,
        EASYPRIVACY_RULESET_ID: EASYPRIVACY_RULESET_ID,
        NET_TOTAL_KEY: NET_TOTAL_KEY,
        DNR_RULE_ID_BASE: DNR_RULE_ID_BASE,
        DNR_ID_MIN: DNR_ID_MIN,
        DNR_ID_MAX: DNR_ID_MAX,
        TRACKING_DOMAINS: TRACKING_DOMAINS,
        PIXELBLOCK_PROVIDERS: PIXELBLOCK_PROVIDERS,
        VERSION: VERSION,
      };
    }
  } catch (_) { /* ignore */ }

}());
