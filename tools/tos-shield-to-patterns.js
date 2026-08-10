'use strict';
/* PawsOff — publish the bundled ToS Shield vocabulary as a signed remote feed.
 *
 * background.js has always fetched /tos-shield/patterns.json and has always got
 * a 404, because nothing ever emitted that file. The clause vocabulary only
 * existed as DEFAULT_CONFIG inside src/content/tos-shield.js, so every wording
 * fix or new pattern needed a full Store release to reach anybody.
 *
 * Unlike the other converters there is no upstream project to convert. The input
 * IS our own bundled config, read out of the shipping content script so the two
 * can never drift. This re-stamps it with the release configVersion, wraps it in
 * the metadata envelope the release manifest requires, and re-checks it against
 * the same structural rules tos-shield.js applies before it will adopt a remote
 * config. A bad edit to DEFAULT_CONFIG therefore fails CI here instead of
 * shipping a feed every client silently rejects.
 *
 * The schema stays deliberately data-only (anchors/objects/modifiers as literal
 * strings, never regex source): see the note above DEFAULT_CONFIG. The caps
 * below exist so a runaway edit cannot publish a multi-megabyte pattern set.
 */

const SOURCE_NAME = 'pawsoff-bundled';
const SOURCE_URL = 'https://github.com/Alfa-Dev404/GetPawsOff/blob/main/src/content/tos-shield.js';
const SOURCE_LICENSE = 'MPL-2.0';
const ATTRIBUTION = 'ToS Shield clause vocabulary, PawsOff, MPL-2.0.';

const MAX_CATEGORIES = 64;
const MAX_PATTERNS = 512;
const MAX_TERMS_PER_LIST = 256;
const MAX_TERM_LENGTH = 200;
const MAX_SECTION_TERMS = 256;
const SEVERITIES = new Set(['low', 'med', 'high']);
const REQUIRED_SECTIONS = ['pageDetection', 'segmentation', 'negation', 'scoring'];

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** A vocabulary term: non-empty, bounded, and literal (never a regex source). */
function isTerm(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_TERM_LENGTH;
}

/**
 * Normalise a term list: trim, drop blanks, dedupe case-insensitively, cap.
 * Dedupe runs BEFORE the cap so a list padded with duplicates cannot push real
 * terms off the end (the bug tosdr-to-grades had).
 * @param {*} list
 * @param {number} max
 * @returns {string[]}
 */
function cleanTerms(list, max = MAX_TERMS_PER_LIST) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (!isTerm(raw)) continue;
    const term = raw.trim();
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  if (out.length > max) throw new Error(`term list exceeds ${max} entries`);
  return out;
}

function cleanCategory(category) {
  if (!isRecord(category)) throw new Error('category is not an object');
  if (!isTerm(category.id)) throw new Error('category is missing an id');
  if (!isTerm(category.label)) throw new Error(`category ${category.id} is missing a label`);
  if (!SEVERITIES.has(category.severity)) throw new Error(`category ${category.id} has an unknown severity`);
  return {
    id: category.id,
    label: category.label,
    description: isTerm(category.description) ? category.description : '',
    severity: category.severity,
    defaultEnabled: category.defaultEnabled !== false,
  };
}

function cleanPattern(pattern, categoryIds) {
  if (!isRecord(pattern)) throw new Error('pattern is not an object');
  if (!isTerm(pattern.id)) throw new Error('pattern is missing an id');
  if (!categoryIds.has(pattern.categoryId)) {
    throw new Error(`pattern ${pattern.id} references unknown category ${pattern.categoryId}`);
  }
  const anchors = cleanTerms(pattern.anchors);
  const objects = cleanTerms(pattern.objects);
  // A pattern with no anchors can never fire, and one with no objects matches
  // any sentence containing a bare verb. Both are silent-failure shapes, so
  // they fail the build rather than reaching the matcher.
  if (!anchors.length) throw new Error(`pattern ${pattern.id} has no usable anchors`);
  if (!objects.length) throw new Error(`pattern ${pattern.id} has no usable objects`);
  const weight = Number(pattern.weight);
  if (!Number.isFinite(weight) || weight <= 0 || weight > 10) {
    throw new Error(`pattern ${pattern.id} has an out-of-range weight`);
  }
  return {
    id: pattern.id,
    categoryId: pattern.categoryId,
    enabled: pattern.enabled !== false,
    weight,
    anchors,
    objects,
    modifiers: cleanTerms(pattern.modifiers),
  };
}

