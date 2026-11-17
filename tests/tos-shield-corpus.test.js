/* ToS Shield accuracy on real policy text.
 *
 * tests/fixtures/tos-corpus.json holds quotes that ToS;DR reviewers labelled
 * (rebuild with tools/build-tos-corpus.mjs). Each row is either adverse, with
 * the categories that count as a correct flag, or protective, with the
 * categories that would contradict the reviewer.
 *
 * The floors below are a ratchet: raise them when the matcher improves, and
 * treat a drop as a regression. They are not a claim of overall accuracy.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { test, assert } = require('./harness/framework');
const { loadTosShield } = require('./harness/sandbox');

const T = loadTosShield().internals || {};
const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tos-corpus.json'), 'utf8'));

function flaggedCategories(text) {
  const found = new Set();
  for (const sentence of T.segmentSentences(text)) {
    for (const hit of T.matchSentence(T.normalizeForMatch(sentence.raw))) found.add(hit.categoryId);
  }
  return found;
}

// Even rows are for tuning the vocabulary; odd rows are held out and only measured.
function measure(keep) {
  T.compileConfig(T.DEFAULT_CONFIG);
  T.getState().settings = T.defaultSettings(T.DEFAULT_CONFIG);
  const known = new Set(T.DEFAULT_CONFIG.categories.map((category) => category.id));
  const out = { adverse: 0, caught: 0, protective: 0, contradicted: 0, uncovered: 0, missed: {}, wrong: [] };
  for (const row of corpus.rows.filter(keep)) {
    const flags = flaggedCategories(row.t);
    if (row.e) {
      // A row whose categories ToS Shield does not have yet is tracked, not scored.
      if (!row.e.some((id) => known.has(id))) { out.uncovered += 1; continue; }
      out.adverse += 1;
      if (row.e.some((id) => flags.has(id))) out.caught += 1;
      else out.missed[row.e[0]] = (out.missed[row.e[0]] || 0) + 1;
    } else {
      out.protective += 1;
      if (row.not.some((id) => flags.has(id))) { out.contradicted += 1; out.wrong.push(row.case); }
    }
  }
  out.recall = out.adverse ? out.caught / out.adverse : 0;
  out.contradictionRate = out.protective ? out.contradicted / out.protective : 0;
  return out;
}

// Measured on 2026-11-16 with 16 categories: recall 0.55, contradiction rate 0.
const RECALL_FLOOR = 0.5;
const CONTRADICTION_CEILING = 0.1;

function report(label, m) {
  console.log('        [corpus ' + label + '] recall ' + m.caught + '/' + m.adverse + ' (' + Math.round(m.recall * 100)
    + '%), protective clauses contradicted ' + m.contradicted + '/' + m.protective
    + ' (' + Math.round(m.contradictionRate * 100) + '%), no category yet for ' + m.uncovered
    + ', misses ' + JSON.stringify(m.missed));
}

test('tos corpus: recall and contradiction rate hold their floors on held-out quotes', () => {
  const tuned = measure((row, i) => i % 2 === 0);
  const heldOut = measure((row, i) => i % 2 === 1);
  report('tuning half', tuned);
  report('held-out half', heldOut);
  assert(heldOut.adverse >= 70 && heldOut.protective >= 15, 'corpus is large enough to mean something');
  assert(heldOut.recall >= RECALL_FLOOR, 'recall fell below ' + RECALL_FLOOR + ': ' + heldOut.recall);
  assert(heldOut.contradictionRate <= CONTRADICTION_CEILING, 'contradiction rate rose above ' + CONTRADICTION_CEILING + ': ' + heldOut.contradictionRate);
});

// Cases the ToS;DR quotes do not exercise: who is acting, and legal idioms.
const HAND_WRITTEN = [
  ['You can update your privacy policy preferences at any time.', null],
  ['You may delete your account at any time from the settings page.', null],
  ['You may terminate this agreement and close your account whenever you wish.', null],
  ['If you change your email address, please update your profile so we can notify you of changes to these terms.', null],
  ['We will notify you by email at least 30 days before we change these terms.', null],
  ['We retain your data only for as long as necessary to provide the service, after which it is deleted.', null],
  ['We share your information with service providers who process it only on our behalf and under contract.', null],
  ['We may sell, rent, or share the information we collect about you with advertisers.', 'data_sale'],
  ['Information collected, including your browsing history, is sold to data brokers.', 'data_sale'],
  ['Your account can be closed by us for any reason or no reason.', 'unilateral_termination'],
  ['We may terminate your account at any time without notice.', 'unilateral_termination'],
  ['You may be tracked across websites by our advertising partners.', 'tracking_surveillance'],
  ['We may use your content to train our machine learning and artificial intelligence models.', 'ai_training'],
  ['You may not use the service to train machine learning models.', null],
  ['Your subscription renews automatically and fees are non-refundable.', 'auto_renewal'],
  ['We combine data from our partners with what we know about you to build a profile for personalised advertising.', 'profiling'],
  ['You agree to indemnify and hold us harmless from any claims arising from your use of the service.', 'indemnification'],
  ['You give us a non-exclusive, transferable, sub-licensable, royalty-free, worldwide license to host and use anything you post.', 'content_license'],
];

test('tos matcher: user actions and protective wording stay quiet, company actions flag', () => {
  T.compileConfig(T.DEFAULT_CONFIG);
  T.getState().settings = T.defaultSettings(T.DEFAULT_CONFIG);
  for (const [text, expected] of HAND_WRITTEN) {
    const flags = Array.from(flaggedCategories(text));
    if (expected === null) assert(flags.length === 0, 'should stay quiet but flagged ' + flags.join(', ') + ': ' + text);
    else assert(flags.includes(expected), 'should flag ' + expected + ' but got [' + flags.join(', ') + ']: ' + text);
  }
});
