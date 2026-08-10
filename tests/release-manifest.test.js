'use strict';

const { test, assert, eq } = require('./harness/framework');
const fs = require('fs');
const os = require('os');
const path = require('path');

let releaseModule;
async function api() {
  if (!releaseModule) releaseModule = await import('../tools/build-release-manifest.mjs');
  return releaseModule;
}

test('release manifest: validates monotonic sequence and bounded release id', async () => {
  const { assertReleaseInputs } = await api();
  const out = assertReleaseInputs({
    releaseId: '2026-07-14.42',
    sequence: '2026071400042',
    previousSequence: '2026071400041',
    generatedAt: '2026-07-14T05:00:00.000Z',
    ttlDays: '7',
  });
  eq(out.sequence, 2026071400042);
  let rejected = false;
  try {
    assertReleaseInputs({ releaseId: '../escape', sequence: 1, generatedAt: '2026-07-14T05:00:00.000Z' });
  } catch (_) { rejected = true; }
  assert(rejected, 'path-like release id rejected');

  for (const bad of [
    { releaseId: 'valid', sequence: 0, previousSequence: 0, generatedAt: '2026-07-14T05:00:00.000Z' },
    { releaseId: 'valid', sequence: -1, previousSequence: 0, generatedAt: '2026-07-14T05:00:00.000Z' },
    { releaseId: 'valid', sequence: 1, previousSequence: 0, generatedAt: 'not-a-date' },
    { releaseId: 'valid', sequence: 1, previousSequence: 0, generatedAt: '2026-07-14T05:00:00.000Z', ttlDays: 0 },
    { releaseId: 'valid', sequence: 1, previousSequence: 0, generatedAt: '2026-07-14T05:00:00.000Z', ttlDays: 31 },
    { releaseId: 'valid', sequence: 1, previousSequence: 0, generatedAt: '2026-07-14T05:00:00Z' },
    { releaseId: 'valid', sequence: 1, previousSequence: 0, generatedAt: '2026-07-14T10:30:00.000+05:30' },
    { releaseId: 'valid', sequence: 1, previousSequence: 0, generatedAt: '2026-07-14 05:00:00.000Z' },
  ]) {
    let boundaryRejected = false;
    try { assertReleaseInputs(bad); } catch (_) { boundaryRejected = true; }
    assert(boundaryRejected, 'invalid sequence/date/TTL boundary rejected');
  }

  for (const ttlDays of [1, 30]) {
    const boundary = assertReleaseInputs({
      releaseId: 'valid',
      sequence: 1,
      previousSequence: 0,
      generatedAt: '2026-07-14T05:00:00.000Z',
      ttlDays,
    });
    eq(boundary.ttlDays, ttlDays, 'valid TTL boundary accepted');
  }

  for (const sequence of [41, 42]) {
    let rollbackRejected = false;
    try {
      assertReleaseInputs({
        releaseId: 'valid',
        sequence,
        previousSequence: 42,
        generatedAt: '2026-07-14T05:00:00.000Z',
      });
    } catch (_) { rollbackRejected = true; }
    assert(rollbackRejected, 'equal and lower release sequences are rejected');
  }
});

test('release manifest: hashes exact bytes and writes immutable plus legacy copies', async () => {
  const { buildRelease, sha256Hex } = await api();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pawsoff-release-'));
  const inputRel = 'dist/consent.json';
  const input = path.join(root, inputRel);
  fs.mkdirSync(path.dirname(input), { recursive: true });
  const payload = {
    schemaVersion: 1,
    configVersion: '20260714050000',
    source: 'autoconsent',
    sourceVersion: '1.2.3',
    sourceLicense: 'MIT',
    attribution: 'Fixture only',
    frameworks: [{
      name: 'Fixture CMP',
      containerSelector: '#fixture-cmp',
      rejectSelectors: ['#fixture-reject'],
    }],
  };
  const bytes = Buffer.from(JSON.stringify(payload) + '\n');
  fs.writeFileSync(input, bytes);

  const output = path.join(root, 'publish');
  const result = buildRelease({
    root,
    out: output,
    releaseId: '2026-07-14.42',
    sequence: 2026071400042,
    previousSequence: 2026071400041,
    generatedAt: '2026-07-14T05:00:00.000Z',
    ttlDays: 7,
    feeds: [{
      key: 'consentGhost', required: true, input: inputRel,
      fileName: 'consent.json', legacyPath: 'consent-ghost/consent-config.json',
    }],
  });

  const desc = result.manifest.feeds.consentGhost;
  eq(desc.signaturePath, desc.path + '.sig', 'detached signature path is committed by the manifest');
  eq(desc.sha256, sha256Hex(bytes), 'manifest hash covers exact published bytes');
  eq(desc.bytes, bytes.length);
  eq(desc.sourceLicense, 'MIT');
  eq(result.manifest.expiresAt, '2026-07-21T05:00:00.000Z');
  assert(fs.readFileSync(path.join(output, desc.path), 'utf8') === bytes.toString(), 'immutable copy exact');
  assert(fs.readFileSync(path.join(output, 'consent-ghost/consent-config.json'), 'utf8') === bytes.toString(), 'legacy copy exact');
});

