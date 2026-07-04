/* PawsOff - EDGE-CASE tests for the observe-only prevalence learner.
 *
 * These complement prevalence-learner.test.js by pinning the boundary
 * behaviours that are easiest to break during a Complex Method refactor of
 * record()/spotted(): input guards, the time-decay curve, verdict thresholds,
 * the per-tracker site cap, and empty/unknown read paths.
 * Every test loads a fresh, isolated learner instance.
 */
'use strict';

const { test, assert, eq, approx } = require('./harness/framework');
const { loadLearner, today, SNITCH_KEY } = require('./harness/sandbox');

test('record: ignores incomplete input (no first party / empty / non-array)', async () => {
  const { NS } = loadLearner();
  await NS.record(null, ['ad.evil.com']);
  await NS.record('', ['ad.evil.com']);
  await NS.record('news.com', []);
  await NS.record('news.com', null);
  const stats = await NS.getStats();
  eq(stats.totalTrackers, 0, 'nothing recorded from incomplete batches');
});

test('record: a first party that only lists itself records nothing', async () => {
  const { NS } = loadLearner();
  await NS.record('news.com', ['www.news.com', 'news.com']);
  const stats = await NS.getStats();
  eq(stats.totalTrackers, 0, 'self-only batch is a no-op');
});

test('scoring: a 30-day-old sighting decays to ~0.5 and reads "allow"', async () => {
  const { NS, getStore } = loadLearner();
  await NS.record('a.com', ['decayer.com']);
  const entry = getStore()[SNITCH_KEY][NS.hashHost('decayer.com')];
  const fp = Object.keys(entry.s)[0];
  entry.s[fp] = today() - 30; // one half-life old
  const v = await NS.getVerdict('decayer.com');
  approx(v.score, 0.5, 1e-9, 'half-life decay');
  eq(v.verdict, 'allow', 'below OBSERVE_FLOOR');
});

test('scoring: a 60-day-old sighting decays to ~0.25 (two half-lives)', async () => {
  const { NS, getStore } = loadLearner();
  await NS.record('a.com', ['decayer.com']);
  const entry = getStore()[SNITCH_KEY][NS.hashHost('decayer.com')];
  const fp = Object.keys(entry.s)[0];
  entry.s[fp] = today() - 60;
  const v = await NS.getVerdict('decayer.com');
  approx(v.score, 0.25, 1e-9, 'two half-lives');
});

test('verdict: a score between the floor and threshold reads "observing"', async () => {
  const { NS } = loadLearner();
  await NS.record('a.com', ['mid.com']);
  await NS.record('b.com', ['mid.com']); // score 2: >= OBSERVE_FLOOR, < BLOCK_THRESHOLD
  const v = await NS.getVerdict('mid.com');
  approx(v.score, 2, 1e-9);
  eq(v.verdict, 'observing');
});

test('record: distinct sites per tracker are capped (oldest dropped)', async () => {
  const { NS, getStore } = loadLearner();
  for (let i = 0; i < 70; i++) {
    await NS.record('site' + i + '.com', ['ad.evil.com']);
  }
  const entry = getStore()[SNITCH_KEY][NS.hashHost('evil.com')];
  eq(Object.keys(entry.s).length, 64, 'capped at MAX_SITES_PER_TRACKER');
});

test('spotted: empty or malformed inputs return an empty list', async () => {
  const { NS } = loadLearner();
  eq((await NS.spotted('', ['x.com'])).length, 0, 'no first party');
  eq((await NS.spotted('news.com', null)).length, 0, 'hostList not an array');
  eq((await NS.spotted('news.com', [])).length, 0, 'no hosts');
});

test('spotted: a never-recorded third party reports score 0 / allow / 0 sites', async () => {
  const { NS } = loadLearner();
  const list = await NS.spotted('news.com', ['fresh-unknown.com']);
  eq(list.length, 1);
  eq(list[0].domain, 'fresh-unknown.com');
  approx(list[0].score, 0);
  eq(list[0].sites, 0);
  eq(list[0].verdict, 'allow');
});

test('getVerdict: an unknown host is score 0 / allow', async () => {
  const { NS } = loadLearner();
  const v = await NS.getVerdict('never-seen.com');
  approx(v.score, 0);
  eq(v.verdict, 'allow');
});

test('compact: keeps a tracker that still has a fresh sighting', async () => {
  const { NS, getStore } = loadLearner();
  await NS.record('fresh.com', ['mix.com']);
  await NS.record('stale.com', ['mix.com']);
  getStore()[SNITCH_KEY][NS.hashHost('mix.com')].s[NS.hashHost('stale.com')] = today() - 200; // expire just this one
  await NS.compact();
  const after = getStore()[SNITCH_KEY][NS.hashHost('mix.com')];
  assert(after, 'tracker retained while a fresh sighting remains');
  eq(Object.keys(after.s).length, 1, 'only the stale sighting pruned');
  assert(!(NS.hashHost('stale.com') in after.s), 'stale sighting removed');
});
