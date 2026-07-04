#!/usr/bin/env node
/* PawsOff build tool - extract the base domains the static EasyPrivacy
 * ruleset already blocks, so the prevalence enforcer can dedup against it
 * instead of spending a dynamic-rule slot on something already covered.
 *
 * Input:  src/rules/easyprivacy.json (DNR rule array)
 * Output: src/rules/easyprivacy-domains.json (sorted base-domain array)
 *
 * Run from the extension root: node tools/easyprivacy-domains.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const IN = join(ROOT, 'src/rules/easyprivacy.json');
const OUT = join(ROOT, 'src/rules/easyprivacy-domains.json');

// Load psl-lite (CommonJS-ish IIFE attaching to a root object).
const require = createRequire(import.meta.url);
const pslSrc = readFileSync(join(ROOT, 'src/learn/psl-lite.js'), 'utf8');
const pslRoot = {};
new Function('self', pslSrc)(pslRoot);
const getBaseDomain = pslRoot.PawsOffPSL ? pslRoot.PawsOffPSL.getBaseDomain : (h) => h;

function hostFromUrlFilter(uf) {
  if (typeof uf !== 'string') return '';
  // Only the domain-anchored form is a reliable host signal: ||host^ or ||host/...
  const m = /^\|\|([a-z0-9.\-]+?)(?:\^|\/|$)/i.exec(uf);
  return m ? m[1].toLowerCase() : '';
}

const rules = JSON.parse(readFileSync(IN, 'utf8'));
const domains = new Set();
let anchored = 0, viaRequestDomains = 0;

for (const r of (Array.isArray(rules) ? rules : [])) {
  // Only harvest from BLOCK rules. An @@ allow/exception rule (action.type
  // 'allow') names a host that is NOT blocked - counting it would make the
  // dedupe list wrongly suppress a dynamic block that should still install.
  if (!r || !r.action || r.action.type !== 'block') continue;
  const cond = r.condition || {};
  if (Array.isArray(cond.requestDomains)) {
    for (const h of cond.requestDomains) {
      const b = getBaseDomain(String(h || '').toLowerCase());
      if (b && b.indexOf('.') >= 0) { domains.add(b); viaRequestDomains++; }
    }
  }
  const host = hostFromUrlFilter(cond.urlFilter);
  if (host) {
    const b = getBaseDomain(host);
    if (b && b.indexOf('.') >= 0) { domains.add(b); anchored++; }
  }
}

const out = Array.from(domains).sort();
writeFileSync(OUT, JSON.stringify(out) + '\n');
console.log('[easyprivacy-domains] rules=%d anchored=%d requestDomains=%d -> %d unique base domains',
  Array.isArray(rules) ? rules.length : 0, anchored, viaRequestDomains, out.length);
console.log('wrote', OUT);
