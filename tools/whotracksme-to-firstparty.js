'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// whotracksme-to-firstparty.js
//
// CLEAN-ROOM converter. Reads a caller-supplied tracker/company catalog and
// emits a prevalence-learner seed:
//   { schemaVersion:1, configVersion, source, attribution,
//     firstPartySets:[[...]], yellowlist:[...] }
//
// IMPORTANT: this converter does not grant or infer a licence for its input.
// Ghostery TrackerDB and DuckDuckGo Tracker Radar are non-commercial datasets
// as of 2026 and must not be used for a commercial release without separate
// permission. The caller owns source and redistribution-rights validation.
//
// The learner already says "extend later via signed remote config" for both its
// FIRST_PARTY_SETS (same-owner domains are never third-party to each other) and
// its BUNDLED_YELLOWLIST (function-critical domains -> cookieblock, not block).
// This produces exactly those two structures from community data.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const { isIP } = require('node:net');
const path = require('path');

// Categories a site usually NEEDS to function -> COOKIEBLOCK rather than BLOCK.
const YELLOW_CATEGORIES = new Set([
  'cdn', 'hosting', 'essential', 'audio_video_player', 'comments', 'customer_interaction',
]);

const MAX_SETS = 2000;
const MAX_SET_SIZE = 40;
const MAX_YELLOW = 4000;
const MAX_TRACKERS = 50000;
const MAX_COMPANIES = 20000;
const MAX_DOMAINS_PER_ITEM = 100;
const MAX_DOMAIN_ASSOCIATIONS = 100000;
const METADATA_MAX = Object.freeze({
  configVersion: 80,
  source: 80,
  sourceLicense: 120,
  attribution: 500,
});

const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const DOMAIN_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function isDomainText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasForbiddenDomainSyntax(value) {
  return /[*\s]/.test(value);
}

