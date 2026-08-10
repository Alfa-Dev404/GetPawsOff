/* PawsOff — test sandbox for the local prevalence tier.
 *
 * Loads the REAL shipping files into a fresh `vm` context so tests exercise the
 * code that actually ships, not a copy.
 *
 *   loadLearner()   -> service-worker learner (psl-lite.js + prevalence-learner.js)
 *                      with an in-memory PROMISE-style chrome.storage.local.
 *   loadCollector() -> content-script collector (prevalence-collector.js) with a
 *                      window/location stub that passes its top-frame guard and a
 *                      CALLBACK-style chrome stub. master switch is forced OFF so
 *                      the load-time begin() lifecycle never starts; the file's
 *                      guarded test hook exposes its pure helpers.
 *
 * Each loader call returns a fully isolated instance.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const LEARN_DIR = path.resolve(__dirname, '..', '..', 'src', 'learn');
const BG_DIR = path.resolve(__dirname, '..', '..', 'src', 'background');
const CONTENT_DIR = path.resolve(__dirname, '..', '..', 'src', 'content');
const LIB_DIR = path.resolve(__dirname, '..', '..', 'src', 'lib');
const POPUP_DIR = path.resolve(__dirname, '..', '..', 'src', 'popup');
const OPTIONS_DIR = path.resolve(__dirname, '..', '..', 'src', 'options');
const SNITCH_KEY = '__pawsOff_pv_snitch';
const META_KEY = '__pawsOff_pv_meta';
const MASTER_KEY = '__pawsOff_master_enabled';
const DAY_MS = 86400000;

function today() {
  return Math.floor(Date.now() / DAY_MS);
}

// ── Learner: promise-style chrome.storage.local stub ────────────────────────
function makeChrome() {
  let store = {};
  const local = {
    get(keys) {
      const out = {};
      if (keys == null) {
        Object.assign(out, store);
      } else if (typeof keys === 'string') {
        if (Object.prototype.hasOwnProperty.call(store, keys)) out[keys] = store[keys];
      } else if (Array.isArray(keys)) {
        keys.forEach((k) => { if (Object.prototype.hasOwnProperty.call(store, k)) out[k] = store[k]; });
      } else {
        Object.keys(keys).forEach((k) => {
          out[k] = Object.prototype.hasOwnProperty.call(store, k) ? store[k] : keys[k];
        });
      }
      return Promise.resolve(out);
    },
    set(obj) {
      Object.keys(obj).forEach((k) => { store[k] = obj[k]; });
      return Promise.resolve();
    },
    remove(keys) {
      (Array.isArray(keys) ? keys : [keys]).forEach((k) => { delete store[k]; });
      return Promise.resolve();
    },
  };
  const noopListener = { addListener() {} };
  // Capturing stub so tests can prove the free extension registers no external
  // website bridge.
  const onMessageExternal = { _fns: [], addListener(fn) { this._fns.push(fn); } };
  const chrome = {
    storage: { local },
    runtime: {
      id: 'pawsoff-test',
      onMessage: noopListener,
      onMessageExternal,
      onInstalled: noopListener,
      onStartup: noopListener,
    },
    alarms: { create() {}, onAlarm: noopListener },
  };
  return { chrome, getStore: () => store };
}

function loadLearner() {
  const { chrome, getStore } = makeChrome();
  const root = {};
  const sandbox = { self: root, chrome, console };
  vm.createContext(sandbox);
  for (const file of ['psl-lite.js', 'prevalence-learner.js']) {
    const code = fs.readFileSync(path.join(LEARN_DIR, file), 'utf8');
    vm.runInContext(code, sandbox, { filename: file });
  }
  return { NS: root.__pawsOff_prevalence, PSL: root.PawsOffPSL, getStore, root };
}

function loadEnforcer() {
  let store = {};
  const messageListeners = [];
  const alarmListeners = [];
  const storageListeners = [];
  const alarmCreates = [];
  let dynamicReads = 0;
  const chrome = {
    storage: {
      local: {
        get(keys) {
          if (keys === null) return Promise.resolve({ ...store });
          const out = {};
          const list = Array.isArray(keys) ? keys : [keys];
          list.forEach((key) => {
            if (Object.prototype.hasOwnProperty.call(store, key)) out[key] = store[key];
          });
          return Promise.resolve(out);
        },
        set(payload) { Object.assign(store, payload); return Promise.resolve(); },
        remove(keys) {
          (Array.isArray(keys) ? keys : [keys]).forEach((key) => { delete store[key]; });
          return Promise.resolve();
        },
      },
      onChanged: { addListener(listener) { storageListeners.push(listener); } },
    },
    runtime: {
      id: 'pawsoff-test',
      onMessage: { addListener(listener) { messageListeners.push(listener); } },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
    },
    alarms: {
      create(name, options) { alarmCreates.push({ name, options }); },
      onAlarm: { addListener(listener) { alarmListeners.push(listener); } },
    },
    declarativeNetRequest: {
      getDynamicRules() { dynamicReads += 1; return Promise.resolve([]); },
      getSessionRules() { return Promise.resolve([]); },
      updateDynamicRules() { return Promise.resolve(); },
    },
  };
  const root = { __pawsOff_TEST: true, chrome };
  const sandbox = { self: root, chrome, console };
  vm.createContext(sandbox);
  for (const file of ['psl-lite.js', 'prevalence-enforcer.js']) {
    const code = fs.readFileSync(path.join(LEARN_DIR, file), 'utf8');
    vm.runInContext(code, sandbox, { filename: file });
  }
  return {
    internals: root.__pawsOff_enforcerInternals,
    chrome,
    messageListeners,
    alarmListeners,
    storageListeners,
    alarmCreates,
    getDynamicReads: () => dynamicReads,
    getStore: () => store,
  };
}

// ── Collector: callback-style chrome.storage.local stub ─────────────────────
function makeCollectorChrome(initialStore) {
  let store = initialStore || {};
  const messages = [];
  const local = {
    get(keys, cb) {
      const out = {};
      if (keys == null) {
        Object.assign(out, store);
      } else if (typeof keys === 'string') {
        if (Object.prototype.hasOwnProperty.call(store, keys)) out[keys] = store[keys];
      } else if (Array.isArray(keys)) {
        keys.forEach((k) => { if (Object.prototype.hasOwnProperty.call(store, k)) out[k] = store[k]; });
      } else {
        Object.keys(keys).forEach((k) => {
          out[k] = Object.prototype.hasOwnProperty.call(store, k) ? store[k] : keys[k];
        });
      }
      if (typeof cb === 'function') cb(out);
    },
    set(obj, cb) {
      Object.keys(obj).forEach((k) => { store[k] = obj[k]; });
      if (typeof cb === 'function') cb();
    },
    remove(keys, cb) {
      (Array.isArray(keys) ? keys : [keys]).forEach((k) => { delete store[k]; });
      if (typeof cb === 'function') cb();
    },
  };
  const chrome = {
    storage: { local },
    runtime: {
      id: 'pawsoff-test',
      lastError: null,
      sendMessage(message, callback) {
        messages.push(message);
        if (typeof callback === 'function') callback({ ok: true, spotted: [] });
      },
    },
  };
  return { chrome, getStore: () => store, messages };
}

function loadCollector(options) {
  const o = options || {};
  // Most tests force the master switch OFF so begin() never runs. Lifecycle
  // tests opt in and receive captured timers/listeners instead.
  const initialStore = {};
  initialStore[MASTER_KEY] = o.enabled === true;
  const { chrome, getStore, messages } = makeCollectorChrome(initialStore);

  const timers = [];
  const windowListeners = {};
  const documentListeners = {};
  const win = {};
  win.top = win; // pass the `window.top !== window` top-frame guard
  win.__pawsOff_TEST = true; // unlock the guarded test-export hook
  win.addEventListener = function (type, listener) { windowListeners[type] = listener; };
  const location = { protocol: 'https:', hostname: 'example.com', href: 'https://example.com/' };
  const document = {
    addEventListener(type, listener) { documentListeners[type] = listener; },
    visibilityState: 'visible',
  };
  function FakePerformanceObserver() {}
  FakePerformanceObserver.prototype.observe = function () {};
  FakePerformanceObserver.prototype.disconnect = function () {};
  const sandbox = {
    self: win,
    window: win,
    location,
    document,
    chrome,
    console,
    URL,
    performance: { getEntriesByType() { return []; } },
    PerformanceObserver: FakePerformanceObserver,
    setTimeout(listener, delay) {
      timers.push({ listener, delay });
      return timers.length;
    },
  };
  vm.createContext(sandbox);
  const pslCode = fs.readFileSync(path.join(LEARN_DIR, 'psl-lite.js'), 'utf8');
  vm.runInContext(pslCode, sandbox, { filename: 'psl-lite.js' });
  const code = fs.readFileSync(path.join(LEARN_DIR, 'prevalence-collector.js'), 'utf8');
  vm.runInContext(code, sandbox, { filename: 'prevalence-collector.js' });
  return {
    internals: win.__pawsOff_collectorInternals,
    getStore,
    win,
    document,
    messages,
    timers,
    windowListeners,
    documentListeners,
  };
}

// ── Background service worker: promise-style chrome + SW globals ──────────
function loadBackground(options) {
  const o = options || {};
  const { chrome, getStore } = makeChrome();
  // Capture storage.onChanged so tests can exercise the real event path
  // without making every local.set call implicitly trigger background work.
  const storageChangeListeners = [];
  chrome.storage.onChanged = { addListener(fn) { storageChangeListeners.push(fn); } };
  // Capture alarm listeners too, so tests can drive the periodic refresh path.
  const alarmListeners = [];
  chrome.alarms = {
    _creates: [],
    create(name, opts) { this._creates.push({ name, options: opts }); },
    onAlarm: { addListener(fn) { alarmListeners.push(fn); } },
  };
  // Capturing declarativeNetRequest stub so allow/DNR rule writes can be asserted.
  chrome.declarativeNetRequest = {
    _calls: [],
    updateDynamicRules(arg) { this._calls.push(arg); return Promise.resolve(); },
    getDynamicRules() { return Promise.resolve([]); },
  };
  const root = {};
  const fetchAttempts = [];
  root.__pawsOff_TEST = true; // unlock the guarded test-export hook
  // background.js has no DOM; it needs the SW globals atob + TextEncoder (used
  // by base64ToBytes / signature verify). importScripts() is undefined here and
  // throws, but the file wraps it in try/catch, so the load is unaffected. The
  // top-level fetch/DNR work only runs inside install/startup callbacks that
  // never fire under test.
  const sandbox = {
    self: root,
    chrome,
    console,
    atob: global.atob,
    TextEncoder: global.TextEncoder,
    TextDecoder: global.TextDecoder,
    Uint8Array: global.Uint8Array,
    Date: o.Date || global.Date,
    // Never expose the real network stack to code under test — a stray fetch must
    // fail loudly, not silently hit the network. (Top-level fetch only runs in
    // callbacks that don't fire under test; this just hard-guarantees it.)
    fetch: function (url) {
      fetchAttempts.push(String(url));
      return Promise.reject(new Error('network disabled in background test sandbox'));
    },
    URL: global.URL, // real MV3 service workers expose the URL global
  };
  vm.createContext(sandbox);
  // Same order background.js importScripts them: release-feed defines the
  // signedFeed dep the signed-config client gates every release fetch on.
  const releaseFeed = fs.readFileSync(path.join(BG_DIR, 'release-feed.js'), 'utf8');
  vm.runInContext(releaseFeed, sandbox, { filename: 'release-feed.js' });
  const boundedResponse = fs.readFileSync(path.join(BG_DIR, 'bounded-response.js'), 'utf8');
  vm.runInContext(boundedResponse, sandbox, { filename: 'bounded-response.js' });
  const configValidation = fs.readFileSync(path.join(BG_DIR, 'config-validation.js'), 'utf8');
  vm.runInContext(configValidation, sandbox, { filename: 'config-validation.js' });
  const signedConfigClient = fs.readFileSync(path.join(BG_DIR, 'signed-config-client.js'), 'utf8');
  vm.runInContext(signedConfigClient, sandbox, { filename: 'signed-config-client.js' });
  const code = fs.readFileSync(path.join(BG_DIR, 'background.js'), 'utf8');
  vm.runInContext(code, sandbox, { filename: 'background.js' });
  return {
    internals: root.__pawsOff_backgroundInternals,
    getStore,
    root,
    chrome,
    emitStorageChange(changes, area) {
      return Promise.all(storageChangeListeners.map((fn) => Promise.resolve().then(
        () => fn(changes, area || 'local'),
      )));
    },
    fetchAttempts,
    fireAlarm(name) {
      alarmListeners.forEach((fn) => fn({ name }));
      // Alarm handlers are sync fire-and-forget; drain the microtask queue so
      // the async refresh work they kick off has run before assertions.
      return new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

// ── ConsentGhost: content-script DOM + timer stubs + Jest-style module hook ──
// consent-ghost.js already ships a CommonJS test-export (module.exports.__test)
// intended for Jest. We satisfy it by injecting a `module` object into the vm
// context — NO source edit required. init() is async, so it defers every DOM /
// observer / scan side effect to microtasks that never run before the file's
// synchronous export block executes; the inert stubs below keep those deferred
// calls harmless anyway. `htmlLang` / `navLang` drive detectLangs() so language
// priority can be exercised.
function loadConsentGhost(opts) {
  const o = opts || {};
  const htmlLang = o.htmlLang !== undefined ? o.htmlLang : 'en';
  const navLang = o.navLang !== undefined ? o.navLang : 'en-US';

  const { chrome } = makeChrome();
  // Explicitly disable so init()'s deferred path tears down without scanning,
  // UNLESS the test wants an allowed/enabled site (opts.enabled).
  if (!o.enabled) chrome.storage.local.set({ __pawsOff_consentGhost_disabled: true });
  chrome.storage.onChanged = { addListener() {} };
  // Message channel. Default: a "not ready" promise stub (loadRemoteConfig
  // awaits it). opts.recordMessages: capture every sendMessage and ACK callback-
  // style calls with {ok:true} (simulating the SW accepting the MAIN injection),
  // so the _cmpApiRequested dedup guard stays armed across boot()+init().
  const messages = [];
  if (o.recordMessages) {
    chrome.runtime.sendMessage = function (msg, cb) {
      messages.push(msg);
      if (typeof cb === 'function') cb({ ok: true });
      return Promise.resolve(undefined);
    };
  } else {
    chrome.runtime.sendMessage = function () { return Promise.resolve(undefined); };
  }

  function FakeObserver() {}
  FakeObserver.prototype.observe = function () {};
  FakeObserver.prototype.disconnect = function () {};

  const win = {};
  win.top = win;
  win.addEventListener = function () {};
  win.removeEventListener = function () {};
  // Optional sessionStorage stub so the reload-loop circuit breaker can be
  // exercised (and shared across simulated reloads). Real frames expose one.
  if (o.sessionStorage) win.sessionStorage = o.sessionStorage;
  const location = { protocol: 'https:', hostname: 'example.com', href: 'https://example.com/', pathname: '/', hash: '' };
  // documentElement tracks appended children so prehide install/reveal (a <style>
  // on <html>) is observable; appendChild/removeChild set parentNode so
  // revealPrehide()'s node-removal path works.
  const documentElement = {
    getAttribute(name) { return name === 'lang' ? htmlLang : null; },
    _kids: [],
    appendChild(n) { this._kids.push(n); if (n) n.parentNode = this; return n; },
    removeChild(n) { const i = this._kids.indexOf(n); if (i >= 0) this._kids.splice(i, 1); if (n) n.parentNode = null; return n; },
  };
  // opts.document fully replaces the fake document (used to model the prehide↔
  // isVisible() collision in the rejecter regression test).
  const document = o.document || {
    documentElement,
    // opts.noBody simulates document_start (body not yet parsed) so init()'s
    // boot() defers, isolating the early requestCmpApiMain() call.
    body: o.noBody ? null : {},
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() { return { style: {}, setAttribute() {}, appendChild() {}, removeChild() {}, textContent: '', parentNode: null }; },
  };
  const navigator = { language: navLang };
  const moduleShim = { exports: {} };
  const sandbox = {
    self: win,
    window: win,
    location,
    document,
    navigator,
    chrome,
    console,
    URL,
    MutationObserver: FakeObserver,
    // scopedQueryAll's shadow-pierce path uses `node instanceof Element`; without a
    // defined Element that throws ReferenceError. A dummy constructor makes it
    // resolve to false for plain fake nodes (no shadow walk), matching real-DOM
    // light-DOM behaviour.
    Element: function Element() {},
    // findConsentContainer reads getComputedStyle(el).position/.zIndex. Fake els
    // carry an __style; everything else defaults to static/auto (→ not overlay-ish,
    // same as the prior "getComputedStyle undefined → throw → skip" behaviour).
    getComputedStyle: function (el) { return (el && el.__style) || { position: 'static', zIndex: 'auto' }; },
    setTimeout: function () { return 0; },
    clearTimeout: function () {},
    module: moduleShim,
  };
  vm.createContext(sandbox);
  const code = fs.readFileSync(path.join(CONTENT_DIR, 'consent-ghost.js'), 'utf8');
  vm.runInContext(code, sandbox, { filename: 'consent-ghost.js' });
  const internals = (moduleShim.exports && moduleShim.exports.__test) || {};
  return { internals, win, document, sandbox, messages };
}

// ── Generic content-script loader (PixelBlock + ToS Shield) ─────────────────
// Both files use the SAME pattern as consent-ghost.js: an async init() that
// defers all DOM/observer/scan work to microtasks, plus a CommonJS
// `module.exports.__test` hook at the very end. We satisfy that hook by
// injecting a `module` object — NO source edit. Default hostname 'example.com'
// is not a webmail/ToS host, so init() detects no provider and returns early;
// the pure helpers are still exported. `atob` is provided for tos-shield's
// base64ToBytes.
function _runContentScript(fileName, opts) {
  const o = opts || {};
  const hostname = o.hostname || 'example.com';
  const { chrome } = makeChrome();
  chrome.storage.onChanged = { addListener() {} };
  chrome.runtime.sendMessage = function () { return Promise.resolve(undefined); };

  function FakeObserver() {}
  FakeObserver.prototype.observe = function () {};
  FakeObserver.prototype.disconnect = function () {};

  const win = {};
  win.top = win;
  win.crypto = require('node:crypto').webcrypto;
  win.TextEncoder = TextEncoder;
  win.addEventListener = function () {};
  win.removeEventListener = function () {};
  const location = { protocol: 'https:', hostname, href: 'https://' + hostname + '/', pathname: '/', hash: '', search: '' };
  const document = {
    documentElement: { getAttribute() { return null; } },
    title: '',
    body: {},
    head: { appendChild() {} },
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() { return { style: {}, setAttribute() {}, appendChild() {}, remove() {}, isConnected: false }; },
  };
  const navigator = { language: 'en-US' };
  const moduleShim = { exports: {} };
  const sandbox = {
    self: win,
    window: win,
    location,
    document,
    navigator,
    chrome,
    console,
    URL,
    MutationObserver: FakeObserver,
    setTimeout: function () { return 0; },
    clearTimeout: function () {},
    atob: global.atob,
    crypto: win.crypto,
    TextEncoder,
    module: moduleShim,
  };
  vm.createContext(sandbox);
  if (fileName === 'tos-shield.js') {
    for (const dependency of ['tos-shield-core.js', 'tos-shield-panel.js']) {
      const dependencyCode = fs.readFileSync(path.join(CONTENT_DIR, dependency), 'utf8');
      vm.runInContext(dependencyCode, sandbox, { filename: dependency });
    }
  }
  const code = fs.readFileSync(path.join(CONTENT_DIR, fileName), 'utf8');
  vm.runInContext(code, sandbox, { filename: fileName });
  const internals = (moduleShim.exports && moduleShim.exports.__test) || {};
  return { internals, win, document, sandbox };
}

function loadPixelBlock(opts) { return _runContentScript('pixel-block.js', opts); }
function loadTosShield(opts) { return _runContentScript('tos-shield.js', opts); }

// ── consent-prehide.js loader (document_start flash-suppression script) ──────
// Standalone IIFE with a module.exports.__test hook. Custom documentElement +
// capturable setTimeout so the watchdog can be fired deterministically.
function loadConsentPrehide(opts) {
  const o = opts || {};
  const { chrome } = makeChrome();
  const scheduled = [];
  const kids = [];
  const documentElement = {
    _kids: kids,
    appendChild(n) { kids.push(n); n.parentNode = this; return n; },
    removeChild(n) { const i = kids.indexOf(n); if (i >= 0) kids.splice(i, 1); n.parentNode = null; return n; },
  };
  const document = o.document || {
    documentElement,
    createElement() {
      return { textContent: '', parentNode: null, remove() { if (this.parentNode) this.parentNode.removeChild(this); } };
    },
  };
  const win = {};
  win.top = win;
  const moduleShim = { exports: {} };
  const sandbox = {
    self: win, window: win, document, chrome, console,
    setTimeout: function (fn, ms) { scheduled.push({ fn, ms }); return scheduled.length; },
    clearTimeout: function () {},
    module: moduleShim,
  };
  vm.createContext(sandbox);
  const code = fs.readFileSync(path.join(CONTENT_DIR, 'consent-prehide.js'), 'utf8');
  vm.runInContext(code, sandbox, { filename: 'consent-prehide.js' });
  const internals = (moduleShim.exports && moduleShim.exports.__test) || {};
  return { internals, win, document, sandbox, scheduled };
}

// ── po-catch.js: shared "catch" recorder (callback-style chrome) ────────────
// po-catch attaches its API to `self` (= window) as window.PawsOffCatch and
// writes catches via callback-style chrome.storage.local. Its record() path is
// synchronous under our stub, so getStore() reflects writes immediately.
function loadPoCatch(opts) {
  const o = opts || {};
  const hostname = o.hostname || 'shop.example.com';
  const { chrome, getStore } = makeCollectorChrome(o.initialStore || {});
  const win = {};
  win.location = { hostname };
  const moduleShim = { exports: {} };
  const sandbox = { self: win, window: win, location: win.location, chrome, console, module: moduleShim };
  vm.createContext(sandbox);
  const code = fs.readFileSync(path.join(LIB_DIR, 'po-catch.js'), 'utf8');
  vm.runInContext(code, sandbox, { filename: 'po-catch.js' });
  const internals = (moduleShim.exports && moduleShim.exports.__test) || {};
  return { api: win.PawsOffCatch, getStore, win, internals };
}

// po-allow.js is a context-agnostic IIFE that installs window.PawsOffAllow and
// uses self.chrome.storage.local (callback-style) for read()/write(). We give
// it a collector chrome so storage round-trips can be asserted.
function loadAllow(opts) {
  const o = opts || {};
  const { chrome, getStore } = makeCollectorChrome(o.initialStore || {});
  const win = { location: { hostname: o.hostname || 'shop.example.com' } };
  win.chrome = chrome; // po-allow reads self.chrome.storage.local
  const sandbox = { self: win, window: win, location: win.location, chrome, console };
  vm.createContext(sandbox);
  const code = fs.readFileSync(path.join(LIB_DIR, 'po-allow.js'), 'utf8');
  vm.runInContext(code, sandbox, { filename: 'po-allow.js' });
  return { A: win.PawsOffAllow, getStore, chrome, win };
}

// ── cmp-api-main.js: page MAIN-world programmatic CMP rejecter ──────────────
// Runs in the page's MAIN world: NO chrome.* here. Tests inject fake CMP globals
// via opts.globals; we capture the same-frame CustomEvent the script dispatches
// on a successful reject. The probe loops run synchronously once on load
// (tryUntil calls tick() immediately); setTimeout is a no-op so polling never
// recurses, and the give-up watchdog never trips (elapsed ≈ 0). Fresh page each
// call (the double-run guard lives on the per-call window).
function loadCmpApiMain(opts) {
  const o = opts || {};
  const events = [];
  const win = {};
  if (o.globals) Object.keys(o.globals).forEach((k) => { win[k] = o.globals[k]; });
  function CustomEvent(type, init) {
    this.type = type;
    this.detail = init ? init.detail : undefined;
    this.bubbles = init ? init.bubbles : undefined;
    this.cancelable = init ? init.cancelable : undefined;
  }
  const documentObj = { dispatchEvent(ev) { events.push(ev); return true; } };
  const sandbox = {
    self: win,
    window: win,
    document: documentObj,
    CustomEvent,
    setTimeout: function () { return 0; },
    clearTimeout: function () {},
    console,
  };
  vm.createContext(sandbox);
  const code = fs.readFileSync(path.join(CONTENT_DIR, 'cmp-api-main.js'), 'utf8');
  vm.runInContext(code, sandbox, { filename: 'cmp-api-main.js' });
  // Derive `done` from the dispatched signal event (detail.cmp) rather than a
  // page-visible window marker — cmp-api-main no longer leaks one to the page.
  return { events, win, done: events.length ? events[events.length - 1].detail.cmp : undefined };
}

// Same file, loaded with a `module` shim so we can read its pure-predicate test
// hook (module.exports.__test). In the real MAIN world `module` is undefined and
// the hook is skipped, so this never changes shipping behaviour. No CMP globals
// → the probe kickoff is inert (nothing ready), we only want the predicates.
function loadCmpApiMainInternals() {
  const moduleShim = { exports: {} };
  const win = {};
  const documentObj = { dispatchEvent() { return true; } };
  function CustomEvent() {}
  const sandbox = {
    self: win,
    window: win,
    document: documentObj,
    CustomEvent,
    setTimeout: function () { return 0; },
    clearTimeout: function () {},
    console,
    module: moduleShim,
  };
  vm.createContext(sandbox);
  const code = fs.readFileSync(path.join(CONTENT_DIR, 'cmp-api-main.js'), 'utf8');
  vm.runInContext(code, sandbox, { filename: 'cmp-api-main.js' });
  return (moduleShim.exports && moduleShim.exports.__test) || {};
}

// ── Extension-page IIFEs (popup.js / options.js) ───────────────────────────
// Both end with `document.addEventListener('DOMContentLoaded', init)`, so init()
// (and ALL DOM/storage work) never runs under test — only the synchronous const/
// function defs and the injected-`module` __test export execute. We satisfy the
// hook by injecting `module`, exactly like the content scripts.
function _runPageScript(dir, fileName, options) {
  const o = options || {};
  const moduleShim = { exports: {} };
  const win = {};
  win.addEventListener = function () {};
  const documentObj = o.document || {
    addEventListener() {},
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() { return { style: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, setAttribute() {} }; },
  };
  const { chrome, getStore } = makeCollectorChrome(o.initialStore || {});
  chrome.storage.onChanged = { addListener() {} };
  chrome.tabs = { query() {}, reload() {} };
  chrome.runtime.openOptionsPage = function () {};
  if (typeof o.sendMessage === 'function') chrome.runtime.sendMessage = o.sendMessage;
  const sandbox = {
    self: win,
    window: win,
    document: documentObj,
    location: { hostname: 'example.com' },
    chrome,
    console,
    URL,
    setTimeout: function () { return 0; },
    clearTimeout: function () {},
    module: moduleShim,
  };
  vm.createContext(sandbox);
  const adaptiveCode = fs.readFileSync(path.join(LIB_DIR, 'adaptive-mode.js'), 'utf8');
  vm.runInContext(adaptiveCode, sandbox, { filename: 'adaptive-mode.js' });
  moduleShim.exports = {};
  const code = fs.readFileSync(path.join(dir, fileName), 'utf8');
  vm.runInContext(code, sandbox, { filename: fileName });
  return { internals: (moduleShim.exports && moduleShim.exports.__test) || {}, win, document: documentObj, getStore };
}
function loadPopup(options) { return _runPageScript(POPUP_DIR, 'popup.js', options); }
function loadOptions(options) { return _runPageScript(OPTIONS_DIR, 'options.js', options); }

module.exports = {
  loadLearner,
  loadEnforcer,
  loadCollector,
  loadBackground,
  loadConsentGhost,
  loadConsentPrehide,
  loadPixelBlock,
  loadTosShield,
  loadPoCatch,
  loadAllow,
  loadCmpApiMain,
  loadCmpApiMainInternals,
  loadPopup,
  loadOptions,
  makeChrome,
  makeCollectorChrome,
  today,
  DAY_MS,
  SNITCH_KEY,
  META_KEY,
  MASTER_KEY,
  LEARN_DIR,
};
