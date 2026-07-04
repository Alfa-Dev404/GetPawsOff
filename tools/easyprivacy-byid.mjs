#!/usr/bin/env node
/* PawsOff - rule-id → base-domain index builder (dev tool, offline).
 *
 * Derives { ruleId -> registrable domain } from the bundled easyprivacy.json.
 * Powers the toolbar badge's distinct-tracker count: getMatchedRules only
 * returns a rule id, so dedup across rules that share a tracker needs
 * id -> domain.
 *
 * Only domain-anchored rules ("||domain^" / "||domain/...") get an entry;
 * path/query-pattern rules have no domain and fall back to per-rule counting.
 *
 * Output: src/rules/easyprivacy-byid.json
 *   { d: [unique base domains], byId: [index into d per ruleId, -1 if unmapped] }
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RULES = join(ROOT, 'src', 'rules', 'easyprivacy.json');
const PSL_SRC = join(ROOT, 'src', 'learn', 'psl-lite.js');
const OUT = join(ROOT, 'src', 'rules', 'easyprivacy-byid.json');

// Load the real psl-lite so base-domain grouping matches the extension exactly.
const PSL = new Function('self', readFileSync(PSL_SRC, 'utf8') + '\nreturn self.PawsOffPSL;')({});

// "||host^" / "||host/..." / "||host" - capture the host of a domain-anchored rule.
const DOMAIN_ANCHOR = /^\|\|([a-z0-9][a-z0-9.\-]*\.[a-z]{2,})(?:[\^/:?]|$)/i;

/** PURE: base registrable domain for a domain-anchored urlFilter, else ''. */
export function domainOfUrlFilter(urlFilter) {
  if (typeof urlFilter !== 'string') return '';
  const m = DOMAIN_ANCHOR.exec(urlFilter);
  if (!m) return '';
  const host = m[1].toLowerCase().replace(/\.$/, '');
  return PSL.getBaseDomain(host) || '';
}

function main() {
  const rules = JSON.parse(readFileSync(RULES, 'utf8'));
  const d = [];
  const idx = new Map(); // domain -> index into d
  let maxId = 0;
  for (const r of rules) { if (r && r.id > maxId) maxId = r.id; }
  const byId = new Array(maxId + 1).fill(-1); // byId[ruleId] = index into d, or -1
  let mapped = 0;
  for (const r of rules) {
    const id = r && r.id;
    const base = domainOfUrlFilter(r && r.condition && r.condition.urlFilter);
    if (!id || !base) continue;
    let i = idx.get(base);
    if (i === undefined) { i = d.length; d.push(base); idx.set(base, i); }
    byId[id] = i;
    mapped++;
  }
  writeFileSync(OUT, JSON.stringify({ d, byId }));
  process.stderr.write(
    `easyprivacy-byid.json: ${mapped}/${rules.length} rules mapped to ${d.length} distinct domains\n`
  );
}

if (process.argv[1]) {
  try { const { realpathSync } = await import('node:fs'); if (realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main(); }
  catch (_) { /* imported for tests */ }
}
