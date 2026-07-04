/* PawsOff - manifest content-script injection surface (perf root-cause guard).
 *
 * PERF root cause: the broad consent content script (http(s)://*\/*) ran in
 * EVERY frame, including empty about:blank ad iframes, paying ~234KB parse +
 * a MutationObserver per frame before first paint => tab freeze / slow restore.
 *
 * Change 1: drop match_about_blank from the broad rule. Change 3: split the broad
 * rule into a lightweight prehide script at document_start and the heavy engine
 * bundle at document_idle. We keep all_frames:true on both (real cross-origin CMP
 * iframes need it; the prehide watchdog protects gated sub-frames) and leave the
 * targeted CMP-host block's match_origin_as_fallback untouched. This test pins the
 * full split contract so a future edit can't silently re-broaden or re-merge it.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { test, assert } = require('./harness/framework.js');

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8')
);

const CONSENT_JS = 'src/content/consent-ghost.js';
const PREHIDE_JS = 'src/content/consent-prehide.js';
const scripts = manifest.content_scripts || [];

function isBroadHttp(matches) {
  return Array.isArray(matches)
    && matches.includes('http://*/*')
    && matches.includes('https://*/*');
}

// The broad ENGINE entry is the http(s) one carrying the heavy consent-ghost
// bundle; post-split it runs at document_idle.
const broadConsent = scripts.find(
  (e) => isBroadHttp(e.matches) && Array.isArray(e.js) && e.js.includes(CONSENT_JS)
);

// The broad PREHIDE entry is the lightweight http(s) one carrying only
// consent-prehide.js at document_start.
const broadPrehide = scripts.find(
  (e) => isBroadHttp(e.matches) && Array.isArray(e.js) && e.js.includes(PREHIDE_JS)
);

const targetedCmp = scripts.find(
  (e) => !isBroadHttp(e.matches)
    && Array.isArray(e.js) && e.js.includes(CONSENT_JS)
);

test('manifest: broad consent script exists and no longer matches about:blank', () => {
  assert(broadConsent, 'broad http(s) consent content-script entry is present');
  assert(
    broadConsent.match_about_blank !== true,
    'broad consent rule must NOT set match_about_blank:true (perf: empty ad iframes)'
  );
});

test('manifest: engine bundle entry - document_idle + all_frames, no about:blank', () => {
  assert(broadConsent.run_at === 'document_idle', 'engine bundle runs at document_idle (Change 3)');
  assert(broadConsent.all_frames === true, 'engine keeps all_frames:true (cross-origin CMP iframes)');
  assert(broadConsent.match_about_blank !== true, 'engine rule must NOT match about:blank');
});

test('manifest: prehide entry - document_start + all_frames, no about:blank, no engine', () => {
  assert(broadPrehide, 'broad consent-prehide.js entry is present');
  assert(broadPrehide.run_at === 'document_start', 'prehide runs at document_start (pre-paint)');
  assert(broadPrehide.all_frames === true, 'prehide runs in all frames (watchdog protects sub-frames)');
  assert(broadPrehide.match_about_blank !== true, 'prehide rule must NOT match about:blank');
  assert(!broadPrehide.js.includes(CONSENT_JS),
    'heavy engine must NOT be in the document_start prehide entry');
});

test('manifest: background service worker points at the real path', () => {
  // The real path is src/background/background.js (NOT src/background.js). Pin it
  // so a doc/refactor drift can't ship a manifest that points at a missing SW.
  assert(manifest.background, 'manifest declares a background entry');
  assert(
    manifest.background.service_worker === 'src/background/background.js',
    'service_worker must be src/background/background.js'
  );
});

test('manifest: targeted CMP-host block keeps match_origin_as_fallback', () => {
  assert(targetedCmp, 'targeted CMP-host consent block is present');
  assert(
    targetedCmp.match_origin_as_fallback === true,
    'targeted CMP block keeps match_origin_as_fallback:true'
  );
});
