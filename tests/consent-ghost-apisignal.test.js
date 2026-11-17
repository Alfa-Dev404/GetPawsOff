/* PawsOff, when a MAIN-world CMP API signal may be recorded as a rejected banner. */
'use strict';

const { test, eq } = require('./harness/framework');
const { loadConsentGhost } = require('./harness/sandbox');

const { internals } = loadConsentGhost({ noBody: true });
const doc = (found) => ({ querySelector: (sel) => (found && sel === '#onetrust-banner-sdk' ? {} : null) });
const box = (width, height) => ({ getBoundingClientRect: () => ({ width, height }) });

test('a banner hidden by prehide still has a box; an empty wrapper does not', () => {
  eq(internals.hasBox(box(500, 300)), true);
  eq(internals.hasBox(box(1366, 0)), false);
  eq(internals.hasBox({ getBoundingClientRect() { throw new Error('detached'); } }), false);
});

test('API signal is proven by a laid-out banner or a hidden OneTrust banner element', () => {
  eq(internals.cmpSignalProven('Cookiebot', 1, doc(false)), true, 'banner was laid out');
  eq(internals.cmpSignalProven('OneTrust', 0, doc(true)), true, 'pre-empted OneTrust banner');
  eq(internals.cmpSignalProven('OneTrust', 0, doc(false)), false, 'OneTrust page with no banner');
  eq(internals.cmpSignalProven('Cookiebot', 0, doc(true)), false, 'only OneTrust has this evidence');
});
