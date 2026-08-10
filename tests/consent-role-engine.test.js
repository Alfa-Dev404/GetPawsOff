'use strict';

const { test, assert, eq } = require('./harness/framework');
const {
  COMPLETION_WAIT_MS,
  POLL_MS,
  createConsentRoleEngine,
} = require('../src/content/consent-role-engine.js');

function element(label, onClick) {
  return {
    label,
    visible: true,
    isConnected: true,
    clicks: 0,
    click() { this.clicks += 1; if (onClick) onClick(this); },
  };
}

function fixture() {
  const map = new Map();
  const doc = {};
  const queries = [];
  let allowed = true;
  const engine = createConsentRoleEngine({
    doc,
    queryAll(root, selector) { queries.push({ root, selector }); return map.get(selector) || []; },
    isVisible(node) { return !!node.visible; },
    isForbidden(node) { return /accept|agree|save|confirm/i.test(node.label || ''); },
    clickAllowed() { return allowed; },
    sleep() { return Promise.resolve(); },
  });
  return { doc, engine, map, queries, setAllowed(value) { allowed = value; } };
}

function flow() {
  return {
    directReject: ['#reject'],
    openPreferences: ['#manage'],
    completion: ['#cmp'],
  };
}

function engineForSafetyTest(reject, predicates) {
  return createConsentRoleEngine({
    doc: {},
    queryAll(_root, selector) { return selector === '#reject' ? [reject] : []; },
    isVisible(node) { return !!node.visible; },
    clickAllowed() { return true; },
    sleep() { return Promise.resolve(); },
    ...(predicates || {}),
  });
}

function completionFixture(visibleCompletion) {
  const cmp = element('cookie dialog');
  const reject = element('reject all');
  let completionChecks = 0;
  const engine = createConsentRoleEngine({
    doc: {},
    queryAll(_root, selector) {
      if (selector === '#reject') return [reject];
      if (selector !== '#cmp') return [];
      completionChecks += 1;
      return visibleCompletion(completionChecks) ? [cmp] : [];
    },
    isVisible(node) { return !!node.visible; },
    isForbidden() { return false; },
    clickAllowed() { return true; },
    sleep() { return Promise.resolve(); },
  });
  return { cmp, engine, getChecks() { return completionChecks; } };
}

test('consent role engine: direct reject is verified before success', async () => {
  const f = fixture();
  const cmp = element('cookie dialog');
  const reject = element('reject all', () => { cmp.visible = false; });
  f.map.set('#cmp', [cmp]);
  f.map.set('#reject', [reject]);
  const result = await f.engine.run(flow(), cmp, false, () => true);
  assert(result.completed, 'completion verified');
  eq(result.stage, 'reject');
  eq(reject.clicks, 1, 'one reviewed action');
});

test('consent role engine: every accept/save label remains forbidden', async () => {
  for (const label of ['Accept', 'Agree', 'Save and accept']) {
    const f = fixture();
    const cmp = element('cookie dialog');
    const target = element(label);
    f.map.set('#cmp', [cmp]);
    f.map.set('#reject', [target]);
    const result = await f.engine.run(flow(), cmp, false, () => true);
    assert(!result.acted, `${label} is never clicked`);
    eq(target.clicks, 0);
  }
});

test('consent role engine: preferences → reject follows fixed local order and verifies the surface', async () => {
  const f = fixture();
  const order = [];
  const cmp = element('cookie dialog');
  const reject = element('reject all', () => { order.push('reject'); cmp.visible = false; });
  reject.visible = false;
  const manage = element('manage preferences', () => {
    order.push('preferences');
    manage.visible = false;
    reject.visible = true;
  });
  f.map.set('#cmp', [cmp]);
  f.map.set('#manage', [manage]);
  f.map.set('#reject', [reject]);

  const result = await f.engine.run(flow(), cmp, false, () => true);
  assert(result.completed, 'rejection verified');
  eq(order.join('>'), 'preferences>reject');
  assert(
    f.queries.filter((query) => query.selector === '#reject').every((query) => query.root === cmp),
    'reject candidates remain scoped to the original CMP surface',
  );
});

