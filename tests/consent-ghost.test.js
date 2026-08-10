/* PawsOff — Tier-1 unit tests for Consent Autopilot (consent-ghost.js).
 *
 * Covers the PURE, side-effect-free core of the content script:
 *   - phrase → regex compilation (escapeRe, phrasesToRegexes) and the anchored,
 *     whitespace-flexible matching contract
 *   - language detection + priority ordering (detectLangs, buildPatterns,
 *     flatPhrases)
 *   - the unified label classifier surfaced via looksReject / looksAccept /
 *     looksPreferences / isAcceptLabel, including the two failure modes the code
 *     is explicitly designed around:
 *       • "Accept All Cookies" must read as ACCEPT (longest-hit veto)
 *       • a pay-or-consent "Subscribe" / "Refuser et s'abonner" wall must be
 *         UNTOUCHABLE (subscribe dominates → neither reject nor accept)
 *   - btnText / heuristicLabel text extraction
 *   - normalizeRemoteConfig (the trust boundary: schema gate, selector
 *     filtering, and the hard rule that a remote `steps` engine is NEVER adopted)
 *
 * These exercise the REAL shipping file: the harness loads consent-ghost.js into
 * a vm context and satisfies its existing Jest-style `module.exports.__test`
 * hook (no source edit). The DOM-driven half (scanAndReject, executeSteps,
 * findConsentContainer, observer) is Tier-2 (jsdom) and runs on a real machine.
 */
'use strict';

const { test, assert, eq } = require('./harness/framework');
const { loadConsentGhost } = require('./harness/sandbox');

const loaded = loadConsentGhost();
const t = loaded.internals || {};
const {
  escapeRe,
  phrasesToRegexes,
  detectLangs,
  buildPatterns,
  flatPhrases,
  looksReject,
  looksAccept,
  looksPreferences,
  isAcceptLabel,
  isUnsafeRoleAction,
  isConsentRoleTarget,
  btnText,
  heuristicLabel,
  normalizeRemoteConfig,
  shouldStandDownAfterRoleResult,
  REJECT_PHRASES_BY_LANG,
  ACCEPT_PHRASES_BY_LANG,
  PREF_PHRASES_BY_LANG,
  BUNDLED_CONSENT_CONFIG,
} = t;

// Tiny fake element: just enough surface for btnText/heuristicLabel/isAcceptLabel.
function el(text, attrs) {
  const a = attrs || {};
  return {
    innerText: text || '',
    textContent: text || '',
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(a, name) ? a[name] : null; },
  };
}

function v2Config(name, selectors) {
  return {
    schemaVersion: 2,
    frameworks: [{
      name,
      selectors: {
        containers: ['#cmp'],
        directReject: ['#reject'],
        openPreferences: [],
        save: [],
        completion: ['#cmp'],
        ...(selectors || {}),
      },
    }],
  };
}

test('consentGhost: the Jest-style hook exposes the pure helpers', () => {
  assert(t && typeof t === 'object', '__test object exposed');
  ['escapeRe', 'phrasesToRegexes', 'detectLangs', 'buildPatterns', 'looksReject', 'normalizeRemoteConfig'].forEach((k) => {
    assert(typeof t[k] === 'function', k + ' is a function');
  });
});

// ── escapeRe ───────────────────────────────────────────────────────
test('escapeRe: neutralises regex metacharacters so phrases match literally', () => {
  const re = new RegExp('^' + escapeRe('a.b*c(d)') + '$');
  assert(re.test('a.b*c(d)'), 'literal string matches itself');
  assert(!re.test('axbxcxd'), '. and * are not treated as wildcards');
});

// ── phrasesToRegexes ───────────────────────────────────────────────
test('phrasesToRegexes: anchored to the whole label (no substring matches)', () => {
  const [re] = phrasesToRegexes(['reject all']);
  assert(re.test('reject all'), 'exact label matches');
  assert(re.test('Reject All'), 'case-insensitive');
  assert(!re.test('please reject all now'), 'anchored ^...$ rejects substrings');
});

