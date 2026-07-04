/* PawsOff - iframe attribution for po-catch.js.
 *
 * Regression coverage for the Sourcepoint / cross-origin CMP iframe bug: a
 * banner destroyed inside a 3rd-party iframe (privacy-mgmt.com) must be
 * attributed to the TOP-LEVEL site the user is visiting, otherwise the popup's
 * per-site filter (originHash !== state.originHash) drops it and the Banners
 * chip stays 0.
 *
 * Loads the REAL src/lib/po-catch.js into a fresh vm context per case, with a
 * window/location stub that simulates top-frame, cross-origin sub-frame
 * (location.ancestorOrigins), and sandboxed/null-origin sub-frame. Also checks
 * the background sink helper topOriginHashFromSender() derives the hash from the
 * browser-trusted sender.tab.url.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test, assert, eq } = require('./harness/framework.js');
const { loadBackground } = require('./harness/sandbox.js');

const PO_CATCH = path.resolve(__dirname, '..', 'src', 'lib', 'po-catch.js');
const CATCH_PREFIX = '__pawsOff_catch_';

// Run po-catch.js in a simulated frame. opts:
//   topFrame      - boolean, is this the top window?
//   hostname      - this frame's own hostname
//   ancestorOrigins - array of ancestor origin strings (Chrome semantics), or undefined
//   sendResp      - response the background stub returns for pawsoff_topOriginHash
function runPoCatch(opts) {
  const o = opts || {};
  let store = {};
  const local = {
    get(keys, cb) {
      const out = {};
      if (keys == null) Object.assign(out, store);
      else if (typeof keys === 'string') { if (store[keys] !== undefined) out[keys] = store[keys]; }
      else if (Array.isArray(keys)) keys.forEach((k) => { if (store[k] !== undefined) out[k] = store[k]; });
      else Object.keys(keys).forEach((k) => { out[k] = store[k] !== undefined ? store[k] : keys[k]; });
      if (typeof cb === 'function') cb(out);
    },
    set(obj, cb) { Object.keys(obj).forEach((k) => { store[k] = obj[k]; }); if (typeof cb === 'function') cb(); },
    remove(keys, cb) { (Array.isArray(keys) ? keys : [keys]).forEach((k) => { delete store[k]; }); if (typeof cb === 'function') cb(); },
  };
  const chrome = {
    storage: { local },
    runtime: {
      id: 'pawsoff-test',
      lastError: null,
      // Synchronous callback so the deferred write lands before assertions.
      sendMessage(_msg, cb) { if (typeof cb === 'function') cb(o.sendResp || null); },
    },
  };
  const win = {};
  win.self = win;
  win.top = o.topFrame ? win : {}; // distinct object => sub-frame
  const location = { hostname: o.hostname || '', href: 'https://' + (o.hostname || '') + '/' };
  if (o.ancestorOrigins) location.ancestorOrigins = o.ancestorOrigins;
  win.location = location;
  const sandbox = { self: win, window: win, chrome, console, URL, Math, Date, JSON };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(PO_CATCH, 'utf8'), sandbox, { filename: 'po-catch.js' });
  return { api: win.PawsOffCatch, getStore: () => store };
}

function onlyCatch(store) {
  const keys = Object.keys(store).filter((k) => k.indexOf(CATCH_PREFIX) === 0);
  return keys.length === 1 ? store[keys[0]] : null;
}

test('po-catch: top frame attributes to its own host', () => {
  const { api, getStore } = runPoCatch({ topFrame: true, hostname: 'example.com' });
  api.recordBanner('cmp');
  const rec = onlyCatch(getStore());
  assert(rec, 'one catch written');
  eq(rec.originHash, api.hashHost('example.com'), 'top-frame originHash');
  eq(rec.feature, 'banner', 'feature preserved');
});

test('po-catch: cross-origin CMP iframe attributes to the TOP site, not the iframe', () => {
  // Banner destroyed inside privacy-mgmt.com iframe embedded on a news site.
  const { api, getStore } = runPoCatch({
    topFrame: false,
    hostname: 'privacy-mgmt.com',
    ancestorOrigins: ['https://www.example-news.com'],
  });
  api.recordBanner('sourcepoint');
  const rec = onlyCatch(getStore());
  assert(rec, 'one catch written');
  eq(rec.originHash, api.hashHost('www.example-news.com'), 'attributed to top site');
  assert(rec.originHash !== api.hashHost('privacy-mgmt.com'), 'NOT attributed to iframe origin');
});

test('po-catch: deeply nested frames use the last ancestor (top) origin', () => {
  const { api, getStore } = runPoCatch({
    topFrame: false,
    hostname: 'inner-widget.io',
    ancestorOrigins: ['https://mid.cmp.net', 'https://top.shop.example'],
  });
  api.recordBanner('cmp');
  const rec = onlyCatch(getStore());
  eq(rec.originHash, api.hashHost('top.shop.example'), 'last ancestor is the top');
});

test('po-catch: sandboxed frame (no ancestorOrigins) falls back to background sender hash', () => {
  const { api, getStore } = runPoCatch({
    topFrame: false,
    hostname: 'sandboxed.example',          // own host should be IGNORED
    ancestorOrigins: undefined,             // sandboxed / null-origin
    sendResp: { ok: true, originHash: 'h:deadbeef' },
  });
  api.recordBanner('cmp');
  const rec = onlyCatch(getStore());
  eq(rec.originHash, 'h:deadbeef', 'used background-provided top hash');
  assert(rec.originHash !== api.hashHost('sandboxed.example'), 'did not use the frame host');
});

test('po-catch: background unavailable => last-resort local hash (no crash, still recorded)', () => {
  const { api, getStore } = runPoCatch({
    topFrame: false,
    hostname: 'lonely.example',
    ancestorOrigins: undefined,
    sendResp: null,                          // background gave nothing
  });
  api.recordBanner('cmp');
  const rec = onlyCatch(getStore());
  eq(rec.originHash, api.hashHost('lonely.example'), 'fell back to local origin hash');
});

test('po-catch: explicit caller originHash always wins', () => {
  const { api, getStore } = runPoCatch({ topFrame: true, hostname: 'example.com' });
  api.record({ feature: 'tracker', label: 'x', originHash: 'h:cafef00d' });
  const rec = onlyCatch(getStore());
  eq(rec.originHash, 'h:cafef00d', 'caller-supplied attribution respected');
});

test('background: topOriginHashFromSender derives top hash from trusted sender.tab.url', () => {
  const { internals } = loadBackground();
  const got = internals.topOriginHashFromSender({ tab: { url: 'https://site.example.org/some/page?q=1' } });
  eq(got, internals.fnvHash('site.example.org'), 'hash matches top-level host');
});

test('background: topOriginHashFromSender returns null when no tab url (spoof-safe)', () => {
  const { internals } = loadBackground();
  eq(internals.topOriginHashFromSender({}), null, 'no tab => null');
  eq(internals.topOriginHashFromSender({ tab: {} }), null, 'no url => null');
  eq(internals.topOriginHashFromSender(null), null, 'no sender => null');
});