test('consent role engine: never clicks an unrelated save control when reject is missing', async () => {
  const f = fixture();
  const cmp = element('cookie dialog');
  const save = element('save choices');
  const manage = element('manage preferences');
  f.map.set('#cmp', [cmp]);
  f.map.set('#manage', [manage]);
  f.map.set('#save', [save]);
  const candidateFlow = { ...flow(), directReject: ['#save'], openPreferences: [] };
  const result = await f.engine.run(candidateFlow, cmp, false, () => true);
  assert(!result.acted, 'forbidden Save target does not start an action');
  assert(!result.completed, 'Save is not success');
  eq(save.clicks, 0, 'save untouched');
});

test('consent role engine: a vanished reject button is not proof while the CMP remains visible', async () => {
  const f = fixture();
  const cmp = element('cookie dialog');
  const reject = element('reject all', () => { reject.visible = false; });
  f.map.set('#cmp', [cmp]);
  f.map.set('#reject', [reject]);
  const result = await f.engine.run(flow(), cmp, false, () => true);
  assert(result.acted, 'reject was clicked');
  assert(!result.completed, 'visible completion surface keeps the result unverified');
  eq(result.stage, 'reject-unverified');
});

test('consent role engine: completion requires three consecutive absent polls', async () => {
  const f = completionFixture((check) => check === 1 || check === 3);
  const result = await f.engine.run(flow(), f.cmp, false, () => true);
  assert(result.completed, 'surface eventually remained absent');
  eq(f.getChecks(), (COMPLETION_WAIT_MS / POLL_MS) + 2, 'verification includes the pre-click visibility check');
});

test('consent role engine: two consecutive absent polls are insufficient', async () => {
  const f = completionFixture((check) => check === 1 || (check - 1) % 3 === 0);
  const result = await f.engine.run(flow(), f.cmp, false, () => true);
  assert(!result.completed, 'fewer than three consecutive absences cannot verify completion');
});

test('consent role engine: an always-absent completion selector cannot prove success', async () => {
  const reject = element('reject all');
  const engine = createConsentRoleEngine({
    doc: {},
    queryAll(_root, selector) { return selector === '#reject' ? [reject] : []; },
    isVisible(node) { return !!node.visible; },
    isForbidden() { return false; },
    clickAllowed() { return true; },
    sleep() { return Promise.resolve(); },
  });
  const result = await engine.run(flow(), element('cookie dialog'), false, () => true);
  assert(result.acted, 'reviewed reject action still runs');
  assert(!result.completed, 'missing pre-click surface remains unverified');
});

test('consent role engine: accept veto, breaker, and generation fence block action', async () => {
  const f = fixture();
  const cmp = element('cookie dialog');
  const accept = element('accept all');
  f.map.set('#cmp', [cmp]);
  f.map.set('#reject', [accept]);
  let result = await f.engine.run(flow(), cmp, false, () => true);
  assert(!result.acted, 'accept-labelled target vetoed');
  eq(accept.clicks, 0);

  accept.label = 'reject all';
  f.setAllowed(false);
  result = await f.engine.run(flow(), cmp, false, () => true);
  assert(!result.acted, 'breaker denied click');
  f.setAllowed(true);
  result = await f.engine.run(flow(), cmp, false, () => false);
  assert(!result.acted, 'stale scan denied click');
  eq(accept.clicks, 0);
});

test('consent role engine: missing action-safety dependency stands down', async () => {
  const reject = element('reject all');
  const engine = engineForSafetyTest(reject);
  const result = await engine.run(flow(), {}, false, () => true);
  assert(!result.acted, 'unwired safety predicate cannot authorize a click');
  eq(reject.clicks, 0, 'target remains untouched');
});

test('consent role engine: every fallback safety predicate must authorize the target', async () => {
  const reject = element('reject all');
  const engine = engineForSafetyTest(reject, {
    isForbidden() { return false; },
    isAccept() { return true; },
  });
  const result = await engine.run(flow(), {}, false, () => true);
  assert(!result.acted, 'a veto from either fallback predicate blocks the click');
  eq(reject.clicks, 0);
});
