/* Free-extension boundary: the three-feature build must not expose an external
 * website bridge or advertise a website allowlist in its manifest.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { test, eq } = require('./harness/framework');
const { loadBackground } = require('./harness/sandbox');

const ROOT = path.join(__dirname, '..');

test('free build: background registers no external website listener', () => {
  const { chrome } = loadBackground();
  eq(chrome.runtime.onMessageExternal._fns.length, 0, 'no external bridge');
});

test('free build: manifest exposes no externally-connectable website', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  eq(Object.prototype.hasOwnProperty.call(manifest, 'externally_connectable'), false,
    'no externally_connectable declaration');
});

test('free build: popup contains only the three protection features', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'popup', 'popup.html'), 'utf8');
  const labels = Array.from(html.matchAll(/id="feat-[^"]+"[^>]*>[\s\S]*?<span>([^<]+)<\/span>/g), (match) => match[1]);
  eq(labels.join(','), 'Consent,Trackers,Terms');
  eq(/open-dashboard|data-removal|>Removals</i.test(html), false, 'no unrelated product link');
});
