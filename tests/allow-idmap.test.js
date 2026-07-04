/* PawsOff - regression: pause/allow DNR rule-id allocation must be collision-free.
 * Guards against a hash-collision bug where two paused sites could share one
 * rule id and silently clobber each other's pause. The persisted allocator
 * guarantees each site a stable, unique id.
 */
'use strict';
const { test, assert, eq } = require('./harness/framework');
const { loadBackground } = require('./harness/sandbox');

function bg() { const { internals, chrome } = loadBackground(); return { I: internals, chrome }; }
function lastCall(chrome) {
  const c = chrome.declarativeNetRequest._calls;
  return c[c.length - 1];
}

test('allocateRuleId: unique + stable + probes past a taken preferred slot', () => {
  const { I } = bg();
  const base = I.ALLOW_PAUSE_ID_BASE, span = I.ALLOW_PAUSE_ID_SPAN;
  const band = {};
  const ids = [];
  // Force EVERY key to prefer the same slot (base) → pure probing stress.
  for (let i = 0; i < 30; i++) ids.push(I.allocateRuleId(band, base, span, 'k' + i, base));
  eq(new Set(ids).size, 30, 'all 30 ids unique despite identical preferred slot');
  ids.forEach((id) => assert(id >= base && id < base + span, 'stays in band: ' + id));
  eq(I.allocateRuleId(band, base, span, 'k0', base), ids[0], 'same key → same id (stable)');
});

test('allocateRuleId: returns null when the band is exhausted (fail-safe, no clobber)', () => {
  const { I } = bg();
  const base = 100, span = 3, band = {};
  eq(typeof I.allocateRuleId(band, base, span, 'a', base), 'number');
  eq(typeof I.allocateRuleId(band, base, span, 'b', base), 'number');
  eq(typeof I.allocateRuleId(band, base, span, 'c', base), 'number');
  eq(I.allocateRuleId(band, base, span, 'd', base), null, 'full band refuses rather than reuse');
});

test('allocateRuleId: ignores corrupt/out-of-band persisted ids (self-heals)', () => {
  const { I } = bg();
  const base = I.ALLOW_PAUSE_ID_BASE, span = I.ALLOW_PAUSE_ID_SPAN;
  const band = { good: base + 5, bad1: 999999, bad2: 'x', bad3: base - 1 };
  eq(I.allocateRuleId(band, base, span, 'good', base), base + 5, 'valid id reused as-is');
  const id = I.allocateRuleId(band, base, span, 'bad1', base);
  assert(Number.isInteger(id) && id >= base && id < base + span, 'reassigned a valid in-band id');
  assert(id !== 999999, 'did not reuse the corrupt out-of-band id');
});

test('allow-rules: >20 paused sites - no id collision, every site keeps its rule', async () => {
  const { I, chrome } = bg();
  const N = 25;
  const ids = [];
  for (let i = 0; i < N; i++) {
    const res = await I.handleAllowMessage({ op: 'pauseSite', site: 'site' + i + '.example' });
    eq(res.ok, true, 'paused site' + i);
    ids.push(lastCall(chrome).addRules[0].id);
  }
  eq(new Set(ids).size, N, 'no two of ' + N + ' paused sites share a rule id');
  ids.forEach((id) =>
    assert(id >= I.ALLOW_PAUSE_ID_BASE && id < I.ALLOW_PAUSE_ID_BASE + I.ALLOW_PAUSE_ID_SPAN, 'in pause band'));

  // Every paused site's rule is intact: re-pausing returns its SAME id.
  for (let i = 0; i < N; i++) {
    await I.handleAllowMessage({ op: 'pauseSite', site: 'site' + i + '.example' });
    eq(lastCall(chrome).addRules[0].id, ids[i], 'site' + i + ' still holds its original id');
  }
});

test('allow-rules: two sites sharing a preferred slot get DIFFERENT ids (the exact old bug)', async () => {
  const { I, chrome } = bg();
  // Find two hosts that collide under the old (hash % span) preferred formula.
  const seen = {};
  let a = null, b = null;
  for (let i = 0; i < 20000 && !b; i++) {
    const host = 'c' + i + '.example';
    const pref = I.sitePauseRuleId(host);
    if (seen[pref] !== undefined) { a = seen[pref]; b = host; } else seen[pref] = host;
  }
  assert(a && b, 'found a colliding preferred-slot pair');
  eq(I.sitePauseRuleId(a), I.sitePauseRuleId(b), 'same preferred slot - old code WOULD collide');

  await I.handleAllowMessage({ op: 'pauseSite', site: a });
  const idA = lastCall(chrome).addRules[0].id;
  await I.handleAllowMessage({ op: 'pauseSite', site: b });
  const idB = lastCall(chrome).addRules[0].id;
  assert(idA !== idB, 'allocator assigns distinct ids despite identical preferred slot');

  // Unpausing B frees its id and must NOT touch A's rule.
  await I.handleAllowMessage({ op: 'unpauseSite', site: b });
  eq(lastCall(chrome).removeRuleIds[0], idB, 'unpause removes B, not A');
});
