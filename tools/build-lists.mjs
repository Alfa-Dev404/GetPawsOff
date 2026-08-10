// build-lists.mjs — community-list fetch + convert orchestrator (run in CI).
//
// Pulls only approved, commercially usable community data, runs clean-room
// converters, writes signed-config-ready artifacts to dist-lists/. Signing
// (ECDSA P-256 detached .sig) and publishing are a separate step so the
// release private key never lives in this repo.
//
// Requires network — CI only, not the offline build sandbox.
//   node tools/build-lists.mjs
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dir, '..');
const AUTOCONSENT_VERSION = '16.11.0';
const AUTOCONSENT_RULES_URL =
  `https://cdn.jsdelivr.net/npm/@duckduckgo/autoconsent@${AUTOCONSENT_VERSION}/dist/addon-mv3/rules.json`;
const EASYPRIVACY_URL = 'https://easylist.to/easylist/easyprivacy.txt';
const CONFIG_VERSION_RE = /^\d{14}$/;
const AUTOCONSENT_MAX_BYTES = 10 * 1024 * 1024;
const EASYPRIVACY_MAX_BYTES = 20 * 1024 * 1024;
const TOSDR_PAGE_MAX_BYTES = 2 * 1024 * 1024;
const TOSDR_SERVICE_MAX_BYTES = 16 * 1024 * 1024;
const MAX_TOSDR_SERVICES = 20000;
const MAX_TOSDR_PAGES = 5000;

const autoconsent = require('./autoconsent-to-consent-rules.js');
const tosdr = require('./tosdr-to-grades.js');
const easyPrivacyDelta = require('./easyprivacy-to-delta.js');
const psl = require('../src/learn/psl-lite.js').PawsOffPSL;
const essentialDomains = Array.from(require('../src/learn/prevalence-enforcer.js').ESSENTIAL_DOMAINS);

function requiredConfigVersion(env = process.env) {
  const value = env && env.PAWSOFF_CONFIG_VERSION;
  if (!CONFIG_VERSION_RE.test(String(value || ''))) {
    throw new Error('PAWSOFF_CONFIG_VERSION must be an explicit 14-digit UTC release version');
  }
  return value;
}

async function readBoundedText(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`response exceeds ${maxBytes} bytes`);
  }
  const body = response.body;
  if (!body) throw new Error('response body is not stream-readable');
  if (typeof body.getReader !== 'function') throw new Error('response body is not stream-readable');
  const result = await readResponseChunks(body.getReader(), maxBytes);
  return new TextDecoder().decode(mergeResponseChunks(result));
}

async function readResponseChunks(reader, maxBytes) {
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) return { chunks, total };
      total += part.value.byteLength;
      if (total > maxBytes) await rejectOversizedResponse(reader, maxBytes);
      chunks.push(part.value);
    }
  } finally {
    try { reader.releaseLock(); } catch (_) { /* optional */ }
  }
}

async function rejectOversizedResponse(reader, maxBytes) {
  try { await reader.cancel(); } catch (_) { /* optional */ }
  throw new Error(`response exceeds ${maxBytes} bytes`);
}

function mergeResponseChunks(result) {
  const merged = new Uint8Array(result.total);
  let offset = 0;
  for (const chunk of result.chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return merged;
}

function requireResponseOrigin(response, allowedOrigin) {
  let origin;
  try { origin = new URL(response.url).origin; } catch (_) { throw new Error('response has no valid final URL'); }
  if (origin !== allowedOrigin) throw new Error(`response redirected outside ${allowedOrigin}`);
}

function validateFetchedResponse(response, allowedOrigin) {
  if (response.status >= 300 && response.status < 400) throw new Error('redirect response rejected');
  if (!response.ok) throw new Error('HTTP ' + response.status);
  requireResponseOrigin(response, allowedOrigin);
}

async function fetchWithTimeout(url, ms, maxBytes, allowedOrigin = new URL(url).origin) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { redirect: 'manual', signal: ctrl.signal });
    validateFetchedResponse(res, allowedOrigin);
    return await readBoundedText(res, maxBytes);
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('timeout after ' + ms + 'ms fetching ' + url);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ToS;DR's v3 API only returns full point/classification detail on a
// PER-SERVICE basis (aggressively rate-limited), unlike the old bulk
// all-services/v2 endpoint this used to hit. Fetching detail for all ~10k
// services isn't CI-friendly, so this paginates the bulk list instead (host +
// letter grade only); `flagged` stays empty for every entry as a result —
// tosdr-to-grades.js already tolerates a missing `points` array.
//
// The API caps at 5 requests per rolling 10s window (X-RateLimit-Limit/Reset
// response headers, no Retry-After on a 429) — pace requests well under that
// and back off using the reset header's own countdown on a 429, rather than a
// blind fixed delay.
async function fetchTosdrPage(page, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await requestTosdrPage(page, ctrl.signal);
  } catch (err) {
    throw normalizeTosdrPageError(err, page, ms);
  } finally {
    clearTimeout(timer);
  }
}

