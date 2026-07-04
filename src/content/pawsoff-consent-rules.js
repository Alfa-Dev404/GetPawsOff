/*!
 * pawsoff-consent-rules.js
 *
 * PawsOff's own declarative consent opt-out rules (site-specific), kept
 * separate from the vendored generic rules so licenses don't mix:
 *   - this file: PawsOff project license (PolyForm/BSL-style, non-compete)
 *   - src/content/vendor/autoconsent-rules.js: MPL-2.0 (vendored, isolated)
 *
 * Loaded first, ahead of the vendored generic rules, so a site-specific flow
 * wins over a generic CMP guess. Fail-open contract applies: never click
 * Accept/Agree, stand down on pay-or-consent walls, only ever reject.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PawsOffOwnConsentRules = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  // GEDI (Gruppo Editoriale GEDI) titles run a Sourcepoint TCF v2 CMP whose
  // generic flow the vendored rules don't reliably reject (Manage -> reject
  // purposes -> Legitimate Interest tab -> Object all -> Save). This rule
  // encodes that multi-step flow and is URL-gated to the GEDI mastheads so it
  // can never fire elsewhere. Selectors are best-effort against the
  // Sourcepoint DOM and should be validated against the live sites.
  var SEL = {
    // Sourcepoint message container (banner or modal)
    root: '.message-container, .sp_choice_type_12, .sp-message-open',
    // Banner-level "Reject all" (newer Sourcepoint variant), short-circuits.
    // Attribute values with spaces must be quoted, or the whole grouped
    // selector throws and matches nothing.
    rejectAll: '.sp_choice_type_REJECT_ALL, button[title="Reject All"], .sp-reject-all',
    // Banner-level "Manage" / "Customize" to open the privacy manager
    manage: '.sp_choice_type_12, button[title="Manage Cookies"], .sp-manage',
    // Privacy-manager modal root
    purposes: '.privacy-manager, .tcfv2-stack, .sp-pm',
    // Reject-all inside the privacy manager
    rejectPurposes: '.sp_choice_type_REJECT_ALL, button[title="Reject All"], .sp-reject-purposes',
    // Fallback: turn every ENABLED purpose toggle off. Only ever target toggles
    // that are ON (:checked / .sp-toggle-on), clicking an unchecked toggle would
    // turn it ON (opt the user IN), the exact opposite of rejecting.
    purposeToggle: '.sp-toggle-on, .privacy-manager input[type=checkbox]:checked',
    // "Legitimate interest" tab
    liTab: '.sp-li-tab, button[title="Legitimate Interest"], .legitimate-interest-tab',
    // "Object all" inside the legitimate-interest tab
    objectAll: '.sp_choice_type_OBJECT_ALL, button[title="Object All"], .sp-object-all',
    // Persist the rejection
    save: '.sp_choice_type_SAVE_AND_EXIT, button[title="Save & Exit"], .sp-save'
  };

  var gediRule = {
    name: 'pawsoff-gedi-cmp',
    // Only ever run on the GEDI mastheads, in the main frame. The trailing
    // (/|$) prevents suffix-spoofing hosts like repubblica.it.evil.com.
    runContext: {
      main: true,
      frame: false,
      urlPattern: '^https?://([^/]+\\.)?((repubblica|lastampa|ilsecoloxix|gelocal|huffingtonpost|deejay|capital)\\.it|limesonline\\.com)(/|$)'
    },
    prehideSelectors: [SEL.root],
    detectCmp: [{ exists: SEL.root }],
    detectPopup: [{ visible: SEL.root }],
    optOut: [
      {
        if: { exists: SEL.rejectAll },
        then: [
          { waitForThenClick: SEL.rejectAll }
        ],
        else: [
          { waitForThenClick: SEL.manage },
          { waitForVisible: SEL.purposes, timeout: 3000 },
          // Reach Save ONLY after an actual rejection/object, never persist the
          // dialog's default state. Each reject path carries its own LI handling
          // + Save; if NO reject control is found we stand down (no Save).
          {
            if: { exists: SEL.rejectPurposes },
            then: [
              { click: SEL.rejectPurposes },
              {
                if: { exists: SEL.liTab },
                then: [
                  { click: SEL.liTab },
                  { waitForThenClick: SEL.objectAll, optional: true }
                ]
              },
              { waitForThenClick: SEL.save }
            ],
            else: [
              {
                if: { exists: SEL.purposeToggle },
                then: [
                  { click: SEL.purposeToggle, all: true },
                  {
                    if: { exists: SEL.liTab },
                    then: [
                      { click: SEL.liTab },
                      { waitForThenClick: SEL.objectAll, optional: true }
                    ]
                  },
                  { waitForThenClick: SEL.save }
                ]
                // no else: no reject control present → do NOT Save (stand down)
              }
            ]
          }
        ]
      }
    ],
    // TCF v2 writes the IAB euconsent-v2 cookie once a choice is saved.
    test: [{ cookieContains: 'euconsent-v2' }],
    cosmetic: false
  };

  return {
    _license: 'PawsOff project license (PolyForm/BSL-style, source-available, non-compete)',
    _note: 'PawsOff-authored site-specific consent rules. Not derived from autoconsent.',
    _generated: '2026-06-26',
    rules: [gediRule]
  };
});
