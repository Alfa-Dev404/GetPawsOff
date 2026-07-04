'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// tosdr-to-grades.js
//
// CLEAN-ROOM converter. Reads a ToS;DR (Terms of Service; Didn't Read) service
// export and emits a per-domain reputation dataset:
//   { schemaVersion:1, configVersion, source, attribution,
//     services:{ host:{ name, grade, flagged:[{title, topic, severity}] } } }
//
// ToS;DR content is CC-BY-SA. That obligation (attribution + share-alike) applies
// to THIS generated DATA FILE only - it is data fetched at runtime, not linked
// into the product's source code, so it does not affect PawsOff's own licence.
// The `attribution` field is embedded so the obligation travels with the data.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const BAD = new Set(['bad', 'blocker']); // the classifications worth surfacing

function stripHost(h) {
  if (typeof h !== 'string') return null;
  let s = h.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  return s || null;
}

function pointClassification(p) {
  if (!p || typeof p !== 'object') return null;
  if (p.case && typeof p.case.classification === 'string') return p.case.classification.toLowerCase();
  if (typeof p.classification === 'string') return p.classification.toLowerCase();
  return null;
}

function pointTitle(p) {
  if (p && p.case && typeof p.case.title === 'string') return p.case.title;
  if (p && typeof p.title === 'string') return p.title;
  return '';
}

function pointTopic(p) {
  if (!p) return '';
  if (p.topic && typeof p.topic === 'object' && typeof p.topic.name === 'string') return p.topic.name;
  if (typeof p.topic === 'string') return p.topic;
  return '';
}

function serviceGrade(svc) {
  if (svc && svc.rating && typeof svc.rating.letter === 'string') return svc.rating.letter.toUpperCase();
  if (typeof svc.rating === 'string') return svc.rating.toUpperCase();
  if (typeof svc.grade === 'string') return svc.grade.toUpperCase();
  return null;
}

function serviceHosts(svc) {
  const cands = []
    .concat(Array.isArray(svc.urls) ? svc.urls : [])
    .concat(Array.isArray(svc.domains) ? svc.domains : [])
    .concat(typeof svc.url === 'string' ? [svc.url] : []);
  const out = [];
  for (const c of cands) {
    const h = stripHost(typeof c === 'string' ? c : (c && (c.url || c.name)));
    if (h) out.push(h);
  }
  return Array.from(new Set(out));
}

function parseService(svc) {
  if (!svc || typeof svc !== 'object') return null;
  const hosts = serviceHosts(svc);
  if (!hosts.length) return null;
  const flagged = [];
  const points = Array.isArray(svc.points) ? svc.points : [];
  for (const p of points) {
    const cls = pointClassification(p);
    if (!cls || !BAD.has(cls)) continue;
    flagged.push({
      title: pointTitle(p).slice(0, 140),
      topic: pointTopic(p).slice(0, 60),
      severity: cls === 'blocker' ? 'high' : 'med',
    });
  }
  return {
    hosts,
    entry: {
      name: typeof svc.name === 'string' ? svc.name : hosts[0],
      grade: serviceGrade(svc),
      flagged,
    },
  };
}

function convert(services, opts = {}) {
  const arr = Array.isArray(services)
    ? services
    : (services && Array.isArray(services.services) ? services.services : []);
  const out = {};
  let hosts = 0, skipped = 0, flagged = 0;
  for (const svc of arr) {
    const parsed = parseService(svc);
    if (!parsed) { skipped++; continue; }
    for (const h of parsed.hosts) {
      out[h] = parsed.entry;
      hosts++;
      flagged += parsed.entry.flagged.length;
    }
  }
  const config = {
    schemaVersion: 1,
    configVersion: opts.configVersion || new Date().toISOString().slice(0, 10),
    source: 'tosdr',
    attribution: 'Data from ToS;DR (tosdr.org), licensed CC-BY-SA',
    services: out,
  };
  return { config, stats: { services: arr.length, hosts, skipped, flagged } };
}

// Resolve a host to its entry: exact match, then progressively-broader base
// domains (app.foo.com -> foo.com).
function lookupGrade(host, config) {
  if (!config || !config.services || typeof host !== 'string') return null;
  const h = stripHost(host);
  if (!h) return null;
  if (config.services[h]) return config.services[h];
  const parts = h.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const cand = parts.slice(i).join('.');
    if (config.services[cand]) return config.services[cand];
  }
  return null;
}

module.exports = { parseService, convert, lookupGrade, stripHost, pointClassification };

if (require.main === module) {
  const args = process.argv.slice(2);
  const outFile = args[0];
  const inFile = args[1];
  if (!outFile || !inFile) {
    console.error('usage: node tosdr-to-grades.js <out.json> <services.json>');
    process.exit(2);
  }
  const parsed = JSON.parse(fs.readFileSync(inFile, 'utf8'));
  const { config, stats } = convert(parsed);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(config, null, 2));
  console.log('tosdr ->', outFile, JSON.stringify(stats));
}
