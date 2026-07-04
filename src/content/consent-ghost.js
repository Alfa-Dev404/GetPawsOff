/**
 * consent-ghost.js - PawsOff ConsentGhost
 *
 * Content script: silently auto-rejects cookie consent banners before the
 * user sees them. Runs on every page via Manifest V3.
 *
 * Public API: window.__pawsOff_consentGhost_init()
 * Rules: IIFE, try/catch around every async fn, no setTimeout/setInterval in
 * the background service worker (content scripts are exempt - they run in
 * the page process), all window props namespaced window.__pawsOff_*, silent
 * failures only (errors → chrome.storage.local, never surfaced on the host
 * page), never mutate or remove host DOM beyond clicking a verified reject
 * control, never log user PII.
 */

(function () {
  'use strict';

  // ── Double-run guard ───────────────────────────────────────────────────────
  // Same extension injected twice into one frame shares the isolated world, so
  // the namespace persists and this guard is authoritative.
  if (typeof window.__pawsOff_consentGhost_init === 'function') return;

  // ── Internal namespace on window ────────────────────────────────────────────
  // These live in the content script's isolated world, not the page's global,
  // so hostile page scripts cannot read or mutate them.
  window.__pawsOff_consentGhost_startedAt = Date.now(); // ms since epoch, set on init
  window.__pawsOff_consentGhost_handled   = false;      // true once a banner is acted on
  window.__pawsOff_consentGhost_observer  = null;       // MutationObserver reference

  // Synchronous in-flight lock, set BEFORE any await so concurrent observer
  // batches cannot both pass the `handled` check at the same instant. Unlike
  // `handled` (permanent for the page view) this resets after each call.
  // Kept as a closure variable (not on window) so nothing outside this IIFE,
  // including other PawsOff modules, can touch it.
  let _scanning = false;

  // Generation guard (closes the double-click race the bare `_scanning` boolean
  // left open, TODO v2 2c). Every scan captures the current generation when it
  // takes the lock; a navigation/disable reset INVALIDATES any in-flight scan by
  // bumping the generation. A scan that finds its generation stale after an
  // await bails BEFORE clicking, and refuses to clear the newer scan's lock in
  // its `finally`. Pure + exposed via __test.
  function makeScanGuard() {
    let gen = 0;
    return {
      capture: function () { return gen; },
      invalidate: function () { return ++gen; },
      isCurrent: function (g) { return g === gen; },
    };
  }
  const _scanGuard = makeScanGuard();

  // ── Observer lifetime ───────────────────────────────────────────────────────
  // Torn down after 15s so it never leaks on pages that go quiet. setTimeout is
  // fine here - content scripts run in the page process, not the evictable
  // service worker - and a quiet page never fires a mutation callback to check
  // Date.now() against, so a real timer is the only thing that works.
  const OBSERVER_LIFETIME_MS = 15_000;

  // ── Log storage tuning ─────────────────────────────────────────────────────
  const LOG_KEY_PREFIX = '__pawsOff_consentGhost_log_';
  const LOG_MAX_ENTRIES = 200;     // retention cap across all frames/tabs
  const LOG_PRUNE_SAMPLE = 0.1;    // prune on ~1 in 10 writes (see logToStorage)
  // Monotonic reject counter, never pruned, so the popup total never plateaus.
  const CG_TOTAL_KEY = '__pawsOff_cg_total_rejected';

  // ── Reload-loop breaker ────────────────────────────────────────────────────
  // Some CMPs reload the page to apply a consent choice (e.g. check24.de). The
  // "handled" guard lives only in page memory, so a naive implementation would
  // reject → reload → reject forever. We stamp a per-origin key after acting;
  // the next load skips auto-reject for a short cooldown. Host is a one-way
  // FNV-1a hash, local-only.
  const ACTED_PREFIX = '__pawsOff_cg_acted_';
  const REJECT_COOLDOWN_MS = 15000; // sliding window for the reload-loop guard
  const LOOP_MAX_REJECTS = 3;       // rejects per origin per window before standing down (a clear reload loop)

  // ── Banner-regeneration breaker (nav-resistant, synchronous) ────────────────
  // Some CMPs don't reload, they re-inject a fresh banner after each dismissal
  // (focus.de/contentpass, repubblica.it), often via a pushState that wipes the
  // reload guard's sessionStorage budget. That guard is async chrome.storage,
  // so a sub-second re-inject loop races past it. This one counts rejections
  // per origin in sessionStorage instead (synchronous, survives SPA nav), and
  // stands down for a cool-off once a loop is confirmed rather than flickering
  // forever - the right response to a pay-or-consent wall with no free reject.
  const REGEN_KEY = 'pawsoff_cg_regen';
  const REGEN_MAX_REJECTS = 3;      // rejects per origin within the window before standing down
  const REGEN_WINDOW_MS = 15000;    // sliding window for counting rejections
  const REGEN_STANDDOWN_MS = 60000; // cool-off once the loop is confirmed

  // ── Enable/disable (driven by the popup + options UI) ──────────────────────
  // The UI writes a single boolean flag; defaults to enabled on a fresh
  // install. A storage READ failure instead sets _stateLoadFailed and stands
  // down (see below) - we can't trust an incomplete pause/disable state, so
  // fail-open here means "don't act," not "protect anyway." `_disabled` is
  // cached so the synchronous scan path can short-circuit without an await.
  const DISABLED_KEY = '__pawsOff_consentGhost_disabled';
  const ALLOW_KEY = '__pawsOff_allowlist';
  let _disabled = false;
  let _sitePaused = false;
  let _stateLoadFailed = false; // couldn't read pause/disable state → stand down
  let _cmpApiRequested = false;
  let _cmpApiVisibleBefore = [];

  /**
   * Load the disabled flag once at init. Fail-open: any error → stay enabled.
   * @returns {Promise<void>}
   */
  async function loadDisabledFlag() {
    try {
      const s = await chrome.storage.local.get([DISABLED_KEY, ALLOW_KEY]);
      _disabled = s && s[DISABLED_KEY] === true;
      const allow = s && s[ALLOW_KEY];
      const oh = hashHost(location.hostname);
      const site = allow && allow.sites && oh ? allow.sites[oh] : null;
      _sitePaused = !!(site && site.paused > 0);
      _stateLoadFailed = false; // read succeeded
    } catch (_) {
      // Can't read pause/disable state → stand down rather than assume enabled
      // and act on an unknown site.
      _disabled = false;
      _sitePaused = false;
      _stateLoadFailed = true;
    }
  }

  function protectionPaused() {
    return _disabled || _sitePaused || _stateLoadFailed;
  }

  function requestCmpApiMain() {
    try {
      if (protectionPaused() || _cmpApiRequested || window.top !== window) return;
      _cmpApiVisibleBefore = activeConfig.filter((f) => {
        try {
          const el = document.querySelector(f.containerSelector);
          return !!el && isVisible(el);
        } catch (_) { return false; }
      }).map((f) => f.name);
      _cmpApiRequested = true;
      chrome.runtime.sendMessage({ type: 'pawsoff_consentGhost_runMain' }, (resp) => {
        try {
          void chrome.runtime.lastError;
          if (!resp || !resp.ok) _cmpApiRequested = false;
        } catch (_) { _cmpApiRequested = false; }
      });
    } catch (_) {
      _cmpApiRequested = false;
    }
  }

  // ── Master selector config ─────────────────────────────────────────────────
  //   containerSelector → confirms the framework is active on this page.
  //   rejectSelectors   → tried in order; first visible, non-accept match wins.
  //   pierceShadow      → walk open shadow roots when matching (web-component CMPs).
  //   Never list an "accept" selector here.
  //
  // This array is the bundled/offline fallback. At runtime loadRemoteConfig()
  // asks background.js for a signed+verified consent-config.json and, if
  // valid, swaps it into `activeConfig` - selector breakage can be patched
  // without a Web Store re-review (remote data is allowed under MV3, remote
  // code is not). The text fallback below is multilingual (REJECT_PHRASES_BY_LANG
  // / ACCEPT_PHRASES_BY_LANG), keyed off document.documentElement.lang →
  // navigator.language → every language as a last resort.
  const BUNDLED_CONSENT_CONFIG = [

    // ── 1. OneTrust ─────────────────────────────────────────────────────────
    {
      name: 'OneTrust',
      containerSelector: '#onetrust-banner-sdk, #onetrust-consent-sdk, .onetrust-pc-dark-filter',
      rejectSelectors: [
        '#onetrust-reject-all-handler',
        '.onetrust-reject-btn-handler',
        'button[class*="onetrust-reject"]',
        // '#onetrust-pc-btn-handler' is "Save Settings"/"Confirm My Choices" -
        // persists whatever toggles are currently set, not a reject. Never click it.
        '.ot-pc-refuse-all-handler',
      ],
    },

    // ── 2. CookieYes ────────────────────────────────────────────────────────
    {
      name: 'CookieYes',
      containerSelector: '.cky-consent-container, .cky-modal, #cky-consent-elem',
      rejectSelectors: [
        '.cky-btn-reject',
        '[data-cky-tag="reject-button"]',
        'button[aria-label*="Reject"]',
      ],
    },

    // ── 3. Cookiebot ────────────────────────────────────────────────────────
    // Cookiebot often ships the dialog hidden in the initial HTML and reveals
    // it by toggling display/class - handled by the attribute-aware observer,
    // not by added-node detection.
    {
      name: 'Cookiebot',
      containerSelector: '#CybotCookiebotDialog, #cookiebanner, .cookiebanner',
      rejectSelectors: [
        '#CybotCookiebotDialogBodyButtonDecline',
        '[id*="CybotCookiebot"][id*="Decline"]',
        '.CybotCookiebotDialogBodyButton[onclick*="decline"]',
        'a#CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll',
      ],
    },

    // ── 4. TrustArc ─────────────────────────────────────────────────────────
    {
      name: 'TrustArc',
      containerSelector: '#truste-consent-content, .truste_overlay, #trustarc-irb-container',
      rejectSelectors: [
        '.truste-reject-all-btn',
        '.pdynamicbutton .rejectBtn',
        // 'a[href*="rejectAll"]' is a real anchor and clicking it can navigate
        // the page; the accept-veto won't catch a navigation, so we rely on
        // the class-based selectors above instead.
        '#trustarc-irb-btn-reject',
      ],
    },

    // ── 5. Quantcast Choice ──────────────────────────────────────────────────
    {
      name: 'Quantcast',
      containerSelector: '#qc-cmp2-ui, .qc-cmp2-container',
      rejectSelectors: [
        'button[data-id="reject-all"]',
        '.qc-cmp2-summary-buttons button[mode="secondary"]',
        // Removed the broad '.qc-cmp2-button:not([mode="primary"])', it also
        // matched "More options"/"Manage", risking a click on the wrong control.
        // The two specific reject selectors above are enough.
      ],
    },

    // ── 6. Osano ────────────────────────────────────────────────────────────
    {
      name: 'Osano',
      containerSelector: '.osano-cm-window, .osano-cm-dialog',
      rejectSelectors: [
        '.osano-cm-deny',
        '.osano-cm-decline',
        'button.osano-cm-btn[data-action="deny"]',
      ],
    },

    // ── 7. Didomi ────────────────────────────────────────────────────────────
    // window.Didomi is only present on sites actually running the Didomi SDK
    // (Le Monde runs its own gdpr-lmd CMP instead, see below). The notice uses
    // #didomi-host as the host element; the disagree button is identified by
    // id or data-testid. `.didomi-components-button--variant-link-secondary`
    // is the secondary-style CTA for "Disagree & Close" in the newer SDK layout.
    {
      name: 'Didomi',
      containerSelector: '#didomi-host, #didomi-notice, .didomi-popup-container',
      rejectSelectors: [
        '#didomi-notice-disagree-button',
        '[data-testid="didomi-notice-disagree-button"]',
        // Deliberately no 'button#didomi-notice-learn-more-button ~ button':
        // that matches every sibling after "learn more" blindly, and in many
        // Didomi layouts that sibling is Agree/Accept - would opt the user in.
        '.didomi-components-button--variant-link-secondary',
        // Modern Didomi SDK (v2) uses data-testid on the disagree CTA; some
        // publishers override the id, so also match the SDK class pattern.
        // Deliberately no onclick*="Didomi.notice.hide" match: that API call
        // only dismisses the notice UI, it doesn't confirm the user rejected
        // tracking - behavior on a bare dismiss varies by publisher config,
        // so it's not a verified reject and we stand down rather than risk
        // it acting like a soft-accept.
        '[data-purpose="disagree"]',
      ],
    },

    // ── 7b. Le Monde / gdpr-lmd ──────────────────────────────────────────────
    // Le Monde runs an in-house CMP under the `gdpr-lmd-*` CSS namespace,
    // deployed across the whole Le Monde Group (telerama.fr, etc.) - not
    // Didomi, despite similar branding. Reject:
    // <a class="gdpr-lmd-wall__refuse-link js-gdpr-deny-subscribe"
    //    data-gdpr-expression="denyAll">Reject all cookies</a>.
    // The reject class includes `js-gdpr-deny-subscribe` - on Le Monde,
    // rejecting cookies routes into their subscription flow. We still
    // complete the privacy action; the subscribe prompt after is the
    // publisher's own design, not a PawsOff failure.
    {
      name: 'LeMonde / gdpr-lmd',
      containerSelector: '.gdpr-lmd-wall, .gdpr-lmd-standard',
      rejectSelectors: [
        // Primary: the visually prominent top-of-wall "Reject all cookies" link
        '.gdpr-lmd-wall__refuse-link',
        '[data-gdpr-expression="denyAll"]',
        // Fallback class used in some Le Monde Group sub-brands
        '.js-gdpr-deny-subscribe',
      ],
    },

    // ── 8. Usercentrics ──────────────────────────────────────────────────────
    // Renders its UI inside an open shadow root on <uc-ui-container> /
    // #usercentrics-root. document.querySelector can't cross that boundary,
    // so this entry is flagged pierceShadow:true and matching goes through
    // scopedQueryAll(), which walks shadow roots.
    {
      name: 'Usercentrics',
      pierceShadow: true,
      containerSelector: '#usercentrics-root, uc-ui-container',
      rejectSelectors: [
        '[data-testid="uc-deny-all-button"]',
        'button#uc-btn-deny-all',
        '[id="usercentrics-reject-all"]',
        // Deliberately no 'button[data-testid="uc-save-settings-button"]' -
        // that's "Save Settings", it persists the current toggles, not a reject.
      ],
    },

    // ── 8b. Sourcepoint ──────────────────────────────────────────────────────
    // Used by many large EU publishers (Spiegel, Bild, The Guardian, etc.).
    // Renders in a container/iframe whose id starts with "sp_message_container_".
    // Reject buttons carry a stable "sp_choice_type_N" class - type 13 =
    // "Reject all" on most configs. Some publishers hide reject behind a
    // "Preferences" second layer with no one-click reject; the heuristic tier
    // below is the backstop for those.
    {
      name: 'Sourcepoint',
      containerSelector: '[id^="sp_message_container"], [class*="sp_message_container"], .sp_veil + [class*="sp_message"], .message-stacks, .message-overlay, .sp_choice_type_13',
      rejectSelectors: [
        // ── Stable Sourcepoint choice classes (publisher-config-independent) ──
        'button.sp_choice_type_13',             // "Reject all" (most Sourcepoint configs)
        'button.sp_choice_type_REJECT_ALL',
        '.sp_choice_type_REJECT_ALL',
        '.sp_choice_type_13',
        '[data-sp-choice-type="13"]',           // data-attr variant
        '[data-sp_choice_type="13"]',
        // ── English title / aria reject labels (Guardian, WaPo, Bloomberg…) ──
        'button[aria-label="Reject All" i]',
        'button[aria-label*="Reject all" i]',
        'button[aria-label*="Reject" i]',
        'button[title="Reject All" i]',
        'button[title*="Reject all" i]',
        'button[title*="Reject" i]',
        'button[title*="Disagree" i]',
        'button[aria-label*="Disagree" i]',
        'button[title*="Do not consent" i]',
        'button[aria-label*="Do not consent" i]',
        'button[title*="Decline" i]',
        'button[aria-label*="Decline" i]',
        'button[title*="Refuse" i]',
        'button[aria-label*="Refuse" i]',
        'button[title*="No, thank" i]',         // Guardian custom skin
        'button[aria-label*="No, thank" i]',
        'button[title*="Continue without accepting" i]',
        'button[aria-label*="Continue without accepting" i]',
        'button[title*="Necessary only" i]',
        'button[title*="Only necessary" i]',
        'button[title*="Essential only" i]',
        // ── High-volume localized reject titles (DE/FR/ES/IT/NL/DA/SV) ──
        'button[title*="Ablehnen" i]',
        'button[aria-label*="Ablehnen" i]',
        'button[title*="Tout refuser" i]',
        'button[aria-label*="Tout refuser" i]',
        'button[title*="Refuser" i]',
        'button[title*="Rechazar" i]',
        'button[title*="Rifiuta" i]',
        'button[title*="Weigeren" i]',
        'button[title*="Afvis" i]',
        'button[title*="Neka" i]',
        // ── Generic data hook (last resort; still accept-vetoed) ──
        '[data-action="reject"]',
      ],
    },

    // ── 8a. Check24 (bespoke in-house CMP) ────────────────────────────────
    // Custom banner: .c24-cookie-consent-notice. Reject = "Nur notwendige
    // Cookies" → a.c24-cookie-consent-functional (functional-only consent).
    // Accept label "geht klar" matches no generic accept phrase, so the
    // accept-veto can't recognise it - an explicit named rule is the safe way.
    {
      name: 'Check24',
      containerSelector: '.c24-cookie-consent-notice',
      rejectSelectors: [
        'a.c24-cookie-consent-functional',
      ],
    },

    // ── 8b. consentmanager.net (#cmpbox), common on DE/EU sites ─────────────
    // Reject ("Ablehnen") is a.cmpboxbtnno, often a plain <a href="#"> with
    // no role="button" - a button-only text fallback would miss it.
    {
      name: 'ConsentManager.net',
      containerSelector: '#cmpbox, .cmpbox, [id^="cmpbox"], [class*="cmpbox"], #cmpwrapper, .cmpwrapper',
      rejectSelectors: [
        'a.cmpboxbtnno',
        'button.cmpboxbtnno',
        '.cmpboxbtn.cmpboxbtnno',
        '.cmpboxbtnno',
        '[data-cmp-action="reject"]',
      ],
    },

    // ── 9. Generic / GDPR catch-all ─────────────────────────────────────────
    // Most specific → most generic; accept-only buttons never listed. The
    // accept-veto matters most here, since these selectors are broad enough
    // to incidentally match an accept control.
    {
      name: 'Generic',
      containerSelector: [
        '[class*="cookie-banner"]',
        '[class*="cookie-consent"]',
        '[id*="cookie-banner"]',
        '[id*="gdpr"]',
        '[role="dialog"][aria-label*="cookie"]',
        '[role="dialog"][aria-label*="Cookie"]',
        '[role="dialog"][aria-label*="consent"]',
      ].join(', '),
      rejectSelectors: [
        'button[id*="reject-all"]',
        'button[id*="decline-all"]',
        'button[class*="reject-all"]',
        'button[class*="decline-all"]',
        '[aria-label*="Reject all" i]',
        '[aria-label*="Decline all" i]',
        'button[data-consent-reject]',
        '[data-action="reject"]',
        '[data-action="decline"]',
        // Le Monde / gdpr-lmd family safety net for sub-brands not caught by
        // the named entry above.
        '[data-gdpr-expression="denyAll"]',
      ],
    },
  ];

  // ── Text-based fallback labels (last resort within a detected container) ──
  // Phrases are keyed by 2-letter language code. buildPatterns() picks the
  // page language (document.documentElement.lang → navigator.language) and
  // always appends every other language as a last-resort tier, so language
  // detection failing never costs us a reject button.
  //
  // Accept phrases are localised too, on purpose: the accept-veto is
  // worthless on a non-English page if it only knows English accept words -
  // that's exactly how a French banner could get mis-clicked. Reject and
  // accept coverage grow together for this reason.
  const REJECT_PHRASES_BY_LANG = {
    en: ['reject all', 'decline all', 'refuse all', 'reject', 'decline', 'refuse', 'essential only', 'necessary only', 'do not accept', 'do not consent', 'do not agree', 'no, thank you', 'no thank you', 'no thanks', 'continue without accepting'],
    fr: ['tout refuser', 'continuer sans accepter', 'refuser', 'je refuse', 'tout rejeter', 'refuser tout', 'refuser et fermer'],
    de: ['alle ablehnen', 'alles ablehnen', 'ablehnen', 'nicht akzeptieren', 'nur notwendige', 'nur erforderliche'],
    es: ['rechazar todo', 'rechazar', 'no aceptar', 'rechazar todas', 'solo esenciales'],
    it: ['rifiuta tutto', 'rifiuta', 'non accettare', 'rifiuta tutti', 'solo necessari'],
    nl: ['alles weigeren', 'weigeren', 'alles afwijzen', 'afwijzen', 'alleen noodzakelijke'],
    pt: ['rejeitar tudo', 'rejeitar', 'recusar tudo', 'recusar', 'apenas essenciais'],
    pl: ['odrzuć wszystkie', 'odrzuć', 'odrzucam', 'tylko niezbędne'],
    da: ['afvis alle', 'afvis', 'kun nødvendige'],
    sv: ['avvisa alla', 'avvisa', 'neka alla', 'endast nödvändiga'],
    fi: ['hylkää kaikki', 'hylkää', 'vain välttämättömät'],
    nb: ['avvis alle', 'avvis', 'avslå alle', 'kun nødvendige'],
    cs: ['odmítnout vše', 'odmítnout', 'pouze nezbytné'],
    sk: ['odmietnuť všetko', 'odmietnuť', 'len nevyhnutné'],
    ro: ['respinge tot', 'respinge', 'refuz', 'doar esențiale'],
    hu: ['összes elutasítása', 'elutasítás', 'elutasítom', 'csak szükséges'],
    el: ['απόρριψη όλων', 'απόρριψη', 'μόνο απαραίτητα'],
    ru: ['отклонить все', 'отклонить', 'отказаться', 'только необходимые'],
    uk: ['відхилити все', 'відхилити', 'лише необхідні'],
    tr: ['tümünü reddet', 'reddet', 'sadece gerekli'],
    bg: ['отхвърли всички', 'отхвърли', 'само необходими'],
    hr: ['odbij sve', 'odbij', 'samo nužne'],
    sl: ['zavrni vse', 'zavrni', 'samo nujne'],
    et: ['keeldu kõigist', 'keeldu', 'ainult vajalikud'],
    lt: ['atmesti visus', 'atmesti', 'tik būtini'],
    lv: ['noraidīt visu', 'noraidīt', 'tikai nepieciešamie'],
    ga: ['diúltaigh do gach rud', 'diúltaigh'],
    ja: ['すべて拒否', '拒否', '同意しない'],
    ko: ['모두 거부', '거부', '동의 안 함'],
    zh: ['全部拒绝', '拒绝', '拒绝全部', '不同意'],
    ar: ['رفض الكل', 'رفض', 'عدم الموافقة'],
    he: ['דחה הכל', 'דחה', 'לא מסכים'],
    id: ['tolak semua', 'tolak', 'hanya yang penting'],
    th: ['ปฏิเสธทั้งหมด', 'ปฏิเสธ'],
    vi: ['từ chối tất cả', 'từ chối'],
  };

  const ACCEPT_PHRASES_BY_LANG = {
    en: ['accept all', 'accept', 'agree', 'i agree', 'allow all', 'allow cookies', 'allow', 'ok', 'got it', 'agree & close'],
    fr: ['tout accepter', 'accepter', "j'accepte", 'accepter et fermer', 'autoriser', "j'autorise"],
    de: ['alle akzeptieren', 'akzeptieren', 'zustimmen', 'ich stimme zu', 'alle annehmen', 'einverstanden'],
    es: ['aceptar todo', 'aceptar', 'estoy de acuerdo', 'permitir', 'de acuerdo'],
    it: ['accetta tutto', 'accetta', 'sono d\'accordo', 'consenti', 'accetto'],
    nl: ['alles accepteren', 'accepteren', 'akkoord', 'toestaan', 'ik ga akkoord'],
    pt: ['aceitar tudo', 'aceitar', 'concordo', 'permitir', 'aceito'],
    pl: ['zaakceptuj wszystkie', 'akceptuję', 'zgadzam się', 'zezwól'],
    da: ['accepter alle', 'accepter', 'tillad alle', 'jeg accepterer'],
    sv: ['acceptera alla', 'acceptera', 'tillåt alla', 'godkänn'],
    fi: ['hyväksy kaikki', 'hyväksy', 'salli kaikki'],
    nb: ['godta alle', 'godta', 'tillat alle', 'aksepter'],
    cs: ['přijmout vše', 'přijmout', 'souhlasím'],
    sk: ['prijať všetko', 'prijať', 'súhlasím'],
    ro: ['acceptă tot', 'accept', 'sunt de acord'],
    hu: ['összes elfogadása', 'elfogadás', 'elfogadom'],
    el: ['αποδοχή όλων', 'αποδοχή', 'σ��μφωνώ'],
    ru: ['принять все', 'принять', 'согласен', 'разрешить'],
    uk: ['прийняти все', 'прийняти', 'погоджуюсь'],
    tr: ['tümünü kabul et', 'kabul et', 'kabul ediyorum'],
    bg: ['приеми всички', 'приеми', 'съгласен съм'],
    hr: ['prihvati sve', 'prihvati', 'slažem se'],
    sl: ['sprejmi vse', 'sprejmi', 'strinjam se'],
    et: ['nõustu kõigiga', 'nõustu', 'luba kõik'],
    lt: ['priimti visus', 'priimti', 'sutinku'],
    lv: ['pieņemt visu', 'pieņemt', 'piekrītu'],
    ga: ['glac le gach rud', 'glac', 'aontaím'],
    ja: ['すべて同意', 'すべて受け入れる', '同意する', '許可'],
    ko: ['모두 동의', '동의', '모두 허용', '수락'],
    zh: ['全部接受', '接受', '同意', '全部同意', '允许'],
    ar: ['قبول الكل', 'قبول', 'أوافق', 'موافق'],
    he: ['אשר הכל', 'אשר', 'מסכים', 'קבל'],
    id: ['terima semua', 'terima', 'setuju', 'izinkan'],
    th: ['ยอมรับทั้งหมด', 'ยอมรับ', 'อนุญาต'],
    vi: ['chấp nhận tất cả', 'chấp nhận', 'đồng ý'],
  };

  // Escape a literal phrase for use inside a RegExp.
  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Build an anchored, whitespace-flexible regex from a list of literal phrases.
  // ^…$ keeps matching to the WHOLE visible label (so "Accept" never matches
  // inside "Do not accept"); \s* lets "rejectall" / "reject  all" both match.
  function phrasesToRegexes(phrases) {
    const out = [];
    for (const p of phrases) {
      try {
        const body = escapeRe(p.toLowerCase()).replace(/\s+/g, '\\s*');
        out.push(new RegExp('^' + body + '$', 'i'));
      } catch (_) { /* skip malformed phrase */ }
    }
    return out;
  }

  // Detect the page language: explicit <html lang> first, then navigator, then
  // none. We only need the 2-letter primary subtag (e.g. "fr" from "fr-FR").
  function detectLangs() {
    const langs = [];
    try {
      const htmlLang = (document.documentElement.getAttribute('lang') || '').toLowerCase().slice(0, 2);
      if (htmlLang) langs.push(htmlLang);
    } catch (_) { /* ignore */ }
    try {
      const navLang = (navigator.language || '').toLowerCase().slice(0, 2);
      if (navLang && !langs.includes(navLang)) langs.push(navLang);
    } catch (_) { /* ignore */ }
    return langs;
  }

  // Produce the ACTIVE pattern arrays. Tier 1 = detected page language(s),
  // Tier 2 = English (the lingua franca of "Accept/Reject" buttons even abroad),
  // Tier 3 = EVERY other language (last resort so detection failure never costs
  // us a match). De-dupes languages while preserving that priority order.
  function buildPatterns(byLang) {
    const order = [];
    const add = (l) => { if (byLang[l] && !order.includes(l)) order.push(l); };
    detectLangs().forEach(add);
    add('en');
    Object.keys(byLang).forEach(add); // remaining languages, last resort
    let phrases = [];
    for (const l of order) phrases = phrases.concat(byLang[l]);
    return phrasesToRegexes(phrases);
  }

  // Tracks the page language the phrase lists were last built for, so init()
  // only rebuilds them when the language actually changes.
  let _lastBuiltLang = null;

  // ── Generic heuristic tier, OPTION B: container-scoped (safe backstop) ────
  //
  // Why this exists: named frameworks + exact-anchored text only catch CMPs we
  // know. Bespoke walls in any language slip through. This tier is the backstop.
  //
  // OPTION B (chosen over document-wide A): we FIRST detect a consent CONTAINER
  //, a banner/overlay that is fixed/sticky or high-z-index, reasonably large,
  // visible, AND whose own text mentions cookies/consent, then scan for the
  // reject button ONLY inside that container. This near-eliminates the
  // catastrophic false-positive of clicking an unrelated "Decline" elsewhere on
  // the page (e.g. a friend-request widget), because such controls don't live
  // inside a consent overlay. Trade-off: a consent banner that is NOT an overlay
  // (rare, consent UIs are overlays by nature) may be missed. We accept that:
  // for a tool people trust with Gmail, a miss is far cheaper than a wrong click.
  //
  // Still FAST + SAFE + i18n:
  //   - runs ONLY after every named framework misses (tiered; zero known-CMP cost)
  //   - container search is capped; button scan is scoped to the container
  //   - CONTAINS matching over 35-language phrase lists ("alle ablehnen" inside
  //     "Alle ablehnen und speichern")
  //   - reads visible text AND untranslated attributes (Google-Translate-proof)
  //   - 5g accept-veto in every language: never clicks an "accept"-reading label
  const MAX_CONTAINER_SCAN = 1200;      // cap on elements examined for container detection
  const MIN_CONTAINER_AREA = 12000;     // px^2 - a real banner is sizeable (~ 200x60+)
  const HIGH_Z_THRESHOLD = 100;         // z-index at/above this counts as "overlay-ish"
  const HEURISTIC_SWEEP_COOLDOWN_MS = 1500; // negative-cache window: after a sweep finds no
                                            // overlay, skip re-sweeping for this long so a
                                            // burst of unrelated mutations can't re-run the
                                            // expensive 1200-node scan on every batch.

  // Flat, language-prioritised phrase lists (lowercased) for CONTAINS matching.
  // Rebuilt per page view alongside the regex patterns.
  function flatPhrases(byLang) {
    const order = [];
    const add = (l) => { if (byLang[l] && !order.includes(l)) order.push(l); };
    detectLangs().forEach(add);
    add('en');
    Object.keys(byLang).forEach(add);
    let out = [];
    for (const l of order) out = out.concat(byLang[l].map((p) => p.toLowerCase()));
    // Longer phrases first so "tout refuser" is tested before "refuser", we
    // prefer the most specific (whole-banner) reject over a partial.
    return out.sort((a, b) => b.length - a.length);
  }
  let REJECT_PHRASES_FLAT = flatPhrases(REJECT_PHRASES_BY_LANG);
  let ACCEPT_PHRASES_FLAT = flatPhrases(ACCEPT_PHRASES_BY_LANG);

  // ── Pay-or-consent WALL veto phrases ───────────────────────────────────────
  // On cookie WALLS (Le Figaro, Bild, Spiegel, many EU publishers) the only
  // non-accept choice is "Refuse & subscribe" / "Subscribe", which does NOT
  // grant a free refusal, it sends the user to a paid subscription / paywall.
  // These labels frequently contain a reject word ("refuser et s'abonner"), so
  // without this veto our reject matcher would click them and paywall the user.
  // classifyLabel() treats a subscribe-dominant label as untouchable.
  const SUBSCRIBE_PHRASES_BY_LANG = {
    en: ['subscribe', 'subscription', 'go ad-free', 'become a member', 'get a subscription'],
    fr: ["refuser et s'abonner", "s'abonner", "m'abonner", 'abonnez-vous', 'abonnement', 'sans publicité', 's abonner'],
    de: ['abonnieren', 'jetzt abonnieren', 'pur-abo', 'pur abo', 'abo abschließen'],
    es: ['suscríbete', 'suscribirse', 'suscripción'],
    it: ['abbonati', 'abbonamento'],
    pt: ['assinar', 'assinatura'],
    nl: ['abonneren', 'abonnement', 'word lid'],
    pl: ['subskrybuj', 'subskrypcja', 'wykup abonament'],
    sv: ['prenumerera', 'prenumeration'],
    da: ['abonnér', 'abonnement'],
    nb: ['abonner', 'abonnement'],
    fi: ['tilaa', 'tilaus'],
  };
  let SUBSCRIBE_PHRASES_FLAT = flatPhrases(SUBSCRIBE_PHRASES_BY_LANG);

  // ── Pay-or-consent WALL classifier (contentpass/focus.de, Le Figaro, …) ────
  // A "wall" offers NO free reject: the only non-accept choice routes to a paid
  // subscription. Clicking a reject-looking control on these does not opt the
  // user out, it bounces them into the subscribe flow, or (contentpass) simply
  // re-injects the banner, which is the focus.de loop. The correct behaviour is
  // to STAND DOWN on detection, never click, and label it honestly in the popup.
  //
  // This function is PURE (surface text + button labels in, verdict out) so it
  // is unit-testable without a DOM. Two independent signals make a wall:
  //   1. A high-confidence vendor marker in the surface text (e.g. "contentpass")
  //     , these CMPs are pay-or-consent by construction, so we stand down even
  //      if a reject-looking control is present (it isn't a FREE reject).
  //   2. An accept/subscribe control exists AND there is NO free reject control
  //      among the surface's buttons (the generic pay-or-consent shape).
  const WALL_BRAND_HINTS = [
    'contentpass', 'content pass', 'pur-abo', 'pur abo', 'pur-abonnement',
  ];
  function surfaceLooksLikeWall(surfaceText, buttonLabels) {
    try {
      const text = (surfaceText || '').toLowerCase();
      for (let i = 0; i < WALL_BRAND_HINTS.length; i++) {
        if (text.indexOf(WALL_BRAND_HINTS[i]) !== -1) return true;
      }
      const labels = Array.isArray(buttonLabels) ? buttonLabels : [];
      let hasFreeReject = false;
      let hasAcceptOrSubscribe = false;
      for (let j = 0; j < labels.length; j++) {
        // Lowercase here so the classifier is robust even when a caller passes
        // raw labels; classifyLabel()/longestHit() match against lowercase banks.
        const l = (labels[j] || '').toLowerCase();
        if (!l) continue;
        if (looksReject(l)) hasFreeReject = true;
        if (looksAccept(l) || longestHit(l, SUBSCRIBE_PHRASES_FLAT) > 0) hasAcceptOrSubscribe = true;
      }
      return hasAcceptOrSubscribe && !hasFreeReject;
    } catch (_) {
      return false;
    }
  }

  // Page-level keyword gate: only run the heuristic if the document actually
  // mentions cookies/consent/privacy in some major language. Cheap substring
  // scan of a capped slice of body text. Prevents firing on normal pages.
  const CONSENT_PAGE_HINTS = [
    'cookie', 'consent', 'privacy', 'gdpr', 'tracking', 'datenschutz', 'cookies',
    'einwilligung', 'zustimmung', 'confidentialité', 'consentement', 'privacidad',
    'consenso', 'privacidade', 'toestemming', 'samtykke', 'zgoda', 'согласие',
  ];

  /** Lowercased combined label of an element: visible text + key attributes.
   *  Attributes (aria-label/title/value/data-*) survive Google Translate, which
   *  only rewrites visible text nodes, so checking both is translation-proof. */
  function heuristicLabel(el) {
    try {
      const parts = [
        el.innerText || el.textContent || '',
        el.getAttribute('aria-label') || '',
        el.getAttribute('title') || '',
        el.getAttribute('alt') || '',        // icon-only buttons / <input type="image">
        el.getAttribute('value') || '',
        el.getAttribute('data-testid') || '',
        el.getAttribute('data-action') || '',
        el.getAttribute('data-role') || '',
      ];
      return parts.join(' ').toLowerCase().replace(/\s+/g, ' ').trim();
    } catch (_) {
      return '';
    }
  }

  // ── Unified label classifier (fix: consistent accept-veto across tiers) ────
  // Both the selector path and the heuristic path must agree on what a button
  // "is". Two failure modes we must avoid:
  //   - anchored ^...$ matching misses "Accept All Cookies" (≠ "accept all") →
  //     the broad Generic/Quantcast selectors then click ACCEPT. Catastrophic.
  //   - plain CONTAINS vetoes "Do not accept" (contains "accept") even though it
  //     is a valid REJECT label. Guaranteed miss.
  // Resolution: CONTAINS matching for breadth, but the LONGEST matching phrase
  // from either list wins. "Accept All Cookies" → longest hit is "accept all"
  // (accept) → veto. "Do not accept" → "do not accept" (len 13) beats "accept"
  // (len 6) → reject wins → not vetoed. Length is a robust proxy for specificity.
  function longestHit(label, phrases) {
    let best = 0;
    for (const p of phrases) {
      if (p.length > best && label.includes(p)) best = p.length;
    }
    return best;
  }
  /** A subscribe/pay-wall control dominates when its phrase match is at least
   *  as specific as both reject and accept, never click it (pay-or-consent). */
  function subscribeDominates(subHit, rejectHit, acceptHit) {
    return subHit > 0 && subHit >= rejectHit && subHit >= acceptHit;
  }
  /** Classify a label as 'reject' | 'accept' | 'none' by most-specific match. */
  function classifyLabel(label) {
    if (!label) return 'none';
    const r = longestHit(label, REJECT_PHRASES_FLAT);
    const a = longestHit(label, ACCEPT_PHRASES_FLAT);
    // Pay-or-consent WALL guard: a "Refuse & subscribe" / "Subscribe" control is
    // NOT a free refusal, it sends the user to a paywall. Never click a
    // subscribe-dominant label, even when it literally contains "refuse/reject"
    // (e.g. Le Figaro's "Refuser et s'abonner"). Treat it as untouchable.
    const s = longestHit(label, SUBSCRIBE_PHRASES_FLAT);
    if (subscribeDominates(s, r, a)) return 'none';
    if (r === 0 && a === 0) return 'none';
    return r >= a ? 'reject' : 'accept'; // ties favour reject (safer for the user)
  }

  /** True if the label reads as ACCEPT and is NOT outranked by a reject phrase. */
  function looksAccept(label) {
    return classifyLabel(label) === 'accept';
  }
  /** True if the label reads as REJECT (and is at least as specific as accept). */
  function looksReject(label) {
    return classifyLabel(label) === 'reject';
  }

  // ── Multi-step ("Preferences") phrases ─────────────────────────────────────
  // Some CMPs (Sourcepoint on Spiegel, TrustArc, etc.) hide reject behind a
  // second layer reached via a "Preferences"/"Manage"/"Settings" button. These
  // phrases identify that opener so we can drill in. CONTAINS-matched, 35 langs.
  const PREF_PHRASES_BY_LANG = {
    en: ['preferences', 'manage', 'manage choices', 'manage options', 'manage cookies', 'customize', 'customise', 'settings', 'options', 'more options', 'purposes'],
    fr: ['préférences', 'gérer', 'gérer les choix', 'paramétrer', 'personnaliser', 'paramètres', 'gérer mes choix'],
    de: ['einstellungen', 'verwalten', 'anpassen', 'mehr optionen', 'auswahl verwalten', 'einstellungen verwalten', 'zwecke'],
    es: ['preferencias', 'gestionar', 'configurar', 'personalizar', 'opciones', 'más opciones', 'ajustes'],
    it: ['preferenze', 'gestisci', 'personalizza', 'impostazioni', 'altre opzioni', 'gestisci opzioni'],
    nl: ['voorkeuren', 'beheren', 'instellingen', 'aanpassen', 'meer opties', 'opties beheren'],
    pt: ['preferências', 'gerir', 'gerenciar', 'personalizar', 'configurações', 'mais opções', 'definições'],
    pl: ['preferencje', 'zarządzaj', 'ustawienia', 'dostosuj', 'więcej opcji'],
    da: ['præferencer', 'administrer', 'indstillinger', 'tilpas', 'flere muligheder'],
    sv: ['inställningar', 'hantera', 'anpassa', 'fler alternativ', 'hantera val'],
    fi: ['asetukset', 'hallinnoi', 'mukauta', 'lisävaihtoehdot'],
    nb: ['innstillinger', 'administrer', 'tilpass', 'flere alternativer'],
    cs: ['předvolby', 'spravovat', 'nastavení', 'přizpůsobit', 'další možnosti'],
    sk: ['predvoľby', 'spravovať', 'nastavenia', 'prispôsobiť'],
    ro: ['preferințe', 'gestionează', 'setări', 'personalizează', 'mai multe opțiuni'],
    hu: ['beállítások', 'kezelés', 'testreszabás', 'további lehetőségek'],
    el: ['προτιμήσεις', 'διαχείριση', 'ρυθμίσεις', 'περισσότερες επιλογές'],
    ru: ['настройки', 'управление', 'настроить', 'параметры', 'больше опций'],
    uk: ['налаштування', 'керувати', 'параметри', 'більше опцій'],
    tr: ['tercihler', 'yönet', 'ayarlar', 'özelleştir', 'daha fazla seçenek'],
    bg: ['предпочитания', 'управление', 'настройки', 'още опции'],
    hr: ['postavke', 'upravljanje', 'prilagodi', 'više opcija'],
    sl: ['nastavitve', 'upravljanje', 'prilagodi', 'več možnosti'],
    et: ['eelistused', 'halda', 'seaded', 'rohkem valikuid'],
    lt: ['nuostatos', 'tvarkyti', 'nustatymai', 'daugiau parinkčių'],
    lv: ['preferences', 'pārvaldīt', 'iestatījumi', 'vairāk iespēju'],
    ja: ['設定', '管理', 'カスタマイズ', 'その他のオプション'],
    ko: ['설정', '관리', '맞춤설정', '추가 옵션', '환경설정'],
    zh: ['设置', '管理', '自定义', '更多选项', '偏好设置'],
    ar: ['تفضي��ات', 'إدارة', 'إعدادات', 'تخصيص', 'المزيد من الخيارات'],
    he: ['העדפות', 'נהל', 'הגדרות', 'אפשרויות נוספות'],
    id: ['preferensi', 'kelola', 'pengaturan', 'sesuaikan', 'opsi lainnya'],
    th: ['การตั้งค่า', 'จัดการ', 'ปรับแต่ง', 'ตัวเลือกเพิ่มเติม'],
    vi: ['tùy chọn', 'quản lý', 'cài đặt', 'tùy chỉnh', 'thêm tùy chọn'],
  };
  let PREF_PHRASES_FLAT = flatPhrases(PREF_PHRASES_BY_LANG);
  /** True if the label looks like a "Preferences / Manage" opener (multilingual). */
  function looksPreferences(label) {
    return !!label && PREF_PHRASES_FLAT.some((p) => label.includes(p));
  }

  // Multi-step guard: open a preference panel AT MOST ONCE per page view, so we
  // never loop or repeatedly pop a modal. Reset on SPA navigation.
  let _multiStepTried = false;

  // ── Reload-loop circuit breaker ────────────────────────────────────────────
  // Some CMP "Preferences / Manage" openers NAVIGATE the iframe instead of
  // opening an in-document modal (e.g. corriere.it / Sourcepoint). A full reload
  // re-runs this content script fresh, wiping in-memory guards like
  // _multiStepTried, so we'd click the same opener again → reload → … until
  // Chrome's IPC-flooding throttle hangs the tab. We bound consent CLICK actions
  // per frame within a short window, PERSISTED in sessionStorage so the count
  // survives reloads. Every click path (direct reject, Preferences opener,
  // framework selector) spends one unit. sessionStorage access can throw in
  // sandboxed / partitioned frames, so every access is guarded and falls back to
  // an in-memory counter, the breaker must never itself break consent handling.
  const CB_KEY = 'pawsoff_cg_cb';
  const CB_MAX_ACTIONS = 3;      // clicks allowed per window, per frame
  const CB_WINDOW_MS = 10_000;   // sliding window
  let _cbTripLogged = false;     // log the trip at most once per page view
  let _cbMem = null;             // in-memory fallback when sessionStorage is unusable

  function _cbStore() {
    try { return window.sessionStorage || null; } catch (_) { return null; }
  }
  function _cbLoad() {
    const ss = _cbStore();
    if (ss) {
      try {
        const raw = ss.getItem(CB_KEY);
        if (raw) {
          const o = JSON.parse(raw);
          if (o && typeof o.n === 'number' && typeof o.t === 'number') return o;
        }
        return { n: 0, t: 0 };
      } catch (_) { /* security / parse error → fall back to in-memory */ }
    }
    return _cbMem ? { n: _cbMem.n, t: _cbMem.t } : { n: 0, t: 0 };
  }
  function _cbSave(rec) {
    _cbMem = rec; // always keep the in-memory mirror
    const ss = _cbStore();
    if (!ss) return;
    try { ss.setItem(CB_KEY, JSON.stringify(rec)); } catch (_) { /* ignore */ }
  }

  /**
   * Reserve budget for ONE consent click in this frame. Returns false (breaker
   * tripped) once CB_MAX_ACTIONS clicks have happened within CB_WINDOW_MS; the
   * window self-heals after it elapses. Logged at most once per page view. Never
   * throws, on any internal error it fails OPEN (returns true) so a storage
   * quirk can't disable consent rejection.
   * @returns {boolean}
   */
  function consentClickAllowed() {
    try {
      const now = Date.now();
      let rec = _cbLoad();
      if (!rec || typeof rec.t !== 'number' || (now - rec.t) > CB_WINDOW_MS) rec = { n: 0, t: now };
      if (rec.n >= CB_MAX_ACTIONS) {
        if (!_cbTripLogged) {
          _cbTripLogged = true;
          try { logToStorage({ status: 'circuit_breaker', framework: 'ConsentGhost' }); } catch (_) {}
        }
        return false;
      }
      rec.n += 1;
      _cbSave(rec);
      return true;
    } catch (_) {
      return true; // fail open - never let the breaker break consent handling
    }
  }
  // Clear the budget on a genuine same-document (SPA) navigation. Full reloads
  // deliberately do NOT reach this, they must keep the persisted count.
  function _cbReset() {
    _cbTripLogged = false;
    _cbMem = null;
    const ss = _cbStore();
    if (ss) { try { ss.removeItem(CB_KEY); } catch (_) {} }
    // NOTE: deliberately does NOT touch REGEN_KEY, the regeneration breaker must
    // survive SPA navigation, which is exactly how these banners loop.
  }

  // ── Banner-regeneration breaker helpers (see constants above) ───────────────
  let _regenMem = null; // in-memory fallback when sessionStorage is unusable
  function _regenLoad() {
    const ss = _cbStore();
    if (ss) {
      try {
        const raw = ss.getItem(REGEN_KEY);
        if (raw) {
          const o = JSON.parse(raw);
          if (o && typeof o.n === 'number') return o;
        }
        return { n: 0, t: 0, until: 0, logged: false };
      } catch (_) { /* security / parse error → in-memory */ }
    }
    return _regenMem
      ? { n: _regenMem.n, t: _regenMem.t, until: _regenMem.until, logged: _regenMem.logged }
      : { n: 0, t: 0, until: 0, logged: false };
  }
  function _regenSave(rec) {
    _regenMem = rec;
    const ss = _cbStore();
    if (!ss) return;
    try { ss.setItem(REGEN_KEY, JSON.stringify(rec)); } catch (_) { /* ignore */ }
  }
  // True while we are in a post-loop cool-off. Never throws; fails OPEN (false)
  // so a storage quirk can't permanently mute consent rejection.
  function regenLoopTripped() {
    try {
      const rec = _regenLoad();
      return !!(rec && typeof rec.until === 'number' && rec.until > Date.now());
    } catch (_) { return false; }
  }
  // Count one successful reject/hide; arm the cool-off once we exceed the
  // allowance within the window. Starting a fresh window clears the once-per-
  // stand-down log flag so a later genuine loop is reported again.
  function recordRejectForRegen() {
    try {
      const now = Date.now();
      let rec = _regenLoad();
      if (!rec || typeof rec.t !== 'number' || (now - rec.t) > REGEN_WINDOW_MS) {
        rec = { n: 0, t: now, until: 0, logged: false };
      }
      rec.n += 1;
      if (rec.n >= REGEN_MAX_REJECTS) rec.until = now + REGEN_STANDDOWN_MS;
      _regenSave(rec);
    } catch (_) { /* silent */ }
  }

  // Pay-or-consent WALL: record the popup flag at most once per page view. Reset on nav.
  let _wallRecorded = false;
  // Set true the moment a pay-or-consent wall is recognised this page view.
  // scanAndReject() then stands down HARD (marks handled, disconnects, logs once)
  // instead of letting the heuristic / ConsentFrame paths keep clicking into it
  // and re-triggering the banner (the focus.de/contentpass loop). Reset on nav.
  let _wallStandDown = false;
  let _wallStandDownLogged = false;
  // Centralised wall stand-down: arm the hard stand-down and surface the popup
  // chip at most once. Never throws (logging must never break consent handling).
  function standDownAsWall(detail) {
    _wallStandDown = true;
    if (!_wallRecorded) {
      _wallRecorded = true;
      try {
        if (window.PawsOffCatch && typeof window.PawsOffCatch.recordWall === 'function') {
          window.PawsOffCatch.recordWall(detail || 'Refusing requires a paid subscription');
        }
      } catch (_) { /* never throw from logging */ }
    }
  }
  // Collect the (capped) text + button labels of a consent surface so the pure
  // wall classifier can judge it. Shared by the heuristic and ConsentFrame paths.
  function surfaceTextAndLabels(root) {
    const out = { text: '', labels: [] };
    try {
      if (!root) return out;
      out.text = ((root.innerText || root.textContent || '') + '').slice(0, 4000);
      const btns = scopedQueryAll(
        root,
        'button, a[role="button"], [role="button"], input[type="button"], input[type="submit"], a[href="#"]',
        true,
      );
      for (let i = 0; i < btns.length; i++) {
        try { out.labels.push(heuristicLabel(btns[i])); } catch (_) { /* skip */ }
      }
    } catch (_) { /* return what we have */ }
    return out;
  }
  // Frameworks already logged 'detected_no_action' this page view, prevents the
  // observer from writing a duplicate log entry on every mutation batch while a
  // container is present but its buttons haven't rendered (that spam could evict
  // useful entries from the capped log). Reset on navigation.
  const _detectedLogged = new Set();

  // ── "Detected but couldn't reject" surfacer (fix: popup banner count = 0) ───
  // When a consent banner is plainly present but we cannot complete a reject
  // (classic case: a cross-origin CMP whose reject button lives inside the
  // vendor's OWN iframe, so this frame detects the wrapper but can't click it),
  // the popup used to show 0 because only a CONFIRMED reject is recorded. We now
  // record ONE honest "seen" catch per page view so the count reflects reality -
  // flagged seen:true so the popup labels it "Detected", never "Rejected".
  //
  // Deferred + verified: a real reject often lands a beat after detection, so we
  // wait, then record ONLY if (a) nothing rejected in the meantime and (b) a
  // consent surface is STILL on screen (frame-independent truth via
  // anyConsentSurfaceVisible). Top frame only, to avoid double-counting from the
  // CMP iframe. Scheduled at most once per page view; both flags reset on nav.
  let _seenRecorded = false;
  let _seenScheduled = false;
  const SEEN_RECORD_DELAY_MS = 4500;
  function recordDetectedSurface(framework) {
    try {
      if (_seenRecorded || _seenScheduled || window.top !== window) return;
      _seenScheduled = true;
      setTimeout(function () {
        try {
          if (_seenRecorded || window.__pawsOff_consentGhost_handled) return;
          // Banner gone? Then it WAS dismissed (by us or the CMP's own iframe) -
          // don't fabricate a "seen" for a surface that's no longer there.
          if (!anyConsentSurfaceVisible()) return;
          _seenRecorded = true;
          if (window.PawsOffCatch && typeof window.PawsOffCatch.recordBannerSeen === 'function') {
            window.PawsOffCatch.recordBannerSeen(framework);
          }
        } catch (_) { /* silent */ }
      }, SEEN_RECORD_DELAY_MS);
    } catch (_) { /* silent */ }
  }

  /**
   * OPTION B core: find the consent container, then click the reject inside it.
   * Returns true if it clicked.
   *
   * Step 1, locate a container: an element that is fixed/sticky OR has a high
   *   z-index, is visible and sizeable, and whose OWN text mentions a consent
   *   keyword. We pick the highest-z / most-overlay-like match.
   * Step 2, within that container only, find the best multilingual reject that
   *   is not an accept, and click it.
   * @returns {boolean}
   */
  // ── Reliable layer-2 drill-in (poll-until-present) ─────────────────────────
  // After opening the preferences panel we actively poll for a reject control
  // to render, rather than relying on the MutationObserver to fire again. This
  // makes the multi-step flow deterministic instead of timing-dependent.
  // setTimeout is acceptable in a content script (it runs in the page process,
  // not in the evictable service worker).
  const WAIT_RETRIES = 12;      // ~12 × 250ms = 3s budget for layer 2 to appear
  const WAIT_INTERVAL_MS = 250;

  /**
   * Find a visible, multilingual, non-accept reject control inside `root`.
   * Shared by layer 1 and the polled layer 2.
   * @param {Element|Document} root
   * @returns {Element|null}
   */
  function findRejectIn(root) {
    try {
      const candidates = scopedQueryAll(
        root,
        'button, a[role="button"], [role="button"], input[type="button"], input[type="submit"], a[href="#"]',
        true,
      );
      for (const el of candidates) {
        if (!isVisible(el)) continue;
        const label = heuristicLabel(el);
        if (!label || looksAccept(label)) continue; // 5g veto (any language)
        if (looksReject(label)) return el;
      }
    } catch (_) { /* silent */ }
    return null;
  }

  /**
   * After opening a preferences panel, poll for a reject control to appear and
   * click it. Re-detects the container each tick because layer 2 may render as a
   * NEW overlay. Never clicks "Save"/"Confirm", only an explicit reject, so a
   * Save-only panel ends with no action (the safe state).
   * @param {number} attempt
   */
  function pollLayerTwoReject(attempt) {
    try {
      if (window.__pawsOff_consentGhost_handled || protectionPaused()) return; // honour mid-poll disable/pause
      const root = findConsentContainer() || document.body;
      // Wall guard: layer 2 may reveal the surface is pay-or-consent. Never click
      // into a wall; stand down so scanAndReject can flag it on its next pass.
      if (root) {
        const _sl = surfaceTextAndLabels(root);
        if (surfaceLooksLikeWall(_sl.text, _sl.labels)) { standDownAsWall(); return; }
      }
      const rejectEl = root ? findRejectIn(root) : null;
      if (rejectEl) {
        if (!consentClickAllowed()) return;
        rejectEl.click();
        window.__pawsOff_consentGhost_handled = true;
        if (window.__pawsOff_consentGhost_observer) {
          try { window.__pawsOff_consentGhost_observer.disconnect(); } catch (_) {}
          window.__pawsOff_consentGhost_observer = null;
        }
        logToStorage({ status: 'rejected', framework: 'Heuristic/multi-step' });
        incrementTotal(CG_TOTAL_KEY);
        return;
      }
      if (attempt < WAIT_RETRIES) {
        setTimeout(() => pollLayerTwoReject(attempt + 1), WAIT_INTERVAL_MS);
      }
      // Exhausted retries with no reject → Save-only panel; leave it (safe).
    } catch (_) { /* silent */ }
  }

  function tryHeuristicReject() {
    try {
      // Negative-cache / debounce: a recent sweep already found no overlay, so
      // don't re-run the expensive scan on every mutation batch. A banner that
      // appears later is still caught on the next sweep after the cooldown.
      if (Date.now() < _heuristicCooldownUntil) return false;

      const container = findConsentContainer();
      if (!container) {
        _heuristicCooldownUntil = Date.now() + HEURISTIC_SWEEP_COOLDOWN_MS;
        return false; // no overlay → do NOTHING (the safe choice)
      }

      // Scope the button scan to the container (pierce shadow roots within it).
      const candidates = scopedQueryAll(
        container,
        'button, a[role="button"], [role="button"], input[type="button"], input[type="submit"], a[href="#"]',
        true,
      );

      // Pay-or-consent WALL guard (BEFORE any click): a contentpass-style wall or
      // an accept/subscribe-only surface has no free reject, clicking a reject-
      // looking control just re-triggers the banner (the focus.de loop). Stand
      // down hard and flag it instead of fighting.
      {
        const _labels = [];
        for (let _i = 0; _i < candidates.length; _i++) {
          try { _labels.push(heuristicLabel(candidates[_i])); } catch (_) { /* skip */ }
        }
        const _txt = (container.innerText || container.textContent || '').slice(0, 4000);
        if (surfaceLooksLikeWall(_txt, _labels)) { standDownAsWall(); return false; }
      }

      let rejectEl = null;
      let prefEl = null;
      let sawAcceptOrSubscribe = false;
      for (const el of candidates) {
        if (!isVisible(el)) continue;
        const label = heuristicLabel(el);
        if (!label) continue;
        // Note accept / pay-wall controls so we can recognise a cookie WALL below.
        if (looksAccept(label) || longestHit(label, SUBSCRIBE_PHRASES_FLAT) > 0) sawAcceptOrSubscribe = true;
        if (looksAccept(label)) continue;            // 5g veto (any language)
        if (!rejectEl && looksReject(label)) rejectEl = el;
        else if (!prefEl && looksPreferences(label)) prefEl = el;
      }

      // Preferred path: an explicit reject button exists in this layer → click.
      if (rejectEl) {
        if (!consentClickAllowed()) return false;
        rejectEl.click();
        return true;
      }

      // MULTI-STEP fallback: no direct reject, but there's a "Preferences /
      // Manage" opener (e.g. Spiegel/Sourcepoint, TrustArc). Open the second
      // layer ONCE per page, then POLL for the layer-2 reject to render and
      // click it (pollLayerTwoReject), deterministic, not observer-dependent.
      //
      // CRITICAL SAFETY: layer 2 still only ever clicks an explicit reject
      // (looksReject), never a "Save my choices"/"Confirm" button, which would
      // persist pre-enabled toggles (the 5b trap). Worst case: panel opens, no
      // reject appears within the budget, we stop. Bounded; never loops.
      if (prefEl && !_multiStepTried) {
        if (!consentClickAllowed()) return false;
        _multiStepTried = true;
        prefEl.click();
        setTimeout(() => pollLayerTwoReject(0), WAIT_INTERVAL_MS);
        return false; // not handled yet - the poll will finish the job
      }

      // Pay-or-consent wall with no reject and no preferences (Spiegel layer 1,
      // Le Figaro): leave it alone rather than click "accept"/"subscribe". Per
      // the user's setting, FLAG it in the popup so they know we saw it and stood
      // down on purpose, refusing here would cost a paid subscription.
      if (sawAcceptOrSubscribe && !_wallRecorded) {
        _wallRecorded = true;
        try {
          if (window.PawsOffCatch && typeof window.PawsOffCatch.recordWall === 'function') {
            window.PawsOffCatch.recordWall('Refusing requires a paid subscription');
          }
        } catch (_) { /* never throw from logging */ }
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  // ── Iframe consent-document handling (Sourcepoint / cross-origin CMP UIs) ──
  // Big reliability gap this closes: CMPs like Sourcepoint (The Guardian,
  // idealo.de, Spiegel, Bild) render their banner inside their OWN cross-origin
  // iframe (privacy-mgmt.com / sp-prod.net / sourcepoint.*). Our content script
  // IS injected into that iframe (all_frames:true), but inside it the consent UI
  // is the WHOLE document, not a fixed/high-z overlay floating over a page.
  // findConsentContainer()'s overlay/z-index signature therefore never matches,
  // so both the named-selector tier (its container ids live in the PARENT frame)
  // and the heuristic tier miss. Here we detect "I am inside a consent-only
  // document" and scan the entire document for a reject control.
  const CMP_FRAME_HOST_RE = /(^|\.)(privacy-mgmt\.com|sp-prod\.net|consensu\.org|sourcepoint\.com)$/i;

  // Pure frame-relevance test (perf gate). The broad consent script injects into
  // EVERY frame (all_frames:true), so most sub-frames are empty ad iframes that
  // should never pay for the engine. A sub-frame is relevant only if it's a known
  // CMP host OR its small document reads like a consent page. Top frame always
  // runs. Exposed via __test. (Note: top frame uses the normal page path, so the
  // CMP-iframe-specific tryConsentFrameReject() path keys off inConsentFrame(),
  // which is just this gate restricted to sub-frames.)
  function shouldRunInFrame(isTop, hostname, bodyText) {
    if (isTop) return true;
    const host = (hostname || '').toLowerCase();
    if (CMP_FRAME_HOST_RE.test(host) || host.indexOf('sourcepoint') !== -1) return true;
    const txt = (bodyText || '').toLowerCase();
    if (!txt || txt.length > 20000) return false; // looks like a real content frame
    return CONSENT_PAGE_HINTS.some((h) => txt.includes(h));
  }

  function inConsentFrame() {
    try {
      if (window.top === window.self) return false; // top frame uses the normal path
      return shouldRunInFrame(false, location.hostname, (document.body && document.body.innerText) || '');
    } catch (_) {
      return false;
    }
  }

  /**
   * Reject path for when we are running INSIDE a CMP's own iframe (the whole
   * document is the consent dialog). Clicks a direct reject if present; otherwise
   * opens a Preferences/Manage layer ONCE and polls for the layer-2 reject. Only
   * ever clicks an explicit reject (never Save/Accept), same safety as the
   * heuristic tier. Returns true only if it clicked a reject this tick.
   */
  function tryConsentFrameReject() {
    try {
      const root = document.body || document.documentElement;
      if (!root) return false;

      // Pay-or-consent WALL guard (BEFORE any click): if this consent-only
      // document is a contentpass-style wall or offers no free reject, stand down
      // and flag it. Clicking here is exactly what re-injects the focus.de banner.
      {
        const _sl = surfaceTextAndLabels(root);
        if (surfaceLooksLikeWall(_sl.text, _sl.labels)) { standDownAsWall(); return false; }
      }

      // Direct reject anywhere in this consent-only document.
      const rejectEl = findRejectIn(root);
      if (rejectEl) {
        if (!consentClickAllowed()) return false;
        rejectEl.click();
        setTimeout(() => { try { if (rejectEl && rejectEl.click) rejectEl.click(); } catch (_) {} }, 150);
        return true;
      }

      // Multi-step: open a Preferences/Manage opener once, then poll for reject.
      if (!_multiStepTried) {
        const candidates = scopedQueryAll(
          root,
          'button, a[role="button"], [role="button"], input[type="button"], input[type="submit"], a[href="#"]',
          true,
        );
        for (const el of candidates) {
          if (!isVisible(el)) continue;
          const label = heuristicLabel(el);
          if (!label || looksAccept(label)) continue; // never click accept
          if (looksPreferences(label)) {
            if (!consentClickAllowed()) return false;
            _multiStepTried = true;
            el.click();
            setTimeout(() => pollLayerTwoReject(0), WAIT_INTERVAL_MS);
            return false; // poll will finish the job
          }
        }
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  // ── Declarative action-sequence engine (steps[]) ─────────────────────────���─
  // Each named framework in the remote config may optionally define a `steps`
  // array describing an ordered multi-step flow, e.g.
  //   ["click:.prefs-btn", "waitFor:.reject-btn:2000", "click:.reject-btn"].
  // Steps are signed remote-config DATA, never executable code. Every click
  // target is still run through the accept-veto and the double-click retry. If
  // any step fails (timeout or missing selector) the chain aborts, we never
  // half-complete a multi-step flow. Steps run asynchronously with the
  // content-script-safe setTimeout. This keeps complex flows patchable via the
  // signed config without shipping a new extension build.
  const STEP_TIMEOUT_DEFAULT = 3000; // default waitFor budget if not specified

  /**
   * Execute a declarative step sequence. Returns a Promise<boolean>, true if
   * the full chain completed (consent was rejected), false if any step failed.
   * @param {string[]} steps  e.g. ["click:.prefs-btn", "waitFor:.reject-btn:2000", "click:.reject-btn"]
   * @param {Element} root  the container to scope queries to
   * @returns {Promise<boolean>}
   */
  /** A step target is clickable only if visible and NOT an accept control
   *  (accept-veto). Shared by the click and xpath step verbs. */
  function isClickableReject(el) {
    return !!el && isVisible(el) && !isAcceptLabel(el);
  }
  async function executeSteps(steps, root) {
    try {
      if (!Array.isArray(steps) || !steps.length) return false;
      for (const step of steps) {
        let verb, rest, timeout;

        if (typeof step === 'string') {
          // Legacy string shorthand: "verb:selector[:timeout]"
          const firstColon = step.indexOf(':');
          if (firstColon < 0) continue;
          verb = step.slice(0, firstColon).toLowerCase().trim();
          rest = step.slice(firstColon + 1);
          timeout = STEP_TIMEOUT_DEFAULT;
        } else if (typeof step === 'object' && step !== null) {
          // Structural object: { verb: "waitFor", selector: "...", timeout: 2000 }
          verb = (step.verb || '').toLowerCase().trim();
          rest = step.selector || '';
          timeout = step.timeout !== undefined ? Number(step.timeout) : STEP_TIMEOUT_DEFAULT;
        } else {
          continue;
        }

        if (verb === 'click') {
          const targets = scopedQueryAll(root, rest, true);
          const el = targets.find((e) => isClickableReject(e));
          if (!el) return false; // step failed - abort chain
          el.click();
          setTimeout(() => { try { if (el && el.click) el.click(); } catch (_) {} }, 150); // double-click resilience
        } else if (verb === 'waitfor') {
          let selector = rest;
          // Only attempt to parse trailing timeout from string shorthand
          if (typeof step === 'string') {
            const lastColon = rest.lastIndexOf(':');
            if (lastColon > 0 && /^\d+$/.test(rest.slice(lastColon + 1))) {
              selector = rest.slice(0, lastColon);
              timeout = parseInt(rest.slice(lastColon + 1), 10) || STEP_TIMEOUT_DEFAULT;
            }
          }
          const found = await waitForElement(selector, root, timeout);
          if (!found) return false; // step failed - abort chain
        } else if (verb === 'hide') {
          const targets = scopedQueryAll(root, rest, true);
          targets.forEach((el) => { try { el.style.display = 'none'; } catch (_) {} });
        } else if (verb === 'xpath') {
          try {
            const xr = document.evaluate(rest, root, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            const el = xr.singleNodeValue;
            if (!isClickableReject(el)) return false;
            el.click();
            setTimeout(() => { try { if (el && el.click) el.click(); } catch (_) {} }, 150);
          } catch (_) { return false; }
        }
      }
      return true; // all steps succeeded
    } catch (_) {
      return false;
    }
  }

  /**
   * Poll for an element matching `selector` inside `root` to appear and become
   * visible. Returns the element or null after `timeoutMs`.
   * @param {string} selector
   * @param {Element} root
   * @param {number} timeoutMs
   * @returns {Promise<Element|null>}
   */
  function waitForElement(selector, root, timeoutMs) {
    return new Promise((resolve) => {
      const interval = 200;
      let elapsed = 0;
      const check = () => {
        const targets = scopedQueryAll(root || document, selector, true);
        const el = targets.find((e) => isVisible(e));
        if (el) { resolve(el); return; }
        elapsed += interval;
        if (elapsed >= timeoutMs) { resolve(null); return; }
        setTimeout(check, interval);
      };
      check();
    });
  }

  let _cachedContainer = null;
  let _heuristicCooldownUntil = 0; // negative-cache timestamp for the overlay sweep

  /**
   * Detect a consent overlay/banner container. Returns the element or null.
   * Signature of a consent surface: visible + sizeable + (fixed/sticky OR high
   * z-index) + its own text contains a consent keyword. Bounded scan.
   * @returns {Element|null}
   */
  // Pure: choose the best consent container from overlay-filtered candidates.
  // Sort by z-index DESC so capping keeps the most overlay-like (a high-z banner
  // never falls off the cap), then apply the size + text gates, then pick the
  // highest-z survivor. cands = [{ el, z, area, hasText }]. Exposed via __test.
  function pickConsentContainer(cands, cap) {
    const sorted = cands.slice().sort((a, b) => b.z - a.z);
    const limit = Math.min(sorted.length, cap);
    let best = null;
    let bestZ = -1;
    for (let i = 0; i < limit; i++) {
      const c = sorted[i];
      if (c.area < MIN_CONTAINER_AREA) continue;
      if (!c.hasText) continue;
      if (c.z > bestZ) { bestZ = c.z; best = c.el; }
    }
    return best;
  }

  // Read up to `cap` of `els`' computed style and push the overlay-ish, sizeable,
  // consent-text ones onto `out`. `getComputedStyle` forces a style recalc, so the
  // cap bounds the cost: only the COUNT of style reads is capped (`seen`), not the
  // push. Pass cap=Infinity for the small "strong" set (always worth reading).
  function collectOverlayCands(els, out, cap) {
    let seen = 0;
    for (let i = 0; i < els.length && seen < cap; i++) {
      const el = els[i];
      if (!isVisible(el)) continue;
      seen++;
      let cs;
      try { cs = getComputedStyle(el); } catch (_) { continue; }
      const pos = cs.position;
      const z = parseInt(cs.zIndex, 10);
      const overlayish = (pos === 'fixed' || pos === 'sticky' || (Number.isFinite(z) && z >= HIGH_Z_THRESHOLD));
      if (!overlayish) continue;
      let rect;
      try { rect = el.getBoundingClientRect(); } catch (_) { continue; }
      const area = rect.width * rect.height;
      const txt = (el.innerText || el.textContent || '').slice(0, 4000).toLowerCase();
      const hasText = CONSENT_PAGE_HINTS.some((h) => txt.includes(h));
      out.push({ el: el, z: Number.isFinite(z) ? z : 0, area: area, hasText: hasText });
    }
  }

  // Banners almost always carry a dialog role or a cookie/consent/gdpr/cmp marker.
  // This narrow set is small per page, so we read its computed style UNCAPPED , 
  // that is what makes a marker-bearing banner late in the DOM still findable.
  const STRONG_CONTAINER_SEL =
    'dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"], ' +
    '[class*="cookie" i], [id*="cookie" i], [class*="consent" i], [id*="consent" i], ' +
    '[class*="gdpr" i], [id*="gdpr" i], [class*="cmp" i], [id*="cmp" i], ' +
    '[class*="cookie-banner" i], [class*="cookiebanner" i]';
  // `div` matches most of the page, so the generic sweep is the expensive one , 
  // BOUNDED at MAX_CONTAINER_SCAN style reads (perf: avoids recalc over a huge DOM).
  const GENERIC_CONTAINER_SEL = 'div, section, aside';

  function findConsentContainer() {
    if (_cachedContainer && isVisible(_cachedContainer)) return _cachedContainer;
    try {
      // Cheap document-level keyword pre-gate: if NO consent keyword appears
      // anywhere in the page's text, there is no banner to find, so skip the
      // overlay sweep entirely. textContent does NOT force a reflow.
      const docText = ((document.body && document.body.textContent) || '').toLowerCase();
      if (docText && !CONSENT_PAGE_HINTS.some((h) => docText.includes(h))) return null;

      const cands = [];
      // 1) Strong, marker-bearing candidates: few per page → read all (uncapped).
      collectOverlayCands(scopedQueryAll(document, STRONG_CONTAINER_SEL, true), cands, Infinity);
      // 2) Generic div/section sweep: BOUNDED style reads (the perf-critical path).
      collectOverlayCands(scopedQueryAll(document, GENERIC_CONTAINER_SEL, true), cands, MAX_CONTAINER_SCAN);

      const best = pickConsentContainer(cands, MAX_CONTAINER_SCAN);
      _cachedContainer = best;
      return best;
    } catch (_) {
      return null;
    }
  }

  // ── Active config (remote-with-bundled-fallback) ───────────────────────────
  // `activeConfig` is what scanAndReject() actually iterates. It STARTS as the
  // bundled array (offline / first-run authority) and is swapped to a verified
  // remote config only if loadRemoteConfig() succeeds. We never start from, or
  // fall to, an unverified download, fail-open means "use bundled".
  let activeConfig = BUNDLED_CONSENT_CONFIG;

  /**
   * Normalise a remote consent-config.json into the internal framework shape.
   * The remote schema wraps entries under `frameworks` with extra fields
   * (id, enabled, addedIn); we keep only enabled ones and map to the
   * {name, containerSelector, rejectSelectors, pierceShadow} shape scanAndReject
   * expects. Returns null if the payload is structurally unusable (→ keep bundled).
   * @param {*} cfg
   * @returns {Array|null}
   */
  /** Remote config is only usable if it's the schema version we understand. */
  function isUsableRemoteConfig(cfg) {
    return !!cfg && cfg.schemaVersion === 1 && Array.isArray(cfg.frameworks);
  }
  /** A framework entry is valid only with a name, container selector, and a
   *  reject-selector array, and not explicitly disabled. */
  function isValidFrameworkEntry(f) {
    return !!f && f.enabled !== false &&
      typeof f.name === 'string' && typeof f.containerSelector === 'string' &&
      Array.isArray(f.rejectSelectors);
  }
  function normalizeRemoteConfig(cfg) {
    try {
      if (!isUsableRemoteConfig(cfg)) return null;
      const out = [];
      for (const f of cfg.frameworks) {
        if (!isValidFrameworkEntry(f)) continue;
        out.push({
          name: f.name,
          containerSelector: f.containerSelector,
          rejectSelectors: f.rejectSelectors.filter((s) => typeof s === 'string'),
          pierceShadow: f.pierceShadow === true,
          // POLICY (Chrome Web Store, no remotely-controlled behavior): we do NOT
          // accept an action-`steps` engine (click/hide/xpath/waitFor) from remote
          // config. Remote config may only DESCRIBE which elements to reject via
          // declarative selectors; the actual clicking is done by local, reviewed
          // code gated by the accept-veto. Any `steps` in remote config are ignored.
        });
      }
      return out.length ? out : null; // empty list is unusable - keep bundled
    } catch (_) {
      return null;
    }
  }

  /**
   * Ask background.js for the signed+verified consent-config.json. background is
   * the ONLY component that fetches and SubtleCrypto-verifies it (content scripts
   * can't be trusted to hold the verification path). On any failure, no SW, not
   * yet fetched, invalid signature, malformed, we keep the bundled config.
   * Fail-OPEN by design: a privacy tool should keep protecting, never go dark.
   * @returns {Promise<void>}
   */
  /** background returns { ok, config } only when the signed config verified. */
  function isConfigResponseOk(resp) {
    return !!resp && !!resp.ok && !!resp.config;
  }
  async function loadRemoteConfig() {
    try {
      if (!chrome.runtime || !chrome.runtime.sendMessage) return;
      const resp = await chrome.runtime.sendMessage({ type: 'pawsoff_consentGhost_getConfig' });
      if (!isConfigResponseOk(resp)) return;            // not ready / failed → bundled
      const normalized = normalizeRemoteConfig(resp.config);
      if (normalized) activeConfig = normalized;                // verified swap
    } catch (_) {
      // Silent, bundled config stays active.
    }
  }

  // ── Error / event logging ────────────────────────────────────────────────────
  //
  // 7a FIX, UNIQUE-KEY WRITES.
  // Consent CMPs commonly load inside iframes, so several content-script
  // instances run in parallel and write to the SAME chrome.storage.local area.
  // The old get→unshift→set pattern is a read-modify-write: two frames that
  // interleave both read the same array and the second set() clobbers the
  // first's entry (lost update). Writing each entry under its OWN unique key
  // removes the shared mutable array entirely, so concurrent writes can never
  // collide. Readers (options/log page) enumerate keys by LOG_KEY_PREFIX.
  //
  // INVARIANT, NO OFF-DEVICE SIGNAL: logging here is LOCAL-ONLY and stays that
  //   way. A previously-considered "ship aggregate health counters to an external
  //   monitoring service" idea is REJECTED: any off-device emission would violate
  //   the project's no-network-home rule. Any future health counters MUST live in
  //   chrome.storage.local and never be transmitted anywhere. A source-scan
  //   negative-control test fails the build if an analytics/egress token ever
  //   appears in src/ (see tests/no-offdevice-egress.test.js).
  /**
   * One-way, synchronous digest of a hostname for LOCAL log de-identification.
   * FNV-1a/32; a privacy de-identifier, NOT a security primitive. Returns
   * 'h:' + 8 hex chars, or null for empty input.
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

  // ── Reload-loop breaker (per-origin, COUNTER-based) ─────────────────────────
  // Some CMPs RELOAD the page to apply consent (e.g. check24.de). A naive "don't
  // act twice" stamp over-corrects: it also muted the FIRST reject after a normal
  // manual reload, so banners stopped getting rejected for 15s. Instead we COUNT
  // rejects within a sliding window and only stand down once we've clearly looped
  // (>= LOOP_MAX_REJECTS within REJECT_COOLDOWN_MS). One or two rejects still go
  // through, so normal use keeps working.
  function _actedKey() { return ACTED_PREFIX + hashHost(location.hostname || ''); }
  async function loopGuardTripped() {
    try {
      if (!chrome.storage || !chrome.storage.local) return false;
      const k = _actedKey();
      const s = await chrome.storage.local.get(k);
      const rec = s && s[k];
      // Backward-compatible: ignore any old plain-number stamp from a prior build.
      if (!rec || typeof rec.last !== 'number') return false;
      // Window elapsed since the last reject → stale; clear it and start fresh.
      if (Date.now() - rec.last >= REJECT_COOLDOWN_MS) {
        try { chrome.storage.local.remove(k); } catch (_) {}
        return false;
      }
      // Recent rejects exist; only trip once we've exceeded the loop allowance.
      return (rec.n || 0) >= LOOP_MAX_REJECTS;
    } catch (_) { return false; }
  }
  function markActed() {
    try {
      if (!chrome.storage || !chrome.storage.local) return;
      const k = _actedKey();
      chrome.storage.local.get(k, (s) => {
        try {
          void chrome.runtime.lastError;
          const now = Date.now();
          const prev = s && s[k];
          const within = prev && typeof prev.last === 'number' && (now - prev.last < REJECT_COOLDOWN_MS);
          const n = within ? ((prev.n || 0) + 1) : 1;
          const o = {}; o[k] = { n: n, last: now, first: within ? (prev.first || now) : now };
          chrome.storage.local.set(o, () => { try { void chrome.runtime.lastError; } catch (_) {} });
        } catch (_) { /* silent */ }
      });
    } catch (_) { /* silent */ }
  }

  async function logToStorage(entry) {
    // PawsOff catch feed (popup "Today's catch"), record actual banner
    // rejections only. Non-PII: no URL, no page content; site stays hashed.
    try {
      if (entry && entry.status === 'rejected') {
        // Stamp the per-origin cooldown FIRST so a CMP page-reload can't loop us.
        markActed();
        if (window.PawsOffCatch) window.PawsOffCatch.recordBanner(entry.framework);
      }
      // Feed the synchronous, nav-resistant regeneration breaker on every
      // dismissal (reject OR cosmetic hide) so a re-inject loop is bounded even
      // when pushState keeps wiping the reload-loop budget.
      if (entry && (entry.status === 'rejected' || entry.status === 'hidden')) {
        recordRejectForRegen();
      }
    } catch (_) { /* silent */ }
    try {
      // `domain` is a one-way FNV-1a digest of the visited site host, enough to
      // tell two failure sites apart for debugging without storing a plaintext,
      // browsing-history-like hostname. It never leaves the device (local-first).
      const key = LOG_KEY_PREFIX + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      await chrome.storage.local.set({
        [key]: { ...entry, ts: Date.now(), domain: hashHost(location.hostname) },
      });

      // Retention is best-effort and SAMPLED: running get(null) on every single
      // write across many frames would be wasteful. Briefly exceeding the cap is
      // harmless because every entry is an independent key (no array to corrupt).
      if (Math.random() < LOG_PRUNE_SAMPLE) await pruneLogs();
    } catch (_) {
      // Silent (rule 4): storage may be unavailable (restricted/private contexts).
    }
  }

  // Trim the oldest log entries down to LOG_MAX_ENTRIES. Safe under concurrency:
  // remove() of distinct keys cannot lose unrelated entries the way an array
  // rewrite would.
  async function pruneLogs() {
    try {
      let keys;
      if (typeof chrome.storage.local.getKeys === 'function') {
        keys = (await chrome.storage.local.getKeys()).filter((k) => k.startsWith(LOG_KEY_PREFIX));
      } else {
        keys = Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith(LOG_KEY_PREFIX));
      }
      if (keys.length <= LOG_MAX_ENTRIES) return;
      const entries = await chrome.storage.local.get(keys);
      keys.sort((a, b) => ((entries[a] && entries[a].ts) || 0) - ((entries[b] && entries[b].ts) || 0));
      const excess = keys.slice(0, keys.length - LOG_MAX_ENTRIES);
      await chrome.storage.local.remove(excess);
    } catch (_) {
      // Silent.
    }
  }

  /**
   * Increment a monotonic aggregate counter by `by` (default 1).
   * Read-modify-write is intentional: races are ~impossible here (the `handled`
   * flag ensures at most one frame rejects per page), and the worst-case is a
   * 1-count undercount, acceptable for a display total.
   * @param {string} key
   * @param {number} [by]
   * @returns {Promise<void>}
   */
  async function incrementTotal(key, by) {
    try {
      const s = await chrome.storage.local.get(key);
      const cur = (s && typeof s[key] === 'number') ? s[key] : 0;
      await chrome.storage.local.set({ [key]: cur + (by || 1) });
    } catch (_) { /* silent */ }
  }

  // ── DOM helpers ────────────────────��───────────────���───────────────────────

  /**
   * Return an element's shadow root, OPEN or CLOSED.
   * Improvement over a plain `.shadowRoot` read: in a content script, Chrome 88+
   * exposes `chrome.dom.openOrClosedShadowRoot(el)` which reaches CLOSED roots
   * too (some CMPs use mode:'closed' specifically to evade extensions). We try
   * that first and fall back to `.shadowRoot` (open-only) when the API is
   * unavailable, so we degrade gracefully instead of assuming the API exists.
   * @param {Element} el
   * @returns {ShadowRoot|null}
   */
  /** True when Chrome's closed-shadow API is available (Chrome/Chromium only). */
  function canUseChromeDomShadow() {
    return typeof chrome !== 'undefined' && chrome.dom &&
      typeof chrome.dom.openOrClosedShadowRoot === 'function';
  }
  function getShadowRoot(el) {
    try {
      if (!(el instanceof Element)) return null;
      if (canUseChromeDomShadow()) {
        return chrome.dom.openOrClosedShadowRoot(el) || null;
      }
      return el.shadowRoot || null;
    } catch (_) {
      return el.shadowRoot || null;
    }
  }

  /**
   * 1a: Shadow-piercing query.
   * Returns all elements under `root` matching `selector`. When `pierce` is true
   * we additionally walk every shadow root beneath `root` (and `root`'s own
   * shadow root) and query inside each, INCLUDING closed roots where the
   * chrome.dom API is available (see getShadowRoot).
   *
   * Cost is bounded to a single tree walk and is only paid for frameworks flagged
   * pierceShadow:true, so light-DOM CMPs keep the cheap querySelectorAll path.
   */
  function scopedQueryAll(root, selector, pierce) {
    const out = [];
    const seen = new Set();
    const push = (el) => {
      if (el && !seen.has(el)) { seen.add(el); out.push(el); }
    };
    const queryInto = (node) => {
      try {
        // XPath support: selectors starting with "//" or "(//" are evaluated as
        // XPath instead of CSS. This matches CMPs that use dynamic class names
        // but have a stable DOM structure (e.g. "the 2nd button inside a div
        // whose text contains 'consent'"). Results join the shared dedup set.
        if (selector.startsWith('//') || selector.startsWith('(//')) {
          const xpResult = document.evaluate(selector, node, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          for (let i = 0; i < xpResult.snapshotLength; i++) push(xpResult.snapshotItem(i));
          return;
        }
        const found = node.querySelectorAll(selector);
        for (const el of found) push(el);
      } catch (_) {
        // Malformed selector, skip; caller proceeds to the next pattern.
      }
    };

    queryInto(root);

    if (pierce) {
      const stack = [root];
      const visited = new Set();
      while (stack.length) {
        const node = stack.pop();
        if (visited.has(node)) continue;
        visited.add(node);

        // The node itself may be a shadow host (open OR closed root).
        if (node instanceof Element) {
          const sr = getShadowRoot(node);
          if (sr && !visited.has(sr)) { queryInto(sr); stack.push(sr); }
        }
        let descendants;
        try { descendants = node.querySelectorAll('*'); } catch (_) { continue; }
        for (const el of descendants) {
          const sr = getShadowRoot(el);
          if (sr && !visited.has(sr)) {
            queryInto(sr);
            stack.push(sr);
          }
        }
      }
    }
    return out;
  }

  /**
   * True if `el` is visible and interactable.
   * Prefers Chrome 105+ checkVisibility(), which honours display/visibility/
   * opacity inherited from ANY ancestor and content-visibility, all missed by a
   * naive getBoundingClientRect check. Falls back to a rect check pre-105.
   */
  function isVisible(el) {
    try {
      if (!el) return false;
      if (typeof el.checkVisibility === 'function') {
        return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    } catch (_) {
      return false;
    }
  }

  /**
   * Normalised visible label text. `.value` deliberately omitted, on <button>
   * it is the form submission value, not the visible label (a button can have
   * value="reject" yet display "Accept All").
   */
  function btnText(el) {
    try {
      return (el.innerText || el.textContent || el.getAttribute('aria-label')
              || el.getAttribute('title') || el.getAttribute('alt') || '')
        .trim()
        .replace(/\s+/g, ' ');
    } catch (_) {
      return '';
    }
  }

  /**
   * 5g: accept-veto predicate. A reject selector, especially the broad generic
   * ones and framework relayouts, can incidentally match an accept/consent
   * control. We refuse to click anything whose visible label reads as "accept".
   * An empty label (icon-only button) is NOT vetoed; the selector is trusted in
   * that case because there is no text evidence to the contrary.
   *
   * Uses the SAME unified classifier as the heuristic tier (classifyLabel), so
   * "Accept All Cookies" is correctly vetoed (longest hit "accept all" wins over
   * nothing on the reject side) while "Do not accept" is NOT vetoed (the longer
   * reject phrase outranks the substring "accept").
   */
  function isAcceptLabel(el) {
    const t = btnText(el).toLowerCase();
    return classifyLabel(t) === 'accept';
  }

  // ── CSS fast-hide ───────────────────────────────────────���────────────────────
  // On a confirmed consent container, inject a targeted `display:none` instantly
  // so the user never sees the banner flash while we look for the reject button.
  // We only do this AFTER matching the container (safe scope) and we undo it if
  // we fail to click reject, so the banner re-appears rather than being hidden
  // with consent left unhandled. The injected <style> is ours.
  // Anti-fingerprinting: never write a custom marker attribute (data-po-cg-*)
  // onto page-owned nodes, anti-adblock scripts scan for known signatures.
  // Instead we toggle the container's own inline `display` and remember the
  // prior value in a WeakMap so we can restore it exactly if we fail to reject.
  const _fastHideMap = new WeakMap();
  function fastHideContainer(container) {
    try {
      if (!container || !container.style) return;
      if (_fastHideMap.has(container)) return;
      _fastHideMap.set(container, {
        value:    container.style.getPropertyValue('display'),
        priority: container.style.getPropertyPriority('display'),
      });
      container.style.setProperty('display', 'none', 'important');
    } catch (_) { /* silent */ }
  }
  function undoFastHide(container) {
    try {
      if (!container || !container.style) return;
      const prev = _fastHideMap.get(container);
      if (prev === undefined) return;
      container.style.removeProperty('display');
      if (prev.value) container.style.setProperty('display', prev.value, prev.priority || '');
      _fastHideMap.delete(container);
    } catch (_) { /* silent */ }
  }

  // ── Pre-paint flash suppression (prehide) ──────────────────────────────────
  // At document_start we inject a <style> that hides ONLY the vetted, named-CMP
  // container selectors (activeConfig), so the banner doesn't flash before we can
  // reject it. An UNCONDITIONAL watchdog removes the style after PREHIDE_MAX_MS no
  // matter what (SW silent, cmp-api never loads, JS throws, no CMP at all), and
  // every terminal outcome reveals early. The hide is `visibility:hidden` (not
  // display) so reveal causes no reflow and the invisible banner can't be clicked.
  // Because visibility:hidden also fails our OWN isVisible() gate, scanAndReject
  // reveals the instant it MATCHES a known container, then hands off to
  // fastHideContainer() (display) in the SAME synchronous tick, no paint between.
  const PREHIDE_MAX_MS = 1500;
  let _prehideStyle = null;
  let _prehideRevealed = false;

  // Pure: build one rule PER selector (never `a,b{}`, a single invalid member
  // would drop the whole grouped rule). Skip anything that isn't plainly a CSS
  // selector or could break out of / inject into the stylesheet. The remote-config
  // sanitizer (normalizeRemoteConfig) only checks `typeof string`, so a future
  // remote containerSelector could be non-CSS; per-rule emission + this filter
  // confine the blast radius to the offending selector.
  function buildPrehideCss(selectors) {
    if (!Array.isArray(selectors)) return '';
    const rules = [];
    for (const group of selectors) {
      if (typeof group !== 'string') continue;
      for (const raw of group.split(',')) {
        const s = raw.trim();
        if (!s) continue;
        if (/[{}<>/]/.test(s)) continue;                          // stylesheet break-out / CSS-comment (/*) injection
        if (s.charAt(0) === '@' || s.charAt(0) === '(') continue; // at-rule injection / XPath-ish
        rules.push(s + '{visibility:hidden!important}');
      }
    }
    return rules.join('');
  }

  function revealPrehide() {
    if (_prehideRevealed) return;                  // idempotent - many paths call this
    _prehideRevealed = true;
    try {
      const s = _prehideStyle;
      if (s && s.parentNode) s.parentNode.removeChild(s);
      else if (s && typeof s.remove === 'function') s.remove();
    } catch (_) { /* silent */ }
    _prehideStyle = null;
    // Hand off to the document_start prehide script, which owns the real
    // flash-suppression <style> on most pages. Different function (no recursion);
    // no-op when that script didn't run (tests, or self-install fallback above).
    try { if (window.__pawsOff_revealPrehide) window.__pawsOff_revealPrehide(); } catch (_) { /* silent */ }
  }

  function installPrehide(docEl, css, schedule) {
    if (!docEl || typeof docEl.appendChild !== 'function' || !css) return null;
    try {
      const style = document.createElement('style'); // anonymous: no marker attr/id (anti-fingerprint)
      style.textContent = css;
      docEl.appendChild(style);
      _prehideStyle = style;
      // UNCONDITIONAL reveal, independent of the SW, cmp-api-main, or the signal.
      try { schedule(revealPrehide, PREHIDE_MAX_MS); }
      catch (_) { revealPrehide(); }                // scheduling failed → reveal NOW, never orphan
      return style;
    } catch (_) { revealPrehide(); return null; }
  }

  /**
   * Try to click a reject/decline/essential-only button within `root`.
   * Returns true if a button was successfully clicked.
   *
   * DOUBLE-CLICK RESILIENCE: some CMPs dismiss their click handler in a race,
   * so the first click is swallowed. A single delayed re-click 150ms later
   * catches those without side effects.
   */
  function tryClickReject(root, rejectSelectors, pierce) {
    for (const sel of rejectSelectors) {
      // scopedQueryAll swallows malformed-selector DOMExceptions per query, so a
      // single bad pattern cannot abort the remaining patterns.
      const candidates = scopedQueryAll(root, sel, pierce);
      for (const el of candidates) {
        if (isAcceptLabel(el)) continue;   // 5g veto
        if (isVisible(el)) {
          if (!consentClickAllowed()) return false;
          try {
            el.click();
            // Double-click resilience: re-click after 150ms in case the CMP
            // swallowed the first event (common with animated dismiss handlers).
            setTimeout(() => { try { if (el && el.click) el.click(); } catch (_) {} }, 150);
            return true;
          } catch (_) {
            // Click threw (detached node etc.), try the next candidate.
            continue;
          }
        }
      }
    }
    return false;
  }

  /**
   * Text-based fallback: click a button whose label classifies as REJECT.
   * If ONLY accept buttons exist (no reject option), do nothing, we never click
   * accept on the user's behalf. Uses the unified classifier so "Accept All
   * Cookies" is treated as accept and "Do not accept" as reject.
   */
  function tryTextFallback(root, pierce) {
    try {
      // Broadened element set: many CMPs (consentmanager.net, bespoke German
      // banners) render reject as a PLAIN <a> link or an [onclick] handler with
      // no role="button". Scanning only <button> missed those entirely. Safe to
      // widen here because every candidate is still gated by classifyLabel ===
      // 'reject' (must carry a reject phrase) AND the accept-veto below.
      const buttons = scopedQueryAll(root, 'button, a, [role="button"], [type="submit"], [onclick]', pierce)
        .filter(isVisible);

      const rejectBtns = buttons.filter((b) => classifyLabel(btnText(b).toLowerCase()) === 'reject');
      const acceptBtns = buttons.filter((b) => classifyLabel(btnText(b).toLowerCase()) === 'accept');

      if (acceptBtns.length > 0 && rejectBtns.length === 0) return false;


      if (rejectBtns.length > 0) {
        if (!consentClickAllowed()) return false; // gate the text fallback through the breaker too
        try {
          rejectBtns[0].click();
          return true;
        } catch (_) {
          return false;
        }
      }
    } catch (_) {
      // Silent.
    }
    return false;
  }

  // ── Core consent scan ────────────────────────���─────────────────────────────

  let _needsRescan = false;
  let _rescanLoopCount = 0; // Guard against anti-block infinite loops

  /**
   * Scans the page for known consent banners and attempts to reject them.
   * Called on initial load and on every relevant MutationObserver batch.
   */
  /** True when a framework defines a non-empty declarative steps[] chain. */
  function frameworkHasSteps(framework) {
    return !!framework.steps && Array.isArray(framework.steps) && framework.steps.length > 0;
  }
  /** A container is worth acting on only if it is present and visible. */
  function isUsableContainer(container) {
    return !!container && isVisible(container);
  }

  // ── Orphaned-backdrop reaper (fix: "banner gone but the overlay stays") ─────
  // Cross-origin CMPs (Sourcepoint et al.) render the dialog inside their OWN
  // iframe, but the full-screen click-blocking VEIL and the page scroll-lock live
  // in the TOP document. When the reject is performed from inside that iframe (a
  // different frame/process), the CMP USUALLY postMessages the parent to tear the
  // veil down, but on many publisher skins it doesn't, leaving a transparent or
  // dark overlay that swallows every click plus an `overflow:hidden` scroll-lock.
  // The page then looks clear but is unbrowsable. Nothing else in the pipeline
  // touches these top-frame nodes, so we reap them here once the consent surface
  // they belonged to is gone.
  //
  // SAFETY: curated, CMP-namespaced selectors ONLY (never a broad
  // "[class*=overlay]") so we can never strip a site's own modal backdrop, and we
  // act ONLY when a veil is visible AND no consent dialog/iframe is still on
  // screen, i.e. the veil is demonstrably orphaned. Top frame only. Fail-open:
  // any error → do nothing. No marker attribute is written (anti-fingerprint).
  const BACKDROP_SELECTORS = [
    '.sp_veil',                                  // Sourcepoint
    '.onetrust-pc-dark-filter',                  // OneTrust preference-centre dimmer
    '.truste_overlay', '.truste_box_overlay',    // TrustArc
    '.qc-cmp-cleanslate .qc-cmp2-bg', '.qc-cmp2-bg', // Quantcast
    '.didomi-popup-backdrop',                    // Didomi
    '.cky-overlay',                              // CookieYes
    '.cmpboxbg',                                 // consentmanager.net
  ];
  // CMP-namespaced scroll-lock classes applied to <html>/<body>.
  const SCROLL_LOCK_CLASSES = [
    'sp-message-open', 'ot-overflow-hidden', 'didomi-popup-open',
    'cky-modal-open', 'cmpbox-open', 'truste-overlay-on',
  ];

  // A consent SURFACE (the actual dialog/iframe, not the veil) is still visible.
  // While one is, the veil is legitimate and we leave it alone.
  function anyConsentSurfaceVisible() {
    try {
      const frames = document.querySelectorAll(
        'iframe[id^="sp_message_iframe"], iframe[src*="privacy-mgmt.com"], iframe[src*="sp-prod.net"], iframe[src*="consensu.org"], iframe[title*="consent" i], iframe[title*="cookie" i]'
      );
      for (let i = 0; i < frames.length; i++) { if (isVisible(frames[i])) return true; }
      for (let c = 0; c < activeConfig.length; c++) {
        let el = null;
        try { el = document.querySelector(activeConfig[c].containerSelector); } catch (_) { el = null; }
        if (el && isVisible(el)) return true;
      }
    } catch (_) { /* fall through → treat as none visible */ }
    return false;
  }

  // Pure decision (unit-testable): reap iff a veil is visible and nothing else
  // consent-related is on screen.
  function shouldReapBackdrop(backdropVisible, consentSurfaceVisible) {
    return !!backdropVisible && !consentSurfaceVisible;
  }

  const _reaped = new WeakSet();
  function neutralizeBackdrop(el) {
    try {
      if (!el || _reaped.has(el) || !el.style) return;
      _reaped.add(el);
      // Inline style on the veil only (a node the CMP created purely to block the
      // page). No marker attribute, matching fastHideContainer()'s approach.
      el.style.setProperty('display', 'none', 'important');
      el.style.setProperty('pointer-events', 'none', 'important');
    } catch (_) { /* silent */ }
  }
  function restoreScrollLock() {
    try {
      const targets = [document.documentElement, document.body];
      for (let i = 0; i < targets.length; i++) {
        const n = targets[i];
        if (!n) continue;
        try {
          if (n.style && n.style.overflow === 'hidden') n.style.removeProperty('overflow');
          if (n.style && n.style.overflowY === 'hidden') n.style.removeProperty('overflow-y');
        } catch (_) { /* silent */ }
        for (let c = 0; c < SCROLL_LOCK_CLASSES.length; c++) {
          try {
            if (n.classList && n.classList.contains(SCROLL_LOCK_CLASSES[c])) {
              n.classList.remove(SCROLL_LOCK_CLASSES[c]);
            }
          } catch (_) { /* silent */ }
        }
      }
    } catch (_) { /* silent */ }
  }

  // Top-frame reaper: neutralize any orphaned consent veil + restore scrolling.
  // Returns true if it reaped at least one veil.
  function reapOrphanBackdrops() {
    try {
      if (protectionPaused()) return false;
      if (window.top !== window) return false; // veils live in the top document
      let veils = [];
      try {
        veils = Array.prototype.slice.call(document.querySelectorAll(BACKDROP_SELECTORS.join(', ')));
      } catch (_) { veils = []; }
      const visibleVeils = veils.filter((v) => {
        try { return isVisible(v) && !_reaped.has(v); } catch (_) { return false; }
      });
      if (!visibleVeils.length) return false;
      if (!shouldReapBackdrop(true, anyConsentSurfaceVisible())) return false;
      for (let i = 0; i < visibleVeils.length; i++) neutralizeBackdrop(visibleVeils[i]);
      restoreScrollLock();
      try { logToStorage({ status: 'backdrop_reaped', framework: 'ConsentGhost' }); } catch (_) {}
      return true;
    } catch (_) { return false; }
  }

  // Schedule a few cheap reaper passes after a reject. The veil teardown a CMP
  // (or our in-iframe click) triggers is asynchronous and may itself leave the
  // veil behind, so we re-check at a handful of increasing delays. Idempotent:
  // the _reaped WeakSet + the surface-visible guard make repeat passes harmless.
  const BACKDROP_REAP_DELAYS = [300, 900, 1800, 3000];
  function scheduleBackdropReaps() {
    try {
      if (window.top !== window) return;
      for (let i = 0; i < BACKDROP_REAP_DELAYS.length; i++) {
        try { setTimeout(reapOrphanBackdrops, BACKDROP_REAP_DELAYS[i]); } catch (_) { /* silent */ }
      }
    } catch (_) { /* silent */ }
  }

  // ── Layer 0: declarative CMP rules engine (autoconsent-derived ruleset) ─────
  // Runs a vendored, MPL-licensed ruleset (from DuckDuckGo autoconsent) through
  // PawsOff's OWN DSL interpreter (consent-rules-engine.js) BEFORE the bundled-
  // selector and heuristic layers. This adds true multi-step opt-out (toggle
  // purposes off → Reject All → Save) and pay-or-consent wall awareness that the
  // flat selector layer cannot express. Fail-open: if the engine or its data did
  // not load, this is a silent no-op and the existing layers run unchanged.
  let _acEngine = null;
  let _acEngineTried = false;
  let _acLastRun = 0;
  function getAutoconsentEngine() {
    if (_acEngineTried) return _acEngine;
    _acEngineTried = true;
    try {
      const E = window.PawsOffConsentEngine;
      const P = window.PawsOffConsentPatterns;
      if (!E || typeof E.createConsentEngine !== 'function') return null;
      _acEngine = E.createConsentEngine({
        doc: document,
        win: window,
        clickAllowed: consentClickAllowed, // every click is gated by the breaker
        isVisible: isVisible,
        neverMatch: (P && P.NEVER_MATCH_PATTERNS) || [],
      });
    } catch (_) { _acEngine = null; }
    return _acEngine;
  }
  function getAutoconsentRules() {
    try {
      // PawsOff's OWN site-specific rules load FIRST so a hand-authored flow
      // (e.g. GEDI) wins over a generic vendored CMP guess. The vendored
      // (MPL-2.0) generic rules follow as the fallback.
      const O = window.PawsOffOwnConsentRules;
      const own = (O && Array.isArray(O.rules)) ? O.rules : [];
      const R = window.PawsOffConsentRules;
      const vendored = (R && Array.isArray(R.rules)) ? R.rules : [];
      const all = own.concat(vendored);
      return all.length ? all : null;
    } catch (_) { return null; }
  }
  // Returns { outcome: 'rejected'|'hidden'|'paywall', rule, verified } or null.
  async function tryAutoconsentLayer() {
    // Light throttle: detectCmp runs across the whole ruleset, and scanAndReject
    // fires on every mutation. Re-running the full ruleset more than ~twice a
    // second is wasteful; the observer will re-scan anyway.
    const t = Date.now();
    if (t - _acLastRun < 500) return null;
    _acLastRun = t;
    const engine = getAutoconsentEngine();
    const rules = getAutoconsentRules();
    if (!engine || !rules || !rules.length) return null;
    let result;
    try { result = await engine.run(rules, { isTop: window.top === window }); }
    catch (_) { return null; }
    if (!result) return null;
    if (result.paywall) {
      // Pay-or-consent wall: no free reject exists. Stand down honestly, never
      // fabricate a success. Log it as a wall (not 'rejected'). We do NOT mark
      // the page handled, so the heuristic layer (which has its own subscribe
      // veto) may still look for a genuine reject elsewhere on the page.
      try { logToStorage({ status: 'paywall_no_reject', framework: 'autoconsent:' + (result.rule || 'unknown') }); } catch (_) {}
      return { outcome: 'paywall', rule: result.rule, verified: null };
    }
    if (result.handled) {
      // Cosmetic hide, or a reject whose self-test reported NOT rejected, is
      // logged as 'hidden', distinct from a verified/blind 'rejected'.
      const outcome = (result.cosmetic || result.verified === false) ? 'hidden' : 'rejected';
      return { outcome: outcome, rule: result.rule, verified: result.verified };
    }
    return null;
  }

  async function scanAndReject() {
    // Drop execution if disabled or already handled.
    if (protectionPaused() || window.__pawsOff_consentGhost_handled) return;

    // Reload-loop breaker: some CMPs reload the page to apply consent (e.g.
    // check24.de). We allow a couple of rejects per origin, but once we've clearly
    // looped (LOOP_MAX_REJECTS within the window) we stand down for this load so we
    // don't reject → reload → reject forever. Normal single rejects, and a manual
    // reload + reject, still go through.
    if (await loopGuardTripped()) { revealPrehide(); window.__pawsOff_consentGhost_handled = true; return; }

    // Banner-REGENERATION breaker (synchronous + nav-resistant): catches CMPs
    // that re-inject a fresh banner without a reload and fire pushState to wipe
    // the click budget (focus.de/contentpass, repubblica.it). Once we've clearly
    // looped, stand down for the cool-off and log it ONCE, honestly, instead of
    // rejecting → new banner → rejecting forever.
    if (regenLoopTripped()) {
      revealPrehide();
      window.__pawsOff_consentGhost_handled = true;
      try {
        const _r = _regenLoad();
        if (_r && !_r.logged) {
          _r.logged = true; _regenSave(_r);
          logToStorage({ status: 'banner_regenerating', framework: 'ConsentGhost' });
        }
      } catch (_) {}
      return;
    }

    // Trailing-edge debounce: if a scan is already running, queue a rescan
    // and drop the current call. This guarantees that banners appearing during
    // an active scan are caught immediately after it finishes.
    if (_scanning) {
      if (_rescanLoopCount < 5) {
        _needsRescan = true;
      }
      return;
    }
    _scanning = true;
    const _myGen = _scanGuard.capture();

    try {
      // ── Layer 0: declarative autoconsent-derived ruleset ──────────────────
      // Multi-step + paywall-aware. Runs before the flat bundled selectors and
      // the heuristic. A pay-wall result falls through (already logged) so the
      // heuristic can still try; a real reject/hide short-circuits the scan.
      const _ac = await tryAutoconsentLayer();
      // Superseded by a newer scan/navigation while awaiting? Bail before acting.
      if (!_scanGuard.isCurrent(_myGen)) return;
      if (_ac && (_ac.outcome === 'rejected' || _ac.outcome === 'hidden')) {
        revealPrehide(); // H2: Layer-0 handled it - don't wait for the watchdog to reveal
        if (window.__pawsOff_consentGhost_observer) {
          try { window.__pawsOff_consentGhost_observer.disconnect(); } catch (_) {}
          window.__pawsOff_consentGhost_observer = null;
        }
        window.__pawsOff_consentGhost_handled = true;
        logToStorage({ status: _ac.outcome, framework: 'autoconsent:' + _ac.rule, verified: _ac.verified });
        // Count only true rejections in the all-time counter, a cosmetic 'hidden'
        // is not a reject.
        if (_ac.outcome === 'rejected') incrementTotal(CG_TOTAL_KEY);
        scheduleBackdropReaps(); // clear any leftover veil/scroll-lock the CMP left behind
        return;
      }

      for (const framework of activeConfig) {
        const pierce = framework.pierceShadow === true;

        // TODO(v2 5e): use querySelectorAll + iterate all matches. querySelector
        //   returns only the FIRST match, so a hidden decoy that matches the
        //   container selector ahead of the real banner makes us skip the
        //   framework entirely.
        let container = document.querySelector(framework.containerSelector);
        // For shadow-DOM CMPs the host is usually in light DOM, but cover the
        // case where the host itself is nested inside another shadow root.
        if (!container && pierce) {
          container = scopedQueryAll(document, framework.containerSelector, true)[0] || null;
        }
        // Reveal our OWN prehide BEFORE the isVisible() gate, visibility:hidden
        // would otherwise make us skip the very banner we hid. fastHideContainer()
        // (display) takes over synchronously below: no paint between reveal+rehide.
        if (container) revealPrehide();
        if (!isUsableContainer(container)) continue;

        // CSS fast-hide: instantly hide the banner so the user never sees it
        // flash while we look for the reject button. Undo if we fail to click.
        fastHideContainer(container);

        // Declarative steps[] engine: if the framework defines a multi-step
        // action sequence (from remote config), execute it first. This enables
        // complex flows (click Preferences → wait → click Reject) as pure DATA
        // without code changes. Falls through to simple selectors on failure.
        let clicked = false;
        if (frameworkHasSteps(framework)) {
          clicked = await executeSteps(framework.steps, container);
          // Superseded mid-await? Don't fall through into more clicks.
          if (!_scanGuard.isCurrent(_myGen)) return;
        }

        if (!clicked) clicked = tryClickReject(container, framework.rejectSelectors, pierce);
        if (!clicked) clicked = tryTextFallback(container, pierce);

        if (clicked) {
          // Disconnect immediately, before any await, so the CMP
          // dismiss animation doesn't keep firing the observer
          if (window.__pawsOff_consentGhost_observer) {
            try { window.__pawsOff_consentGhost_observer.disconnect(); } catch (_) {}
            window.__pawsOff_consentGhost_observer = null;
          }
          window.__pawsOff_consentGhost_handled = true;
          logToStorage({ status: 'rejected', framework: framework.name });
          incrementTotal(CG_TOTAL_KEY);
          scheduleBackdropReaps(); // clear any leftover veil/scroll-lock the CMP left behind
          return;
        }

        // No reject found yet, undo the hide so the banner reappears (we don't
        // silently hide consent without actually rejecting it).
        undoFastHide(container);

        // Container present but no actionable button yet (skeleton state). Log
        // ONCE per framework per page view (the observer re-scans on every
        // mutation; without this guard a buttonless container spams the log).
        if (!_detectedLogged.has(framework.name)) {
          _detectedLogged.add(framework.name);
          logToStorage({ status: 'detected_no_action', framework: framework.name });
        }
        // Surface it in the popup as "Detected" if it's still up after a grace
        // period and nothing rejects it (e.g. reject lives in a cross-origin CMP
        // iframe this frame can't reach). Deferred + deduped inside the helper.
        recordDetectedSurface(framework.name);
      }

      // ── Heuristic backstop ──────────────────────────────────────────────
      // Every named framework missed. Try the generic, multilingual,
      // translation-proof reject before giving up. This is what catches unknown
      // CMPs (Sourcepoint variants, bespoke walls) in any language.
      // Generic detection needs real visibility, drop any remaining prehide so a
      // reject button inside a still-hidden known container isn't invisible to us.
      revealPrehide();
      let _backstopDone = tryHeuristicReject();
      const _frameReject = !_backstopDone && inConsentFrame();
      if (_frameReject) _backstopDone = tryConsentFrameReject();
      if (_backstopDone) {
        if (window.__pawsOff_consentGhost_observer) {
          try { window.__pawsOff_consentGhost_observer.disconnect(); } catch (_) {}
          window.__pawsOff_consentGhost_observer = null;
        }
        window.__pawsOff_consentGhost_handled = true;
        logToStorage({ status: 'rejected', framework: _frameReject ? 'ConsentFrame' : 'Heuristic' });
        incrementTotal(CG_TOTAL_KEY);
        scheduleBackdropReaps(); // clear any leftover veil/scroll-lock the CMP left behind
        return;
      }

      // Pay-or-consent WALL stand-down: a wall was recognised on one of the paths
      // above. Do NOT keep scanning/clicking, that is what loops focus.de. Mark
      // handled (so the observer disconnects and re-injected banners are ignored)
      // and log the honest 'paywall_no_reject' outcome once. We never fabricate a
      // reject; the wall stays visible because refusing it would cost the user a
      // paid subscription.
      if (_wallStandDown) {
        if (window.__pawsOff_consentGhost_observer) {
          try { window.__pawsOff_consentGhost_observer.disconnect(); } catch (_) {}
          window.__pawsOff_consentGhost_observer = null;
        }
        window.__pawsOff_consentGhost_handled = true;
        if (!_wallStandDownLogged) {
          _wallStandDownLogged = true;
          logToStorage({ status: 'paywall_no_reject', framework: 'wall' });
        }
        return;
      }
    } catch (err) {
      revealPrehide(); // H2: never leave content hidden if the scan threw before a reveal
      try {
        logToStorage({ status: 'error', message: err && err.message });
      } catch (_) {
        // Truly silent.
      }
    } finally {
      // Only the CURRENT scan may release the lock / schedule a rescan. A
      // superseded scan (navigation or re-enable bumped the generation while we
      // awaited) leaves the newer scan's lock + state untouched, so its late
      // await can never double-click the new page.
      if (_scanGuard.isCurrent(_myGen)) {
        _scanning = false;
        if (_needsRescan && !window.__pawsOff_consentGhost_handled) {
          _needsRescan = false;
          _rescanLoopCount++;
          setTimeout(scanAndReject, 10);
        } else {
          _rescanLoopCount = 0; // Reset when the page goes quiet
        }
      }
    }
  }

  // ── MutationObserver setup ─────────────────────────────────────────────────

  function startObserver() {
    try {
      const observer = new MutationObserver(async (mutations, obs) => {
        // Check handled FIRST before doing anything else
        if (window.__pawsOff_consentGhost_handled) {
          obs.disconnect();
          window.__pawsOff_consentGhost_observer = null;
          return;
        }

        // 3a FIX: react to BOTH newly added nodes AND attribute toggles. Many
        // CMPs (OneTrust, Cookiebot) ship the banner hidden in the initial HTML
        // and REVEAL it by flipping a class / style / hidden attribute, zero
        // nodes are added, so the old childList-only check never fired and those
        // banners were never rejected.
        const relevant = mutations.some(
          (m) => m.addedNodes.length > 0 || m.type === 'attributes'
        );
        if (!relevant) return;

        // A cross-origin CMP (Sourcepoint) rejects from INSIDE its own iframe, so
        // this top frame never sets `handled`, but the iframe's removal IS a
        // mutation here. Reap any veil/scroll-lock it orphaned on the way out.
        reapOrphanBackdrops();

        // The trailing-edge debounce inside scanAndReject() safely handles batches
        // arriving while a scan is in flight, so we can just fire-and-forget here.
        scanAndReject();
      });

      // 3a: attributeFilter is scoped to the handful of attributes a CMP
      // realistically toggles to reveal a banner. Watching class/style across
      // the whole subtree is unavoidably a bit noisy on animation-heavy sites,
      // but the _scanning lock + `handled` short-circuit make repeat callbacks
      // cheap, and OBSERVER_LIFETIME_MS guarantees teardown regardless.
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'open', 'data-visible'],
      });

      window.__pawsOff_consentGhost_observer = observer;

      // Hard teardown (see OBSERVER_LIFETIME_MS rationale). Guard the null-out so
      // a stale timer from a previous observer cannot clobber a newer reference.
      setTimeout(() => {
        try { observer.disconnect(); } catch (_) { /* already gone */ }
        if (window.__pawsOff_consentGhost_observer === observer) {
          window.__pawsOff_consentGhost_observer = null;
        }
      }, OBSERVER_LIFETIME_MS);
    } catch (err) {
      logToStorage({ status: 'observer_error', message: err && err.message });
    }
  }

  // ── Public init function ───────────────────────────────────────────────────

  window.__pawsOff_consentGhost_init = async function () {
    try {
      // Respect the on/off switch from the popup/options UI. Disabled → tear any
      // observer down and do nothing (fail-open: only an explicit `true` flag
      // disables; missing/unknown stays protecting).
      await loadDisabledFlag();
      if (protectionPaused()) {
        revealPrehide(); // disabled/paused: never leave a banner hidden on a site we won't act on
        if (window.__pawsOff_consentGhost_observer) {
          try { window.__pawsOff_consentGhost_observer.disconnect(); } catch (_) {}
          window.__pawsOff_consentGhost_observer = null;
        }
        return;
      }

      // Perf gate: in a sub-frame that is neither a known CMP host nor a consent
      // page, do nothing, reveal any prehide and bail. This spares empty ad
      // iframes the regex rebuild, scan, and MutationObserver. Top frames and
      // real CMP/consent sub-frames fall through to the normal path.
      if (window.top !== window &&
          !shouldRunInFrame(false, location.hostname, (document.body && document.body.innerText) || '')) {
        revealPrehide();
        return;
      }

      // Rebuild text patterns ONLY if the page language changed since last build.
      // This prevents expensive regex compilation on every SPA navigation hash-change.
      const currentLang = detectLangs().join(',');
      if (currentLang !== _lastBuiltLang) {
        REJECT_PHRASES_FLAT = flatPhrases(REJECT_PHRASES_BY_LANG);
        ACCEPT_PHRASES_FLAT = flatPhrases(ACCEPT_PHRASES_BY_LANG);
        SUBSCRIBE_PHRASES_FLAT = flatPhrases(SUBSCRIBE_PHRASES_BY_LANG);
        PREF_PHRASES_FLAT = flatPhrases(PREF_PHRASES_BY_LANG);
        _lastBuiltLang = currentLang;
      }

      requestCmpApiMain();

      // Fire-and-forget remote config loader: never block the first scan waiting
      // for the service worker.
      loadRemoteConfig().then(() => {
        if (!window.__pawsOff_consentGhost_handled) scanAndReject();
      });

      scanAndReject(); // starts immediately with bundled config
      if (!window.__pawsOff_consentGhost_handled) {
        startObserver();
      }
      // Top-frame backstop: a cross-origin CMP that rejects from inside its own
      // iframe never flips `handled` here, so also sweep for an orphaned veil /
      // scroll-lock on a few short delays regardless of this frame's outcome.
      scheduleBackdropReaps();
    } catch (err) {
      try {
        logToStorage({ status: 'init_error', message: err && err.message });
      } catch (_) {
        // Silent.
      }
    }
  };

  // ── Live toggle: react to the popup/options switch without a reload ─────────
  // When the user flips ConsentGhost off, stop acting immediately; when they
  // flip it back on, re-run a scan + re-arm the observer on the current page.
  try {
    if (chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        try {
          if (area !== 'local' || (!changes[DISABLED_KEY] && !changes[ALLOW_KEY])) return;
          const wasPaused = protectionPaused();
          if (changes[DISABLED_KEY]) _disabled = changes[DISABLED_KEY].newValue === true;
          if (changes[ALLOW_KEY]) {
            const allow = changes[ALLOW_KEY].newValue;
            const oh = hashHost(location.hostname);
            const site = allow && allow.sites && oh ? allow.sites[oh] : null;
            _sitePaused = !!(site && site.paused > 0);
          }
          const nowPaused = protectionPaused();
          if (nowPaused === wasPaused) return;
          if (nowPaused) {
            if (window.__pawsOff_consentGhost_observer) {
              try { window.__pawsOff_consentGhost_observer.disconnect(); } catch (_) {}
              window.__pawsOff_consentGhost_observer = null;
            }
          } else {
            // Re-enabled mid-page: allow a fresh attempt on whatever is shown now.
            window.__pawsOff_consentGhost_handled = false;
            _scanGuard.invalidate(); // drop any scan orphaned by the paused window
            _scanning = false;
            _cmpApiRequested = false;
            window.__pawsOff_consentGhost_init();
          }
        } catch (_) { /* silent */ }
      });
    }
  } catch (_) { /* silent - storage API unavailable */ }

  // ── SPA navigation reset ───────────────────────────────────────────────────
  //
  // Chrome 102+ Navigation API fires on ALL client-side navigation (pushState,
  // replaceState, popstate, anchor clicks, fragment changes) in one handler with
  // no history monkey-patching, avoiding conflicts with other extensions.
  function resetForNavigation() {
    try {
      if (window.__pawsOff_consentGhost_observer) {
        window.__pawsOff_consentGhost_observer.disconnect();
        window.__pawsOff_consentGhost_observer = null;
      }
      window.__pawsOff_consentGhost_handled = false;

      // Invalidate any in-flight scan: bumping the generation makes the orphaned
      // scan bail after its next await (BEFORE clicking) and skip its finally, so
      // its late-resolving await can never double-click the freshly navigated
      // page. (Closes v2 2c, the abort-token / generation-counter fix.)
      _scanGuard.invalidate();
      _scanning = false;
      _needsRescan = false;
      _rescanLoopCount = 0;
      _cachedContainer = null; // reset cached container on navigation
      _heuristicCooldownUntil = 0; // new page → allow an immediate overlay sweep
      _multiStepTried = false; // new page → allow the preferences drill-in again
      _cbReset();              // new page → fresh consent-click budget (full reloads keep theirs)
      _wallRecorded = false;   // new page → allow one wall flag again
      _wallStandDown = false;  // new page → re-evaluate wall status from scratch
      _wallStandDownLogged = false;
      _detectedLogged.clear(); // new page → allow one detected_no_action per framework again
      _seenRecorded = false;   // new page → allow one "detected" catch again
      _seenScheduled = false;

      window.__pawsOff_consentGhost_init();
    } catch (err) {
      try {
        logToStorage({ status: 'spa_reset_error', message: err && err.message });
      } catch (_) {
        // Silent.
      }
    }
  }

  if (typeof navigation !== 'undefined') {
    try {
      // Chrome 102+ Navigation API handles SPAs natively, but we guard against
      // hash changes to avoid tearing down the observer continuously.
      navigation.addEventListener('navigate', (e) => {
        if (e.navigationType === 'traverse') return; // back/forward only, skip
        const dest = new URL(e.destination.url);
        if (dest.pathname === location.pathname && dest.hash !== location.hash) return;
        resetForNavigation();
      });
    } catch (_) {
      // Silent, older Chromium without the Navigation API; initial scan + the
      // observer still cover the first page view.
    }
  }

  // ── MAIN world CMP API tier signal ─────────────────────────────────────────
  // cmp-api-main.js (world: MAIN) calls CMP APIs (OneTrust.RejectAll, etc.) and
  // dispatches this event on success. We mark the page handled and disconnect the
  // observer so the DOM-click tier doesn't double-act. CustomEvents cross the
  // isolated-world boundary because they travel on the shared document object;
  // they do NOT carry any data (the detail field is ignored), we only care that
  // the event fired (i.e. a CMP API call succeeded).
  try {
    document.addEventListener('pawsoff:cmp:rejected', (e) => {
      try {
        if (protectionPaused()) return;
        const cmp = (e && e.detail && e.detail.cmp) || 'CMP-API';
        if (window.__pawsOff_consentGhost_handled) return; // already done

        // The page can dispatch DOM events too. Treat this signal as proof only
        // when a known banner was visibly present before the extension requested
        // MAIN-world execution; otherwise it is merely a hint to rescan.
        if (_cmpApiVisibleBefore.length === 0) {
          scanAndReject();
          return;
        }

        // Post-action verification: Wait 1200ms before declaring success.
        // Some CMP APIs silently no-op, and some animate their dismissal over
        // ~400-800ms. If the banner remains visible after the wait, we fall
        // back to Tier 2 (DOM click).
        setTimeout(() => {
          if (window.__pawsOff_consentGhost_handled) return;
          
          let stillVisible = false;
          for (const f of activeConfig) {
            let container = document.querySelector(f.containerSelector);
            if (!container && f.pierceShadow) {
              container = scopedQueryAll(document, f.containerSelector, true)[0] || null;
            }
            if (container && isVisible(container)) {
              stillVisible = true;
              break;
            }
          }

          if (!stillVisible) {
            // API succeeded (banner removed or never shown).
            revealPrehide();
            if (window.__pawsOff_consentGhost_observer) {
              try { window.__pawsOff_consentGhost_observer.disconnect(); } catch (_) {}
              window.__pawsOff_consentGhost_observer = null;
            }
            window.__pawsOff_consentGhost_handled = true;
            logToStorage({ status: 'rejected', framework: 'CMP-API/' + cmp });
            incrementTotal(CG_TOTAL_KEY);
          } else {
            // API failed silently, banner is still staring at the user.
            // Do NOT mark handled, allow the observer / Tier 2 to run.
            logToStorage({ status: 'api_failed_fallback', framework: 'CMP-API/' + cmp });
            scanAndReject(); // Trigger scan to immediately fallback
          }
        }, 1200);
      } catch (_) { /* silent */ }
    });
  } catch (_) { /* silent - safe to omit if addEventListener unavailable */ }

  // ── Auto-invoke ────────────────────────────────────────────────────────────
  // We now inject at document_start (to catch CMPs the instant they appear and
  // to reach iframes early). At that moment document.body may not exist yet and
  // the scan/heuristic touch it, so defer the FIRST init until the DOM is at
  // least interactive. Subsequent observer/navigation runs are unaffected.
  function __pawsOff_consentGhost_boot() {
    // Step 3: suppress the first-paint banner flash for KNOWN CMP containers from
    // document_start, with an unconditional reveal watchdog. Attached to <html>
    // (document.body may not exist yet). Fail-open: any failure → no prehide.
    try {
      // Prehide is normally owned by consent-prehide.js (document_start) and
      // revealed via the shared isolated-world hook. Self-install ONLY as a
      // fail-safe if that script never ran (detected by the absent hook). At
      // document_idle this can't beat first paint, but it preserves the
      // reject-without-flash contract and keeps the unit tests' invariant.
      if (!window.__pawsOff_revealPrehide) {
        installPrehide(document.documentElement,
                       buildPrehideCss(activeConfig.map((f) => f.containerSelector)),
                       setTimeout);
      }
    } catch (_) { /* silent */ }
    // Race the CMP SDK as early as possible: request the MAIN-world API tier at
    // document_start, BEFORE init()'s body-gated deferral. requestCmpApiMain()
    // touches no document.body, so it is safe here; the service worker re-checks
    // disabled/paused before injecting (background.js handleConsentMainInjection),
    // so an early call on a paused/disabled site injects nothing. The
    // _cmpApiRequested guard dedupes against init()'s own later call.
    try { requestCmpApiMain(); } catch (_) { /* silent */ }
    try {
      if (document.body) {
        window.__pawsOff_consentGhost_init();
      } else {
        document.addEventListener('DOMContentLoaded', () => {
          window.__pawsOff_consentGhost_init();
        }, { once: true });
      }
    } catch (_) {
      // Last-resort: try a direct init so we never silently no-op.
      try { window.__pawsOff_consentGhost_init(); } catch (__) { /* silent */ }
    }
  }
  __pawsOff_consentGhost_boot();

  // ── Test-only export ────────────────────────────────────────────────────────
  // NO-OP IN CHROME: a content script has no CommonJS `module`, so this block is
  // skipped at runtime (typeof module === 'undefined'). Under Jest it exposes the
  // pure helpers for unit testing. Never relied on by the extension itself.
  try {
    if (typeof module !== 'undefined' && module.exports) {
      module.exports.__test = {
        escapeRe, phrasesToRegexes, detectLangs, buildPatterns,
        isAcceptLabel, btnText, normalizeRemoteConfig,
        flatPhrases, looksAccept, looksReject, heuristicLabel,
        looksPreferences, PREF_PHRASES_BY_LANG,
        surfaceLooksLikeWall, WALL_BRAND_HINTS,
        REJECT_PHRASES_BY_LANG, ACCEPT_PHRASES_BY_LANG, BUNDLED_CONSENT_CONFIG,
        consentClickAllowed, CB_MAX_ACTIONS, CB_WINDOW_MS, CB_KEY,
        regenLoopTripped, recordRejectForRegen, _regenLoad, _regenSave,
        REGEN_KEY, REGEN_MAX_REJECTS, REGEN_WINDOW_MS, REGEN_STANDDOWN_MS,
        makeScanGuard,
        buildPrehideCss, installPrehide, revealPrehide, PREHIDE_MAX_MS,
        pickConsentContainer, findConsentContainer, shouldRunInFrame,
        shouldReapBackdrop, reapOrphanBackdrops, anyConsentSurfaceVisible,
        restoreScrollLock, neutralizeBackdrop,
        BACKDROP_SELECTORS, SCROLL_LOCK_CLASSES,
      };
    }
  } catch (_) { /* ignore */ }

}());