test('phrasesToRegexes: whitespace is flexible (\\s*) between words', () => {
  const [re] = phrasesToRegexes(['reject all']);
  assert(re.test('rejectall'), 'collapsed spacing matches');
  assert(re.test('reject   all'), 'extra spacing matches');
});

test('phrasesToRegexes: skips malformed phrases without throwing', () => {
  const out = phrasesToRegexes(['ok', 123, null, undefined]);
  assert(Array.isArray(out), 'returns an array');
  assert(out.length >= 1, 'the valid phrase still compiles');
});

// ── detectLangs / buildPatterns / flatPhrases ─────────────────────────────
test('detectLangs: default stub reports the page language (en)', () => {
  const langs = detectLangs();
  assert(Array.isArray(langs), 'returns an array');
  assert(langs.indexOf('en') !== -1, 'detects en from <html lang> / navigator');
});

test('detectLangs: <html lang> takes priority over navigator, de-duped', () => {
  const fr = loadConsentGhost({ htmlLang: 'fr', navLang: 'en-US' });
  const langs = fr.internals.detectLangs();
  eq(langs[0], 'fr', 'html lang wins first slot');
  assert(langs.indexOf('en') !== -1, 'navigator language still included');
  eq(langs.length, new Set(langs).size, 'no duplicate languages');
});

test('buildPatterns: compiles a usable reject pattern set for the page', () => {
  const patterns = buildPatterns(REJECT_PHRASES_BY_LANG);
  assert(Array.isArray(patterns) && patterns.length > 0, 'non-empty pattern list');
  assert(patterns.some((re) => re.test('reject all')), 'a known reject label matches');
});

test('flatPhrases: lowercased and sorted longest-first (specificity wins)', () => {
  const flat = flatPhrases(REJECT_PHRASES_BY_LANG);
  assert(Array.isArray(flat) && flat.length > 0, 'non-empty');
  for (let i = 1; i < flat.length; i++) {
    assert(flat[i - 1].length >= flat[i].length, 'descending by length at index ' + i);
  }
  flat.forEach((p) => assert(p === p.toLowerCase(), 'phrase is lowercased'));
});

// ── classifier: looksReject / looksAccept ───────────────────────────────
test('looksReject: plain reject labels are recognised', () => {
  assert(looksReject('reject all'), '"reject all" reads as reject');
  assert(!looksReject('accept all'), '"accept all" does not read as reject');
});

test('looksAccept: "Accept All Cookies" reads as ACCEPT (longest-hit veto)', () => {
  assert(looksAccept('accept all cookies'), 'the catastrophic-misclick case is caught');
  assert(!looksReject('accept all cookies'), 'and never treated as a reject');
});

test('classifier: a pay-or-consent subscribe wall is untouchable (neither)', () => {
  // "subscribe" alone, and the French "refuser et s'abonner" which literally
  // contains a reject word — both must classify as NEITHER reject nor accept.
  assert(!looksReject('subscribe'), 'subscribe is not a free reject');
  assert(!looksAccept('subscribe'), 'subscribe is not an accept either');
  assert(!looksReject("refuser et s'abonner"), 'paywall reject-word does not trigger a click');
});

test('looksPreferences: recognises a manage/settings opener, not a reject', () => {
  assert(looksPreferences('manage'), '"manage" is a preferences opener');
  assert(looksPreferences('cookie settings'), '"settings" substring matches');
  assert(!looksPreferences('reject all'), 'a reject button is not a preferences opener');
  assert(!looksPreferences(''), 'empty label is not a preferences opener');
});

// ── btnText / heuristicLabel / isAcceptLabel ────────────────────────────
test('btnText: normalises whitespace and falls back to aria-label', () => {
  eq(btnText(el('  Reject   All ')), 'Reject All', 'collapses + trims whitespace');
  eq(btnText(el('', { 'aria-label': 'Reject all' })), 'Reject all', 'aria-label fallback when no text');
});

