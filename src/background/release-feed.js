/* PawsOff signed-release helpers.
 *
 * This module deliberately contains no fetch, storage, or Chrome API calls. The
 * service worker owns those side effects; this file only validates the signed
 * release manifest, resolves same-origin immutable paths, and verifies that a
 * downloaded feed matches the exact byte length and SHA-256 digest committed
 * by that manifest.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  try { root.PawsOffSignedFeed = api; } catch (_) { /* ignore */ }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const SCHEMA_VERSION = 1;
  const CONFIG_ORIGIN = 'https://config.getpawsoff.app';
  const RELEASE_ID_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,79}$/;
  const FEED_KEY_RE = /^[a-z][A-Za-z0-9]{0,63}$/;
  const VERSION_RE = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))*$/;
  const SHA256_RE = /^[0-9a-f]{64}$/;
  const UTC_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
  const MAX_CLOCK_SKEW_MS = 10 * 60 * 1000;
  const MAX_FEED_BYTES = 5 * 1024 * 1024;
  const MAX_FEEDS = 16;
  const MANIFEST_KEYS = new Set([
    'schemaVersion', 'sequence', 'releaseId', 'generatedAt', 'expiresAt',
    'minimumEngineVersion', 'feeds',
  ]);
  const DESCRIPTOR_KEYS = new Set([
    'path', 'signaturePath', 'sha256', 'bytes', 'configVersion',
    'source', 'sourceVersion', 'sourceLicense', 'attribution',
  ]);
  const SAFE_PATH_CHECKS = [
    (path) => typeof path === 'string',
    (path) => path.length <= 240,
    (path) => path.indexOf('?') === -1,
    (path) => path.indexOf('#') === -1,
    (path) => path.indexOf('\\') === -1,
    (path) => !path.split('/').includes('..'),
  ];

  function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function hasExactKeys(value, allowed, required) {
    if (!isRecord(value)) return false;
    const keys = Object.keys(value);
    if (!keys.every((key) => allowed.has(key))) return false;
    return required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
  }

  function versionParts(value) {
    if (typeof value !== 'string' || !VERSION_RE.test(value)) return null;
    const parts = value.split('.').map(Number);
    return parts.every(Number.isSafeInteger) ? parts : null;
  }

  function compareVersions(a, b) {
    const left = versionParts(a);
    const right = versionParts(b);
    if (!left || !right) return null;
    const count = Math.max(left.length, right.length);
    for (let i = 0; i < count; i += 1) {
      const x = left[i] || 0;
      const y = right[i] || 0;
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  }

  function hasUnsafePathSyntax(path) {
    return !SAFE_PATH_CHECKS.every((check) => check(path));
  }

  function isSafeReleasePath(path, releaseId) {
    if (hasUnsafePathSyntax(path)) return false;
    return path.indexOf(`/releases/${releaseId}/`) === 0;
  }

  function hasValidDescriptorBytes(descriptor) {
    const checks = [
      Number.isSafeInteger(descriptor.bytes),
      descriptor.bytes > 0,
      descriptor.bytes <= MAX_FEED_BYTES,
    ];
    return checks.every(Boolean);
  }

  function hasValidDescriptorVersion(descriptor) {
    return !!versionParts(descriptor.configVersion);
  }

  function validOptionalDescriptorText(value, maxLength) {
    if (value === undefined) return true;
    if (value === null) return true;
    if (typeof value !== 'string') return false;
    return value.length <= maxLength && !/[\0\r\n]/.test(value);
  }

  function hasValidDescriptorMetadata(descriptor) {
    return [
      validOptionalDescriptorText(descriptor.source, 80),
      validOptionalDescriptorText(descriptor.sourceVersion, 80),
      validOptionalDescriptorText(descriptor.sourceLicense, 120),
      validOptionalDescriptorText(descriptor.attribution, 500),
    ].every(Boolean);
  }

  function validateDescriptor(descriptor, releaseId) {
    if (!hasExactKeys(
      descriptor,
      DESCRIPTOR_KEYS,
      ['path', 'signaturePath', 'sha256', 'bytes', 'configVersion'],
    )) return false;
    if (!isSafeReleasePath(descriptor.path, releaseId)) return false;
    if (descriptor.signaturePath !== `${descriptor.path}.sig`) return false;
    if (!SHA256_RE.test(String(descriptor.sha256 || ''))) return false;
    if (!hasValidDescriptorBytes(descriptor)) return false;
    return hasValidDescriptorVersion(descriptor) && hasValidDescriptorMetadata(descriptor);
  }

  function hasValidManifestIdentity(manifest, currentVersion) {
    const compatibility = compareVersions(currentVersion, manifest.minimumEngineVersion);
    const checks = [
      Number.isSafeInteger(manifest.sequence),
      manifest.sequence > 0,
      RELEASE_ID_RE.test(String(manifest.releaseId || '')),
      !!versionParts(manifest.minimumEngineVersion),
      compatibility !== null && compatibility >= 0,
    ];
    return checks.every(Boolean);
  }

  function hasValidManifestWindow(manifest, nowMs, allowExpired) {
    if (typeof manifest.generatedAt !== 'string' || !UTC_TIMESTAMP_RE.test(manifest.generatedAt)) return false;
    if (typeof manifest.expiresAt !== 'string' || !UTC_TIMESTAMP_RE.test(manifest.expiresAt)) return false;
    const generatedAt = Date.parse(manifest.generatedAt);
    const expiresAt = Date.parse(manifest.expiresAt);
    const checks = [
      Number.isFinite(generatedAt),
      Number.isFinite(expiresAt),
      expiresAt > generatedAt,
      generatedAt <= nowMs + MAX_CLOCK_SKEW_MS,
      allowExpired || expiresAt > nowMs,
    ];
    return checks.every(Boolean);
  }

  function hasValidFeeds(manifest) {
    if (!isRecord(manifest.feeds)) return false;
    const keys = Object.keys(manifest.feeds);
    if (!keys.length || keys.length > MAX_FEEDS) return false;
    if (!keys.every((key) => FEED_KEY_RE.test(key))) return false;
    return keys.every((key) => validateDescriptor(manifest.feeds[key], manifest.releaseId));
  }

  function validateManifest(manifest, options) {
    const opts = options || {};
    const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
    const currentVersion = String(opts.currentVersion || '0.0.0');
    if (!hasExactKeys(manifest, MANIFEST_KEYS, Array.from(MANIFEST_KEYS))) return false;
    if (manifest.schemaVersion !== SCHEMA_VERSION) return false;
    if (!hasValidManifestIdentity(manifest, currentVersion)) return false;
    if (!hasValidManifestWindow(manifest, nowMs, !!opts.allowExpired)) return false;
    return hasValidFeeds(manifest);
  }

  function isTrustedReleaseUrl(base, resolved, path) {
    const checks = [
      base.protocol === 'https:',
      resolved.protocol === 'https:',
      base.origin === CONFIG_ORIGIN,
      resolved.origin === CONFIG_ORIGIN,
      resolved.pathname === path,
      !resolved.search,
      !resolved.hash,
    ];
    return checks.every(Boolean);
  }

  function resolveReleaseUrl(manifestUrl, path) {
    if (!isSafeReleasePath(path, path.split('/')[2] || '')) return null;
    try {
      const base = new URL(manifestUrl);
      const resolved = new URL(path, base);
      if (!isTrustedReleaseUrl(base, resolved, path)) return null;
      return resolved.href;
    } catch (_) {
      return null;
    }
  }

  function bytesToHex(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, '0');
    return out;
  }

  function descriptorReleaseId(descriptor) {
    const path = descriptor && descriptor.path;
    return typeof path === 'string' ? path.split('/')[2] : '';
  }

  async function verifyFeedText(rawText, descriptor, cryptoImpl) {
    try {
      if (!validateDescriptor(descriptor, descriptorReleaseId(descriptor))) return false;
      if (!cryptoImpl) return false;
      if (!cryptoImpl.subtle) return false;
      const bytes = new TextEncoder().encode(rawText);
      if (bytes.byteLength !== descriptor.bytes) return false;
      const digest = await cryptoImpl.subtle.digest('SHA-256', bytes);
      return bytesToHex(new Uint8Array(digest)) === descriptor.sha256;
    } catch (_) {
      return false;
    }
  }

  function shouldAdoptManifest(highWaterSequence, candidate) {
    if (!Number.isSafeInteger(highWaterSequence) || highWaterSequence < 0) return false;
    return !!candidate && Number.isSafeInteger(candidate.sequence) && candidate.sequence > highWaterSequence;
  }

  return Object.freeze({
    CONFIG_ORIGIN,
    MAX_FEED_BYTES,
    MAX_FEEDS,
    SCHEMA_VERSION,
    compareVersions,
    isCanonicalVersion: (value) => !!versionParts(value),
    isSafeReleasePath,
    resolveReleaseUrl,
    shouldAdoptManifest,
    validateDescriptor,
    validateManifest,
    verifyFeedText,
  });
}));
