/* PawsOff - Tier-1 behavioural tests for the programmatic CMP rejecter
 * (cmp-api-main.js), ConsentGhost's highest-reliability consent tier.
 *
 * This script runs in the page's MAIN world and calls each CMP's own JS API to
 * reject consent, then dispatches a single same-frame CustomEvent
 * ('pawsoff:cmp:rejected') so the isolated-world consent-ghost.js marks the page
 * handled and the DOM-click tier doesn't double-act.
 *
 * These are behavioural tests: the harness injects a fake CMP global, loads the
 * REAL shipping file, and asserts (a) the right reject method was invoked,
 * (b) exactly one signal event fired carrying the CMP name, and (c) the
 * same-frame contract (bubbles:false). The probe loops run synchronously once on
 * load, so no fake timers are needed. No source edit required.
 *
 * Security contract also checked: only ONE event is emitted even when several
 * CMP globals are present (first tier wins, the rest are guarded out), and a
 * page with no CMP produces no event at all.
 */
'use strict';

const { test, assert, eq } = require('./harness/framework');
const { loadCmpApiMain, loadCmpApiMainInternals } = require('./harness/sandbox');

const EVT = 'pawsoff:cmp:rejected';

// A recorder: a function that counts its calls and remembers the last args.
function spy() {
  const f = function () { f.count++; f.args = Array.prototype.slice.call(arguments); return undefined; };
  f.count = 0;
  f.args = null;
  return f;
}

test('OneTrust: RejectAll is called and a single OneTrust signal fires', () => {
  const rejectAll = spy();
  const r = loadCmpApiMain({ globals: { OneTrust: { RejectAll: rejectAll } } });
  eq(r.done, 'OneTrust', 'marked handled by OneTrust');
  eq(rejectAll.count, 1, 'RejectAll invoked exactly once');
  eq(r.events.length, 1, 'exactly one signal event');
  eq(r.events[0].type, EVT);
  eq(r.events[0].detail.cmp, 'OneTrust');
  eq(r.events[0].bubbles, false, 'same-frame only (no bubbling across frames)');
});

test('OneTrustStub: older banner SDK is used when OneTrust is absent', () => {
  const rejectAll = spy();
  const r = loadCmpApiMain({ globals: { OneTrustStub: { RejectAll: rejectAll } } });
  eq(r.done, 'OneTrust');
  eq(rejectAll.count, 1);
});

test('Cookiebot: decline() is called', () => {
  const decline = spy();
  const r = loadCmpApiMain({ globals: { Cookiebot: { decline } } });
  eq(r.done, 'Cookiebot');
  eq(decline.count, 1);
  eq(r.events[0].detail.cmp, 'Cookiebot');
});

test('CookieConsent: withdraw() fallback works when Cookiebot is absent', () => {
  const withdraw = spy();
  const r = loadCmpApiMain({ globals: { CookieConsent: { withdraw } } });
  eq(r.done, 'Cookiebot', 'same signal name for the Cybot family');
  eq(withdraw.count, 1);
});

test('TrustArc v1: truste.api.clickListener is called with "rejectall"', () => {
  const clickListener = spy();
  const r = loadCmpApiMain({ globals: { truste: { api: { clickListener } } } });
  eq(r.done, 'TrustArc');
  eq(clickListener.count, 1);
  eq(clickListener.args[0], 'rejectall', 'asks TrustArc to reject all');
});

test('TrustArc v2: TrustArc.consent.reject() fallback works', () => {
  const reject = spy();
  const r = loadCmpApiMain({ globals: { TrustArc: { consent: { reject } } } });
  eq(r.done, 'TrustArc');
  eq(reject.count, 1);
});

test('CookieYes: reject() (and decline() fallback) is called', () => {
  eq(loadCmpApiMain({ globals: { CookieYes: { reject: spy() } } }).done, 'CookieYes');
  const decline = spy();
  const r = loadCmpApiMain({ globals: { CookieYes: { decline } } });
  eq(r.done, 'CookieYes');
  eq(decline.count, 1);
});

test('consentmanager.net: __cmp("setConsent", 0, cb) drives the reject', () => {
  const cmp = function (cmd, arg, cb) { cmp.cmd = cmd; cmp.arg = arg; if (typeof cb === 'function') cb(true); };
  const r = loadCmpApiMain({ globals: { __cmp: cmp } });
  eq(r.done, 'consentmanager');
  eq(cmp.cmd, 'setConsent');
  eq(cmp.arg, 0, 'reject-all command code');
  eq(r.events[0].detail.cmp, 'consentmanager');
});

