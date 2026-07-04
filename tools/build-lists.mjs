// build-lists.mjs - community-list fetch + convert orchestrator (run in CI).
//
// Pulls only permissively-licensed community lists, runs the clean-room
// converters, writes signed-config-ready artifacts to dist-lists/. Signing
// (ECDSA P-256 detached .sig) and publishing are a separate step so the
// release private key never lives in this repo.
//
// Requires network - CI only, not the offline build sandbox.
//   node tools/build-lists.mjs
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dir, '..');

const autoconsent = require('./autoconsent-to-consent-rules.js');
const tosdr = require('./tosdr-to-grades.js');
const wtm = require('./whotracksme-to-firstparty.js');

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
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
// letter grade only); `flagged` stays empty for every entry as a result -
// tosdr-to-grades.js already tolerates a missing `points` array.
//
// The API caps at 5 requests per rolling 10s window (X-RateLimit-Limit/Reset
// response headers, no Retry-After on a 429) - pace requests well under that
// and back off using the reset header's own countdown on a 429, rather than a
// blind fixed delay.
async function fetchTosdrPage(page, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(`https://api.tosdr.org/service/v3/?page=${page}`, { signal: ctrl.signal });
    if (res.status === 429) {
      const resetSecs = Number(res.headers.get('x-ratelimit-reset'));
      const err = new Error('HTTP 429');
      err.retryAfterMs = (Number.isFinite(resetSecs) ? resetSecs : 10) * 1000 + 500;
      throw err;
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return JSON.parse(await res.text());
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('timeout after ' + ms + 'ms fetching tosdr page ' + page);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTosdrServices() {
  const services = [];
  for (let page = 1; ; page += 1) {
    let body;
    for (let attempt = 0; ; attempt += 1) {
      try {
        body = await fetchTosdrPage(page, 15000);
        break;
      } catch (err) {
        if (attempt >= 5) throw err;
        await new Promise((r) => setTimeout(r, err.retryAfterMs || 2000 * (attempt + 1)));
      }
    }
    if (!Array.isArray(body.services) || !body.services.length) break;
    services.push(...body.services);
    const total = body.page && body.page.total;
    if (typeof total === 'number' && services.length >= total) break;
    await new Promise((r) => setTimeout(r, 2500)); // stay under 5 req/10s
  }
  return JSON.stringify({ services });
}

// Ghostery's trackerdb export (the successor to the old whotracks.me export
// this used to fetch) keys everything by pattern/org id - {organizations,
// patterns, domains} - rather than the flat {trackers, companies} arrays
// whotracksme-to-firstparty.js expects. Reshape it here; the converter itself
// is clean-room and stays untouched.
async function fetchTrackerdb() {
  const raw = JSON.parse(await fetchWithTimeout(
    'https://github.com/ghostery/trackerdb/releases/latest/download/trackerdb.json', 30000,
  ));
  const trackers = Object.values(raw.patterns || {}).map((p) => ({
    company_id: p.organization || null,
    domains: Array.isArray(p.domains) ? p.domains : [],
    category: p.category || '',
  }));
  const companies = Object.entries(raw.organizations || {}).map(([id, o]) => ({
    id,
    website_url: o && o.website_url,
  }));
  return JSON.stringify({ trackers, companies });
}

// PERMISSIVE sources only. Confirm exact upstream endpoints in CI before relying
// on them - repository layouts move over time.
const SOURCES = [
  {
    feature: 'Consent Autopilot',
    name: 'autoconsent',
    license: 'Apache-2.0',
    // The rule fragments live individually under rules/autoconsent/*.json in
    // git; the compiled bundle this used to fetch straight from git is now
    // only produced at publish time and shipped in the npm package instead.
    fetchText: () => fetchWithTimeout(
      'https://cdn.jsdelivr.net/npm/@duckduckgo/autoconsent@16/dist/addon-mv3/rules.json', 30000,
    ),
    out: 'dist-lists/consent-ghost/consent-config.json',
    run: (text) => autoconsent.convert(JSON.parse(text)),
  },
  {
    feature: 'ToS Shield (reputation layer)',
    name: 'tosdr',
    license: 'CC-BY-SA (data only)',
    fetchText: fetchTosdrServices,
    out: 'dist-lists/tos-shield/tosdr-grades.json',
    run: (text) => tosdr.convert(JSON.parse(text)),
  },
  {
    feature: 'Smart Tracker Radar (seed)',
    name: 'whotracksme',
    license: 'MIT',
    fetchText: fetchTrackerdb,
    out: 'dist-lists/prevalence/firstparty.json',
    run: (text) => wtm.convert(JSON.parse(text)),
  },
];

// Intentionally NOT shipped - incompatible with a commercial / source-available
// product. Documented here so the decision is auditable.
const EXCLUDED = [
  { name: 'DuckDuckGo Tracker Radar', reason: 'CC-BY-NC-SA: non-commercial clause' },
  { name: 'Disconnect entitylist', reason: 'GPL-3.0 + separate commercial terms' },
  { name: 'EasyList Cookie List / AdGuard Annoyances', reason: 'GPL/CC-BY-SA copyleft, hide-only - kept as bundled cosmetic fallback, not a shipped feed' },
];

async function main() {
  for (const src of SOURCES) {
    try {
      const text = await src.fetchText();
      const { config, stats } = src.run(text);
      const outPath = resolve(root, src.out);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify(config, null, 2));
      console.log(`[ok] ${src.name} (${src.license}) -> ${src.out} ${JSON.stringify(stats)}`);
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

main();