test('release manifest: validates feed schema and byte limits before writing output', async () => {
  const { validateFeed } = await api();
  const valid = {
    schemaVersion: 1,
    configVersion: '2026-07-14',
    source: 'autoconsent',
    sourceLicense: 'MPL-2.0',
    attribution: 'AutoConsent fixture',
    frameworks: [{ name: 'CMP', containerSelector: '#cmp', rejectSelectors: ['#reject'] }],
  };
  validateFeed({ key: 'consentGhost', input: 'fixture.json' }, Buffer.from(JSON.stringify(valid)), valid);

  let invalidSchema = false;
  try {
    validateFeed(
      { key: 'consentGhost', input: 'fixture.json' },
      Buffer.from('{}'),
      { ...valid, source: 'untrusted', frameworks: [{}] },
    );
  } catch (_) { invalidSchema = true; }
  assert(invalidSchema, 'untrusted provenance and malformed entries are rejected');

  for (const candidate of [
    { ...valid, action: 'execute' },
    { ...valid, frameworks: [{ ...valid.frameworks[0], xpath: '//button' }] },
    { ...valid, frameworks: [{ ...valid.frameworks[0], containerSelector: '#cmp[' }] },
    { ...valid, frameworks: [{ ...valid.frameworks[0], rejectSelectors: ['#cmp >>> '] }] },
  ]) {
    let unknownRejected = false;
    try {
      validateFeed(
        { key: 'consentGhost', input: 'fixture.json' },
        Buffer.from(JSON.stringify(candidate)),
        candidate,
      );
    } catch (_) { unknownRejected = true; }
    assert(unknownRejected, 'unknown consent feed and framework fields are rejected');
  }

  const validV2 = {
    ...valid,
    schemaVersion: 2,
    frameworks: [{
      name: 'CMP',
      selectors: { containers: ['#cmp'], directReject: ['#reject'], openPreferences: [], save: [], completion: ['#cmp'] },
    }],
  };
  const unsafeV2 = {
    ...validV2,
    frameworks: [{
      ...validV2.frameworks[0],
      selectors: { ...validV2.frameworks[0].selectors, accept: ['#accept'] },
    }],
  };
  let roleRejected = false;
  try {
    validateFeed({ key: 'consentGhostV2', input: 'fixture.json' }, Buffer.from(JSON.stringify(unsafeV2)), unsafeV2);
  } catch (_) { roleRejected = true; }
  assert(roleRejected, 'unknown selector roles are rejected before signing');

  let oversized = false;
  try {
    validateFeed(
      { key: 'consentGhost', input: 'fixture.json', maxBytes: 8 },
      Buffer.alloc(9),
      valid,
    );
  } catch (_) { oversized = true; }
  assert(oversized, 'oversized feed is rejected before publication');
});

test('release manifest: all feeds share one canonical release config version', async () => {
  const { assertConsistentConfigVersions } = await api();
  const item = (key, configVersion) => ({
    spec: { key, input: `${key}.json` },
    parsed: { configVersion },
  });
  eq(assertConsistentConfigVersions([
    item('consentGhost', '20260715000000'),
    item('consentGhostV2', '20260715000000.2'),
    item('tosReputation', '20260715000000'),
  ]), '20260715000000');

  for (const prepared of [
    [item('consentGhost', '20260715000000'), item('tosReputation', '20260716000000')],
    [item('consentGhostV2', '20260715000000')],
    [item('consentGhost', '20260715000000.2')],
  ]) {
    let rejected = false;
    try { assertConsistentConfigVersions(prepared); } catch (_) { rejected = true; }
    assert(rejected, 'mixed or unexpected config version suffix is rejected');
  }
});

test('release manifest: ToS reputation grades are constrained to A-E or null', async () => {
  const { validateFeed } = await api();
  const reputation = {
    schemaVersion: 1,
    configVersion: '20260715000000',
    source: 'tosdr',
    sourceLicense: 'CC-BY-SA-3.0',
    attribution: 'Fixture',
    services: {
      'example.com': { name: 'Example', grade: 'A', flagged: [] },
    },
  };
  for (const grade of ['A', 'B', 'C', 'D', 'E', null]) {
    const allowed = {
      ...reputation,
      services: { 'example.com': { ...reputation.services['example.com'], grade } },
    };
    validateFeed(
      { key: 'tosReputation', input: 'fixture.json' },
      Buffer.from(JSON.stringify(allowed)),
      allowed,
    );
  }
  for (const grade of ['F', 'AA', 'a', 'unknown']) {
    const invalid = {
      ...reputation,
      services: { 'example.com': { ...reputation.services['example.com'], grade } },
    };
    let rejected = false;
    try {
      validateFeed(
        { key: 'tosReputation', input: 'fixture.json' },
        Buffer.from(JSON.stringify(invalid)),
        invalid,
      );
    } catch (_) { rejected = true; }
    assert(rejected, `invalid reputation grade rejected: ${grade}`);
  }
});

test('release manifest: refuses to publish without the required feed', async () => {
  const { buildRelease } = await api();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pawsoff-release-missing-'));
  let rejected = false;
  try {
    buildRelease({
      root,
      out: path.join(root, 'publish'),
      releaseId: '2026-07-14.1',
      sequence: 1,
      previousSequence: 0,
      generatedAt: '2026-07-14T05:00:00.000Z',
      feeds: [{ key: 'required', required: true, input: 'missing.json', fileName: 'x.json', legacyPath: 'x.json' }],
    });
  } catch (_) { rejected = true; }
  assert(rejected, 'required feed absence fails the build');
});

test('release manifest: refuses a non-empty output so stale artifacts cannot survive', async () => {
  const { buildRelease } = await api();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pawsoff-release-stale-'));
  const output = path.join(root, 'publish');
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(output, 'stale.json'), '{}');
  let rejected = false;
  try {
    buildRelease({
      root,
      out: output,
      releaseId: '2026-07-14.1',
      sequence: 1,
      previousSequence: 0,
      generatedAt: '2026-07-14T05:00:00.000Z',
      feeds: [],
    });
  } catch (_) { rejected = true; }
  assert(rejected, 'stale output is never reused');
});
