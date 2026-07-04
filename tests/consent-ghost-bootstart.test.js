/* PawsOff - Step-2 behavioural tests for ConsentGhost's MAIN-world API tier
 * request timing (consent-ghost.js boot()).
 *
 * The CMP API tier (cmp-api-main.js) is requested via a 'pawsoff_consentGhost_runMain'
 * message to the service worker. To shave the first-paint flash, that request now
 * fires from boot() at document_start - BEFORE init()'s body-gated deferral -
 * instead of only from the deferred init(). These tests pin that timing and the
 * _cmpApiRequested dedup across the two call sites.
 *
 * Fail-open / gating note: the request firing early does NOT mean injection
 * happens early on paused/disabled sites - the service worker independently
 * re-checks disabled/paused before injecting (background.js
 * handleConsentMainInjection). That gate is covered by the background tests; here
 * we only assert the content-script request timing.
 */
'use strict';

const { test, assert, eq } = require('./harness/framework');
const { loadConsentGhost } = require('./harness/sandbox');

const RUN_MAIN = 'pawsoff_consentGhost_runMain';
const flush = () => new Promise((resolve) => setImmediate(resolve));
const runMainCount = (msgs) => msgs.filter((m) => m && m.type === RUN_MAIN).length;

test('API tier is requested at document_start (no body → init deferred)', () => {
  // noBody: document.body is null, so boot() defers init() to DOMContentLoaded
  // (which never fires in the harness). The runMain request must STILL be sent -
  // synchronously, from boot() - proving it no longer hides behind init().
  const { messages } = loadConsentGhost({ noBody: true, recordMessages: true });
  eq(runMainCount(messages), 1, 'runMain requested at document_start despite init being deferred');
});

test('early request is independent of the content script\'s own disabled flag', () => {
  // Even with __pawsOff_consentGhost_disabled preset true, the SYNCHRONOUS boot
  // request still fires (loadDisabledFlag is async and has not resolved yet). The
  // service worker - not the stale content-script flag - is the real injection
  // gate, so sending the request here is correct and fail-open.
  const { messages } = loadConsentGhost({ noBody: true, recordMessages: true /* default: disabled preset */ });
  eq(runMainCount(messages), 1, 'request sent at document_start; SW remains the authoritative gate');
});

test('dedup: allowed site fires the runMain request exactly once across boot()+init()', async () => {
  // enabled (allowed) + body present → boot() runs init() synchronously. Both the
  // boot() call site and init()'s own call site invoke requestCmpApiMain(); the
  // _cmpApiRequested guard must collapse them to a SINGLE message. The recorder
  // ACKs with {ok:true} so the guard stays armed (a non-ok ack would reset it).
  const { messages } = loadConsentGhost({ enabled: true, recordMessages: true });
  await flush(); // let init() resume past `await loadDisabledFlag()` and reach its requestCmpApiMain()
  eq(runMainCount(messages), 1, 'exactly one runMain - second call site deduped');
});
