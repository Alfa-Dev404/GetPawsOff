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
// to THIS generated DATA FILE only — it is data fetched at runtime, not linked
// into the product's source code, so it does not affect PawsOff's own licence.
// The `attribution` field is embedded so the obligation travels with the data.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const PSL = require('../src/learn/psl-lite.js').PawsOffPSL;

const BAD = new Set(['bad', 'blocker']); // the classifications worth surfacing
const MAX_SERVICES = 20000;
const MAX_HOSTS_PER_SERVICE = 20;
const MAX_POINTS_PER_SERVICE = 200;
const MAX_FLAGGED_PER_SERVICE = 20;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_RELEASE_HOSTS = 50000;

function parsedHostname(input) {
  try {
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
    return new URL(url).hostname;
  } catch (_) {
    return null;
  }
}

function validHostLabel(label) {
  const checks = [
    label.length > 0,
    label.length <= 63,
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
  ];
  return checks.every(Boolean);
}

function validHost(host) {
  const checks = [host.length >= 4, host.length <= 253, host.indexOf('.') >= 1];
  return checks.every(Boolean) && host.split('.').every(validHostLabel);
}

function stripHost(h) {
  if (typeof h !== 'string') return null;
  const input = h.trim();
  if (!input) return null;
  const parsed = parsedHostname(input);
  if (!parsed) return null;
  const host = parsed.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  return validHost(host) ? host : null;
}

function pointCase(point) {
  return point && typeof point.case === 'object' ? point.case : null;
}

function stringField(object, field) {
  if (!object) return null;
  return typeof object[field] === 'string' ? object[field] : null;
}

