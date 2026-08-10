'use strict';

const { test, assert, eq } = require('./harness/framework');
const delta = require('../tools/easyprivacy-to-delta.js');
const RELEASE_VERSION = '20260715000000';

const SAMPLE = [
  '! Version: 202607141422',
  '||new-tracker.example^$third-party',
  '||script-tracker.example^$script,third-party',
  '||covered.example^$third-party',
  '||essential.example^$third-party',
  '||scoped.example^$third-party,domain=one.example',
  '||frame.example^$subdocument,third-party',
  '||path.example/collect^$third-party',
  '@@||allowed.example^$third-party',
  '||allowed.example^$third-party',
].join('\n');

function convert(text, options = {}) {
  return delta.convert(text, { configVersion: RELEASE_VERSION, ...options });
}

test('easyprivacy delta builder: only conservative exact-domain rules survive', () => {
  const { config } = convert(SAMPLE, {
    coveredDomains: ['covered.example'],
    essentialDomains: ['essential.example'],
  });
  eq(config.configVersion, RELEASE_VERSION);
  eq(config.sourceVersion, '202607141422');
  eq(config.domains.length, 2);
  assert(config.domains.some((entry) => entry.domain === 'new-tracker.example'), 'new tracker emitted');
  assert(config.domains.some((entry) => entry.domain === 'script-tracker.example'), 'explicit safe script rule emitted');
  assert(!config.domains.some((entry) => entry.domain === 'allowed.example'), 'upstream allow wins');
  assert(!config.domains.some((entry) => entry.domain === 'scoped.example'), 'site-scoped rule is not broadened');
  assert(!config.domains.some((entry) => entry.domain === 'frame.example'), 'frame rule stays excluded');
});

test('easyprivacy delta builder: defaults to beacon carriers and preserves attribution', () => {
  const { config } = convert(SAMPLE);
  const entry = config.domains.find((item) => item.domain === 'new-tracker.example');
  eq(entry.resourceTypes.join(','), delta.DEFAULT_TYPES.join(','));
  assert(/EasyList authors/.test(config.attribution), 'attribution embedded');
  assert(/CC-BY-SA/.test(config.sourceLicense), 'redistribution licence embedded');
});

test('easyprivacy delta builder: malformed, path, and executable filters are ignored', () => {
  eq(delta.candidateFromLine('button##.advert'), null);
  eq(delta.candidateFromLine('/tracker-[0-9]+/'), null);
  eq(delta.candidateFromLine('||example.com/path'), null);
  eq(delta.candidateFromLine('||foo..example^$third-party'), null);
  eq(delta.candidateFromLine('||-foo.example^$third-party'), null);
  eq(delta.candidateFromLine(`||${'a'.repeat(64)}.example^$third-party`), null);
});

test('easyprivacy delta builder: source without an upstream version fails closed', () => {
  let rejected = false;
  try { convert('||tracker.example^$third-party'); }
  catch (_) { rejected = true; }
  assert(rejected, 'a dated local fallback is never invented for an unversioned source');
});

test('easyprivacy delta builder: source version is bounded and conservative', () => {
  ['../escape', 'v/1', 'x'.repeat(81), '<script>'].forEach((version) => {
    let rejected = false;
    try { convert(`! Version: ${version}\n||tracker.example^$third-party`); }
    catch (_) { rejected = true; }
    assert(rejected, `unsafe source version rejected: ${version.slice(0, 12)}`);
  });
});

test('easyprivacy delta builder: bounded selection is stable and diversifies base domains', () => {
  const lines = ['! Version: 1'];
  for (let i = 0; i < 12; i += 1) lines.push(`||customer-${i}.tracker-platform.example^$third-party`);
  for (let i = 0; i < 12; i += 1) lines.push(`||vendor-${i}.independent-${i}.example^$third-party`);
  const options = {
    max: 8,
    perBaseCap: 2,
    getBaseDomain: (domain) => domain.endsWith('.tracker-platform.example') ? 'tracker-platform.example' : domain,
  };
  const first = convert(lines.join('\n'), options);
  const second = convert(lines.join('\n'), options);
  eq(JSON.stringify(first.config.domains), JSON.stringify(second.config.domains), 'same source produces the same selection');
  const platformCount = first.config.domains.filter((entry) => entry.domain.endsWith('.tracker-platform.example')).length;
  assert(platformCount <= 2, 'one multi-tenant base cannot consume the feed');
  assert(first.stats.representedBases >= 7, 'small budget covers diverse bases');
});

test('easyprivacy delta builder: caller options cannot disable hard output caps', () => {
  const lines = ['! Version: 1'];
  for (let i = 0; i < delta.MAX_EMITTED_DOMAINS + 50; i += 1) {
    lines.push(`||tracker-${i}.example^$third-party`);
  }
  const result = convert(lines.join('\n'), { max: Number.MAX_SAFE_INTEGER, perBaseCap: Number.MAX_SAFE_INTEGER });
  eq(result.config.domains.length, delta.MAX_EMITTED_DOMAINS, 'emitted domains remain hard-capped');
  eq(delta.boundedOption(Number.MAX_SAFE_INTEGER, 3, delta.MAX_PER_BASE), delta.MAX_PER_BASE, 'per-base option is clamped');
});

test('easyprivacy delta builder: release config version is explicit and canonical', () => {
  for (const configVersion of [undefined, '', '2026-07-15', '01', '1..2']) {
    let rejected = false;
    try { delta.convert(SAMPLE, { configVersion }); } catch (_) { rejected = true; }
    assert(rejected, `invalid release version rejected: ${configVersion}`);
  }
});