/** Section objects are copied through, with every string list bounded. */
function cleanSection(section, name) {
  if (!isRecord(section)) throw new Error(`${name} section is missing`);
  const out = {};
  for (const [key, value] of Object.entries(section)) {
    if (Array.isArray(value)) out[key] = cleanTerms(value, MAX_SECTION_TERMS);
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (isTerm(value)) out[key] = value;
    else throw new Error(`${name}.${key} is not a bounded string, number, or list`);
  }
  return out;
}

function uniqueIds(items, label) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) throw new Error(`duplicate ${label} id: ${item.id}`);
    seen.add(item.id);
  }
  return seen;
}

/**
 * @param {Object} bundled DEFAULT_CONFIG as exported by tos-shield.js
 * @param {{configVersion: string}} opts
 * @returns {{config: Object, stats: Object}}
 */
function convert(bundled, opts) {
  const options = opts || {};
  if (!isRecord(bundled)) throw new Error('bundled ToS config is not an object');
  if (typeof options.configVersion !== 'string' || !options.configVersion) {
    throw new Error('configVersion is required');
  }
  if (bundled.schemaVersion !== 1) throw new Error('unsupported ToS config schemaVersion');
  for (const name of REQUIRED_SECTIONS) {
    if (!isRecord(bundled[name])) throw new Error(`${name} section is missing`);
  }
  if (!Array.isArray(bundled.categories) || !bundled.categories.length) {
    throw new Error('bundled ToS config has no categories');
  }
  if (!Array.isArray(bundled.patterns) || !bundled.patterns.length) {
    throw new Error('bundled ToS config has no patterns');
  }
  if (bundled.categories.length > MAX_CATEGORIES) throw new Error('too many categories');
  if (bundled.patterns.length > MAX_PATTERNS) throw new Error('too many patterns');

  const categories = bundled.categories.map(cleanCategory);
  const categoryIds = uniqueIds(categories, 'category');
  const patterns = bundled.patterns.map((p) => cleanPattern(p, categoryIds));
  uniqueIds(patterns, 'pattern');

  // Every category must be reachable, or the popup renders a filter that can
  // never match anything.
  const covered = new Set(patterns.filter((p) => p.enabled).map((p) => p.categoryId));
  const orphans = categories.filter((c) => c.defaultEnabled && !covered.has(c.id)).map((c) => c.id);
  if (orphans.length) throw new Error(`categories with no enabled pattern: ${orphans.join(', ')}`);

  const config = {
    schemaVersion: 1,
    configVersion: options.configVersion,
    minEngineVersion: isTerm(bundled.minEngineVersion) ? bundled.minEngineVersion : '1.0.0',
    locale: isTerm(bundled.locale) ? bundled.locale : 'en',
    source: SOURCE_NAME,
    sourceUrl: SOURCE_URL,
    sourceLicense: SOURCE_LICENSE,
    attribution: ATTRIBUTION,
    pageDetection: cleanSection(bundled.pageDetection, 'pageDetection'),
    segmentation: cleanSection(bundled.segmentation, 'segmentation'),
    negation: cleanSection(bundled.negation, 'negation'),
    scoring: cleanSection(bundled.scoring, 'scoring'),
    categories,
    patterns,
  };

  return {
    config,
    stats: {
      categories: categories.length,
      patterns: patterns.length,
      terms: patterns.reduce((n, p) => n + p.anchors.length + p.objects.length + p.modifiers.length, 0),
    },
  };
}

module.exports = {
  convert,
  cleanTerms,
  cleanPattern,
  cleanCategory,
  MAX_CATEGORIES,
  MAX_PATTERNS,
  MAX_TERMS_PER_LIST,
  SOURCE_NAME,
};
