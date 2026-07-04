/* PawsOff - consent-rules-engine (autoconsent layer) unit tests.
 *
 * Exercises PawsOff's OWN DSL interpreter against a tiny hand-rolled fake DOM
 * (no jsdom). Covers: array selector chains that pierce shadow DOM + same-origin
 * iframes, the if/any/negated/optional step combinators, breaker-gated clicks,
 * the NEVER_MATCH pay-or-consent wall guard, cosmetic→hidden, and a full
 * verified reject via cookieContains.
 */
'use strict';

const { test, assert, eq } = require('./harness/framework');
const { createConsentEngine } = require('../src/content/consent-rules-engine.js');

/* ---------------------------------------------------------------------------
 * Minimal fake DOM
 * ------------------------------------------------------------------------- */
function tokenize(sel) {
  const t = { tag: null, id: null, cls: [], attrs: [] };
  let s = sel.trim();
  const m = s.match(/^[a-zA-Z*][\w-]*/);
  if (m) { t.tag = m[0]; s = s.slice(m[0].length); }
  const re = /([#.])([\w-]+)|\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/g;
  let mm;
  while ((mm = re.exec(s))) {
    if (mm[1] === '#') t.id = mm[2];
    else if (mm[1] === '.') t.cls.push(mm[2]);
    else t.attrs.push([mm[3], mm[4]]);
  }
  return t;
}
function matchToken(node, t) {
  if (node.nodeType !== 1) return false;
  if (t.tag && t.tag !== '*' && node.tag !== t.tag) return false;
  if (t.id && node.id !== t.id) return false;
  for (const c of t.cls) if (!node._classes.has(c)) return false;
  for (const [k, v] of t.attrs) {
    const av = node.attrs[k];
    if (av === undefined) return false;
    if (v !== undefined && v !== '' && String(av) !== v) return false;
  }
  return true;
}
function walk(root) {
  const out = [];
  (function rec(n) {
    for (const c of n.children) { out.push(c); rec(c); }
  })(root);
  return out;
}
function qsaOne(root, sel) {
  const parts = sel.trim().split(/\s+/).map(tokenize);
  const last = parts[parts.length - 1];
  const res = [];
  for (const node of walk(root)) {
    if (!matchToken(node, last)) continue;
    if (parts.length === 1) { res.push(node); continue; }
    let pi = parts.length - 2, p = node.parent;
    while (p && pi >= 0) { if (matchToken(p, parts[pi])) pi--; p = p.parent; }
    if (pi < 0) res.push(node);
  }
  return res;
}
function qsa(root, sel) {
  const out = [];
  for (const part of String(sel).split(',')) {
    for (const n of qsaOne(root, part)) if (out.indexOf(n) === -1) out.push(n);
  }
  return out;
}
function container(nodeType) {
  const c = { nodeType: nodeType, children: [] };
  c.querySelectorAll = (sel) => qsa(c, sel);
  c.querySelector = (sel) => qsa(c, sel)[0] || null;
  return c;
}
function makeDoc() {
  const d = container(9);
  d.cookie = '';
  d.evaluate = null; // no xpath in these tests
  return d;
}
let _id = 0;
function E(tag, opts) {
  opts = opts || {};
  const node = {
    nodeType: 1, _uid: ++_id, tag: tag, id: opts.id || '',
    _classes: new Set(opts.cls || []), attrs: opts.attrs || {},
    children: [], parent: null,
    innerText: opts.text || '', textContent: opts.text || '',
    style: {}, __visible: opts.visible !== false, _clicks: 0,
  };
  node.classList = { remove: (c) => node._classes.delete(c), add: (c) => node._classes.add(c) };
  node.getBoundingClientRect = () => ({ width: 10, height: 10 });
  node.click = () => { node._clicks++; if (opts.onClick) opts.onClick(node); };
  node.querySelectorAll = (sel) => qsa(node, sel);
  node.querySelector = (sel) => qsa(node, sel)[0] || null;
  return node;
}
function append(parent, child) {
  child.parent = parent.nodeType === 1 ? parent : null;
  parent.children.push(child);
  return child;
}

function engineFor(doc, extra) {
  return createConsentEngine(Object.assign({
    doc: doc,
    win: {},
    sleep: () => Promise.resolve(),
    now: Date.now,
    clickAllowed: () => true,
    neverMatch: [],
  }, extra || {}));
}

/* ---------------------------------------------------------------------------
 * Tests
 * ------------------------------------------------------------------------- */
test('selector chain pierces shadow DOM and same-origin iframe', () => {
  const doc = makeDoc();
  const host = append(doc, E('div', { id: 'host' }));
  const shadow = container(11);
  host.shadowRoot = shadow;
  append(shadow, E('button', { id: 'reject', text: 'Reject all' }));

  const frame = append(doc, E('iframe', { id: 'frame' }));
  const fdoc = container(9);
  frame.contentDocument = fdoc;
  append(fdoc, E('button', { id: 'deep' }));

  const eng = engineFor(doc);
  eq(eng.querySelectorChain(['#host', '#reject']).length, 1, 'pierce shadowRoot');
  eq(eng.querySelectorChain(['#frame', '#deep']).length, 1, 'pierce iframe');
  // a plain (non-chain) selector must NOT see into the shadow root
  eq(eng.elementSelector('#reject').length, 0, 'no leak into shadow without chain');
});

test('exists / negated / any / if-then-else combinators', async () => {
  const doc = makeDoc();
  append(doc, E('div', { id: 'present' }));
  const eng = engineFor(doc);

  eq(await eng.runStep({ exists: '#present' }), true);
  eq(await eng.runStep({ exists: '#missing' }), false);
  eq(await eng.runStep({ exists: '#missing', negated: true }), true, 'negated flips');
  eq(await eng.runStep({ exists: '#missing', optional: true }), true, 'optional swallows failure');
  eq(await eng.runStep({ any: [{ exists: '#missing' }, { exists: '#present' }] }), true, 'any short-circuits true');
  eq(await eng.runStep({ any: [{ exists: '#a' }, { exists: '#b' }] }), false, 'any all-false');
  // if present -> then runs (click present), else ignored
  eq(await eng.runStep({ if: { exists: '#present' }, then: [{ exists: '#present' }], else: [{ exists: '#missing' }] }), true);
  eq(await eng.runStep({ if: { exists: '#missing' }, then: [{ exists: '#missing' }], else: [{ exists: '#present' }] }), true, 'else branch taken');
});

test('clicks are gated by the circuit breaker', async () => {
  const doc = makeDoc();
  const btn = append(doc, E('button', { id: 'reject' }));
  let allowed = false;
  const eng = engineFor(doc, { clickAllowed: () => allowed });
  eq(eng.click('#reject'), false, 'breaker open => no click');
  eq(btn._clicks, 0);
  allowed = true;
  eq(eng.click('#reject'), true, 'breaker closed => click');
  eq(btn._clicks, 1);
});

test('full rule: detect -> opt out -> verified via cookieContains', async () => {
  const doc = makeDoc();
  const banner = append(doc, E('div', { id: 'banner', text: 'We value your privacy' }));
  append(banner, E('button', { id: 'reject', text: 'Reject all', onClick: () => { doc.cookie = 'euconsent=0; path=/'; } }));
  const eng = engineFor(doc);
  const rule = {
    name: 'demo',
    detectCmp: [{ exists: '#banner' }],
    detectPopup: [{ visible: '#banner' }],
    optOut: [{ waitForThenClick: ['#banner', '#reject'] }],
    test: [{ cookieContains: 'euconsent=0' }],
  };
  const r = await eng.runRule(rule);
  eq(r.detected, true);
  eq(r.popup, true);
  eq(r.optedOut, true);
  eq(r.verified, true, 'cookie test confirms reject');
});

test('NEVER_MATCH pay-wall guard stands down without clicking', async () => {
  const doc = makeDoc();
  const wall = append(doc, E('div', { id: 'wall', text: 'Subscribe to read - or accept all cookies' }));
  const rej = append(wall, E('button', { id: 'reject', text: 'Reject' }));
  const eng = engineFor(doc, { neverMatch: [/subscribe/i] });
  const rule = {
    name: 'walled',
    prehideSelectors: ['#wall'],
    detectCmp: [{ exists: '#wall' }],
    detectPopup: [{ visible: '#wall' }],
    optOut: [{ click: '#reject' }],
  };
  const r = await eng.runRule(rule);
  eq(r.detected, true);
  eq(r.paywall, true, 'pay-wall detected');
  eq(r.optedOut, false, 'did not opt out');
  eq(rej._clicks, 0, 'never clicked anything on the wall');
});

test('run(): cosmetic rule reports hidden, not rejected', async () => {
  const doc = makeDoc();
  const banner = append(doc, E('div', { id: 'cmp', text: 'cookies' }));
  const eng = engineFor(doc);
  const rules = [{
    name: 'cosmetic-demo', cosmetic: true,
    detectCmp: [{ exists: '#cmp' }],
    detectPopup: [{ visible: '#cmp' }],
    optOut: [{ hide: '#cmp', method: 'display' }],
  }];
  const out = await eng.run(rules, { isTop: true });
  eq(out.handled, true);
  eq(out.cosmetic, true);
  eq(banner.style.display, 'none', 'banner hidden');
});

test('run(): picks first detected rule and reports it', async () => {
  const doc = makeDoc();
  const banner = append(doc, E('div', { id: 'b2' }));
  append(banner, E('button', { id: 'no', text: 'Reject', onClick: () => { doc.cookie = 'ok=1'; } }));
  const eng = engineFor(doc);
  const rules = [
    { name: 'nomatch', detectCmp: [{ exists: '#nope' }], optOut: [{ click: '#no' }] },
    { name: 'match', detectCmp: [{ exists: '#b2' }], detectPopup: [{ visible: '#b2' }], optOut: [{ click: '#no' }], test: [{ cookieContains: 'ok=1' }] },
  ];
  const out = await eng.run(rules, { isTop: true });
  eq(out.handled, true);
  eq(out.rule, 'match');
  eq(out.verified, true);
});

test('runContext: frame-only rule is skipped on top frame', async () => {
  const doc = makeDoc();
  append(doc, E('div', { id: 'x' }));
  const eng = engineFor(doc);
  const rule = { name: 'frameonly', runContext: { main: false, frame: true }, detectCmp: [{ exists: '#x' }], optOut: [{ exists: '#x' }] };
  const r = await eng.runRule(rule, { isTop: true });
  eq(r.detected, false, 'main:false skips on top frame');
  const r2 = await eng.runRule(rule, { isTop: false });
  eq(r2.detected, true, 'runs inside a sub-frame');
});
