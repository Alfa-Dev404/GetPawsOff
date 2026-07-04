'use strict';
// autoconsent-to-consent-rules.js
//
// Clean-room converter: reads DuckDuckGo `autoconsent` rule JSON (Apache-2.0)
// and emits ConsentGhost's signed-config shape:
//   { schemaVersion:1, configVersion, source, frameworks:[ {name,
//     containerSelector, rejectSelectors, pierceShadow, enabled} ] }
//
// Output is declarative selectors only (container + reject-click), never an
// action `steps` engine - remote DATA describes what to reject, local
// reviewed code does the clicking, gated by the accept-veto.

const fs = require('fs');
const path = require('path');

const SHADOW = />>>/; // autoconsent shadow-piercing combinator

function splitSelectors(sel) {
  if (typeof sel !== 'string') return [];
  return sel.split(',').map((s) => s.trim()).filter(Boolean);
}

function uniq(arr) { return Array.from(new Set(arr)); }

// Collect click-type selectors from an optOut step list, recursing into
// then/else branches. Only `click`/`waitForThenClick` count as reject
// controls; worst case a non-final "open settings" click grants no consent.
function collectClickSelectors(steps, out) {
  if (!Array.isArray(steps)) return out;
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    if (typeof step.click === 'string') for (const s of splitSelectors(step.click)) out.push(s);
    if (typeof step.waitForThenClick === 'string') for (const s of splitSelectors(step.waitForThenClick)) out.push(s);
    if (Array.isArray(step.then)) collectClickSelectors(step.then, out);
    if (Array.isArray(step.else)) collectClickSelectors(step.else, out);
  }
  return out;
}

// Container indicators come from detectPopup (preferred - it is the visible
// banner) then detectCmp (presence of the CMP at all).
function collectDetectorSelectors(rule) {
  const out = [];
  const pull = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const d of arr) {
      if (!d || typeof d !== 'object') continue;
      if (typeof d.visible === 'string') for (const s of splitSelectors(d.visible)) out.push(s);
      else if (typeof d.exists === 'string') for (const s of splitSelectors(d.exists)) out.push(s);
    }
  };
  pull(rule.detectPopup);
  pull(rule.detectCmp);
  return out;
}

function parseRule(rule) {
  if (!rule || typeof rule !== 'object' || typeof rule.name !== 'string') return null;
  const detectors = uniq(collectDetectorSelectors(rule));
  const rejects = uniq(collectClickSelectors(rule.optOut, []));
  if (!detectors.length || !rejects.length) return null; // unusable without both
  const pierceShadow = detectors.concat(rejects).some((s) => SHADOW.test(s));
  return {
    name: rule.name,
    containerSelector: detectors.join(', '),
    rejectSelectors: rejects,
    pierceShadow,
    enabled: true,
  };
}

// Accept: array of rules | { autoconsent:[...] } | a single rule object.
function normalizeRules(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.autoconsent)) return parsed.autoconsent;
  if (parsed && typeof parsed === 'object' && (parsed.detectCmp || parsed.optOut)) return [parsed];
  return [];
}

function convert(rules, opts = {}) {
  const arr = normalizeRules(rules);
  const frameworks = [];
  const seen = new Set();
  let skipped = 0;
  for (const r of arr) {
    const entry = parseRule(r);
    if (!entry) { skipped++; continue; }
    const key = entry.name.toLowerCase();
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key);
    frameworks.push(entry);
  }
  const config = {
    schemaVersion: 1,
    configVersion: opts.configVersion || new Date().toISOString().slice(0, 10),
    source: 'autoconsent',
    frameworks,
  };
  return { config, stats: { total: arr.length, emitted: frameworks.length, skipped } };
}

module.exports = {
  parseRule, convert, splitSelectors, collectClickSelectors,
  collectDetectorSelectors, normalizeRules,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const outFile = args[0];
  const inputs = args.slice(1);
  if (!outFile || !inputs.length) {
    console.error('usage: node autoconsent-to-consent-rules.js <out.json> <input.json|dir...>');
    process.exit(2);
  }
  let rules = [];
  for (const f of inputs) {
    const stat = fs.statSync(f);
    const files = stat.isDirectory()
      ? fs.readdirSync(f).filter((n) => n.endsWith('.json')).map((n) => path.join(f, n))
      : [f];
    for (const file of files) {
      rules = rules.concat(normalizeRules(JSON.parse(fs.readFileSync(file, 'utf8'))));
    }
  }
  const { config, stats } = convert(rules);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(config, null, 2));
  console.log('autoconsent ->', outFile, JSON.stringify(stats));
}
