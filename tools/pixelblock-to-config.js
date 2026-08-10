'use strict';
/* PawsOff — publish the bundled PixelBlock provider table as a signed remote feed.
 *
 * Same gap as ToS Shield patterns: background.js has fetched
 * /pixel-block/pixel-config.json since 0.1.0 and has always got a 404, because
 * the provider table only lived as PROVIDER_CONFIG inside
 * src/content/pixel-block.js. Webmail vendors reshuffle their DOM constantly, so
 * a stale selector means PixelBlock quietly stops finding message bodies until
 * the next Store release. This feed closes that loop.
 *
 * Only the three fields loadRemoteProviderConfig() actually overlays are
 * published (emailBodySelectors, excludeSelectors, legitimateProxies), keyed by
 * provider id. Everything else in PROVIDER_CONFIG — hosts, nativeProtection, the
 * detection logic — stays bundled, because the shipped overlay ignores it and
 * publishing fields nobody reads is just bytes and attack surface.
 *
 * Note the shipped overlay only replaces a field when the remote array is
 * NON-EMPTY, so this feed can add or replace selectors but can never clear them.
 * Empty lists are therefore omitted rather than published. Changing that is a
 * 0.1.0 client-behaviour change and needs a Store release, not a builder edit.
 */

const { isSafeSelector } = require('./autoconsent-to-consent-rules.js');

const SOURCE_NAME = 'pawsoff-bundled';
const SOURCE_URL = 'https://github.com/Alfa-Dev404/GetPawsOff/blob/main/src/content/pixel-block.js';
const SOURCE_LICENSE = 'MPL-2.0';
const ATTRIBUTION = 'PixelBlock webmail provider selectors, PawsOff, MPL-2.0.';

const MAX_PROVIDERS = 64;
const MAX_SELECTORS = 32;
const MAX_PROXIES = 32;
const OVERLAY_FIELDS = ['emailBodySelectors', 'excludeSelectors', 'legitimateProxies'];
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HOST_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Dedupe then cap. Dedupe first so a list padded with repeats cannot push real
 * entries past the limit.
 * @param {*} list
 * @param {(value: string) => boolean} isValid
 * @param {number} max
 * @param {string} label
 * @returns {string[]}
 */
function cleanList(list, isValid, max, label) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new Error(`${label} is not an array`);
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string') throw new Error(`${label} contains a non-string entry`);
    const value = raw.trim();
    if (!value) continue;
    if (!isValid(value)) throw new Error(`${label} contains an unusable entry: ${value}`);
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  if (out.length > max) throw new Error(`${label} exceeds ${max} entries`);
  return out;
}

/** Proxy entries are hostnames the blocker must never touch, not selectors. */
function isProxyHost(value) {
  return HOST_RE.test(value.toLowerCase());
}

/**
 * Project one bundled provider down to its overlayable fields.
 *
 * iframeLimited providers (iCloud) intentionally ship with empty selectors: the
 * message body lives in a cross-origin sandboxed iframe no content script can
 * reach, so detection exists only to surface the limitation in the popup. There
 * is nothing to overlay, and the shipped overlay would ignore empty arrays
 * anyway, so they are skipped rather than published or treated as drift.
 *
 * @param {Object} provider
 * @returns {Object|null} null when the provider has nothing worth publishing
 */
function cleanProvider(provider) {
  if (!isRecord(provider)) throw new Error('provider is not an object');
  if (typeof provider.id !== 'string' || !PROVIDER_ID_RE.test(provider.id)) {
    throw new Error(`provider has an unusable id: ${provider && provider.id}`);
  }
  if (provider.iframeLimited === true) return null;
  const emailBodySelectors = cleanList(
    provider.emailBodySelectors, isSafeSelector, MAX_SELECTORS, `${provider.id}.emailBodySelectors`,
  );
  const excludeSelectors = cleanList(
    provider.excludeSelectors, isSafeSelector, MAX_SELECTORS, `${provider.id}.excludeSelectors`,
  );
  const legitimateProxies = cleanList(
    provider.legitimateProxies, isProxyHost, MAX_PROXIES, `${provider.id}.legitimateProxies`,
  );

  // A provider with no body selectors cannot find a message to scan. That is a
  // broken bundled entry, not something to publish.
  if (!emailBodySelectors.length) {
    throw new Error(`provider ${provider.id} has no usable emailBodySelectors`);
  }

  const out = { id: provider.id, emailBodySelectors };
  if (excludeSelectors.length) out.excludeSelectors = excludeSelectors;
  if (legitimateProxies.length) out.legitimateProxies = legitimateProxies;
  return out;
}

/**
 * @param {Array} bundled PROVIDER_CONFIG as exported by pixel-block.js
 * @param {{configVersion: string}} opts
 * @returns {{config: Object, stats: Object}}
 */
function convert(bundled, opts) {
  const options = opts || {};
  if (!Array.isArray(bundled) || !bundled.length) {
    throw new Error('bundled PixelBlock provider list is empty');
  }
  if (typeof options.configVersion !== 'string' || !options.configVersion) {
    throw new Error('configVersion is required');
  }
  if (bundled.length > MAX_PROVIDERS) throw new Error('too many providers');

  const providers = bundled.map(cleanProvider).filter(Boolean);
  if (!providers.length) throw new Error('no scannable providers left to publish');
  const seen = new Set();
  for (const provider of providers) {
    if (seen.has(provider.id)) throw new Error(`duplicate provider id: ${provider.id}`);
    seen.add(provider.id);
  }

  const config = {
    schemaVersion: 1,
    configVersion: options.configVersion,
    source: SOURCE_NAME,
    sourceUrl: SOURCE_URL,
    sourceLicense: SOURCE_LICENSE,
    attribution: ATTRIBUTION,
    providers,
  };

  return {
    config,
    stats: {
      providers: providers.length,
      selectors: providers.reduce(
        (n, p) => n + p.emailBodySelectors.length + (p.excludeSelectors || []).length, 0,
      ),
      proxies: providers.reduce((n, p) => n + (p.legitimateProxies || []).length, 0),
    },
  };
}

module.exports = {
  convert,
  cleanProvider,
  cleanList,
  isProxyHost,
  OVERLAY_FIELDS,
  MAX_PROVIDERS,
  MAX_SELECTORS,
  SOURCE_NAME,
};
