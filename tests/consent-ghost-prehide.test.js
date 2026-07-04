/* PawsOff - Step-3 tests for the pre-paint flash-suppression (prehide) layer in
 * consent-ghost.js.
 *
 * Prehide injects a <style> at document_start that hides ONLY vetted named-CMP
 * container selectors (visibility:hidden), with an UNCONDITIONAL watchdog that
 * always reveals. The critical risk is self-collision: visibility:hidden fails
 * the rejecter's own isVisible() gate, so scanAndReject() must reveal the instant
 * it matches a known container (then hand off to fastHideContainer/display). The
 * regression test below models exactly that collision
 * (checkVisibility() === !prehideActive) and proves the banner is still rejected,
 * not skipped.
 */
'use strict';

const { test, assert, eq } = require('./harness/framework');
const { loadConsentGhost } = require('./harness/sandbox');

const flush = () => new Promise((resolve) => setImmediate(resolve));
const T = () => loadConsentGhost().internals; // fresh instance per access

// ── buildPrehideCss: per-rule emission + injection-safe filtering ────────────

test('buildPrehideCss: one rule PER selector (never a grouped a,b{})', () => {
  const css = T().buildPrehideCss(['#a, .b']);
  eq(css, '#a{visibility:hidden!important}.b{visibility:hidden!important}',
    'grouped containerSelector split into isolated rules');
});

test('buildPrehideCss: skips non-string, empty, and injection-y selectors', () => {
  const css = T().buildPrehideCss([
    '#ok',            // kept
    42,               // non-string
    '   ',            // empty
    'a{}',            // braces → stylesheet break-out
    'b<c',            // angle bracket
    'x/*y',           // slash → CSS comment injection
    '@import bad',    // leading at-rule
    '(xpath)',        // leading paren
    '/html/div',      // slash anywhere (xpath)
  ]);
  eq(css, '#ok{visibility:hidden!important}', 'only the clean CSS selector survives');
});

test('buildPrehideCss: non-array / empty → empty string (fail-open: no prehide)', () => {
  const t = T();
  eq(t.buildPrehideCss(null), '');
  eq(t.buildPrehideCss([]), '');
  eq(t.buildPrehideCss(['{}', 12]), '', 'all-bad input yields no rules');
});

// ── install + UNCONDITIONAL watchdog reveal (the "no CMP → reraised" case) ───

function fakeHtml() {
  const kids = [];
  return {
    kids,
    appendChild(n) { kids.push(n); n.parentNode = this; return n; },
    removeChild(n) { const i = kids.indexOf(n); if (i >= 0) kids.splice(i, 1); n.parentNode = null; return n; },
  };
}

test('installPrehide: injects a <style> and schedules reveal at PREHIDE_MAX_MS', () => {
  const t = T();
  const html = fakeHtml();
  let scheduled = null;
  t.installPrehide(html, '#x{visibility:hidden!important}', (fn, ms) => { scheduled = { fn, ms }; });
  eq(html.kids.length, 1, 'style attached to <html>');
  eq(html.kids[0].textContent, '#x{visibility:hidden!important}');
  assert(scheduled, 'a reveal was scheduled');
  eq(scheduled.ms, t.PREHIDE_MAX_MS, 'scheduled at the hard ceiling');
  assert(t.PREHIDE_MAX_MS <= 2000, 'ceiling within 2s');
});

test('watchdog reveal: firing the scheduled timer removes the style (no-CMP case)', () => {
  const t = T();
  const html = fakeHtml();
  let scheduled = null;
  t.installPrehide(html, '#x{visibility:hidden!important}', (fn, ms) => { scheduled = { fn, ms }; });
  eq(html.kids.length, 1);
  scheduled.fn();                       // the watchdog fires - no success signal involved
  eq(html.kids.length, 0, 'style raised by the unconditional watchdog');
});

test('reveal is idempotent and scheduler-throw reveals immediately (never orphan)', () => {
  const t = T();
  const html = fakeHtml();
  t.installPrehide(html, '#x{visibility:hidden!important}', () => { throw new Error('no timers'); });
  eq(html.kids.length, 0, 'scheduling failed → style removed synchronously, not orphaned');
  t.revealPrehide();                    // second reveal is a no-op
  eq(html.kids.length, 0);
});

