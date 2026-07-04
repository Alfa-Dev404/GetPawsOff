/**
 * consent-prehide.js, PawsOff ConsentGhost: pre-paint flash suppression.
 *
 * Split out of consent-ghost.js so only this tiny script runs at
 * document_start - hides vetted named-CMP container selectors behind an
 * unconditional self-reveal watchdog, then hands off to the full engine
 * (document_idle) via window.__pawsOff_revealPrehide.
 *
 * IIFE, isolated-world only, window.__pawsOff_* namespace, silent failures,
 * anonymous <style> (no id/attr - anti-fingerprint), never touches nodes it
 * didn't create.
 */
(function () {
  'use strict';

  // Double-run guard. Same-extension scripts share the isolated world per frame,
  // so this global persists and is authoritative (matches consent-ghost.js:32).
  if (window.__pawsOff_revealPrehide) return;

  const PREHIDE_MAX_MS = 1500;

  // SYNC CONTRACT: this list must equal BUNDLED_CONSENT_CONFIG's containerSelector
  // set in consent-ghost.js. Pinned by tests/prehide-split.test.js, adding a CMP
  // there without updating this list fails that test on purpose.
  const CONTAINER_SELECTORS = [
    '#onetrust-banner-sdk, #onetrust-consent-sdk, .onetrust-pc-dark-filter',
    '.cky-consent-container, .cky-modal, #cky-consent-elem',
    '#CybotCookiebotDialog, #cookiebanner, .cookiebanner',
    '#truste-consent-content, .truste_overlay, #trustarc-irb-container',
    '#qc-cmp2-ui, .qc-cmp2-container',
    '.osano-cm-window, .osano-cm-dialog',
    '#didomi-host, #didomi-notice, .didomi-popup-container',
    '.gdpr-lmd-wall, .gdpr-lmd-standard',
    '#usercentrics-root, uc-ui-container',
    '[id^="sp_message_container"], [class*="sp_message_container"], .sp_veil + [class*="sp_message"], .message-stacks, .message-overlay, .sp_choice_type_13',
    '.c24-cookie-consent-notice',
    '#cmpbox, .cmpbox, [id^="cmpbox"], [class*="cmpbox"], #cmpwrapper, .cmpwrapper',
    '[class*="cookie-banner"], [class*="cookie-consent"], [id*="cookie-banner"], [id*="gdpr"], [role="dialog"][aria-label*="cookie"], [role="dialog"][aria-label*="Cookie"], [role="dialog"][aria-label*="consent"]',
  ];

  // Identical to consent-ghost.js buildPrehideCss (pinned by test). Per-selector
  // emission + injection-safe filtering.
  function buildPrehideCss(selectors) {
    if (!Array.isArray(selectors)) return '';
    const rules = [];
    for (const group of selectors) {
      if (typeof group !== 'string') continue;
      for (const raw of group.split(',')) {
        const s = raw.trim();
        if (!s) continue;
        if (/[{}<>/]/.test(s)) continue;
        if (s.charAt(0) === '@' || s.charAt(0) === '(') continue;
        rules.push(s + '{visibility:hidden!important}');
      }
    }
    return rules.join('');
  }

  let _style = null;
  let _revealed = false;

  // Idempotent: watchdog AND the engine may both call this. O(1), held by
  // reference, no querySelector.
  function revealPrehide() {
    if (_revealed) return;
    _revealed = true;
    try {
      const s = _style;
      if (s && typeof s.remove === 'function') s.remove();
      else if (s && s.parentNode) s.parentNode.removeChild(s);
    } catch (_) { /* silent */ }
    _style = null;
  }

  // Expose BEFORE injecting so the engine can always reach the reveal hook.
  window.__pawsOff_revealPrehide = revealPrehide;

  try {
    const css = buildPrehideCss(CONTAINER_SELECTORS);
    if (css) {
      const style = document.createElement('style'); // anonymous: no id/attr (anti-fingerprint)
      style.textContent = css;
      document.documentElement.appendChild(style);
      _style = style;
    }
  } catch (_) { /* silent - fail-open: no prehide */ }

  // UNCONDITIONAL watchdog: content can NEVER stay hidden if the engine bails in a
  // gated sub-frame, errors, or never loads. Scheduling failure → reveal NOW.
  try { setTimeout(revealPrehide, PREHIDE_MAX_MS); }
  catch (_) { revealPrehide(); }

  // Test-only export (no-op in Chrome: content scripts have no CommonJS module).
  try {
    if (typeof module !== 'undefined' && module.exports) {
      module.exports.__test = { CONTAINER_SELECTORS, buildPrehideCss, revealPrehide, PREHIDE_MAX_MS };
    }
  } catch (_) { /* ignore */ }
}());
