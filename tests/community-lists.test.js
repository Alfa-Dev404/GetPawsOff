'use strict';
// Tests for the community-list converters (autoconsent / ToS;DR / whotracks.me).
// Every converter is a PURE function, so these run fully offline. The key
// assertions prove the OUTPUT is drop-in valid for the consumers that already
// exist in the extension (we replicate those consumers' own validators here).

const { test, assert } = require('./harness/framework');
const fs = require('fs');
const path = require('path');

const ac = require('../tools/autoconsent-to-consent-rules');
const td = require('../tools/tosdr-to-grades');
const wtm = require('../tools/whotracksme-to-firstparty');

// ── Replicated ConsentGhost validators (must stay in sync with consent-ghost.js)
function cgUsable(cfg) {
  return !!cfg && cfg.schemaVersion === 1 && Array.isArray(cfg.frameworks);
}
function cgValidEntry(f) {
  return !!f && f.enabled !== false &&
    typeof f.name === 'string' && typeof f.containerSelector === 'string' &&
    Array.isArray(f.rejectSelectors);
}

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.resolve(__dirname, 'fixtures', name), 'utf8'));
}

// ─────────────────────────────── autoconsent ───────────────────────────────
test('autoconsent: parseRule pulls container + splits comma-joined reject selectors', () => {
  const rules = loadFixture('autoconsent-sample.json');
  const e = ac.parseRule(rules[0]);
  assert(e, 'entry produced for Onetrust');
  assert(e.containerSelector.indexOf('#onetrust-banner-sdk') !== -1, 'container selector present');
  assert(e.rejectSelectors.length === 2, 'comma-joined reject split into two');
  assert(e.rejectSelectors.indexOf('#onetrust-reject-all-handler') !== -1, 'first reject kept');
  assert(e.rejectSelectors.indexOf('.ot-pc-refuse-all-handler') !== -1, 'second reject kept');
});

test('autoconsent: a hide-only rule (no reject click) is skipped', () => {
  const rules = loadFixture('autoconsent-sample.json');
  const hideOnly = rules.find((r) => r.name === 'HideOnly');
  assert(ac.parseRule(hideOnly) === null, 'hide-only rule produces no entry');
});

test('autoconsent: convert output is drop-in valid for consent-ghost', () => {
  const rules = loadFixture('autoconsent-sample.json');
  const { config, stats } = ac.convert(rules);
  assert(cgUsable(config), 'isUsableRemoteConfig accepts it');
  assert(config.frameworks.every(cgValidEntry), 'every framework entry is valid');
  assert(stats.emitted === 3, 'three usable CMPs emitted');
  assert(stats.skipped === 1, 'one (hide-only) skipped');
});

test('autoconsent: reject clicks inside if/then branches are collected', () => {
  const rules = loadFixture('autoconsent-sample.json');
  const sp = ac.parseRule(rules.find((r) => r.name === 'Sourcepoint'));
  assert(sp && sp.rejectSelectors.indexOf('.sp_choice_type_REJECT_ALL') !== -1, 'nested reject found');
  assert(sp.rejectSelectors.indexOf('.sp_choice_type_12') !== -1, 'top-level reject found');
});

// ──────────────────────────────────  ToS;DR  ───────────────────────────────
test('tosdr: parseService keeps only bad/blocker points and maps grade + hosts', () => {
  const svcs = loadFixture('tosdr-sample.json');
  const p = td.parseService(svcs[0]);
  assert(p, 'parsed');
  assert(p.hosts.indexOf('example.com') !== -1, 'host stripped of scheme + www');
  assert(p.hosts.indexOf('example.net') !== -1, 'secondary host kept');
  assert(p.entry.grade === 'E', 'grade letter uppercased');
  assert(p.entry.flagged.length === 2, 'only blocker + bad surfaced (good/neutral dropped)');
  assert(p.entry.flagged[0].severity === 'high', 'blocker -> high severity');
});

test('tosdr: convert embeds attribution and lookupGrade resolves www + subdomains', () => {
  const { config, stats } = td.convert(loadFixture('tosdr-sample.json'));
  assert(config.schemaVersion === 1, 'schemaVersion set');
  assert(typeof config.attribution === 'string' && config.attribution.indexOf('ToS;DR') !== -1, 'CC-BY-SA attribution embedded');
  assert(stats.flagged === 4, 'flagged counted per emitted host (2 hosts x 2 clauses)');
  assert(td.lookupGrade('www.example.com', config).grade === 'E', 'lookup strips www');
  assert(td.lookupGrade('app.example.com', config).grade === 'E', 'lookup falls back to base domain');
  assert(td.lookupGrade('unknown.tld', config) === null, 'unknown host -> null');
});

// ─────────────────────────────── whotracks.me ──────────────────────────────
test('whotracksme: domains are grouped by company into first-party sets (>=2)', () => {
  const { config } = wtm.convert(loadFixture('whotracksme-sample.json'));
  const googleSet = config.firstPartySets.find((s) => s.indexOf('google.com') !== -1);
  assert(googleSet, 'google set exists');
  assert(googleSet.indexOf('doubleclick.net') !== -1, 'doubleclick merged into google');
  assert(googleSet.indexOf('google-analytics.com') !== -1, 'analytics merged into google');
  assert(!config.firstPartySets.some((s) => s.length < 2), 'no singleton sets (vimeo dropped)');
});

test('whotracksme: yellowlist only includes function-critical categories', () => {
  const { config } = wtm.convert(loadFixture('whotracksme-sample.json'));
  assert(config.yellowlist.indexOf('cloudflare.com') !== -1, 'cdn domain is yellow');
  assert(config.yellowlist.indexOf('vimeo.com') !== -1, 'audio_video_player is yellow');
  assert(config.yellowlist.indexOf('doubleclick.net') === -1, 'advertising is NOT yellow');
  assert(config.yellowlist.indexOf('google-analytics.com') === -1, 'site_analytics is NOT yellow');
  assert(typeof config.attribution === 'string' && config.attribution.indexOf('MIT') !== -1, 'MIT attribution embedded');
});

// ── Generated artifacts (present only after a build run) stay drop-in valid ──
test('generated consent artifact, if built, is drop-in valid', () => {
  const p = path.resolve(__dirname, '../dist-lists/consent-ghost/consent-config.json');
  if (!fs.existsSync(p)) return; // built in CI / sample run only
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert(cgUsable(cfg), 'usable');
  assert(cfg.frameworks.every(cgValidEntry), 'all entries valid');
});
