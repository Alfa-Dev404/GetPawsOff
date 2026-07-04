/* PawsOff - pay-or-consent WALL classifier (contentpass / focus.de).
 *
 * focus.de runs contentpass: a pay-OR-consent wall where the only non-accept
 * choice is a paid subscription. There is NO free reject, so clicking a
 * reject-looking control just re-injects the banner (the loop). Correct
 * behaviour is to STAND DOWN and label it a wall, never click.
 *
 * surfaceLooksLikeWall(text, labels) is the pure verdict the heuristic and
 * ConsentFrame paths consult before clicking. Two signals make a wall:
 *   1. a high-confidence vendor marker in the surface text ("contentpass"), or
 *   2. an accept/subscribe control with NO free reject among the buttons.
 */
'use strict';

const { test, assert, eq } = require('./harness/framework.js');
const { loadConsentGhost } = require('./harness/sandbox.js');

const { internals } = loadConsentGhost();
const wall = internals.surfaceLooksLikeWall;

test('wall: contentpass brand marker in text is a wall even with a reject-looking button', () => {
  // contentpass walls sometimes show an "Ablehnen"-style control that is NOT a
  // free reject (it routes to subscribe). The brand signature must win.
  const text = 'Mit Ihrer Zustimmung oder einem contentpass Pur-Abo lesen Sie werbefrei.';
  eq(wall(text, ['Akzeptieren', 'Ablehnen']), true, 'contentpass text → wall');
});

test('wall: pur-abo marker (no "contentpass" word) still classifies as a wall', () => {
  eq(wall('Jetzt mit PUR-Abo werbefrei nutzen', ['Akzeptieren']), true, 'pur-abo → wall');
});

test('wall: accept + subscribe but no free reject is a wall', () => {
  eq(wall('We use cookies to fund journalism.', ['Accept all', 'Subscribe']), true,
    'accept/subscribe without a free reject → wall');
});

test('wall: a genuine CMP with a real Reject control is NOT a wall', () => {
  eq(wall('We value your privacy. Manage your cookie choices.', ['Accept all', 'Reject all']), false,
    'a free reject exists → not a wall');
});

test('wall: "Refuser et s\'abonner" (subscribe-dominant) with no free reject is a wall', () => {
  // Le Figaro style: the "reject" label is subscribe-dominant, so classifyLabel
  // treats it as 'none' (not a free reject) → wall.
  eq(wall('Abonnez-vous pour refuser la publicite.', ["Tout accepter", "Refuser et s'abonner"]), true,
    'subscribe-dominant pseudo-reject → wall');
});

test('wall: empty / unrelated surface is not a wall', () => {
  eq(wall('', []), false, 'empty → not a wall');
  eq(wall('Newsletter signup', ['Submit']), false, 'unrelated buttons → not a wall');
});

test('wall: degrades safely on bad input (never throws)', () => {
  let threw = false;
  try {
    eq(wall(null, null), false, 'null input → false');
    eq(wall(undefined, undefined), false, 'undefined input → false');
    eq(wall(123, {}), false, 'wrong types → false');
  } catch (_) { threw = true; }
  assert(!threw, 'classifier must never throw');
});