test('heuristicLabel: merges visible text with translation-proof attributes', () => {
  const label = heuristicLabel(el('Accept', { 'aria-label': 'Cookie', 'data-testid': 'consent' }));
  assert(label.indexOf('accept') !== -1, 'includes visible text');
  assert(label.indexOf('cookie') !== -1, 'includes aria-label');
  assert(label === label.toLowerCase(), 'lowercased');
});

test('isAcceptLabel: vetoes accept buttons, allows reject + empty (icon) buttons', () => {
  assert(isAcceptLabel(el('Accept All')), 'accept button is vetoed');
  assert(!isAcceptLabel(el('Reject all')), 'reject button is not vetoed');
  assert(!isAcceptLabel(el('')), 'icon-only (empty label) is trusted, not vetoed');
});

test('isUnsafeRoleAction: role selectors cannot click Save or Confirm controls', () => {
  assert(isUnsafeRoleAction(el('Save choices')), 'standalone Save is forbidden');
  assert(isUnsafeRoleAction(el('Confirm preferences')), 'Confirm is forbidden');
  assert(isUnsafeRoleAction(el('Accept all')), 'Accept remains forbidden');
  assert(!isUnsafeRoleAction(el('Reject all')), 'explicit reject remains eligible');
});

test('isUnsafeRoleAction: hidden identifiers cannot disguise unsafe actions', () => {
  const disguisedSave = el('Manage preferences');
  disguisedSave.id = 'save-and-accept';
  assert(isUnsafeRoleAction(disguisedSave), 'save action in the id is forbidden');

  const disguisedAccept = el('Privacy options');
  disguisedAccept.className = 'accept-all-button';
  assert(isUnsafeRoleAction(disguisedAccept), 'accept action in the class is forbidden');

  const separatedConfirm = el('Reject all');
  separatedConfirm.id = 'confirm-action';
  assert(isUnsafeRoleAction(separatedConfirm), 'hyphenated confirm identifiers are forbidden');

  const separatedSave = el('Reject all');
  separatedSave.className = 'save_button';
  assert(isUnsafeRoleAction(separatedSave), 'underscored save identifiers are forbidden');
});

test('isConsentRoleTarget: requires positive evidence for each declared action', () => {
  assert(isConsentRoleTarget(el('Reject all'), 'directReject'), 'reject label proves reject role');
  assert(isConsentRoleTarget(el('', { 'data-testid': 'reject-all' }), 'directReject'), 'semantic identifier proves reject role');
  assert(isConsentRoleTarget(el('Manage choices'), 'openPreferences'), 'manage label proves preferences role');
  assert(!isConsentRoleTarget(el('Continue'), 'directReject'), 'neutral target is not clicked');
  assert(!isConsentRoleTarget(el('Delete account'), 'directReject'), 'unrelated destructive target is not clicked');
  assert(!isConsentRoleTarget(el('Accept all'), 'directReject'), 'accept target is not clicked');
  assert(!isConsentRoleTarget(el('Reject and delete account'), 'directReject'), 'composite destructive action is not clicked');
  assert(!isConsentRoleTarget(el('Ablehnen und speichern'), 'directReject'), 'localized reject-and-save action is not clicked');
});

// ── normalizeRemoteConfig — the remote-config trust boundary ──────────────
test('normalizeRemoteConfig: accepts a valid v1 config and filters bad selectors', () => {
  const out = normalizeRemoteConfig({
    schemaVersion: 1,
    frameworks: [{ name: 'X', containerSelector: '.x', rejectSelectors: ['.a', '.b', 123, null], pierceShadow: true }],
  });
  assert(Array.isArray(out) && out.length === 1, 'one usable framework');
  eq(out[0].name, 'X');
  eq(out[0].rejectSelectors.length, 2, 'non-string selectors dropped');
  eq(out[0].pierceShadow, true);
});