test('Axeptio: decline() is called', () => {
  const decline = spy();
  const r = loadCmpApiMain({ globals: { axeptioSDK: { decline } } });
  eq(r.done, 'Axeptio');
  eq(decline.count, 1);
});

test('Borlabs: doDeclineAllCookies() is called', () => {
  const doDecline = spy();
  const r = loadCmpApiMain({ globals: { BorlabsCookie: { doDeclineAllCookies: doDecline } } });
  eq(r.done, 'Borlabs');
  eq(doDecline.count, 1);
});

test('no CMP present: nothing is called and no event fires', () => {
  const r = loadCmpApiMain();
  assert(!r.done, 'page not marked handled');
  eq(r.events.length, 0, 'no signal event');
});

test('multiple CMPs present: only the first tier acts, exactly one event', () => {
  const otReject = spy();
  const cbDecline = spy();
  const r = loadCmpApiMain({ globals: { OneTrust: { RejectAll: otReject }, Cookiebot: { decline: cbDecline } } });
  eq(r.done, 'OneTrust', 'tier order: OneTrust wins');
  eq(otReject.count, 1, 'OneTrust acted');
  eq(cbDecline.count, 0, 'lower tier guarded out once handled');
  eq(r.events.length, 1, 'exactly one signal - no double-act');
});

// ── Step-1 hardening: confirmation gating (no "didn't throw" = success) ──────

test('GPP present: opt-out is attempted but NEVER signals (no read-back)', () => {
  let setConsentCalled = 0;
  const gpp = function (cmd, cb, arg) {
    if (cmd === 'ping') { cb({ cmpStatus: 'loaded' }); return; }
    if (cmd === 'setConsent') { setConsentCalled++; eq(arg, 0, 'reject-all code'); }
  };
  const r = loadCmpApiMain({ globals: { __gpp: gpp } });
  eq(setConsentCalled, 1, 'GPP reject attempted');
  assert(!r.done, 'GPP must not mark the page handled');
  eq(r.events.length, 0, 'no signal - GPP has no confirmable read-back');
});

test('USP present: setUSPData opt-out is sent but NEVER signals (data call)', () => {
  let usp = null;
  const uspapi = function (cmd, ver, cb, arg) { if (cmd === 'setUSPData') usp = arg && arg.uspString; };
  const r = loadCmpApiMain({ globals: { __uspapi: uspapi } });
  eq(usp, '1YYN', 'CCPA opt-out string written');
  assert(!r.done, 'USP is a data-rights call, not a banner dismissal');
  eq(r.events.length, 0, 'no signal');
});

test('TCF: setConsent issued all-purposes-false, but NO signal before confirm', () => {
  const calls = [];
  // ping → loaded; setConsent → do NOT ack (stay pending) so confirm never fires.
  const tcfapi = function (cmd, ver, cb, arg) {
    calls.push({ cmd, arg });
    if (cmd === 'ping') cb({ cmpStatus: 'loaded' });
  };
  const r = loadCmpApiMain({ globals: { __tcfapi: tcfapi } });
  const setc = calls.find((c) => c.cmd === 'setConsent');
  assert(setc, 'setConsent was issued');
  for (let i = 1; i <= 10; i++) eq(setc.arg.purpose.consents[i], false, `purpose ${i} not consented`);
  assert(!r.done, 'no premature success - confirmation not yet received');
  eq(r.events.length, 0, 'no signal until getTCData confirms');
});

// ── Pure predicates (module.exports.__test) ──────────────────────────────────

const I = loadCmpApiMainInternals();

test('tcfAllRejected: all-false / empty / missing → rejected; any true → not', () => {
  eq(I.tcfAllRejected({ purpose: { consents: { 1: false, 2: false } } }), true, 'all false → rejected');
  eq(I.tcfAllRejected({ purpose: { consents: {} } }), true, 'empty consents → rejected');
  eq(I.tcfAllRejected({ purpose: {} }), true, 'no consents object → rejected');
  eq(I.tcfAllRejected({ purpose: { consents: { 1: false, 3: true } } }), false, 'one true → not rejected');
  eq(I.tcfAllRejected({ purpose: { consents: { 1: false }, legitimateInterests: { 2: true } } }), false,
    'consent off but legitimate interest still asserted → NOT fully rejected');
  eq(I.tcfAllRejected({ purpose: { consents: { 1: false }, legitimateInterests: { 2: false } } }), true,
    'consent off AND legitimate interest off → rejected');
  eq(I.tcfAllRejected(null), false, 'no data → not a confirmed rejection');
  eq(I.tcfAllRejected(undefined), false, 'no data → not a confirmed rejection');
});

