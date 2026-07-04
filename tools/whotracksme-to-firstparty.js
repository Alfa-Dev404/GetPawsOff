'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// whotracksme-to-firstparty.js
//
// CLEAN-ROOM converter. Reads whotracks.me / Ghostery trackerdb data (MIT -
// permissive) and emits a prevalence-learner seed:
//   { schemaVersion:1, configVersion, source, attribution,
//     firstPartySets:[[...]], yellowlist:[...] }
//
// The learner already says "extend later via signed remote config" for both its
// FIRST_PARTY_SETS (same-owner domains are never third-party to each other) and
// its BUNDLED_YELLOWLIST (function-critical domains -> cookieblock, not block).
// This produces exactly those two structures from community data.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

// Categories a site usually NEEDS to function -> COOKIEBLOCK rather than BLOCK.
const YELLOW_CATEGORIES = new Set([
  'cdn', 'hosting', 'essential', 'audio_video_player', 'comments', 'customer_interaction',
]);

const MAX_SETS = 2000;
const MAX_SET_SIZE = 40;
const MAX_YELLOW = 4000;

function normDomain(d) {
  if (typeof d !== 'string') return null;
  const s = d.trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  return s || null;
}

function toList(x) {
  if (Array.isArray(x)) return x;
  if (x && typeof x === 'object') {
    // keyed map {id: obj} -> [{id, ...obj}]
    return Object.entries(x).map(([id, v]) => (v && typeof v === 'object' ? Object.assign({ id }, v) : { id, value: v }));
  }
  return [];
}

// Build {companyId: Set(domains)} and the yellow-domain set.
function buildIndex(trackers, companies) {
  const byCompany = new Map();
  const yellow = new Set();

  for (const t of toList(trackers)) {
    if (!t || typeof t !== 'object') continue;
    const cid = t.company_id != null ? String(t.company_id)
      : (t.company != null ? String(t.company) : null);
    const domains = []
      .concat(Array.isArray(t.domains) ? t.domains : [])
      .concat(typeof t.domain === 'string' ? [t.domain] : []);
    const cat = typeof t.category === 'string' ? t.category.toLowerCase() : '';
    for (const raw of domains) {
      const d = normDomain(raw);
      if (!d) continue;
      if (cid) {
        if (!byCompany.has(cid)) byCompany.set(cid, new Set());
        byCompany.get(cid).add(d);
      }
      if (YELLOW_CATEGORIES.has(cat)) yellow.add(d);
    }
  }

  for (const c of toList(companies)) {
    if (!c || typeof c !== 'object') continue;
    const cid = c.id != null ? String(c.id) : null;
    if (!cid) continue;
    const domains = []
      .concat(Array.isArray(c.domains) ? c.domains : [])
      .concat(typeof c.website_url === 'string' ? [c.website_url] : []);
    for (const raw of domains) {
      const d = normDomain(raw);
      if (!d) continue;
      if (!byCompany.has(cid)) byCompany.set(cid, new Set());
      byCompany.get(cid).add(d);
    }
  }

  return { byCompany, yellow };
}

function convert(input, opts = {}) {
  const trackers = input && (input.trackers || input.trackerList || (Array.isArray(input) ? input : null));
  const companies = input && input.companies;
  const { byCompany, yellow } = buildIndex(trackers, companies);

  const firstPartySets = [];
  for (const set of byCompany.values()) {
    if (set.size < 2) continue; // a meaningful set needs >=2 domains
    firstPartySets.push(Array.from(set).sort().slice(0, MAX_SET_SIZE));
    if (firstPartySets.length >= MAX_SETS) break;
  }
  const yellowlist = Array.from(yellow).sort().slice(0, MAX_YELLOW);

  const config = {
    schemaVersion: 1,
    configVersion: opts.configVersion || new Date().toISOString().slice(0, 10),
    source: 'whotracksme',
    attribution: 'Derived from whotracks.me / Ghostery trackerdb (MIT)',
    firstPartySets,
    yellowlist,
  };
  return { config, stats: { companies: byCompany.size, sets: firstPartySets.length, yellow: yellowlist.length } };
}

module.exports = { buildIndex, convert, normDomain, toList, YELLOW_CATEGORIES };

if (require.main === module) {
  const args = process.argv.slice(2);
  const outFile = args[0];
  const trackersFile = args[1];
  const companiesFile = args[2];
  if (!outFile || !trackersFile) {
    console.error('usage: node whotracksme-to-firstparty.js <out.json> <trackers.json|combined.json> [companies.json]');
    process.exit(2);
  }
  const first = JSON.parse(fs.readFileSync(trackersFile, 'utf8'));
  let input;
  if (first && (first.trackers || first.companies)) {
    input = first; // combined file
  } else {
    input = { trackers: first, companies: companiesFile ? JSON.parse(fs.readFileSync(companiesFile, 'utf8')) : null };
  }
  const { config, stats } = convert(input);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(config, null, 2));
  console.log('whotracksme ->', outFile, JSON.stringify(stats));
}
