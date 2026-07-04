/* PawsOff - ToS Shield guarded-vocab recall tests.
 *
 * Measures the DELTA the guarded vocabulary additions make on a small labelled
 * clause corpus (real-world EU + US phrasings). "Before" is the same shipping
 * config with only the added tokens stripped, isolating exactly what those
 * tokens contribute - not an unrelated baseline.
 *
 * The additions are anchor-gated (anchor + object must co-occur in one
 * clause), so they lift recall on missed clauses without reintroducing false
 * positives. This file is the regression guard for that balance.
 */
'use strict';

const { test, assert, eq } = require('./harness/framework');
const { loadTosShield } = require('./harness/sandbox');

const T = loadTosShield().internals || {};
const {
  compileConfig,
  defaultSettings,
  normalizeForMatch,
  matchSentence,
  DEFAULT_CONFIG,
  getState,
} = T;

// Tokens introduced by this pass. "Before" = config with these removed.
const ADDED = {
  third_party_sharing: { anchors: ['communicate', 'communicates', 'communicated'] },
  marketing_sharing:   { objects: ['personal data', 'personal information'] },
  liability_waiver:    {
    anchors: ['held liable', 'be liable', 'shall not be liable', 'held responsible'],
    objects: ['in the event', 'arising', 'resulting from'],
  },
};

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function stripAdded(cfg) {
  const c = clone(cfg);
  for (const p of c.patterns) {
    const a = ADDED[p.categoryId];
    if (!a) continue;
    if (a.anchors) p.anchors = p.anchors.filter((x) => a.anchors.indexOf(x) === -1);
    if (a.objects) p.objects = p.objects.filter((x) => a.objects.indexOf(x) === -1);
  }
  return c;
}

// Labelled corpus. e === null means the clause is benign and must NOT flag.
const CORPUS = [
  // ── adverse: the EU / translated phrasings this pass targets ──────────────
  { t: "POLITICO may communicate its Users' personal information to third parties to the extent necessary.", e: 'third_party_sharing' },
  { t: 'The personal data may be used by POLITICO or its affiliates for direct marketing purposes.', e: 'marketing_sharing' },
  { t: 'POLITICO may in no way be held liable in the event that this data is stolen or hijacked by a third party.', e: 'liability_waiver' },
  // ── adverse: already covered before this pass (regression guard) ──────────
  { t: 'We may sell your personal data to third parties.', e: 'data_sale' },
  { t: 'In case of a dispute, the courts of Brussels have exclusive jurisdiction over these terms.', e: 'jurisdiction_choiceoflaw' },
  { t: 'We may change these terms at any time without notice.', e: 'unilateral_change' },
  // ── benign: GDPR / pro-user phrasing that must stay quiet (precision) ─────
  { t: 'We will never sell your personal data.', e: null },
  { t: 'You may at any time request to access, rectify or delete your data by emailing us.', e: null },
  { t: 'POLITICO will keep the personal data of its Users for the duration necessary to achieve the objectives pursued.', e: null },
];

function runCorpus(cfg) {
  compileConfig(cfg);
  getState().settings = defaultSettings(cfg);
  let tp = 0, fn = 0, fp = 0, tn = 0;
  const misses = [];
  const falsePos = [];
  for (const row of CORPUS) {
    const cats = matchSentence(normalizeForMatch(row.t)).map((h) => h.categoryId);
    if (row.e) {
      if (cats.indexOf(row.e) !== -1) tp++;
      else { fn++; misses.push(row.e + ' ← ' + row.t.slice(0, 48)); }
    } else if (cats.length) {
      fp++; falsePos.push(cats.join(',') + ' ← ' + row.t.slice(0, 48));
    } else {
      tn++;
    }
  }
  const adverse = tp + fn;
  return { recall: adverse ? tp / adverse : 0, fpCount: fp, misses, falsePos };
}

test('vocab: guarded additions lift recall with no new false positives', () => {
  const before = runCorpus(stripAdded(DEFAULT_CONFIG));
  const after = runCorpus(DEFAULT_CONFIG);
  console.log(
    '        [vocab] recall before=' + Math.round(before.recall * 100) + '%'
    + ' after=' + Math.round(after.recall * 100) + '%'
    + '; benign false-positives before=' + before.fpCount + ' after=' + after.fpCount,
  );
  assert(after.recall > before.recall, 'recall improved (' + before.recall + ' -> ' + after.recall + ')');
  eq(after.recall, 1, 'every labelled adverse clause now flags; remaining misses=' + JSON.stringify(after.misses));
  eq(after.fpCount, 0, 'no benign clause mis-flagged; false-positives=' + JSON.stringify(after.falsePos));
  eq(before.fpCount, 0, 'corpus precision was already clean - vocab did not trade FN for FP');
});

test('vocab: "communicate … to third parties" now flags third_party_sharing', () => {
  compileConfig(DEFAULT_CONFIG);
  getState().settings = defaultSettings(DEFAULT_CONFIG);
  const cats = matchSentence(normalizeForMatch("POLITICO may communicate its Users' data to third parties.")).map((h) => h.categoryId);
  assert(cats.indexOf('third_party_sharing') !== -1, 'the "communicate" anchor is matched');
});

test('vocab: "held liable" disclaimer now flags liability_waiver', () => {
  compileConfig(DEFAULT_CONFIG);
  getState().settings = defaultSettings(DEFAULT_CONFIG);
  const cats = matchSentence(normalizeForMatch('POLITICO may in no way be held liable in the event that this data is stolen.')).map((h) => h.categoryId);
  assert(cats.indexOf('liability_waiver') !== -1, 'the "held liable" anchor + "in the event" object match');
});

test('vocab: benign GDPR retention-limit clause stays quiet (no data_retention FP)', () => {
  compileConfig(DEFAULT_CONFIG);
  getState().settings = defaultSettings(DEFAULT_CONFIG);
  const cats = matchSentence(normalizeForMatch('POLITICO will keep the personal data of its Users for the duration necessary to achieve the objectives pursued.')).map((h) => h.categoryId);
  eq(cats.length, 0, 'duration-limited retention is not flagged; got=' + JSON.stringify(cats));
});