test('normalizeRemoteConfig: rejects XPath and executable selector syntax', () => {
  eq(normalizeRemoteConfig({
    schemaVersion: 1,
    frameworks: [{
      name: 'Unsafe',
      containerSelector: 'xpath///div[@id="cmp"]',
      rejectSelectors: ['#reject'],
    }],
  }), null, 'XPath container is rejected');
  eq(normalizeRemoteConfig({
    schemaVersion: 1,
    frameworks: [{ name: 'Real XPath', containerSelector: '//div[@id="cmp"]', rejectSelectors: ['#reject'] }],
  }), null, 'real XPath container is rejected');
  eq(normalizeRemoteConfig({
    schemaVersion: 1,
    frameworks: [{ name: 'Unsafe reject', containerSelector: '#cmp', rejectSelectors: ['javascript:reject()'] }],
  }), null, 'executable reject selector is rejected');
  const previousQuerySelector = loaded.document.querySelector;
  loaded.document.querySelector = (selector) => {
    if (selector === 'button[') throw new Error('invalid selector');
    return null;
  };
  try {
    eq(normalizeRemoteConfig({
      schemaVersion: 1,
      frameworks: [{ name: 'Malformed CSS', containerSelector: '#cmp', rejectSelectors: ['button['] }],
    }), null, 'malformed CSS reject selector is rejected');
  } finally {
    loaded.document.querySelector = previousQuerySelector;
  }
});

test('normalizeRemoteConfig: v1 and v2 retain validated shadow selector chains', () => {
  const v1 = normalizeRemoteConfig({
    schemaVersion: 1,
    frameworks: [{
      name: 'ShadowV1',
      containerSelector: '#host >>> #cmp',
      rejectSelectors: ['#host >>> #reject'],
    }],
  });
  eq(v1[0].containerSelector, '#host >>> #cmp');
  eq(v1[0].rejectSelectors[0], '#host >>> #reject');

  const v2 = normalizeRemoteConfig({
    schemaVersion: 2,
    frameworks: [{
      name: 'ShadowV2',
      selectors: {
        containers: ['#host >>> #cmp', '#other-host >>> #cmp'],
        directReject: ['#host >>> #reject'],
        openPreferences: [],
        save: [],
        completion: [],
      },
    }],
  });
  eq(v2[0].rejectSelectors[0], '#host >>> #reject');
  eq(v2[0].containerSelectors.join('|'), '#host >>> #cmp|#other-host >>> #cmp');
});

test('normalizeRemoteConfig: rejects wrong schema / non-array frameworks (→ null)', () => {
  eq(normalizeRemoteConfig({ schemaVersion: 9, frameworks: [] }), null, 'wrong schemaVersion');
  eq(normalizeRemoteConfig({ schemaVersion: 1, frameworks: 'nope' }), null, 'frameworks must be an array');
  eq(normalizeRemoteConfig(null), null, 'null payload');
});

test('normalizeRemoteConfig: v2 adopts constrained roles into the fixed local flow', () => {
  const out = normalizeRemoteConfig(v2Config('SafeCmp', { openPreferences: ['#manage'] }));
  assert(out && out.length === 1, 'v2 framework accepted');
  eq(out[0].rejectSelectors[0], '#reject');
  eq(out[0].roleFlow.openPreferences[0], '#manage');
  assert(!('save' in out[0].roleFlow), 'separate save is not an executable role');
  assert(!('steps' in out[0]), 'no executable action sequence created');
});

test('normalizeRemoteConfig: v2 rejects a remotely supplied save role', () => {
  eq(normalizeRemoteConfig(v2Config('UnsafeSave', { save: ['#save'] })), null);
});

test('normalizeRemoteConfig: v2 completion proof keeps container hints first', () => {
  const completion = Array.from({ length: 16 }, (_, index) => '.done-' + index);
  const out = normalizeRemoteConfig(v2Config('BoundedCmp', { completion }));
  eq(out[0].roleFlow.completion.length, 16, 'completion proof stays bounded');
  eq(out[0].roleFlow.completion[0], '#cmp', 'container is never sliced out');
});

test('normalizeRemoteConfig: v2 truncates oversized completion hints after adding containers', () => {
  const completion = Array.from({ length: 40 }, (_, index) => '.done-' + index);
  const out = normalizeRemoteConfig(v2Config('OversizedCmp', { completion }));
  eq(out[0].roleFlow.completion.length, 16);
  eq(out[0].roleFlow.completion[0], '#cmp');
  eq(out[0].roleFlow.completion[15], '.done-14');
});