test('TCF reject payload: 11 purpose consents + LI exactly {2,7-11}, all false (5a)', () => {
  const p = I.buildTcfRejectPayload();
  // Consents: ALL 11 standard TCF v2.2 purposes, every one false.
  const consents = p.purpose.consents;
  const cKeys = Object.keys(consents).map(Number).sort((a, b) => a - b);
  eq(cKeys.join(','), '1,2,3,4,5,6,7,8,9,10,11', 'consents cover all 11 purposes (fails if 11 missing)');
  cKeys.forEach((k) => eq(consents[k], false, `consent purpose ${k} is false`));
  // LI: EXACTLY the LI-eligible purposes {2,7,8,9,10,11}, every one false. Fails if
  // Purpose 11 is missing OR if a consent-only purpose (1, 3–6) is wrongly added.
  const li = p.purpose.legitimateInterests;
  const liKeys = Object.keys(li).map(Number).sort((a, b) => a - b);
  eq(liKeys.join(','), '2,7,8,9,10,11', 'LI is exactly {2,7,8,9,10,11}');
  liKeys.forEach((k) => eq(li[k], false, `LI purpose ${k} is false`));
  // Bounded-by-construction: vendor.* deliberately NOT enumerated (open-ended GVL).
  eq(Object.keys(p.vendor.consents).length, 0, 'vendor.consents left empty by design');
  eq(Object.keys(p.vendor.legitimateInterests).length, 0, 'vendor.legitimateInterests left empty by design');
});

test('uspConfirmed: only the exact opt-out string passes', () => {
  eq(I.uspConfirmed('1YYN'), true);
  eq(I.uspConfirmed('1NNN'), false);
  eq(I.uspConfirmed('1---'), false);
  eq(I.uspConfirmed(''), false);
  eq(I.uspConfirmed(undefined), false);
});

test('probeOutcome: Tier B signals once on a successful invoke', () => {
  const s1 = I.probeOutcome({}, { tier: 'B', ready: true, invoked: true });
  eq(s1.applied, true);
  eq(s1.signalNow, true, 'Tier B signals on apply');
  eq(s1.signalled, true);
  // second probe after one already signalled → no second signal (first wins)
  const s2 = I.probeOutcome(s1, { tier: 'B', ready: true, invoked: true });
  eq(s2.signalNow, false, 'signal fires at most once');
});

test('probeOutcome: a non-invoked Tier B apply does not signal', () => {
  const s = I.probeOutcome({}, { tier: 'B', ready: true, invoked: false });
  eq(s.applied, true, 'still marked applied (apply-once)');
  eq(s.signalNow, false, 'method not invoked → no signal');
});

test('probeOutcome: deferSignal Tier B (GPP/USP/cmgr) does not auto-signal', () => {
  const s = I.probeOutcome({}, { tier: 'B', ready: true, invoked: true, deferSignal: true });
  eq(s.applied, true);
  eq(s.signalNow, false, 'deferSignal probes emit their own signal, if any');
});

test('probeOutcome: Tier A signals only on confirm===true', () => {
  const applied = I.probeOutcome({}, { tier: 'A', ready: true, invoked: true });
  eq(applied.applied, true);
  eq(applied.signalNow, false, 'Tier A never signals on apply alone');
  eq(I.probeOutcome(applied, { tier: 'A', confirm: null }).signalNow, false, 'pending → no signal');
  eq(I.probeOutcome(applied, { tier: 'A', confirm: false }).signalNow, false, 'not-rejected → no signal');
  eq(I.probeOutcome(applied, { tier: 'A', confirm: 'abort' }).signalNow, false, 'gdprApplies=false → no signal');
  const ok = I.probeOutcome(applied, { tier: 'A', confirm: true });
  eq(ok.signalNow, true, 'confirmed rejection → signal');
  eq(ok.confirmed, true, 'hard stop set');
});

test('probeOutcome: confirmed state is terminal (no further signal)', () => {
  const confirmed = { confirmed: true, signalled: true, applied: true };
  eq(I.probeOutcome(confirmed, { tier: 'A', confirm: true }).signalNow, false);
  eq(I.probeOutcome(confirmed, { tier: 'B', ready: true, invoked: true }).signalNow, false);
});
