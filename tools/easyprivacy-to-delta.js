'use strict';

/* Convert the maintained EasyPrivacy subscription into a conservative live
 * top-up feed. Only exact domain-anchored block filters are eligible; scoped,
 * path, regex, frame, media, websocket, and document rules are intentionally
 * excluded. The extension still applies its own signed-feed validation, rule
 * cap, third-party restriction, and user-allow priority.
 */

const { parseFilterLine } = require('./easyprivacy-to-dnr.js');

const SAFE_TYPES = new Set(['ping', 'image', 'xmlhttprequest', 'script', 'stylesheet', 'font']);
const DEFAULT_TYPES = ['ping', 'image', 'xmlhttprequest'];
const EXACT_DOMAIN_FILTER = /^\|\|([a-z0-9.-]+)\^$/i;
const DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const SOURCE_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,79}$/;
const CONFIG_VERSION_RE = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))*$/;

function isValidDomain(value) {
  return typeof value === 'string' && DOMAIN_RE.test(value);
}

function sourceVersion(text) {
  const match = String(text || '').match(/^!\s*Version:\s*([^\s]+)/mi);
  if (!match) throw new Error('EasyPrivacy source is missing a Version header');
  if (!SOURCE_VERSION_RE.test(match[1])) throw new Error('EasyPrivacy source has an invalid Version header');
  return match[1];
}

function requiredConfigVersion(options) {
  const value = options && options.configVersion;
  if (typeof value !== 'string' || !CONFIG_VERSION_RE.test(value)) {
    throw new TypeError('configVersion is required and must be a canonical release version');
  }
  return value;
}

function stableRank(value) {
  let hash = 0x811c9dc5;
  const input = String(value || '').toLowerCase();
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash;
}

function exactDomain(parsed) {
  if (!parsed) return null;
  const match = EXACT_DOMAIN_FILTER.exec(parsed.condition.urlFilter || '');
  if (!match) return null;
  return isValidDomain(match[1]) ? match[1].toLowerCase() : null;
}

function hasUnsafeScope(condition) {
  if (condition.initiatorDomains) return true;
  if (condition.excludedInitiatorDomains) return true;
  return !!condition.domainType && condition.domainType !== 'thirdParty';
}

function safeResourceTypes(condition) {
  const requested = condition.resourceTypes;
  const types = Array.isArray(requested)
    ? requested.filter((type) => SAFE_TYPES.has(type))
    : DEFAULT_TYPES.slice();
  return types.length ? Array.from(new Set(types)) : null;
}

function candidateFromLine(line) {
  const parsed = parseFilterLine(line);
  const domain = exactDomain(parsed);
  if (!domain) return null;
  if (hasUnsafeScope(parsed.condition)) return null;
  const resourceTypes = safeResourceTypes(parsed.condition);
  if (!resourceTypes) return null;
  return {
    domain,
    resourceTypes,
    allow: parsed.type === 'allow',
  };
}

function baseDomain(domain, getBaseDomain) {
  return String(getBaseDomain(domain) || domain).toLowerCase();
}

function normalizedSet(values) {
  return new Set((values || []).map((domain) => String(domain).toLowerCase()));
}

function isCoveredCandidate(candidate, base, context) {
  return [
    context.covered.has(candidate.domain),
    context.covered.has(base),
    context.essential.has(base),
  ].some(Boolean);
}

function recordCandidate(candidate, context, filters) {
  const base = baseDomain(candidate.domain, context.getBaseDomain);
  if (candidate.allow) {
    filters.allowed.add(candidate.domain);
    filters.allowed.add(base);
    return;
  }
  if (isCoveredCandidate(candidate, base, context)) return;
  if (!filters.blocks.has(candidate.domain)) {
    filters.blocks.set(candidate.domain, candidate.resourceTypes);
  }
}