test('role flow: any unverified action requires a full automation stand-down', () => {
  assert(shouldStandDownAfterRoleResult({ acted: true, completed: false }), 'unverified action stands down');
  assert(!shouldStandDownAfterRoleResult({ acted: false, completed: false }), 'no action may continue scanning');
  assert(!shouldStandDownAfterRoleResult({ acted: true, completed: true }), 'verified completion uses success path');
});

test('normalizeRemoteConfig: v2 needs explicit container and reject roles', () => {
  eq(
    normalizeRemoteConfig(v2Config('NoReject', { directReject: [] })),
    null,
    'save/preferences-only remote rule cannot act',
  );
});

test('normalizeRemoteConfig: skips disabled / structurally-invalid entries', () => {
  const out = normalizeRemoteConfig({
    schemaVersion: 1,
    frameworks: [
      { name: 'Disabled', containerSelector: '.d', rejectSelectors: ['.x'], enabled: false },
      { name: 'NoSelectors', containerSelector: '.n' },
      { containerSelector: '.anon', rejectSelectors: ['.y'] },
    ],
  });
  eq(out, null, 'no usable entries survives → null (keep bundled config)');
});

test('normalizeRemoteConfig: NEVER adopts a remote action-steps engine (MV3 policy)', () => {
  const out = normalizeRemoteConfig({
    schemaVersion: 1,
    frameworks: [{ name: 'Evil', containerSelector: '.e', rejectSelectors: ['.r'], steps: [{ action: 'click', selector: '.anything' }] }],
  });
  assert(out && out.length === 1, 'framework still usable');
  assert(!('steps' in out[0]), 'remote steps engine is stripped — no remotely-controlled behavior');
});

// ── bundled config sanity ──────────────────────────────────────────
test('BUNDLED_CONSENT_CONFIG: every entry is structurally well-formed', () => {
  assert(Array.isArray(BUNDLED_CONSENT_CONFIG) && BUNDLED_CONSENT_CONFIG.length > 0, 'non-empty fallback');
  BUNDLED_CONSENT_CONFIG.forEach((f) => {
    assert(typeof f.name === 'string' && f.name.length > 0, 'has a name');
    assert(typeof f.containerSelector === 'string' && f.containerSelector.length > 0, f.name + ' has a container selector');
    assert(Array.isArray(f.rejectSelectors) && f.rejectSelectors.length > 0, f.name + ' has reject selectors');
  });
  assert(BUNDLED_CONSENT_CONFIG.some((f) => f.name === 'OneTrust'), 'OneTrust is covered');
});

// A "hide"/"close" API call dismisses the notice UI without confirming the
// user rejected tracking — Didomi's actual behavior on a bare dismiss varies
// by publisher config, so it must never be treated as a verified reject
// (CodeRabbit finding, 2026-07-03: [onclick*="Didomi.notice.hide"] was
// removed from Didomi's rejectSelectors for exactly this reason).
test('BUNDLED_CONSENT_CONFIG: no rejectSelector treats a mere hide/close/dismiss as a reject', () => {
  const ambiguous = /\b(hide|close|dismiss)\b/i;
  BUNDLED_CONSENT_CONFIG.forEach((f) => {
    f.rejectSelectors.forEach((sel) => {
      assert(!ambiguous.test(sel), f.name + ' reject selector must not be a bare hide/close/dismiss: ' + sel);
    });
  });
});

test('phrase tables: en reject/accept/preferences lists are populated', () => {
  assert(Array.isArray(REJECT_PHRASES_BY_LANG.en) && REJECT_PHRASES_BY_LANG.en.length > 0, 'en reject phrases');
  assert(Array.isArray(ACCEPT_PHRASES_BY_LANG.en) && ACCEPT_PHRASES_BY_LANG.en.length > 0, 'en accept phrases');
  assert(Array.isArray(PREF_PHRASES_BY_LANG.en) && PREF_PHRASES_BY_LANG.en.length > 0, 'en preferences phrases');
});