function hasExplicitPort(value) {
  const authority = value.replace(URL_SCHEME_RE, '').split(/[/?#]/)[0];
  return /:\d+$/.test(authority);
}

function parseDomainUrl(value) {
  if (URL_SCHEME_RE.test(value)) return new URL(value);
  return new URL(`https://${value}`);
}

function isSafeDomainUrl(url) {
  const protocolAllowed = ['http:', 'https:'].includes(url.protocol);
  const hasCredentials = Boolean(url.username || url.password);
  return protocolAllowed && !hasCredentials && !url.port;
}

function isValidDomainLabel(label) {
  return label.length <= 63 && DOMAIN_LABEL_RE.test(label);
}

function isValidHostname(host) {
  const validLength = host.length >= 4 && host.length <= 253;
  const hasSuffix = host.indexOf('.') >= 1;
  return validLength && hasSuffix && isIP(host) === 0 && host.split('.').every(isValidDomainLabel);
}

function canonicalDomain(value) {
  if (hasForbiddenDomainSyntax(value)) return null;
  if (hasExplicitPort(value)) return null;
  const url = parseDomainUrl(value);
  if (!isSafeDomainUrl(url)) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  return isValidHostname(host) ? host : null;
}

function normDomain(value) {
  if (!isDomainText(value)) return null;
  try { return canonicalDomain(value.trim()); }
  catch (_) { return null; }
}

function isCollection(value) {
  return Array.isArray(value) || isPlainRecord(value);
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireRecord(value, name) {
  if (!isPlainRecord(value)) throw new TypeError(`${name} must contain plain records`);
  return value;
}

function toList(x, name = 'collection') {
  if (Array.isArray(x)) return x;
  if (isPlainRecord(x)) {
    // keyed map {id: obj} -> [{id, ...obj}]
    return Object.entries(x).map(([id, value]) => Object.assign({ id }, requireRecord(value, name)));
  }
  return [];
}

function boundedList(value, name, max) {
  const size = Array.isArray(value) ? value.length : Object.keys(value).length;
  if (size > max) throw new Error(`${name} exceeds its ${max}-item cap`);
  return toList(value, name);
}

function trackerCompanyId(tracker) {
  if (tracker.company_id != null) return String(tracker.company_id);
  if (isPlainRecord(tracker.company)) {
    return tracker.company.id != null ? String(tracker.company.id) : null;
  }
  if (typeof tracker.company === 'string' || typeof tracker.company === 'number') {
    return String(tracker.company);
  }
  return null;
}

function domainList(item, singleKey) {
  const domains = item.domains;
  const values = typeof item[singleKey] === 'string' ? domains.concat(item[singleKey]) : domains;
  if (values.length > MAX_DOMAINS_PER_ITEM) throw new Error('catalog item exceeds its domain cap');
  return values;
}

function addUniqueAssociation(state, domains, domain) {
  if (domains.has(domain)) return;
  if (state.associations >= MAX_DOMAIN_ASSOCIATIONS) {
    throw new Error('catalog exceeds its company-domain association cap');
  }
  domains.add(domain);
  state.associations += 1;
}

function addCompanyDomain(state, companyId, domain) {
  if (!domain) return;
  if (!companyId) {
    if (!state.unowned) state.unowned = new Set();
    addUniqueAssociation(state, state.unowned, domain);
    return;
  }
  if (!state.byCompany.has(companyId)) state.byCompany.set(companyId, new Set());
  addUniqueAssociation(state, state.byCompany.get(companyId), domain);
}

function addYellowDomain(state, domain) {
  if (!domain || state.yellow.has(domain)) return;
  if (state.yellow.size >= MAX_YELLOW) throw new Error('catalog exceeds its yellowlist cap');
  state.yellow.add(domain);
}

function requireTracker(tracker) {
  requireRecord(tracker, 'tracker collection');
  if (!Array.isArray(tracker.domains)) throw new TypeError('tracker domains must be an array');
  return tracker;
}

function indexTracker(tracker, state) {
  requireTracker(tracker);
  const companyId = trackerCompanyId(tracker);
  const category = typeof tracker.category === 'string' ? tracker.category.toLowerCase() : '';
  for (const raw of domainList(tracker, 'domain')) {
    const domain = normDomain(raw);
    addCompanyDomain(state, companyId, domain);
    if (YELLOW_CATEGORIES.has(category)) addYellowDomain(state, domain);
  }
}

function requireCompany(company) {
  requireRecord(company, 'company collection');
  if (company.id == null) throw new TypeError('company record requires an id');
  if (company.domains !== undefined && !Array.isArray(company.domains)) {
    throw new TypeError('company domains must be an array');
  }
  return company.domains === undefined ? Object.assign({}, company, { domains: [] }) : company;
}

function indexCompany(company, state) {
  const valid = requireCompany(company);
  const companyId = String(valid.id);
  for (const raw of domainList(valid, 'website_url')) {
    addCompanyDomain(state, companyId, normDomain(raw));
  }
}

// Build {companyId: Set(domains)} and the yellow-domain set.
function buildIndex(trackers, companies) {
  const state = { byCompany: new Map(), yellow: new Set(), unowned: new Set(), associations: 0 };
  for (const tracker of boundedList(trackers, 'tracker collection', MAX_TRACKERS)) indexTracker(tracker, state);
  for (const company of boundedList(companies, 'company collection', MAX_COMPANIES)) indexCompany(company, state);
  return state;
}

function requiredMetadata(opts) {
  return ['configVersion', 'source', 'sourceLicense', 'attribution'].reduce((out, key) => {
    const value = opts[key];
    const cleaned = typeof value === 'string' ? value.trim() : '';
    if (!cleaned || cleaned.length > METADATA_MAX[key]) {
      throw new TypeError(`${key} is required and must be at most ${METADATA_MAX[key]} characters`);
    }
    out[key] = cleaned;
    return out;
  }, {});
}

function collectFirstPartySets(byCompany) {
  const canonical = new Map();
  for (const set of byCompany.values()) {
    if (set.size < 2) continue;
    const domains = Array.from(set).sort().slice(0, MAX_SET_SIZE);
    canonical.set(domains.join('\0'), domains);
  }
  return Array.from(canonical.values())
    .sort((left, right) => left.join('\0').localeCompare(right.join('\0')))
    .slice(0, MAX_SETS);
}

function catalogCollections(input) {
  if (Array.isArray(input)) return { trackers: input, companies: null };
  if (!input) return { trackers: null, companies: null };
  return {
    trackers: input.trackers || input.trackerList,
    companies: input.companies,
  };
}

function requireCatalogCollections(input) {
  const collections = catalogCollections(input);
  if (!isCollection(collections.trackers)) {
    throw new TypeError('catalog must contain tracker and company collections');
  }
  if (!isCollection(collections.companies)) {
    throw new TypeError('catalog must contain tracker and company collections');
  }
  return collections;
}

function convertedConfig(metadata, firstPartySets, yellowlist) {
  return {
    schemaVersion: 1,
    configVersion: metadata.configVersion,
    source: metadata.source,
    sourceLicense: metadata.sourceLicense,
    attribution: metadata.attribution,
    firstPartySets,
    yellowlist,
  };
}

function convert(input, opts = {}) {
  const metadata = requiredMetadata(opts);
  const { trackers, companies } = requireCatalogCollections(input);
  const { byCompany, yellow } = buildIndex(trackers, companies);
  const firstPartySets = collectFirstPartySets(byCompany);
  const yellowlist = Array.from(yellow).sort().slice(0, MAX_YELLOW);
  const config = convertedConfig(metadata, firstPartySets, yellowlist);
  return { config, stats: { companies: byCompany.size, sets: firstPartySets.length, yellow: yellowlist.length } };
}

module.exports = {
  MAX_COMPANIES,
  MAX_DOMAINS_PER_ITEM,
  MAX_DOMAIN_ASSOCIATIONS,
  MAX_SETS,
  MAX_SET_SIZE,
  MAX_TRACKERS,
  MAX_YELLOW,
  METADATA_MAX,
  YELLOW_CATEGORIES,
  addCompanyDomain,
  addYellowDomain,
  buildIndex,
  collectFirstPartySets,
  convert,
  isCollection,
  isPlainRecord,
  normDomain,
  toList,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const outFile = args[0];
  const trackersFile = args[1];
  const companiesFile = args[2];
  if (!outFile || !trackersFile) {
    console.error('usage: node whotracksme-to-firstparty.js <out.json> <trackers.json|combined.json> [companies.json]');
    console.error('required env: PAWSOFF_CATALOG_VERSION, PAWSOFF_CATALOG_SOURCE, PAWSOFF_CATALOG_LICENSE, PAWSOFF_CATALOG_ATTRIBUTION');
    process.exit(2);
  }
  const first = JSON.parse(fs.readFileSync(trackersFile, 'utf8'));
  let input;
  if (first && (first.trackers || first.companies)) {
    input = first; // combined file
  } else {
    input = { trackers: first, companies: companiesFile ? JSON.parse(fs.readFileSync(companiesFile, 'utf8')) : null };
  }
  const { config, stats } = convert(input, {
    configVersion: process.env.PAWSOFF_CATALOG_VERSION,
    source: process.env.PAWSOFF_CATALOG_SOURCE,
    sourceLicense: process.env.PAWSOFF_CATALOG_LICENSE,
    attribution: process.env.PAWSOFF_CATALOG_ATTRIBUTION,
  });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(config, null, 2));
  console.log('whotracksme ->', outFile, JSON.stringify(stats));
}