function collectFilters(text, context) {
  const filters = { allowed: new Set(), blocks: new Map() };
  for (const line of String(text || '').split(/\r?\n/)) {
    const candidate = candidateFromLine(line);
    if (!candidate) continue;
    recordCandidate(candidate, context, filters);
  }
  return filters;
}

function rankedCandidate(domain, blocks, getBaseDomain) {
  const base = baseDomain(domain, getBaseDomain);
  return {
    domain,
    base,
    depth: Math.max(0, domain.split('.').length - base.split('.').length),
    resourceTypes: blocks.get(domain),
    rank: stableRank(domain),
  };
}

function compareCandidates(left, right) {
  if (left.depth !== right.depth) return left.depth - right.depth;
  if (left.rank !== right.rank) return left.rank - right.rank;
  if (left.domain < right.domain) return -1;
  if (left.domain > right.domain) return 1;
  return 0;
}

function rankCandidates(filters, getBaseDomain) {
  return Array.from(filters.blocks.keys())
    .filter((domain) => !filters.allowed.has(domain) && !filters.allowed.has(baseDomain(domain, getBaseDomain)))
    .map((domain) => rankedCandidate(domain, filters.blocks, getBaseDomain))
    .sort(compareCandidates);
}

function selectDomains(candidates, max, perBaseCap) {
  const baseCounts = new Map();
  const domains = [];
  for (const candidate of candidates) {
    if (domains.length >= max) break;
    const count = baseCounts.get(candidate.base) || 0;
    if (count >= perBaseCap) continue;
    baseCounts.set(candidate.base, count + 1);
    domains.push({ domain: candidate.domain, resourceTypes: candidate.resourceTypes });
  }
  return { baseCounts, domains };
}

function positiveOption(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

const MAX_EMITTED_DOMAINS = 2000;
const MAX_PER_BASE = 25;

function boundedOption(value, fallback, ceiling) {
  return Math.min(positiveOption(value, fallback), ceiling);
}

function convert(text, options) {
  const opts = options || {};
  const configVersion = requiredConfigVersion(opts);
  const upstreamVersion = sourceVersion(text);
  const getBaseDomain = typeof opts.getBaseDomain === 'function' ? opts.getBaseDomain : (domain) => domain;
  const filters = collectFilters(text, {
    getBaseDomain,
    covered: normalizedSet(opts.coveredDomains),
    essential: normalizedSet(opts.essentialDomains),
  });
  // Prefer roots and shallow hosts, then a stable hash, so one multi-tenant
  // platform cannot consume the bounded feed.
  const candidates = rankCandidates(filters, getBaseDomain);
  const selected = selectDomains(
    candidates,
    boundedOption(opts.max, MAX_EMITTED_DOMAINS, MAX_EMITTED_DOMAINS),
    boundedOption(opts.perBaseCap, 3, MAX_PER_BASE),
  );
  const { baseCounts, domains } = selected;
  return {
    config: {
      schemaVersion: 1,
      configVersion,
      source: 'easyprivacy',
      sourceVersion: upstreamVersion,
      sourceUrl: 'https://easylist.to/easylist/easyprivacy.txt',
      sourceLicense: 'GPL-3.0-or-later OR CC-BY-SA-3.0-or-later',
      licenseUrl: 'https://easylist.to/pages/licence.html',
      attribution: 'EasyPrivacy data © The EasyList authors; modified into a conservative domain-only MV3 delta.',
      modifications: 'Kept exact domain-anchored network filters only; removed scoped, path, frame, media, websocket, and navigation rules; applied a bounded diversified selection.',
      domains,
    },
    stats: {
      emitted: domains.length,
      candidates: filters.blocks.size,
      allowed: filters.allowed.size,
      representedBases: baseCounts.size,
    },
  };
}

module.exports = {
  DEFAULT_TYPES,
  SAFE_TYPES,
  MAX_EMITTED_DOMAINS,
  MAX_PER_BASE,
  boundedOption,
  candidateFromLine,
  convert,
  isValidDomain,
  requiredConfigVersion,
  sourceVersion,
  stableRank,
};
