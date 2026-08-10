(function (root) {
  'use strict';

  const VERSION_RE = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))*$/;

  function versionParts(value) {
    if (typeof value !== 'string' || !VERSION_RE.test(value)) return null;
    const parts = value.split('.').map(Number);
    return parts.every(Number.isSafeInteger) ? parts : null;
  }

  function compareVersions(left, right) {
    const a = versionParts(left);
    const b = versionParts(right);
    if (!a || !b) return null;
    const length = Math.max(a.length, b.length);
    for (let i = 0; i < length; i++) {
      const x = a[i] || 0;
      const y = b[i] || 0;
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  }

  function base64ToBytes(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function escapedToken(token) {
    return token.toLowerCase()
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\s+/g, '\\s+');
  }

  function tokenParts(tokens, unique) {
    if (!Array.isArray(tokens)) return [];
    const values = tokens.filter((token) => typeof token === 'string' && token.length);
    return Array.from(unique ? new Set(values) : values).map(escapedToken);
  }

  function compiledRegex(source, flags) {
    try { return new RegExp(source, flags); }
    catch (_) { return null; }
  }

  function buildAltRegex(tokens) {
    const parts = tokenParts(tokens, false);
    if (!parts.length) return null;
    return compiledRegex('(?:^|[^a-z0-9])(?:' + parts.join('|') + ')(?:[^a-z0-9]|$)', 'i');
  }

  function buildEvidenceRegex(tokens) {
    const parts = tokenParts(tokens, true);
    if (!parts.length) return null;
    return compiledRegex('(?:^|[^a-z0-9])(' + parts.join('|') + ')(?=[^a-z0-9]|$)', 'gi');
  }

  function buildStripRegex(tokens) {
    const parts = tokenParts(tokens, false);
    if (!parts.length) return null;
    return compiledRegex('(?:' + parts.join('|') + ')', 'gi');
  }

  function collectEvidenceSpans(text, evidenceRegex) {
    const spans = [];
    evidenceRegex.lastIndex = 0;
    let match;
    while ((match = evidenceRegex.exec(String(text || '')))) {
      if (spans.length >= 16) break;
      const phrase = match[1] || '';
      if (!phrase) continue;
      const start = match.index + match[0].length - phrase.length;
      spans.push({ start, end: start + phrase.length });
    }
    return spans;
  }

  function mergeEvidenceSpans(spans) {
    return spans.sort((a, b) => a.start - b.start).reduce((merged, span) => {
      const previous = merged[merged.length - 1];
      if (previous && span.start <= previous.end) previous.end = Math.max(previous.end, span.end);
      else merged.push({ start: span.start, end: span.end });
      return merged;
    }, []);
  }

  function evidenceSpans(text, evidenceRegex) {
    if (!evidenceRegex) return [];
    return mergeEvidenceSpans(collectEvidenceSpans(text, evidenceRegex));
  }

  function hasRequiredArrays(config) {
    return Array.isArray(config.categories) && Array.isArray(config.patterns);
  }

  function hasRequiredSections(config) {
    return !!config.pageDetection && !!config.segmentation && !!config.negation && !!config.scoring;
  }

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function hasExactKeys(value, allowed, required) {
    if (!isPlainObject(value)) return false;
    const keys = Object.keys(value);
    if (!keys.every((key) => allowed.has(key))) return false;
    return required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
  }

  function finiteInRange(value, minimum, maximum) {
    return Number.isFinite(value) && value >= minimum && value <= maximum;
  }

  function safeIdentifier(value, maxLength) {
    if (typeof value !== 'string') return false;
    if (!value.length || value.length > maxLength) return false;
    return /^[a-z0-9][a-z0-9._-]*$/i.test(value);
  }

  function safeLiteral(value, maxLength) {
    if (typeof value !== 'string') return false;
    if (!value.trim() || value.length > maxLength) return false;
    return !/[\0\r\n]/.test(value);
  }

  function validLiteralList(value, maxItems, maxLength, required) {
    if (!Array.isArray(value) || value.length > maxItems) return false;
    if (required && !value.length) return false;
    return value.every((item) => safeLiteral(item, maxLength));
  }

  const TOS_TOP_KEYS = new Set([
    'schemaVersion', 'configVersion', 'minEngineVersion', 'locale', 'pageDetection',
    'segmentation', 'negation', 'scoring', 'categories', 'patterns',
  ]);
  const TOS_PAGE_KEYS = new Set(['urlTokens', 'titleTokens', 'legaleseMarkers', 'minWordCount', 'confidenceThreshold']);
  const TOS_SEGMENTATION_KEYS = new Set(['abbreviations', 'clauseDelimiters']);
  const TOS_NEGATION_KEYS = new Set(['cues', 'scope', 'penalty']);
  const TOS_SCORING_KEYS = new Set(['presentThreshold', 'modifierBoost', 'aggravatedModifiers']);
  const TOS_CATEGORY_KEYS = new Set(['id', 'label', 'description', 'severity', 'defaultEnabled']);
  const TOS_PATTERN_KEYS = new Set(['id', 'categoryId', 'enabled', 'weight', 'anchors', 'objects', 'modifiers', 'ignoreNegation']);

  function validPageDetection(section) {
    return [
      hasExactKeys(section, TOS_PAGE_KEYS, Array.from(TOS_PAGE_KEYS)),
      validLiteralList(section && section.urlTokens, 128, 120, true),
      validLiteralList(section && section.titleTokens, 128, 160, true),
      validLiteralList(section && section.legaleseMarkers, 128, 160, true),
      Number.isSafeInteger(section && section.minWordCount),
      finiteInRange(section && section.minWordCount, 50, 100000),
      finiteInRange(section && section.confidenceThreshold, 0, 1),
    ].every(Boolean);
  }

  function validSegmentation(section) {
    return [
      hasExactKeys(section, TOS_SEGMENTATION_KEYS, Array.from(TOS_SEGMENTATION_KEYS)),
      validLiteralList(section && section.abbreviations, 128, 40, false),
      validLiteralList(section && section.clauseDelimiters, 64, 80, true),
    ].every(Boolean);
  }

  function validNegation(section) {
    return [
      hasExactKeys(section, TOS_NEGATION_KEYS, Array.from(TOS_NEGATION_KEYS)),
      validLiteralList(section && section.cues, 128, 80, true),
      section && section.scope === 'clause',
      finiteInRange(section && section.penalty, 0, 1),
    ].every(Boolean);
  }

  function validScoring(section) {
    return [
      hasExactKeys(section, TOS_SCORING_KEYS, Array.from(TOS_SCORING_KEYS)),
      finiteInRange(section && section.presentThreshold, 0, 10),
      finiteInRange(section && section.modifierBoost, 0, 10),
      validLiteralList(section && section.aggravatedModifiers, 128, 160, false),
    ].every(Boolean);
  }

  function validOptionalBoolean(value) {
    return value === undefined || typeof value === 'boolean';
  }

  function validOptionalWeight(value) {
    return value === undefined || finiteInRange(value, 0, 10);
  }

  function validCategory(category) {
    const item = isPlainObject(category) ? category : {};
    return [
      hasExactKeys(item, TOS_CATEGORY_KEYS, Array.from(TOS_CATEGORY_KEYS)),
      safeIdentifier(item.id, 80),
      safeLiteral(item.label, 160),
      safeLiteral(item.description, 500),
      ['high', 'med', 'low'].includes(item.severity),
      typeof item.defaultEnabled === 'boolean',
    ].every(Boolean);
  }

  function validPattern(pattern, categoryIds) {
    const item = isPlainObject(pattern) ? pattern : {};
    return [
      hasExactKeys(item, TOS_PATTERN_KEYS, ['id', 'categoryId', 'anchors', 'objects', 'modifiers']),
      safeIdentifier(item.id, 120),
      categoryIds.has(item.categoryId),
      validOptionalBoolean(item.enabled),
      validOptionalWeight(item.weight),
      validLiteralList(item.anchors, 128, 160, true),
      validLiteralList(item.objects, 128, 160, true),
      validLiteralList(item.modifiers, 128, 160, false),
      validOptionalBoolean(item.ignoreNegation),
    ].every(Boolean);
  }

  function validSections(config) {
    return [
      validPageDetection(config.pageDetection),
      validSegmentation(config.segmentation),
      validNegation(config.negation),
      validScoring(config.scoring),
    ].every(Boolean);
  }

  function validCollections(config) {
    const categories = Array.isArray(config.categories) ? config.categories : [];
    const patterns = Array.isArray(config.patterns) ? config.patterns : [];
    const categoryIds = new Set(categories.map((category) => category && category.id));
    const patternIds = new Set(patterns.map((pattern) => pattern && pattern.id));
    return [
      categories.length > 0 && categories.length <= 64,
      patterns.length > 0 && patterns.length <= 512,
      categories.every(validCategory),
      categoryIds.size === categories.length,
      patternIds.size === patterns.length,
      patterns.every((pattern) => validPattern(pattern, categoryIds)),
    ].every(Boolean);
  }

  function validHeader(config, options) {
    const required = [
      'schemaVersion', 'configVersion', 'pageDetection', 'segmentation', 'negation',
      'scoring', 'categories', 'patterns',
    ];
    return [
      hasExactKeys(config, TOS_TOP_KEYS, required),
      config && config.schemaVersion === options.schemaVersion,
      !!versionParts(config && config.configVersion),
      !config || config.minEngineVersion === undefined || !!versionParts(config.minEngineVersion),
      !config || config.locale === undefined || config.locale === 'en',
    ].every(Boolean);
  }

  function validReputationResponse(response) {
    if (!response) return false;
    if (!response.ok) return false;
    if (!response.reputation) return false;
    return typeof response.reputation === 'object';
  }

  function validReputationPoint(point) {
    if (!point || typeof point.title !== 'string') return false;
    return point.severity === 'high' || point.severity === 'med';
  }

  function normalizeReputationPoint(point) {
    return {
      title: point.title.slice(0, 140),
      topic: typeof point.topic === 'string' ? point.topic.slice(0, 60) : '',
      severity: point.severity,
    };
  }

  function normalizeReputationSource(source) {
    if (!source || typeof source !== 'object') return null;
    return {
      attribution: typeof source.attribution === 'string' ? source.attribution.slice(0, 240) : '',
      configVersion: typeof source.configVersion === 'string' ? source.configVersion.slice(0, 40) : '',
    };
  }

  function normalizeReputationResponse(response) {
    try {
      if (!validReputationResponse(response)) return null;
      const item = response.reputation;
      if (typeof item.name !== 'string') return null;
      if (item.name.length > 160) return null;
      const grade = typeof item.grade === 'string' ? item.grade.toUpperCase().slice(0, 8) : null;
      const points = Array.isArray(item.flagged) ? item.flagged.slice(0, 10) : [];
      return {
        reputation: { name: item.name, grade, flagged: points.filter(validReputationPoint).map(normalizeReputationPoint) },
        source: normalizeReputationSource(response.source),
      };
    } catch (_) {
      return null;
    }
  }

  function gradePresentation(grade) {
    const normalized = String(grade || '').toUpperCase();
    if (normalized === 'A' || normalized === 'B') return { label: normalized, tone: 'good', summary: 'generally positive community rating' };
    if (normalized === 'C') return { label: normalized, tone: 'mixed', summary: 'mixed community rating' };
    if (normalized === 'D' || normalized === 'E') return { label: normalized, tone: 'poor', summary: 'poor community rating' };
    return { label: '—', tone: 'unknown', summary: 'not yet rated by the community' };
  }

  function findingEvidenceLabel(finding) {
    return finding && finding.level === 'aggravated' ? 'Strong phrase match' : 'Direct phrase match';
  }

  function tokenList(value) {
    return Array.isArray(value) ? value : [];
  }

  function patternEvidenceTokens(pattern, config) {
    return [].concat(
      tokenList(pattern.anchors),
      tokenList(pattern.objects),
      tokenList(pattern.modifiers),
      tokenList(config.scoring.aggravatedModifiers),
    );
  }

  function compilePattern(pattern, config) {
    if (pattern.enabled === false) return null;
    const anchorRe = buildAltRegex(pattern.anchors);
    const objectRe = buildAltRegex(pattern.objects);
    if (!anchorRe) return null;
    if (!objectRe) return null;
    return {
      id: pattern.id,
      categoryId: pattern.categoryId,
      weight: typeof pattern.weight === 'number' ? pattern.weight : 1,
      anchorRe,
      objectRe,
      modifierRe: buildAltRegex(pattern.modifiers),
      evidenceRe: buildEvidenceRegex(patternEvidenceTokens(pattern, config)),
      ignoreNegation: pattern.ignoreNegation === true,
    };
  }

  function hashHost(host) {
    if (!host || typeof host !== 'string') return null;
    let hash = 0x811c9dc5;
    const value = host.toLowerCase();
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    return 'h:' + hash.toString(16).padStart(8, '0');
  }

  function policyChangeSummary(delta) {
    const prefix = 'Policy text changed since your last visit.';
    if (delta === 0) return prefix + ' Review the highlighted clauses for context.';
    const count = Math.abs(delta);
    const noun = count === 1 ? 'match' : 'matches';
    const direction = delta > 0 ? 'more' : 'fewer';
    return `${prefix} ${count} ${direction} local risk ${noun} detected.`;
  }

  function normalizedPolicyText(text) {
    return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function bytesToHex(bytes) {
    return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, '0')).join('');
  }

  async function sha256Fingerprint(text) {
    const normalized = normalizedPolicyText(text);
    const cryptoApi = root.crypto;
    if (!normalized) return null;
    if (!cryptoApi) return null;
    if (!cryptoApi.subtle) return null;
    if (!root.TextEncoder) return null;
    const bytes = new root.TextEncoder().encode(normalized);
    const digest = await cryptoApi.subtle.digest('SHA-256', bytes);
    return `sha256:${bytesToHex(digest)}`;
  }

  function validPolicySnapshot(snapshot) {
    if (!snapshot || snapshot.v !== 2) return false;
    return /^sha256:[a-f0-9]{64}$/.test(String(snapshot.fingerprint || ''));
  }

  function create(options) {
    function engineTooOld(config) {
      if (!config.minEngineVersion) return false;
      return compareVersions(options.engineVersion, config.minEngineVersion) < 0;
    }

    function validateConfig(config) {
      try {
        if (!validHeader(config, options)) return false;
        if (engineTooOld(config)) return false;
        return validSections(config) && validCollections(config);
      } catch (_) {
        return false;
      }
    }

    async function policyFingerprint(text) {
      try { return await sha256Fingerprint(text); }
      catch (_) { return null; }
    }

    function policySnapshotKey(host, pathname) {
      const siteHash = hashHost(host);
      const normalizedPath = String(pathname || '/').replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
      const pathHash = hashHost(normalizedPath);
      if (!siteHash || !pathHash) return null;
      return `${options.policyPrefix}${siteHash.slice(2)}_${pathHash.slice(2)}`;
    }

    function describePolicyChange(previous, current) {
      if (!validPolicySnapshot(previous) || !validPolicySnapshot(current)) return null;
      if (previous.fingerprint === current.fingerprint) return null;
      const before = Number(previous.total) || 0;
      const after = Number(current.total) || 0;
      const delta = after - before;
      return { previousSeenAt: Number(previous.ts) || 0, delta, summary: policyChangeSummary(delta) };
    }

    return { validateConfig, policyFingerprint, policySnapshotKey, describePolicyChange };
  }

  root.PawsOffTosCore = {
    create,
    compareVersions,
    base64ToBytes,
    buildAltRegex,
    buildEvidenceRegex,
    evidenceSpans,
    buildStripRegex,
    hasRequiredArrays,
    hasRequiredSections,
    normalizeReputationResponse,
    gradePresentation,
    findingEvidenceLabel,
    compilePattern,
    hashHost,
    validPolicySnapshot,
  };
}(typeof window !== 'undefined' ? window : globalThis));
