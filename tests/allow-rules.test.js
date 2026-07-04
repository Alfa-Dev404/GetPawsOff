/* PawsOff - unit tests for the background allow-list → DNR allow rules. */
'use strict';
const { test, assert, eq } = require('./harness/framework');
const { loadBackground } = require('./harness/sandbox');

function bg() {
  const { internals, root, chrome } = loadBackground();
  return { I: internals, root, chrome };
}

test('allow-rules: builder + helper exports present', () => {
  const { I } = bg();
  ['normAllowHost','allowRuleHash','sitePauseRuleId','domainAllowRuleId',
   'buildSitePauseRule','buildDomainAllowRule','handleAllowMessage'].forEach((k) => {
    assert(typeof I[k] === 'function', 'missing ' + k);
  });
  eq(I.ALLOW_PRIORITY, 2);
});

test('allow-rules: normAllowHost normalizes and rejects junk', () => {
  const { I } = bg();
  eq(I.normAllowHost('https://www.Example.com/x'), 'example.com');
  eq(I.normAllowHost('localhost'), '');
  eq(I.normAllowHost(''), '');
});

test('allow-rules: site-pause rule shape + id band', () => {
  const { I } = bg();
  const r = I.buildSitePauseRule('news.example.com');
  eq(r.action.type, 'allowAllRequests');
  assert(r.priority === I.ALLOW_PRIORITY && r.priority > 1, 'priority beats block rules');
  eq(r.condition.requestDomains[0], 'news.example.com');
  assert(r.condition.resourceTypes.indexOf('main_frame') >= 0, 'covers main_frame');
  assert(r.id >= I.ALLOW_PAUSE_ID_BASE && r.id < I.ALLOW_PAUSE_ID_BASE + 200, 'in pause band');
  eq(I.buildSitePauseRule('junk'), null);
});

test('allow-rules: per-domain allow rule shape + id band', () => {
  const { I } = bg();
  const r = I.buildDomainAllowRule('news.example.com', 'doubleclick.net');
  eq(r.action.type, 'allow');
  eq(r.condition.requestDomains[0], 'doubleclick.net');
  eq(r.condition.initiatorDomains[0], 'news.example.com');
  assert(r.id >= I.ALLOW_DOMAIN_ID_BASE && r.id < I.ALLOW_DOMAIN_ID_BASE + 500, 'in domain band');
  eq(I.buildDomainAllowRule('news.example.com', 'junk'), null);
});

test('allow-rules: ids deterministic and pause/domain bands never overlap', () => {
  const { I } = bg();
  eq(I.sitePauseRuleId('a.example.com'), I.sitePauseRuleId('a.example.com'));
  eq(I.domainAllowRuleId('a.example.com', 'doubleclick.net'),
     I.domainAllowRuleId('a.example.com', 'doubleclick.net'));
  const p = I.sitePauseRuleId('a.example.com');
  const d = I.domainAllowRuleId('a.example.com', 'doubleclick.net');
  assert(p < I.ALLOW_DOMAIN_ID_BASE, 'pause id below domain band');
  assert(d >= I.ALLOW_DOMAIN_ID_BASE, 'domain id at/above domain band');
});

test('allow-rules: pauseSite adds rule and self-removes its id', async () => {
  const { I, chrome } = bg();
  const res = await I.handleAllowMessage({ op: 'pauseSite', site: 'news.example.com' });
  eq(res.ok, true);
  const call = chrome.declarativeNetRequest._calls.pop();
  const id = I.sitePauseRuleId('news.example.com');
  assert(call.removeRuleIds.indexOf(id) >= 0, 'removes its own id first');
  eq(call.addRules[0].id, id);
});

test('allow-rules: unpauseSite removes only', async () => {
  const { I, chrome } = bg();
  const res = await I.handleAllowMessage({ op: 'unpauseSite', site: 'news.example.com' });
  eq(res.ok, true);
  const call = chrome.declarativeNetRequest._calls.pop();
  eq(call.removeRuleIds[0], I.sitePauseRuleId('news.example.com'));
  eq(call.addRules.length, 0);
});

test('allow-rules: allowDomain then blockDomain target the same id', async () => {
  const { I, chrome } = bg();
  await I.handleAllowMessage({ op: 'allowDomain', site: 'news.example.com', domain: 'doubleclick.net' });
  const addCall = chrome.declarativeNetRequest._calls.pop();
  await I.handleAllowMessage({ op: 'blockDomain', site: 'news.example.com', domain: 'doubleclick.net' });
  const remCall = chrome.declarativeNetRequest._calls.pop();
  const id = I.domainAllowRuleId('news.example.com', 'doubleclick.net');
  eq(addCall.addRules[0].id, id);
  eq(remCall.removeRuleIds[0], id);
  eq(remCall.addRules.length, 0);
});

test('allow-rules: clearSite removes pause + all domain ids', async () => {
  const { I, chrome } = bg();
  const res = await I.handleAllowMessage({
    op: 'clearSite', site: 'news.example.com',
    domains: ['doubleclick.net', 'scorecardresearch.com'],
  });
  eq(res.ok, true);
  const ids = chrome.declarativeNetRequest._calls.pop().removeRuleIds;
  assert(ids.indexOf(I.sitePauseRuleId('news.example.com')) >= 0, 'pause id removed');
  assert(ids.indexOf(I.domainAllowRuleId('news.example.com', 'doubleclick.net')) >= 0, 'domain 1 removed');
  assert(ids.indexOf(I.domainAllowRuleId('news.example.com', 'scorecardresearch.com')) >= 0, 'domain 2 removed');
});

test('allow-rules: unknown op returns not-ok and writes no rules', async () => {
  const { I, chrome } = bg();
  const before = chrome.declarativeNetRequest._calls.length;
  const res = await I.handleAllowMessage({ op: 'frobnicate', site: 'news.example.com' });
  eq(res.ok, false);
  eq(chrome.declarativeNetRequest._calls.length, before);
});

test('allow-rules: pauseSite with junk site is rejected, no DNR write', async () => {
  const { I, chrome } = bg();
  const before = chrome.declarativeNetRequest._calls.length;
  const res = await I.handleAllowMessage({ op: 'pauseSite', site: 'localhost' });
  eq(res.ok, false);
  eq(chrome.declarativeNetRequest._calls.length, before);
});
