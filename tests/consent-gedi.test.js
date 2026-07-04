/* PawsOff - GEDI (Sourcepoint) own consent rule unit tests.
 *
 * Exercises src/content/pawsoff-consent-rules.js (PawsOff-authored, NOT
 * autoconsent) against the shared engine + a tiny fake DOM. Covers: the
 * URL gate (incl. suffix-spoof rejection), the full Manage -> reject purposes
 * -> Legitimate Interest -> Object all -> Save flow with a verified cookie,
 * off-masthead non-detection, and the pay-or-consent wall stand-down.
 */
'use strict';

const { test, assert, eq } = require('./harness/framework');
const { createConsentEngine } = require('../src/content/consent-rules-engine.js');
const own = require('../src/content/pawsoff-consent-rules.js');

const GEDI = own.rules.find((r) => r.name === 'pawsoff-gedi-cmp');

/* ---- minimal fake DOM (mirrors consent-autoconsent.test.js) ---- */
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
  (function rec(n) { for (const c of n.children) { out.push(c); rec(c); } })(root);
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
  d.evaluate = null;
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
function engineFor(doc, href, extra) {
  return createConsentEngine(Object.assign({
    doc: doc,
    win: { location: { href: href } },
    sleep: () => Promise.resolve(),
    now: Date.now,
    clickAllowed: () => true,
    neverMatch: [],
  }, extra || {}));
}

/* Build the Sourcepoint-style privacy-manager DOM that forces the full
 * Manage -> reject-purposes -> LI tab -> object-all -> save flow. */
function buildGediDom(opts) {
  opts = opts || {};
  const doc = makeDoc();
  const root = append(doc, E('div', { cls: ['message-container'], text: opts.text || 'We and our partners value your privacy' }));
  // Banner has only a Manage button (no banner-level reject) -> forces modal.
  const onSave = () => { doc.cookie = 'euconsent-v2=CPxyz; path=/'; };
  const pm = append(doc, E('div', { cls: ['privacy-manager'] }));
  append(root, E('button', { cls: ['sp-manage'], text: 'Manage Cookies' }));
  if (opts.rejectPurposes !== false) append(pm, E('button', { cls: ['sp-reject-purposes'], text: 'Reject All' }));
  append(pm, E('button', { cls: ['sp-li-tab'], text: 'Legitimate Interest' }));
  append(pm, E('button', { cls: ['sp-object-all'], text: 'Object All' }));
  append(pm, E('button', { cls: ['sp-save'], text: 'Save & Exit', onClick: onSave }));
  return doc;
}

/* ---------------------------------------------------------------------------
 * Tests
 * ------------------------------------------------------------------------- */
test('GEDI rule: URL gate matches mastheads and rejects spoofs', () => {
  assert(GEDI, 'GEDI rule is present');
  const re = new RegExp(GEDI.runContext.urlPattern);
  assert(re.test('https://www.repubblica.it/politica/'), 'matches www.repubblica.it');
  assert(re.test('https://lastampa.it/'), 'matches lastampa.it root');
  assert(re.test('https://www.huffingtonpost.it/article'), 'matches huffingtonpost.it');
  assert(re.test('https://limesonline.com/'), 'matches limesonline.com');
  assert(!re.test('https://example.com/'), 'rejects unrelated host');
  assert(!re.test('https://repubblica.it.evil.com/'), 'rejects suffix-spoof host');
  assert(!re.test('https://notrepubblica.it/'), 'rejects prefix-glued host');
});

test('GEDI rule: full Manage->reject->LI->object->save is verified', async () => {
  const doc = buildGediDom();
  const eng = engineFor(doc, 'https://www.repubblica.it/politica/');
  const r = await eng.runRule(GEDI);
  eq(r.detected, true, 'CMP detected');
  eq(r.popup, true, 'popup visible');
  eq(r.paywall, false, 'not a wall');
  eq(r.optedOut, true, 'completed opt-out flow');
  eq(r.verified, true, 'euconsent-v2 cookie confirms reject');
  // each key control was clicked exactly once
  eq(doc.querySelector('.sp-manage')._clicks, 1, 'Manage clicked');
  eq(doc.querySelector('.sp-reject-purposes')._clicks, 1, 'Reject purposes clicked');
  eq(doc.querySelector('.sp-li-tab')._clicks, 1, 'LI tab clicked');
  eq(doc.querySelector('.sp-object-all')._clicks, 1, 'Object all clicked');
  eq(doc.querySelector('.sp-save')._clicks, 1, 'Save clicked');
});

test('GEDI rule: does not fire off-masthead (no GEDI DOM)', async () => {
  const doc = makeDoc();
  append(doc, E('div', { id: 'banner', text: 'some other cookie banner' }));
  const eng = engineFor(doc, 'https://www.repubblica.it/');
  const r = await eng.runRule(GEDI);
  eq(r.detected, false, 'no Sourcepoint container => not detected');
  eq(r.optedOut, false, 'nothing opted out');
});

test('GEDI rule: stands down on a pay-or-consent wall without clicking', async () => {
  const doc = buildGediDom({ text: 'Abbonati oppure accetta tutti i cookie / Subscribe to continue' });
  const eng = engineFor(doc, 'https://www.repubblica.it/', { neverMatch: [/abbonati/i, /subscribe/i] });
  const r = await eng.runRule(GEDI);
  eq(r.detected, true, 'CMP detected');
  eq(r.paywall, true, 'classified as a wall');
  eq(r.optedOut, false, 'did not opt out');
  eq(doc.querySelector('.sp-manage')._clicks, 0, 'never clicked Manage on a wall');
  eq(doc.querySelector('.sp-save')._clicks, 0, 'never clicked Save on a wall');
});