async function requestTosdrPage(page, signal) {
  const response = await fetch(`https://api.tosdr.org/service/v3/?page=${page}`, { signal });
  if (response.status === 429) throw tosdrRateLimitError(response);
  if (!response.ok) throw new Error('HTTP ' + response.status);
  requireResponseOrigin(response, 'https://api.tosdr.org');
  return parseTosdrPage(await readBoundedText(response, TOSDR_PAGE_MAX_BYTES));
}

function parseTosdrPage(text) {
  const body = JSON.parse(text);
  if (!isTosdrPage(body)) {
    throw new Error('invalid ToS;DR page schema');
  }
  return body;
}

function isTosdrPage(value) {
  if (!value) return false;
  if (typeof value !== 'object') return false;
  if (!Array.isArray(value.services)) return false;
  if (!value.page || typeof value.page !== 'object') return false;
  const total = value.page.total;
  return Number.isSafeInteger(total) && total >= 0 && total <= MAX_TOSDR_SERVICES;
}

function normalizeTosdrPageError(error, page, timeoutMs) {
  if (!error) return error;
  if (error.name !== 'AbortError') return error;
  return new Error('timeout after ' + timeoutMs + 'ms fetching tosdr page ' + page);
}

function tosdrRateLimitError(response) {
  const resetSecs = Number(response.headers.get('x-ratelimit-reset'));
  const waitSeconds = Number.isFinite(resetSecs)
    ? Math.min(60, Math.max(1, resetSecs))
    : 10;
  const error = new Error('HTTP 429');
  error.retryAfterMs = waitSeconds * 1000 + 500;
  return error;
}

function retryDelay(error, attempt) {
  return error.retryAfterMs || 2000 * (attempt + 1);
}

async function fetchTosdrPageWithRetries(page) {
  for (let attempt = 0; attempt <= 5; attempt += 1) {
    try {
      return await fetchTosdrPage(page, 15000);
    } catch (error) {
      if (attempt >= 5) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, retryDelay(error, attempt)));
    }
  }
  throw new Error('ToS;DR retry loop ended unexpectedly');
}

function tosdrPageFinished(body, serviceCount) {
  return serviceCount >= body.page.total;
}

function requireTosdrServiceCapacity(services, incoming) {
  if (services.length + incoming.length > MAX_TOSDR_SERVICES) {
    throw new Error('ToS;DR service list exceeds its cap');
  }
}

function consumeTosdrByteBudget(incoming, budget) {
  const pageBytes = Buffer.byteLength(JSON.stringify(incoming));
  if (budget.bytes + pageBytes > budget.maxBytes) {
    throw new Error('ToS;DR service data exceeds its cumulative byte cap');
  }
  budget.bytes += pageBytes;
}

function appendTosdrServices(services, body, budget) {
  if (!Array.isArray(body.services)) return;
  requireTosdrServiceCapacity(services, body.services);
  consumeTosdrByteBudget(body.services, budget);
  services.push(...body.services);
}

async function appendTosdrPage(services, page, budget) {
  const body = await fetchTosdrPageWithRetries(page);
  appendTosdrServices(services, body, budget);
  if (tosdrPageFinished(body, services.length)) return true;
  if (!body.services.length) throw new Error('ToS;DR pagination ended before page.total');
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 2500));
  return false;
}

function serializedTosdrServices(services, complete) {
  if (!complete) throw new Error('ToS;DR pagination exceeds its page cap');
  if (services.length > MAX_TOSDR_SERVICES) throw new Error('ToS;DR service list exceeds its cap');
  return JSON.stringify({ services });
}

async function fetchTosdrServices() {
  const services = [];
  const budget = { bytes: 0, maxBytes: TOSDR_SERVICE_MAX_BYTES };
  let complete = false;
  for (let page = 1; page <= MAX_TOSDR_PAGES; page += 1) {
    if (await appendTosdrPage(services, page, budget)) {
      complete = true;
      break;
    }
  }
  return serializedTosdrServices(services, complete);
}

