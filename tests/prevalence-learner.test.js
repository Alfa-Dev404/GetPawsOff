/* PawsOff - unit tests for the OBSERVE-ONLY prevalence learner.
 *
 * These pin the privacy + correctness invariants that the upcoming Complex
 * Method refactor of record()/spotted() must NOT change:
 *   - cross-site sightings are deduped per registrable domain
 *   - first-party and same-owner (first-party-set) hosts are never counted
 *   - time-decayed score thresholds map to allow / observing / block
 *   - yellowlisted domains downgrade block -> cookieblock
 *   - stale sightings are pruned by compact()
 * Every test loads a fresh, isolated learner instance.
 */
'use strict';

const { test, assert, eq, approx } = require('./harness/framework');
const { loadLearner, today, SNITCH_KEY } = require('./harness/sandbox');

test('PSL: getBaseDomain collapses hosts to their registrable domain', () => {
  const { PSL } = loadLearner();
  eq(PSL.getBaseDomain('www.tracker.com'), 'tracker.com');
  eq(PSL.getBaseDomain('a.b.example.co.uk'), 'example.co.uk');
  eq(PSL.getBaseDomain('news.com'), 'news.com');
});

test('record: a third party on one site scores 1 and reads as "observing"', async () => {
  const { NS } = loadLearner();
  await NS.record('news.com', ['cdn.tracker.com', 'news.com']);
  const v = await NS.getVerdict('tracker.com');
  eq(v.domain, 'tracker.com');
  approx(v.score, 1, 1e-9, 'fresh single sighting');
  eq(v.verdict, 'observing');
});

test('record: the same first party seen twice does not inflate the score', async () => {
  const { NS } = loadLearner();
  await NS.record('news.com', ['t.com']);
  await NS.record('news.com', ['t.com']);
  const v = await NS.getVerdict('t.com');
  approx(v.score, 1, 1e-9, 'distinct-site count stays 1');
});

test('record: sub-hosts sharing a base count once per page', async () => {
  const { NS } = loadLearner();
  await NS.record('news.com', ['a.t.com', 'b.t.com', 'c.t.com']);
  const v = await NS.getVerdict('t.com');
  approx(v.score, 1, 1e-9, 'deduped to one registrable domain');
});

test('record: crossing BLOCK_THRESHOLD distinct sites yields "block"', async () => {
  const { NS } = loadLearner();
  await NS.record('a.com', ['ad.evil.com']);
  await NS.record('b.com', ['ad.evil.com']);
  await NS.record('c.com', ['ad.evil.com']);
  const v = await NS.getVerdict('evil.com');
  approx(v.score, 3, 1e-9);
  eq(v.verdict, 'block');
});

test('yellowlisted domain crossing threshold downgrades to "cookieblock"', async () => {
  const { NS } = loadLearner();
  await NS.record('a.com', ['www.youtube.com']);
  await NS.record('b.com', ['www.youtube.com']);
  await NS.record('c.com', ['www.youtube.com']);
  const v = await NS.getVerdict('youtube.com');
  approx(v.score, 3, 1e-9);
  eq(v.verdict, 'cookieblock');
});

test('record: first-party and same-owner hosts are never recorded', async () => {
  const { NS } = loadLearner();
  // gstatic.com shares a first-party set with google.com.
  await NS.record('google.com', ['www.gstatic.com', 'fonts.gstatic.com']);
  const v = await NS.getVerdict('gstatic.com');
  approx(v.score, 0, 1e-9, 'same-owner excluded');
  eq(v.verdict, 'allow');
});

test('spotted: dedupes, drops first/same-owner, and sorts by score desc', async () => {
  const { NS } = loadLearner();
  await NS.record('x.com', ['big.com']);
  await NS.record('y.com', ['big.com']);
  await NS.record('z.com', ['big.com']); // big.com -> score 3
  await NS.record('x.com', ['small.com']); // small.com -> score 1
  const list = await NS.spotted('news.com', ['big.com', 'a.small.com', 'news.com', 'self.news.com']);
  eq(list.length, 2, 'first-party hosts removed');
  eq(list[0].domain, 'big.com');
  eq(list[1].domain, 'small.com');
  assert(list[0].score >= list[1].score, 'sorted by score desc');
  eq(list[0].verdict, 'block');
});

test('compact: prunes sightings older than the TTL', async () => {
  const { NS, getStore } = loadLearner();
  await NS.record('a.com', ['old.com']);
  const entry = getStore()[SNITCH_KEY][NS.hashHost('old.com')];
  const fp = Object.keys(entry.s)[0];
  entry.s[fp] = today() - 200; // older than SITE_TTL_DAYS (180)
  await NS.compact();
  assert(!getStore()[SNITCH_KEY][NS.hashHost('old.com')], 'stale tracker pruned');
});

test('getStats: aggregates verdict counts and ranks the worst first', async () => {
  const { NS } = loadLearner();
  await NS.record('a.com', ['ad.evil.com']);
  await NS.record('b.com', ['ad.evil.com']);
  await NS.record('c.com', ['ad.evil.com']); // evil.com -> block
  await NS.record('a.com', ['minor.com']);   // minor.com -> observing
  const stats = await NS.getStats(10);
  eq(stats.mode, 'observe-only');
  eq(stats.totalTrackers, 2);
  eq(stats.wouldBlock, 1);
  eq(stats.observing, 1);
  eq(stats.top[0].domain, NS.hashHost('evil.com')); // storage is hash-only
});

test('reset: clears all learned state', async () => {
  const { NS } = loadLearner();
  await NS.record('a.com', ['t.com']);
  await NS.reset();
  const stats = await NS.getStats();
  eq(stats.totalTrackers, 0);
});
