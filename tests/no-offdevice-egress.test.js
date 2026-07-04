/* PawsOff - negative-control: NO off-device telemetry/analytics egress in src/.
 *
 * Enforces the #1 non-negotiable principle (no telemetry / no network-home) by
 * scanning the extension's OWN JavaScript for known analytics/telemetry service
 * tokens and egress endpoints. Fails the build if any appear - so a future
 * "ship counters to <service>" change cannot land silently.
 *
 * Scope: src/ JS only, EXCLUDING src/content/vendor/ (MPL-vendored autoconsent
 * DATA, not our egress code). JSON blocklists (src/rules, src/data) legitimately
 * NAME trackers to block them and are not executable egress, so they're excluded
 * by scanning .js only.
 *
 * NOTE on `segment`: ToS Shield uses "segmentation"/"segmentSentences" heavily, so
 * the Segment analytics service is matched as a domain (segment.com / segment.io /
 * cdn.segment) - never the bare English word.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { test, assert } = require('./harness/framework');

const SRC = path.join(__dirname, '..', 'src');

// Egress patterns. Brand names that don't collide with English are matched
// directly; `segment` is service-scoped to avoid the "segmentation" false match.
const FORBIDDEN = [
  /sentry/i,
  /datadog/i,
  /mixpanel/i,
  /amplitude/i,
  /google-analytics/i,
  /googletagmanager/i,
  /telemetry/i,
  /\/collect\b/i,
  /\bsegment\.(com|io)\b/i,
  /cdn\.segment\b/i,
  // Egress PRIMITIVES - a future off-device path could use a brand we don't list,
  // so forbid the transports themselves. (fetch is intentionally NOT here: it's
  // used for the signed config fetch + local getURL reads. None of these appear
  // in src/ today - keep it that way.)
  /\bsendBeacon\b/,
  /\bWebSocket\b/,
  /\bXMLHttpRequest\b/,
  /\bEventSource\b/,
];

function jsFiles(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      if (name === 'vendor') continue; // MPL-vendored DATA, not our egress code
      out.push(...jsFiles(full));
    } else if (name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

test('no off-device telemetry/analytics egress token appears in src/ JS', () => {
  const files = jsFiles(SRC);
  assert(files.length > 0, 'found source files to scan');
  const hits = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const re of FORBIDDEN) {
        if (re.test(lines[i])) {
          hits.push(`${path.relative(SRC, f)}:${i + 1}  ${re}  →  ${lines[i].trim().slice(0, 80)}`);
        }
      }
    }
  }
  assert(hits.length === 0, 'off-device egress tokens found:\n  ' + hits.join('\n  '));
});
