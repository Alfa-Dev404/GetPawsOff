// cmp-api-main.js, PawsOff (ConsentGhost CMP API tier)
//
// Runs in the PAGE's MAIN world ("world": "MAIN" in manifest.json) to call CMP
// JS APIs directly - rejects consent programmatically, independent of DOM
// structure or cross-origin iframes. Highest-reliability tier; falls back to
// consent-ghost.js's selector click and heuristic scan (isolated world, same
// frame) if no CMP API matches. On success, dispatches a CustomEvent on
// `document` (same-frame only) that consent-ghost.js listens for.
//
// Success model: never treat "method existed, didn't throw" as success (the
// arte.tv silent-no-op failure mode). Tier A (__tcfapi/__uspapi) confirms via
// the standard read-back getter before signalling; TCF aborts silently when
// gdprApplies === false (nothing to reject). Tier B (vendor SDKs) has no
// verifiable MAIN-world getter, so confirmation is delegated to consent-ghost.js's
// DOM recheck; it signals once on apply and never claims a hard "confirmed" stop.
// signal() fires at most once per page (first tier wins).
//
// Runs in page MAIN world: no chrome.* APIs, no extension storage access, never
// logs URLs/PII, only calls CMP's own public methods, only dispatches one inert
// CustomEvent (no postMessage, no fetch).
//
// CMP coverage: OneTrust, Cookiebot/CookieConsent, Didomi, Osano, Usercentrics,
// TrustArc, CookieYes, consentmanager.net, Axeptio, Borlabs, IAB TCF v2.2
// (confirmed), IAB GPP (best-effort), IAB USP/CCPA (data call).