function firstString(values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function pointClassification(p) {
  if (!p) return null;
  const value = firstString([
    stringField(pointCase(p), 'classification'),
    stringField(p, 'classification'),
  ]);
  return value ? value.toLowerCase() : null;
}

function pointTitle(p) {
  return firstString([stringField(pointCase(p), 'title'), stringField(p, 'title')]) || '';
}

function pointTopic(p) {
  if (!p) return '';
  const topicObject = typeof p.topic === 'object' ? p.topic : null;
  return firstString([stringField(topicObject, 'name'), stringField(p, 'topic')]) || '';
}

function serviceGradeValue(svc) {
  if (!svc) return null;
  const ratingObject = typeof svc.rating === 'object' ? svc.rating : null;
  return firstString([
    stringField(ratingObject, 'letter'),
    stringField(svc, 'rating'),
    stringField(svc, 'grade'),
  ]);
}

function serviceGrade(svc) {
  const value = serviceGradeValue(svc);
  const grade = typeof value === 'string' ? value.toUpperCase() : null;
  return grade && /^[A-E]$/.test(grade) ? grade : null;
}

function serviceHostCandidates(svc) {
  const urls = Array.isArray(svc.urls) ? svc.urls : [];
  const domains = Array.isArray(svc.domains) ? svc.domains : [];
  const single = typeof svc.url === 'string' ? [svc.url] : [];
  return urls.concat(domains, single);
}

function hostCandidateValue(candidate) {
  if (typeof candidate === 'string') return candidate;
  if (!candidate) return null;
  return candidate.url || candidate.name || null;
}

function serviceHosts(svc) {
  const cands = serviceHostCandidates(svc);
  const hosts = Array.from(new Set(cands.map(hostCandidateValue).map(stripHost).filter(Boolean)));
  // Cap is here to bound artifact size, so truncate instead of throwing. One
  // oversized upstream service should not take the whole feed down with it.
  return hosts.slice(0, MAX_HOSTS_PER_SERVICE);
}

function flaggedPoint(point) {
  const classification = pointClassification(point);
  if (!BAD.has(classification)) return null;
  const title = pointTitle(point);
  if (!title) return null;
  return {
    title: title.slice(0, 140),
    topic: pointTopic(point).slice(0, 60),
    severity: classification === 'blocker' ? 'high' : 'med',
  };
}

function serviceFlaggedPoints(svc) {
  const points = Array.isArray(svc.points) ? svc.points : [];
  if (points.length > MAX_POINTS_PER_SERVICE) throw new Error('ToS;DR service exceeds its point cap');
  return points.map(flaggedPoint).filter(Boolean).sort(compareFlagged).slice(0, MAX_FLAGGED_PER_SERVICE);
}

function parseService(svc) {
  if (!svc || typeof svc !== 'object') return null;
  const hosts = serviceHosts(svc);
  if (!hosts.length) return null;
  const flagged = serviceFlaggedPoints(svc);
  const name = firstString([stringField(svc, 'name')]) || hosts[0];
  return {
    hosts,
    entry: {
      name: name.slice(0, 160),
      grade: serviceGrade(svc),
      flagged,
    },
  };
}

function entryQuality(entry) {
  if (!entry) return -1;
  const knownGrade = typeof entry.grade === 'string' && /^[A-E]$/.test(entry.grade) ? 1 : 0;
  return (entry.flagged.length * 10) + knownGrade;
}

function flaggedKey(point) {
  return [point.severity, point.title.trim().toLowerCase(), point.topic.trim().toLowerCase()].join('\0');
}

function compareFlagged(left, right) {
  if (left.severity !== right.severity) return left.severity === 'high' ? -1 : 1;
  return compareText(left.title, right.title) || compareText(left.topic, right.topic);
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function mergeFlagged(preferred, fallback) {
  const unique = new Map();
  for (const point of preferred.concat(fallback)) {
    const key = flaggedKey(point);
    if (!unique.has(key)) unique.set(key, point);
  }
  return Array.from(unique.values()).sort(compareFlagged).slice(0, MAX_FLAGGED_PER_SERVICE);
}

function mergeEntries(current, candidate) {
  if (!current) return candidate;
  const qualityDifference = entryQuality(candidate) - entryQuality(current);
  const candidateFirst = qualityDifference > 0 ||
    (qualityDifference === 0 && compareText(entryTieKey(candidate), entryTieKey(current)) < 0);
  const preferred = candidateFirst ? candidate : current;
  const fallback = preferred === candidate ? current : candidate;
  return {
    name: preferred.name,
    grade: preferred.grade || fallback.grade || null,
    flagged: mergeFlagged(preferred.flagged, fallback.flagged),
  };
}

function entryTieKey(entry) {
  return [entry.name, entry.grade || '', JSON.stringify(entry.flagged)].join('\0');
}

function serviceArray(services) {
  if (Array.isArray(services)) return services;
  if (!services) return [];
  return Array.isArray(services.services) ? services.services : [];
}

function mergeService(output, parsed) {
  for (const host of parsed.hosts) output[host] = mergeEntries(output[host], parsed.entry);
}

function convertServices(services) {
  const output = {};
  let skipped = 0;
  for (const service of services) {
    const parsed = parseService(service);
    if (!parsed) skipped += 1;
    else mergeService(output, parsed);
  }
  const sorted = {};
  for (const host of Object.keys(output).sort()) sorted[host] = output[host];
  return { output: sorted, skipped };
}

function outputByteLimit(opts) {
  const requested = Number.isSafeInteger(opts.maxOutputBytes) && opts.maxOutputBytes > 0
    ? opts.maxOutputBytes : MAX_OUTPUT_BYTES;
  return Math.min(requested, MAX_OUTPUT_BYTES);
}

function requiredConfigVersion(opts) {
  const value = opts && opts.configVersion;
  if (typeof value !== 'string' || !/^\d{14}$/.test(value)) {
    throw new TypeError('configVersion is required and must be deterministic');
  }
  return value;
}

function convert(services, opts = {}) {
  const configVersion = requiredConfigVersion(opts);
  const arr = serviceArray(services);
  if (arr.length > MAX_SERVICES) throw new Error('ToS;DR input exceeds its service cap');
  const converted = convertServices(arr);
  const out = converted.output;
  const entries = Object.values(out);
  const hosts = entries.length;
  if (hosts > MAX_RELEASE_HOSTS) throw new Error('ToS;DR output exceeds its release host cap');
  const flagged = entries.reduce((sum, entry) => sum + entry.flagged.length, 0);
  const config = {
    schemaVersion: 1,
    configVersion,
    source: 'tosdr',
    sourceUrl: 'https://tosdr.org/',
    sourceLicense: 'CC-BY-SA-3.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/',
    attribution: 'Data from ToS;DR (tosdr.org), licensed CC-BY-SA-3.0.',
    modifications: 'Mapped service URLs to hostnames, normalized letter grades, and retained only bad/blocker point summaries when available.',
    services: out,
  };
  if (Buffer.byteLength(JSON.stringify(config, null, 2)) > outputByteLimit(opts)) {
    throw new Error('ToS;DR output exceeds its serialized byte cap');
  }
  return { config, stats: { services: arr.length, hosts, skipped: converted.skipped, flagged } };
}

// Resolve a host to its entry: exact match, then progressively-broader base
// domains (app.foo.com -> foo.com).
function broaderGrade(host, services) {
  const base = PSL.getBaseDomain(host);
  if (!base || base === host) return null;
  let candidate = host;
  while (candidate !== base) {
    candidate = candidate.slice(candidate.indexOf('.') + 1);
    if (services[candidate]) return services[candidate];
  }
  return null;
}

function lookupGrade(host, config) {
  const services = config && config.services;
  if (!services) return null;
  if (typeof host !== 'string') return null;
  const normalized = stripHost(host);
  if (!normalized) return null;
  return services[normalized] || broaderGrade(normalized, services);
}

module.exports = {
  MAX_FLAGGED_PER_SERVICE,
  MAX_HOSTS_PER_SERVICE,
  MAX_OUTPUT_BYTES,
  MAX_POINTS_PER_SERVICE,
  MAX_RELEASE_HOSTS,
  MAX_SERVICES,
  parseService,
  convert,
  compareText,
  entryQuality,
  firstString,
  lookupGrade,
  mergeFlagged,
  mergeEntries,
  pointClassification,
  requiredConfigVersion,
  stripHost,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const outFile = args[0];
  const inFile = args[1];
  if (!outFile || !inFile) {
    console.error('usage: node tosdr-to-grades.js <out.json> <services.json>');
    process.exit(2);
  }
  const parsed = JSON.parse(fs.readFileSync(inFile, 'utf8'));
  const { config, stats } = convert(parsed, { configVersion: process.env.PAWSOFF_CONFIG_VERSION });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(config, null, 2));
  console.log('tosdr ->', outFile, JSON.stringify(stats));
}