// ── disabled site → prehide revealed by init's standdown branch ──────────────

test('disabled site: init standdown reveals the prehide style', async () => {
  // Default load presets __pawsOff_consentGhost_disabled=true. boot() installs the
  // prehide on documentElement; init() resolves the (async) disabled flag and its
  // protectionPaused() branch must reveal - independent of the watchdog (no-op
  // setTimeout here, so only the disabled branch can have removed it).
  const loaded = loadConsentGhost();
  eq(loaded.document.documentElement._kids.length, 1, 'prehide installed at document_start');
  await flush();
  eq(loaded.document.documentElement._kids.length, 0, 'disabled standdown revealed the banner');
});

// ── REGRESSION: a banner hidden by our OWN prehide is still rejected ─────────

test('prehidden banner is still rejected by scanAndReject (revealed, not skipped)', async () => {
  // Model the collision: the OneTrust container/button report
  // checkVisibility() === !prehideActive, where prehideActive is true while the
  // prehide <style> is attached to <html>. If scanAndReject did NOT reveal before
  // the isUsableContainer() gate, the container would read invisible and be
  // skipped. With Insertion A it reveals first, the gate passes, the reject button
  // is clicked, and the page is marked handled.
  const CONTAINER = '#onetrust-banner-sdk, #onetrust-consent-sdk, .onetrust-pc-dark-filter';
  const REJECT = '#onetrust-reject-all-handler';

  const htmlKids = [];
  const htmlEl = {
    getAttribute(n) { return n === 'lang' ? 'en' : null; },
    appendChild(n) { htmlKids.push(n); n.parentNode = this; return n; },
    removeChild(n) { const i = htmlKids.indexOf(n); if (i >= 0) htmlKids.splice(i, 1); n.parentNode = null; return n; },
  };
  const prehideActive = () => htmlKids.some((n) => n && typeof n.textContent === 'string' && n.textContent.indexOf('visibility:hidden') >= 0);

  let clicks = 0;
  let removed = false; // a real CMP removes its banner on reject
  const rejectBtn = {
    textContent: 'Reject All',
    getAttribute() { return null; },
    checkVisibility() { return !prehideActive(); }, // ← the collision: visible only after reveal
    getBoundingClientRect() { return { width: 200, height: 40 }; },
    click() { clicks++; removed = true; },
    closest() { return null; },
    querySelectorAll() { return []; },
  };
  const container = {
    style: {
      _d: '', _p: '',
      setProperty(k, v, p) { if (k === 'display') { this._d = v; this._p = p || ''; } },
      getPropertyValue(k) { return k === 'display' ? this._d : ''; },
      getPropertyPriority(k) { return k === 'display' ? this._p : ''; },
      removeProperty(k) { if (k === 'display') { this._d = ''; this._p = ''; } },
    },
    checkVisibility() { return !prehideActive(); },
    getBoundingClientRect() { return { width: 600, height: 120 }; },
    querySelectorAll(sel) { return sel === REJECT ? [rejectBtn] : []; },
    closest() { return null; },
  };

  const fakeDoc = {
    documentElement: htmlEl,
    body: {},
    addEventListener() {},
    removeEventListener() {},
    querySelector(sel) { return (sel === CONTAINER && !removed) ? container : null; },
    querySelectorAll(sel) { return (sel === CONTAINER && !removed) ? [container] : []; },
    createElement() { return { style: {}, setAttribute() {}, appendChild() {}, removeChild() {}, textContent: '', parentNode: null }; },
  };

  const loaded = loadConsentGhost({ enabled: true, document: fakeDoc });
  assert(prehideActive(), 'prehide is active at document_start (banner would read invisible)');
  await flush();
  await flush();
  eq(clicks, 1, 'reject button was clicked - container not skipped by our own prehide');
  eq(loaded.win.__pawsOff_consentGhost_handled, true, 'page marked handled (rejected)');
  assert(!prehideActive(), 'prehide revealed during the reject');
});