(function () {
  'use strict';

  // ── Coordination state ───────────────────────────────────────────────────
  // Kept in-closure, not on window - a page-visible global would let sites
  // fingerprint the extension or tamper with state.
  let _cmpApiConfirmed = false;  // Tier A positive read-back only → HARD stop
  let _signalDispatched = false; // signal() fires at most once (first tier wins)
  let _cmpGiveUp = false;        // watchdog: no CMP on this page → stop all probes

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Dispatch the success signal to the isolated-world listener in
   * consent-ghost.js (same frame, same document), AT MOST ONCE. CustomEvent is
   * same-frame only, it does NOT cross the frame boundary, which is what we want.
   * @param {string} cmpName
   */
  function signal(cmpName) {
    if (_signalDispatched) return;
    _signalDispatched = true;
    // No window.* marker - page-visible, would fingerprint the extension.
    try {
      document.dispatchEvent(
        new CustomEvent('pawsoff:cmp:rejected', {
          detail:     { cmp: cmpName },
          bubbles:    false,
          cancelable: false,
        }),
      );
    } catch (_) { /* silent */ }
  }

  /**
   * Invoke obj[method](...args) without throwing. Returns true iff invoked -
   * "invoked" is not "applied", a method can silently no-op, so this return
   * value alone never drives a signal (see runProbe).
   */
  function call(obj, method, args) {
    try {
      if (obj && typeof obj[method] === 'function') {
        obj[method].apply(obj, args || []);
        return true;
      }
    } catch (_) { /* silent */ }
    return false;
  }

  /** Any condition that should halt every probe (a tier won, or no CMP here). */
  function stopAll() { return _cmpApiConfirmed || _signalDispatched || _cmpGiveUp; }

  /**
   * Probe runner - the single place that decides when to signal.
   *
   * spec = { name, ready(), apply(), confirm()?, deferSignal?, budget?, interval? }
   *
   * Tier B (no confirm): ready → apply once → signal once → stop; confirmation
   * delegated to the isolated-world DOM recheck.
   * Tier A (confirm): ready → apply once → poll confirm() → signal only on
   * confirm()===true. 'abort' or budget-elapsed → no signal, DOM tier runs instead.
   *
   * setTimeout is fine here - content scripts run in the page process, not the
   * evictable service worker.
   */
  function runProbe(spec) {
    const interval = spec.interval || 300;
    const deadline = Date.now() + (spec.budget || 5000);
    let applied = false;
    function tick() {
      if (stopAll()) return;              // another tier won, or no CMP on page
      if (Date.now() > deadline) return;  // budget spent → fall through to DOM tier
      try {
        if (!applied) {
          if (spec.ready()) {
            applied = true;                       // apply AT MOST ONCE
            const invoked = spec.apply();
            if (!spec.confirm) {                  // ── Tier B ──
              if (invoked !== false && !spec.deferSignal) signal(spec.name);
              return;                             // applied once → STOP
            }
            // ── Tier A ── fall through to confirm polling on the next tick
          }
        } else {
          const r = spec.confirm();
          if (r === true) { _cmpApiConfirmed = true; signal(spec.name); return; }
          if (r === 'abort') return;              // e.g. TCF gdprApplies === false
        }
      } catch (_) { /* silent */ }
      setTimeout(tick, interval);
    }
    tick();
  }

  // ── Pure predicates (no side effects), unit-tested via module.exports.__test ─

  /** True iff a TCF TCData object grants NO purpose consent (all rejected). An
   *  empty/absent consents map means nothing was granted → rejected. */
  function tcfAllRejected(tcData) {
    if (!tcData || typeof tcData !== 'object') return false;
    const purpose = tcData.purpose;
    if (!purpose || typeof purpose !== 'object') return true;
    // Requires no granted consent AND no asserted legitimate interest - a CMP
    // can keep tracking on LI grounds even with consent off.
    const maps = [purpose.consents, purpose.legitimateInterests];
    for (let m = 0; m < maps.length; m++) {
      const map = maps[m];
      if (map && typeof map === 'object') {
        const keys = Object.keys(map);
        for (let i = 0; i < keys.length; i++) { if (map[keys[i]] === true) return false; }
      }
    }
    return true;
  }

  /** True iff a US-Privacy string encodes CCPA opt-out of sale AND sharing.
   *  '1YYN' = CCPA applies / opted OUT of sale / opted OUT of sharing. This is
   *  the exact string the USP probe writes via setUSPData. */
  function uspConfirmed(s) { return s === '1YYN'; }

  /** Pure mirror of runProbe's signal decision, for contract tests. Asserts the
   *  invariants: Tier B signals once on a successful invoke; Tier A signals only
   *  on confirm===true; 'abort'/pending never signal; signalled/confirmed are
   *  terminal (no second signal).
   *  prev = {confirmed, signalled, applied};
   *  ev   = {tier:'A'|'B', ready, invoked, deferSignal, confirm}. */
  function probeOutcome(prev, ev) {
    const s = {
      confirmed: !!(prev && prev.confirmed),
      signalled: !!(prev && prev.signalled),
      applied:   !!(prev && prev.applied),
      signalNow: false,
    };
    ev = ev || {};
    if (s.confirmed || s.signalled) {            // hard stop / first-wins
      if (!s.applied && ev.ready) s.applied = true;
      return s;
    }
    if (!s.applied) {
      if (ev.ready) {
        s.applied = true;
        if (ev.tier === 'B' && ev.invoked !== false && !ev.deferSignal) {
          s.signalled = true; s.signalNow = true;
        }
      }
      return s;
    }
    if (ev.tier === 'A' && ev.confirm === true) { // Tier A confirm phase
      s.confirmed = true; s.signalled = true; s.signalNow = true;
    }
    return s;
  }

  // ── Early-out watchdog ───────────────────────────────────────────────────
  // Most pages run no CMP at all - watch for any known CMP global within a
  // short grace window; if none appears, set the give-up flag so every probe
  // stops at its next tick instead of polling its full budget for nothing.
  const CMP_GLOBALS = [
    'OneTrust', 'OneTrustStub', 'Cookiebot', 'CookieConsent', 'Didomi', 'Osano',
    'UC_UI', 'truste', 'TrustArc', 'CookieYes', '__cmp', 'axeptioSDK',
    'BorlabsCookie', '__tcfapi', '__gpp', '__uspapi',
  ];
  function cmpGlobalPresent() {
    for (let i = 0; i < CMP_GLOBALS.length; i++) {
      try { if (window[CMP_GLOBALS[i]]) return true; } catch (_) { /* guard */ }
    }
    return false;
  }
  (function watchdog(start) {
    if (stopAll()) return;
    if (cmpGlobalPresent()) return;                               // CMP here → run probes
    if (Date.now() - start > 3500) { _cmpGiveUp = true; return; } // none in 3.5s → stop
    setTimeout(() => watchdog(start), 300);
  }(Date.now()));

  // ── 1. OneTrust ──────────────────────────────────────────────────────────────
  // Used by: BBC, Reuters, Adobe, Salesforce, SAP, many US/EU enterprises.
  // SDK method: window.OneTrust.RejectAll() (older banner SDK: OneTrustStub).
  runProbe({
    name: 'OneTrust',
    ready: () => {
      const ot = window.OneTrust || window.OneTrustStub;
      return !!(ot && typeof ot.RejectAll === 'function');
    },
    apply: () => call(window.OneTrust || window.OneTrustStub, 'RejectAll'),
  });

  // ── 2. Cookiebot / CookieConsent ──────────────────────────────────────────
  // Used by: millions of small/medium EU sites (Cybot Cookiebot SaaS).
  // SDK method: window.Cookiebot.decline() / window.CookieConsent.decline().
  runProbe({
    name: 'Cookiebot',
    ready: () => {
      const cb = window.Cookiebot || window.CookieConsent;
      return !!(cb && (typeof cb.decline === 'function' || typeof cb.withdraw === 'function'));
    },
    apply: () => {
      const cb = window.Cookiebot || window.CookieConsent;
      return call(cb, 'decline') || call(cb, 'withdraw');
    },
  });

  // ── 3. Didomi ─────────────────────────────────────────────────────────────
  // Used by: arte.tv, Le Figaro, L'Équipe, M6, many FR/EU publishers.
  // setUserDisagreeToAll() is a no-op until consent state initialises, so we
  // use the race-free didomiOnReady queue as primary, with a polling backstop
  // gated by isReady(). Tier B: confirmation delegated to the DOM recheck.
  function rejectDidomi(Didomi) {
    try {
      if (stopAll()) return true;
      if (!Didomi || typeof Didomi.setUserDisagreeToAll !== 'function') return false;
      Didomi.setUserDisagreeToAll();
      // Some publisher themes (e.g. arte.tv) save the choice but leave the
      // notice on screen, force-hide it so the page is actually usable.
      try {
        if (Didomi.notice && typeof Didomi.notice.hide === 'function') Didomi.notice.hide();
      } catch (_) { /* silent */ }
      signal('Didomi');
      return true;
    } catch (_) { return false; }
  }
  // PRIMARY (race-free): Didomi invokes our callback once it is truly ready,
  // even if it became ready before this script executed.
  try {
    window.didomiOnReady = window.didomiOnReady || [];
    window.didomiOnReady.push(function (Didomi) { rejectDidomi(Didomi); });
  } catch (_) { /* silent */ }
  // BACKSTOP: some integrations replace/pre-drain the queue. Poll, but act ONLY
  // once isReady() is true. deferSignal: rejectDidomi() emits the signal itself.
  runProbe({
    name: 'Didomi',
    deferSignal: true,
    ready: () => {
      const D = window.Didomi;
      return !!(D && typeof D.isReady === 'function' && D.isReady()
                && typeof D.setUserDisagreeToAll === 'function');
    },
    apply: () => rejectDidomi(window.Didomi),
  });

  // ── 4. Osano ──────────────────────────────────────────────────────────────
  // SDK method: window.Osano.cm.deny('all').
  runProbe({
    name: 'Osano',
    ready: () => !!(window.Osano && window.Osano.cm && typeof window.Osano.cm.deny === 'function'),
    apply: () => call(window.Osano.cm, 'deny', ['all']),
  });

  // ── 5. Usercentrics UC_UI ─────────────────────────────────────────────────
  // Used by: Axel Springer brands, ProSiebenSat.1, many DE publishers.
  // SDK method: window.UC_UI.denyAllConsents().
  runProbe({
    name: 'Usercentrics',
    ready: () => !!(window.UC_UI && typeof window.UC_UI.denyAllConsents === 'function'),
    apply: () => call(window.UC_UI, 'denyAllConsents'),
  });

  // ── 6. TrustArc ───────────────────────────────────────────────────────────
  // API: window.truste.api.clickListener('rejectall') (v1) or
  //      window.TrustArc.consent.reject() (v2).
  runProbe({
    name: 'TrustArc',
    ready: () => {
      if (window.truste && window.truste.api && typeof window.truste.api.clickListener === 'function') return true;
      if (window.TrustArc && window.TrustArc.consent && typeof window.TrustArc.consent.reject === 'function') return true;
      return false;
    },
    apply: () => {
      if (window.truste && window.truste.api && call(window.truste.api, 'clickListener', ['rejectall'])) return true;
      if (window.TrustArc && window.TrustArc.consent && call(window.TrustArc.consent, 'reject')) return true;
      return false;
    },
  });

  // ── 7. CookieYes ──────────────────────────────────────────────────────────
  // API: window.CookieYes.reject() / .decline().
  runProbe({
    name: 'CookieYes',
    ready: () => !!(window.CookieYes && (typeof window.CookieYes.reject === 'function' || typeof window.CookieYes.decline === 'function')),
    apply: () => call(window.CookieYes, 'reject') || call(window.CookieYes, 'decline'),
  });

  // ── 8. consentmanager.net ─────────────────────────────────────────────────
  // API: window.__cmp('setConsent', 0, cb) (proprietary command, non-IAB). The
  // callback acknowledges the command, so we signal from the ack (deferSignal)
  // rather than on a bare invoke.
  runProbe({
    name: 'consentmanager',
    deferSignal: true,
    budget: 3000,
    ready: () => typeof window.__cmp === 'function',
    apply: () => {
      try {
        window.__cmp('setConsent', 0, function (result) {
          if (result) signal('consentmanager');
        });
        return true;
      } catch (_) { return false; }
    },
  });

  // ── 9. Axeptio ────────────────────────────────────────────────────────────
  // API: window.axeptioSDK.decline().
  runProbe({
    name: 'Axeptio',
    ready: () => !!(window.axeptioSDK && typeof window.axeptioSDK.decline === 'function'),
    apply: () => call(window.axeptioSDK, 'decline'),
  });

  // ── 10. Borlabs Cookie (WordPress) ────────────────────────────────────────
  // API: window.BorlabsCookie.doDeclineAllCookies().
  runProbe({
    name: 'Borlabs',
    ready: () => !!(window.BorlabsCookie && typeof window.BorlabsCookie.doDeclineAllCookies === 'function'),
    apply: () => call(window.BorlabsCookie, 'doDeclineAllCookies'),
  });

  // ── 11. IAB TCF v2.2, Tier A: setConsent, then confirm via getTCData ──────
  // Standard TCF v2.2 has no "reject" command, but Sourcepoint, Quantcast,
  // AppConsent, and Didomi implement a proprietary setConsent extension on
  // their top-frame __tcfapi stub. Apply it, then read back via the standard
  // getTCData and only signal when no purpose consent remains. Readiness pings
  // until cmpStatus === 'loaded'. gdprApplies === false aborts (no signal) -
  // GDPR doesn't apply, so the DOM tier handles any visible banner instead.
  // The reject payload also clears purpose legitimate interests (LI is
  // opt-out; consent-only reject leaves it granted) - strictly more rejection,
  // never less, so it can't weaken the tier's success condition.
  let _tcfLoaded = false;
  const _tcf = { result: null }; // null=pending | true | false | 'abort'

  // TCF v2.2/v2.3: 11 standard purposes; legitimate interest is permissible
  // only for purposes 2 and 7-11 (per IAB Tech Lab's GDPR-TCF v2.2 spec and
  // Ethyca's TCF reference).
  const TCF_PURPOSES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const TCF_LI_PURPOSES = [2, 7, 8, 9, 10, 11];

  // Pure: reject-all payload for the proprietary __tcfapi('setConsent') call -
  // clears consent for all 11 purposes and legitimate interest for the
  // LI-eligible ones. vendor.* stays empty; the GVL is open-ended and not
  // enumerated here.
  function buildTcfRejectPayload() {
    const consents = {};
    const legitimateInterests = {};
    TCF_PURPOSES.forEach((p) => { consents[p] = false; });
    TCF_LI_PURPOSES.forEach((p) => { legitimateInterests[p] = false; });
    return {
      purpose:             { consents: consents, legitimateInterests: legitimateInterests },
      vendor:              { consents: {}, legitimateInterests: {} },
      specialFeatureOptins: {},
    };
  }
  function applyTcf() {
    try {
      window.__tcfapi('setConsent', 2, function (success) {
        if (!success) return; // leave pending → budget expires → no signal
        try {
          window.__tcfapi('getTCData', 2, function (tcData, ok) {
            if (!ok || !tcData) return;
            if (tcData.gdprApplies === false) { _tcf.result = 'abort'; return; }
            _tcf.result = tcfAllRejected(tcData) ? true : false;
          });
        } catch (_) { /* silent */ }
      }, buildTcfRejectPayload());
      return true;
    } catch (_) { return false; }
  }
  runProbe({
    name: 'TCF',
    budget: 6000,
    interval: 500,
    ready: () => {
      if (typeof window.__tcfapi !== 'function') return false;
      if (_tcfLoaded) return true;
      try { window.__tcfapi('ping', 2, function (p) { if (p && p.cmpStatus === 'loaded') _tcfLoaded = true; }); } catch (_) { /* silent */ }
      return _tcfLoaded;
    },
    apply: applyTcf,
    confirm: () => _tcf.result,
  });

  // ── 12. IAB GPP (Global Privacy Platform) ────────────────────────────────
  // Multi-jurisdiction standard; the reject command is proprietary with no
  // standard cross-vendor read-back, so this is best-effort and never signals
  // - the DOM tier remains responsible for dismissing any banner.
  runProbe({
    name: 'GPP',
    budget: 5000,
    interval: 500,
    deferSignal: true,
    ready: () => typeof window.__gpp === 'function',
    apply: () => {
      try {
        window.__gpp('ping', function (pingData) {
          try {
            if (!pingData || pingData.cmpStatus !== 'loaded') return;
            // Proprietary "reject all" (0), supported by some CMPs. No reliable
            // read-back → we do NOT signal success.
            window.__gpp('setConsent', function () { /* no-op: cannot confirm */ }, 0);
          } catch (_) { /* silent */ }
        });
        return true;
      } catch (_) { return false; }
    },
  });

  // ── 13. CCPA / US Privacy (IAB USP 1.0) ──────────────────────────────────
  // window.__uspapi opt-out; '1YYN' = CCPA applies, opted out of sale and
  // sharing (see uspConfirmed()). A background data-rights call, not a banner
  // dismissal - never signals "handled"; the DOM tier still runs.
  runProbe({
    name: 'USP',
    budget: 3000,
    deferSignal: true,
    ready: () => typeof window.__uspapi === 'function',
    apply: () => {
      try {
        window.__uspapi('setUSPData', 1, function () { /* opt-out set; no signal */ }, { uspString: '1YYN' });
        return true;
      } catch (_) { return false; }
    },
  });

  // ── Test hook ─────────────────────────────────────────────────────────────
  // Skipped in the real MAIN world (`module` is undefined there), so it adds no
  // page-visible global. The harness injects a `module` shim to read these.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports.__test = {
      tcfAllRejected:       tcfAllRejected,
      uspConfirmed:         uspConfirmed,
      probeOutcome:         probeOutcome,
      buildTcfRejectPayload: buildTcfRejectPayload,
    };
  }
}());
