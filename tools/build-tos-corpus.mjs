// Builds tests/fixtures/tos-corpus.json: real policy quotes that ToS;DR
// reviewers have labelled, mapped onto ToS Shield categories.
//
//   node tools/build-tos-corpus.mjs [cache-dir]
//
// Requires network. The API rate-limits hard, so requests are spaced out and
// responses are cached in cache-dir (default .tos-corpus-cache, gitignored).
// ToS;DR data is CC BY-SA 3.0; see THIRD-PARTY-NOTICES.md.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = resolve(process.argv[2] || resolve(root, '.tos-corpus-cache'));
const OUT = resolve(root, 'tests/fixtures/tos-corpus.json');
const API = 'https://api.tosdr.org';
const DELAY_MS = 1500;
const MAX_QUOTE_CHARS = 700;
const MAX_ROWS_PER_CASE = 20;

// English-language services with a comprehensive ToS;DR review.
const SERVICE_IDS = [
  182, 460, 306, 158, 879, 230, 262, 511, 3206, 989, 2895, 2371, 2416, 2491,
  2530, 3015, 3118, 2866, 2909, 1731, 3428, 1741,
];

// ToS;DR case id -> categories any of which counts as a correct flag.
const ADVERSE = {
  396: ['data_sale'],
  243: ['data_sale', 'third_party_sharing'],
  166: ['third_party_sharing'],
  323: ['tracking_surveillance'],
  129: ['tracking_surveillance'],
  128: ['tracking_surveillance', 'marketing_sharing'],
  400: ['tracking_surveillance'],
  373: ['tracking_surveillance'],
  336: ['marketing_sharing'],
  220: ['marketing_sharing', 'third_party_sharing'],
  333: ['data_retention'],
  134: ['content_license'],
  139: ['content_license'],
  130: ['content_license'],
  121: ['unilateral_change'],
  403: ['unilateral_change', 'consent_by_use'],
  201: ['unilateral_termination'],
  339: ['arbitration_classwaiver'],
  117: ['arbitration_classwaiver'],
  286: ['liability_waiver'],
  293: ['liability_waiver'],
  149: ['liability_waiver'],
  287: ['liability_waiver'],
  163: ['jurisdiction_choiceoflaw'],
  242: ['jurisdiction_choiceoflaw'],
  // The ToS;DR case covers automated decisions, profiling and AI training together.
  504: ['ai_training', 'profiling'],
  398: ['auto_renewal'],
  384: ['auto_renewal'],
  145: ['indemnification'],
  146: ['indemnification'],
  326: ['profiling'],
};

// ToS;DR case id -> categories that would contradict the reviewer if flagged.
const PROTECTIVE = {
  193: ['data_sale'],
  311: ['third_party_sharing'],
  170: ['unilateral_termination'],
  195: ['unilateral_termination', 'data_retention'],
  140: ['data_retention'],
  123: ['unilateral_change'],
  303: ['data_retention'],
  177: ['data_retention'],
  335: ['arbitration_classwaiver'],
};

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function cachedJson(name, url) {
  const file = resolve(cacheDir, name);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    await sleep(DELAY_MS * attempt);
    const response = await fetch(url, { headers: { 'user-agent': 'tos-corpus-builder' } });
    if (response.status === 429) continue;
    if (!response.ok) return null;
    const body = await response.json();
    writeFileSync(file, JSON.stringify(body));
    return body;
  }
  return null;
}

function cleanQuote(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

mkdirSync(cacheDir, { recursive: true });
const rows = [];
const perCase = new Map();
const seen = new Set();

for (const serviceId of SERVICE_IDS) {
  const service = await cachedJson(`svc-${serviceId}.json`, `${API}/service/v3/?id=${serviceId}`);
  if (!service || !Array.isArray(service.points)) continue;
  for (const point of service.points) {
    const caseId = point.case && point.case.id;
    const expect = ADVERSE[caseId] || null;
    const mustNot = PROTECTIVE[caseId] || null;
    if (point.status !== 'approved' || !point.document_id || (!expect && !mustNot)) continue;
    if ((perCase.get(caseId) || 0) >= MAX_ROWS_PER_CASE) continue;
    const detail = await cachedJson(`point-${point.id}.json`, `${API}/point/v1/?id=${point.id}`);
    const text = cleanQuote(detail && detail.quote_text);
    if (text.length < 40 || text.length > MAX_QUOTE_CHARS || seen.has(text)) continue;
    seen.add(text);
    perCase.set(caseId, (perCase.get(caseId) || 0) + 1);
    rows.push({
      t: text,
      ...(expect ? { e: expect } : { not: mustNot }),
      case: point.case.title.trim(),
      service: service.name,
    });
  }
  console.error(`${service.name}: ${rows.length} rows so far`);
}

writeFileSync(OUT, JSON.stringify({
  source: 'ToS;DR (https://tosdr.org), CC BY-SA 3.0. Quotes are excerpts of the reviewed services\' own policies.',
  rows,
}, null, 1) + '\n');
console.error(`wrote ${rows.length} rows to ${OUT}`);