// Approved sources only. Licence names are assertions checked during review,
// not guesses inherited from an aggregator. Release metadata records the exact
// generated artifact hash before anything is published.
const SOURCES = [
  {
    feature: 'Consent Autopilot',
    name: 'autoconsent',
    license: 'MPL-2.0',
    // The rule fragments live individually under rules/autoconsent/*.json in
    // git; the compiled bundle this used to fetch straight from git is now
    // only produced at publish time and shipped in the npm package instead.
    fetchText: () => fetchWithTimeout(AUTOCONSENT_RULES_URL, 30000, AUTOCONSENT_MAX_BYTES),
    out: 'dist-lists/consent-ghost/consent-config.json',
    run: (text, configVersion) => {
      const result = autoconsent.convert(JSON.parse(text), {
        configVersion,
        v2ConfigVersion: `${configVersion}.2`,
        sourceVersion: AUTOCONSENT_VERSION,
        sourceUrl: AUTOCONSENT_RULES_URL,
      });
      result.artifacts = [{
        out: 'dist-lists/consent-ghost/consent-config-v2.json',
        config: result.v2Config,
      }];
      return result;
    },
  },
  {
    feature: 'ToS Shield (reputation layer)',
    name: 'tosdr',
    license: 'CC-BY-SA (data only)',
    fetchText: fetchTosdrServices,
    out: 'dist-lists/tos-shield/tosdr-grades.json',
    run: (text, configVersion) => tosdr.convert(JSON.parse(text), { configVersion }),
  },
  {
    feature: 'Signed tracker-list top-up',
    name: 'easyprivacy-delta',
    license: 'GPL-3.0-or-later OR CC-BY-SA-3.0-or-later',
    fetchText: () => fetchWithTimeout(EASYPRIVACY_URL, 30000, EASYPRIVACY_MAX_BYTES),
    out: 'dist-lists/easyprivacy-delta/domains.json',
    run: (text, configVersion) => easyPrivacyDelta.convert(text, {
      configVersion,
      coveredDomains: JSON.parse(readFileSync(resolve(root, 'src/rules/easyprivacy-domains.json'), 'utf8')),
      essentialDomains,
      getBaseDomain: (domain) => psl.getBaseDomain(domain),
      max: 2000,
    }),
  },
];

// Intentionally NOT shipped — incompatible with a commercial / source-available
// product. Documented here so the decision is auditable.
const EXCLUDED = [
  { name: 'DuckDuckGo Tracker Radar', reason: 'CC-BY-NC-SA: non-commercial clause' },
  { name: 'Ghostery TrackerDB', reason: 'CC-BY-NC-SA-4.0: commercial use requires Ghostery permission' },
  { name: 'Disconnect entitylist', reason: 'GPL-3.0 + separate commercial terms' },
  { name: 'EasyList Cookie List / AdGuard Annoyances', reason: 'hide-only annoyance data is outside the network-privacy scope and raises separate attribution/share-alike packaging work' },
];

async function main() {
  const configVersion = requiredConfigVersion();
  for (const src of SOURCES) {
    try {
      const text = await src.fetchText();
      const result = src.run(text, configVersion);
      const artifacts = [{ out: src.out, config: result.config }].concat(result.artifacts || []);
      for (const artifact of artifacts) {
        const outPath = resolve(root, artifact.out);
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, JSON.stringify(artifact.config, null, 2));
      }
      console.log(`[ok] ${src.name} (${src.license}) -> ${artifacts.map((a) => a.out).join(', ')} ${JSON.stringify(result.stats)}`);
    } catch (e) {
      console.error(`[fail] ${src.name}: ${e.message}`);
      process.exitCode = 1;
    }
  }
  console.log('\nExcluded by licence policy:');
  for (const x of EXCLUDED) console.log(`  - ${x.name}: ${x.reason}`);
  console.log('\nNext: sign each artifact (ECDSA P-256 -> <file>.sig) with the release key,');
  console.log('then publish to https://config.getpawsoff.app/<feature>/. The extension verifies');
  console.log('the signature against PINNED_PUBLIC_KEY_JWK before adopting it.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

export {
  MAX_TOSDR_PAGES,
  TOSDR_SERVICE_MAX_BYTES,
  appendTosdrServices,
  fetchWithTimeout,
  parseTosdrPage,
  readBoundedText,
  requireResponseOrigin,
  requiredConfigVersion,
  tosdrRateLimitError,
};
