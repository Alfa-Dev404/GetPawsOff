'use strict';

/* EasyPrivacy -> DNR converter + generated-ruleset integrity tests. */

const fs = require('fs');
const path = require('path');
const { test, assert, eq } = require('./harness/framework');
const conv = require('../tools/easyprivacy-to-dnr');

const { parseFilterLine, lineToRule, labelFor, convert } = conv;

// ── parseFilterLine: skips ────────────────────────────────────────────────
test('parseFilterLine skips comments and headers', () => {
  eq(parseFilterLine('! a comment'), null);
  eq(parseFilterLine('[Adblock Plus 2.0]'), null);
  eq(parseFilterLine(''), null);
  eq(parseFilterLine('   '), null);
});

test('parseFilterLine skips cosmetic / scriptlet filters', () => {
  eq(parseFilterLine('example.com##.ad'), null);
  eq(parseFilterLine('example.com#@#.ad'), null);
  eq(parseFilterLine('example.com#?#.ad:has(> .x)'), null);
  eq(parseFilterLine('example.com#$#abort-on-property-read x'), null);
});

test('parseFilterLine skips regex and non-ASCII patterns', () => {
  eq(parseFilterLine('/ads?\\d+/'), null);
  assert(parseFilterLine('||xn--rcketr.example.com^') !== null, 'ascii punycode is allowed');
  eq(parseFilterLine('||naïve-tracker.com^'), null);
});

test('parseFilterLine drops rules with inexpressible options', () => {
  eq(parseFilterLine('||ads.com^$redirect=noop.js'), null);
  eq(parseFilterLine('||ads.com^$csp=script-src none'), null);
  eq(parseFilterLine('||ads.com^$removeparam=fbclid'), null);
  eq(parseFilterLine('||ads.com^$badfilter'), null);
});

// ── parseFilterLine: accepts ───────────────────────────────────────────────
test('parseFilterLine passes a plain domain-anchored block through', () => {
  const r = parseFilterLine('||doubleclick.net^');
  eq(r.type, 'block');
  eq(r.condition.urlFilter, '||doubleclick.net^');
});

test('parseFilterLine turns @@ exceptions into allow rules', () => {
  const r = parseFilterLine('@@||cdn.example.com^');
  eq(r.type, 'allow');
  eq(r.condition.urlFilter, '||cdn.example.com^');
});

test('parseFilterLine maps third-party options', () => {
  eq(parseFilterLine('||t.com^$third-party').condition.domainType, 'thirdParty');
  eq(parseFilterLine('||t.com^$~third-party').condition.domainType, 'firstParty');
});

test('parseFilterLine maps domain= include/exclude', () => {
  const r = parseFilterLine('||t.com^$domain=a.com|~b.com');
  assert(Array.isArray(r.condition.initiatorDomains), 'has initiatorDomains');
  eq(r.condition.initiatorDomains[0], 'a.com');
  eq(r.condition.excludedInitiatorDomains[0], 'b.com');
});

test('parseFilterLine maps adblock resource types to DNR types', () => {
  eq(parseFilterLine('||t.com^$script').condition.resourceTypes[0], 'script');
  eq(parseFilterLine('||t.com^$subdocument').condition.resourceTypes[0], 'sub_frame');
  eq(parseFilterLine('||t.com^$xmlhttprequest').condition.resourceTypes[0], 'xmlhttprequest');
});

test('parseFilterLine never emits both included and excluded resource types', () => {
  const r = parseFilterLine('||t.com^$script,~image');
  assert(r.condition.resourceTypes, 'keeps the include list');
  assert(!r.condition.excludedResourceTypes, 'drops the exclude list when include present');
});

test('parseFilterLine ignores benign options without dropping the rule', () => {
  const r = parseFilterLine('||t.com^$important,all');
  assert(r && r.type === 'block', 'still a block rule');
});

// ── lineToRule / labelFor ─────────────────────────────────────────────────
test('lineToRule assigns id and allow>block priority', () => {
  eq(lineToRule('||t.com^', 7).priority, 1);
  eq(lineToRule('||t.com^', 7).id, 7);
  eq(lineToRule('@@||t.com^', 9).priority, 2);
  eq(lineToRule('! comment', 1), null);
});

test('labelFor extracts the domain from a urlFilter', () => {
  eq(labelFor({ urlFilter: '||scorecardresearch.com^' }), 'scorecardresearch.com');
  assert(labelFor({ urlFilter: '/pagead/conversion.js' }).length > 0, 'non-empty label for a path filter');
});

// ── convert ───────────────────────────────────────────────────────────────
test('convert assigns sequential ids, dedupes, and counts', () => {
  const text = [
    '! header',
    '||a.com^',
    '||a.com^',          // duplicate -> skipped
    '||b.com^$third-party',
    'example.com##.ad',  // cosmetic -> skipped
    '@@||c.com^',
  ].join('\n');
  const out = convert(text, { startId: 1 });
  eq(out.rules.length, 3);
  eq(out.rules[0].id, 1);
  eq(out.rules[1].id, 2);
  eq(out.rules[2].id, 3);
  eq(out.rules[2].action.type, 'allow');
  eq(out.stats.kept, 3);
  assert(out.stats.skipped >= 3, 'counts skipped lines');
  assert(out.meta[1] && out.meta[1].length > 0, 'meta has a label for id 1');
});

