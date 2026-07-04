/* PawsOff - icon-only / aria-labelled consent buttons.
 *
 * heuristicLabel and btnText fold aria-label/title/alt into the label surface
 * so icon-only buttons are classified, but still go through the same
 * classifyLabel → looksAccept veto + subscribe-wall guard as every other
 * label - no separate click path. Asserts: aria/title/alt "accept" is vetoed,
 * "reject" is accepted, and a subscribe label stays untouchable either way.
 */
'use strict';

const { test, assert, eq } = require('./harness/framework');
const { loadConsentGhost } = require('./harness/sandbox');

const I = loadConsentGhost().internals;

// Icon-only element: no visible text, only the given attributes.
function iconEl(attrs) {
  return {
    innerText: '',
    textContent: '',
    getAttribute(a) { return Object.prototype.hasOwnProperty.call(attrs, a) ? attrs[a] : null; },
  };
}

test('aria-label="Reject all" icon button → classified reject', () => {
  const el = iconEl({ 'aria-label': 'Reject all' });
  eq(I.heuristicLabel(el), 'reject all', 'aria-label folds into the label');
  eq(I.looksReject(I.heuristicLabel(el)), true, 'classified reject');
  eq(I.looksAccept(I.heuristicLabel(el)), false);
});

test('aria-label="Accept all" icon button → vetoed (NOT clickable as reject)', () => {
  const el = iconEl({ 'aria-label': 'Accept all' });
  eq(I.looksAccept(I.heuristicLabel(el)), true, 'accept veto fires on the aria surface');
  eq(I.looksReject(I.heuristicLabel(el)), false, 'never classified reject → heuristic skips it');
  // Named-selector path veto (btnText → isAcceptLabel) must also veto it.
  eq(I.isAcceptLabel(el), true, 'named-path accept-veto sees aria-label');
});

test('alt="..." (the new attribute) is classified for both reject and accept', () => {
  eq(I.looksReject(I.heuristicLabel(iconEl({ alt: 'Reject all' }))), true, 'alt reject → reject');
  eq(I.looksAccept(I.heuristicLabel(iconEl({ alt: 'Accept all' }))), true, 'alt accept → veto');
});

test('title="..." is classified, incl. the named-path veto', () => {
  eq(I.looksAccept(I.heuristicLabel(iconEl({ title: 'Accept all cookies' }))), true);
  eq(I.isAcceptLabel(iconEl({ title: 'Accept all cookies' })), true, 'btnText reads title');
  eq(I.looksReject(I.heuristicLabel(iconEl({ title: 'Reject all' }))), true);
});

test('subscribe/wall guard STILL applies to the aria surface (no bypass)', () => {
  const el = iconEl({ 'aria-label': 'Subscribe' });
  eq(I.looksReject(I.heuristicLabel(el)), false, 'subscribe-dominant → not a reject (untouchable)');
  eq(I.looksAccept(I.heuristicLabel(el)), false, 'and not an accept → never clicked');
});

test('empty icon button (no text, no labels) → no classification (safe)', () => {
  const el = iconEl({});
  eq(I.heuristicLabel(el), '');
  eq(I.looksReject(''), false);
  eq(I.looksAccept(''), false);
});