// ── generated ruleset integrity ───────────────────────────────────────────
const RULES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'rules', 'easyprivacy.json'), 'utf8'));
const META = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'rules', 'easyprivacy-meta.json'), 'utf8'));

test('generated ruleset is a non-trivial array', () => {
  assert(Array.isArray(RULES), 'is an array');
  assert(RULES.length > 5000, 'has thousands of rules, got ' + RULES.length);
});

test('every rule has a unique positive id', () => {
  const ids = new Set();
  for (const r of RULES) {
    assert(Number.isInteger(r.id) && r.id > 0, 'id is a positive int');
    assert(!ids.has(r.id), 'id ' + r.id + ' is unique');
    ids.add(r.id);
  }
  eq(ids.size, RULES.length);
});

test('every rule is a valid DNR block/allow rule', () => {
  for (const r of RULES) {
    assert(r.action && (r.action.type === 'block' || r.action.type === 'allow'), 'action type valid');
    assert(r.condition && typeof r.condition.urlFilter === 'string' && r.condition.urlFilter.length > 0, 'has a urlFilter');
    assert(!/[^\x00-\x7F]/.test(r.condition.urlFilter), 'urlFilter is ASCII');
    assert(!(r.condition.resourceTypes && r.condition.excludedResourceTypes), 'no conflicting resource types');
  }
});

test('allow (exception) rules outrank block rules', () => {
  for (const r of RULES) {
    if (r.action.type === 'allow') assert(r.priority > 1, 'allow priority > block');
    else eq(r.priority, 1);
  }
  assert(RULES.some((r) => r.action.type === 'allow'), 'has at least one allow rule');
});

test('meta map covers every rule id with a non-empty label', () => {
  for (const r of RULES) {
    const label = META[r.id];
    assert(typeof label === 'string' && label.length > 0, 'label for id ' + r.id);
  }
});

// ── Consent-manager core assets are never blocked ──────────────────────
const { isConsentManagerAsset } = conv;

test('isConsentManagerAsset flags CMP core scripts/workers/vendor-list', () => {
  assert(isConsentManagerAsset('://cmpworker.'), 'cmpworker');
  assert(isConsentManagerAsset('/cmp3.js'), 'cmp3.js');
  assert(isConsentManagerAsset('/cmp.js'), 'cmp.js');
  assert(isConsentManagerAsset('/scmp.js'), 'scmp.js');
  assert(isConsentManagerAsset('/cmp/messaging.js'), 'messaging.js');
  assert(isConsentManagerAsset('/sourcepoint.js'), 'sourcepoint.js');
  assert(isConsentManagerAsset('||otg.mblycdn.com/bundles/cmp.js'), 'bundles/cmp.js');
  assert(isConsentManagerAsset('||ezodn.com/cmp/gvl.json'), 'gvl.json');
});

test('isConsentManagerAsset does NOT flag CMP analytics/other paths', () => {
  assert(!isConsentManagerAsset('||consensu.org/?log='), 'log endpoint stays blockable');
  assert(!isConsentManagerAsset('||collector.appconsent.io^'), 'collector stays blockable');
  assert(!isConsentManagerAsset('||doubleclick.net^'), 'normal tracker');
  assert(!isConsentManagerAsset('/analytics.js'), 'analytics.js is not a CMP core asset');
  assert(!isConsentManagerAsset(''), 'empty');
  assert(!isConsentManagerAsset(null), 'null');
});

test('convert drops CMP core-asset BLOCK rules but keeps @@ allow + analytics', () => {
  const text = [
    '||doubleclick.net^',          // normal block -> kept
    '/cmp3.js',                    // CMP core block -> dropped
    '://cmpworker.',               // CMP core block -> dropped
    '/sourcepoint.js',             // CMP core block -> dropped
    '@@||toggo.de/static/js/sourcepoint.js$domain=toggo.de', // allow -> kept
    '||consensu.org/?log=',        // CMP analytics block -> kept
  ].join('\n');
  const { rules } = convert(text, { startId: 1 });
  const filters = rules.map(r => r.condition.urlFilter);
  // dropped
  assert(!filters.some(f => /cmp3\.js/.test(f)), 'cmp3.js dropped');
  assert(!filters.some(f => /cmpworker/.test(f)), 'cmpworker dropped');
  assert(!rules.some(r => r.action.type === 'block' && /sourcepoint\.js/.test(r.condition.urlFilter)), 'sourcepoint block dropped');
  // kept
  assert(filters.some(f => /doubleclick/.test(f)), 'doubleclick kept');
  assert(filters.some(f => /consensu\.org/.test(f)), 'consensu analytics kept');
  // allow exception for sourcepoint.js survives (it is not a block rule)
  assert(rules.some(r => r.action.type === 'allow' && /sourcepoint\.js/.test(r.condition.urlFilter)), 'sourcepoint allow kept');
});

test('lineToRule returns null for a CMP core-asset block line', () => {
  eq(lineToRule('/cmp3.js', 7), null);
  // but an @@ allow for the same asset is still produced
  const r = lineToRule('@@||toggo.de/static/js/sourcepoint.js', 8);
  assert(r && r.action.type === 'allow', 'allow rule still built');
});
