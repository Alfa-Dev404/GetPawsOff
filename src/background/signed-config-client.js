(function (root) {
  'use strict';

  const PINNED_CONFIG_ORIGIN = 'https://config.getpawsoff.app';
  const adoptionLocks = new Map();

  function bothResponsesOk(first, second) {
    return !!first && !!first.ok && !!second && !!second.ok;
  }

  function parseJson(text) {
    try { return JSON.parse(text); }
    catch (_) { return null; }
  }

  function isPinnedConfigUrl(value, pinnedOrigin) {
    try {
      const url = new URL(value);
      return [
        url.protocol === 'https:',
        !url.username,
        !url.password,
        url.origin === (pinnedOrigin || PINNED_CONFIG_ORIGIN),
      ].every(Boolean);
    } catch (_) {
      return false;
    }
  }

  async function fetchPair(fetchFn, firstUrl, secondUrl, pinnedOrigin) {
    if (!isPinnedConfigUrl(firstUrl, pinnedOrigin) || !isPinnedConfigUrl(secondUrl, pinnedOrigin)) {
      throw new TypeError('signed configuration URL must use the pinned origin');
    }
    return Promise.all([
      fetchFn(firstUrl, { cache: 'no-cache', credentials: 'omit', redirect: 'error' }),
      fetchFn(secondUrl, { cache: 'no-cache', credentials: 'omit', redirect: 'error' }),
    ]);
  }

  async function readPair(responses, boundedResponse, firstLimit, secondLimit) {
    if (!bothResponsesOk(responses[0], responses[1])) return null;
    const texts = await Promise.all([
      boundedResponse.readText(responses[0], firstLimit),
      boundedResponse.readText(responses[1], secondLimit),
    ]);
    if (texts[0] === null || texts[1] === null) return null;
    return texts;
  }

  function storedSequence(stored, key) {
    if (!stored || !Object.prototype.hasOwnProperty.call(stored, key)) return 0;
    const sequence = stored[key];
    return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : null;
  }

  function canFetchRelease(deps) {
    if (!deps.signedFeed) return false;
    if (!deps.publicKey) return false;
    return !!deps.boundedResponse;
  }

  function withAdoptionLock(cacheKey, action) {
    const previous = adoptionLocks.get(cacheKey) || Promise.resolve();
    const current = previous.then(action, action);
    adoptionLocks.set(cacheKey, current);
    return current.finally(() => {
      if (adoptionLocks.get(cacheKey) === current) adoptionLocks.delete(cacheKey);
    });
  }

  function create(deps) {
    let releaseManifestPromise = null;
    let releaseManifestForced = false;

    async function getStoredReleaseState() {
      try {
        if (!deps.signedFeed) return { manifest: null, sequence: 0 };
        const stored = await deps.storage.get([deps.manifestCacheKey, deps.sequenceKey]);
        const candidate = stored && stored[deps.manifestCacheKey];
        const valid = deps.signedFeed.validateManifest(candidate, { currentVersion: deps.currentVersion });
        const sequence = storedSequence(stored, deps.sequenceKey);
        const linked = valid && sequence === candidate.sequence;
        return {
          manifest: linked ? candidate : null,
          sequence,
        };
      } catch (_) {
        return { manifest: null, sequence: 0 };
      }
    }

    async function verifiedManifest(texts, stored) {
      if (!(await deps.verifySignature(texts[0], texts[1]))) {
        await deps.log('release_manifest_sig_invalid');
        return stored.manifest;
      }
      const parsed = parseJson(texts[0]);
      if (!parsed) {
        await deps.log('release_manifest_parse_error');
        return stored.manifest;
      }
      if (!deps.signedFeed.validateManifest(parsed, { currentVersion: deps.currentVersion })) {
        await deps.log('release_manifest_invalid');
        return stored.manifest;
      }
      return withAdoptionLock(`manifest:${deps.manifestCacheKey}:${deps.sequenceKey}`, async () => {
        const current = await getStoredReleaseState();
        if (!deps.signedFeed.shouldAdoptManifest(current.sequence, parsed)) {
          return current.manifest;
        }
        await deps.storage.set({
          [deps.manifestCacheKey]: parsed,
          [deps.sequenceKey]: parsed.sequence,
        });
        return parsed;
      });
    }

    async function fetchReleaseManifest(force) {
      if (!canFetchRelease(deps)) return null;
      const stored = await getStoredReleaseState();
      if (!force) {
        if (stored.manifest) return stored.manifest;
      }
      try {
        const responses = await fetchPair(deps.fetch, deps.manifestUrl, deps.manifestSignatureUrl, deps.configOrigin);
        const texts = await readPair(responses, deps.boundedResponse, deps.manifestMaxBytes, deps.signatureMaxBytes);
        return texts ? verifiedManifest(texts, stored) : stored.manifest;
      } catch (error) {
        await deps.log('release_manifest_fetch_error', { message: error && error.message });
        return stored.manifest;
      }
    }

    async function getReleaseManifest(force) {
      const wantsForce = !!force;
      while (releaseManifestPromise) {
        if (!wantsForce || releaseManifestForced) return releaseManifestPromise;
        await releaseManifestPromise;
      }
      const pending = fetchReleaseManifest(wantsForce);
      releaseManifestPromise = pending;
      releaseManifestForced = wantsForce;
      try { return await pending; }
      finally {
        if (releaseManifestPromise === pending) {
          releaseManifestPromise = null;
          releaseManifestForced = false;
        }
      }
    }

    function releaseDescriptor(manifest, feedKey) {
      return manifest && manifest.feeds ? manifest.feeds[feedKey] : null;
    }

    function releaseUrls(descriptor) {
      if (!descriptor) return null;
      const config = deps.signedFeed.resolveReleaseUrl(deps.manifestUrl, descriptor.path);
      const signature = deps.signedFeed.resolveReleaseUrl(deps.manifestUrl, descriptor.signaturePath);
      return config && signature ? { config, signature } : null;
    }

    async function releaseIntegrityValid(texts, descriptor) {
      const results = await Promise.all([
        deps.verifySignature(texts[0], texts[1]),
        deps.signedFeed.verifyFeedText(texts[0], descriptor, deps.crypto),
      ]);
      return results[0] && results[1];
    }

    async function adoptReleaseConfig(options, descriptor, texts) {
      if (!(await releaseIntegrityValid(texts, descriptor))) {
        await deps.log(`${options.logPrefix}_release_integrity_invalid`);
        return null;
      }
      return adoptReleaseConfigText(options, texts[0], descriptor.configVersion);
    }

    async function fetchReleaseConfig(options) {
      if (!deps.signedFeed || !deps.boundedResponse) return null;
      const descriptor = releaseDescriptor(await getReleaseManifest(options.force), options.feedKey);
      const urls = releaseUrls(descriptor);
      if (!urls) return null;
      try {
        const responses = await fetchPair(deps.fetch, urls.config, urls.signature, deps.configOrigin);
        const texts = await readPair(responses, deps.boundedResponse, deps.signedFeed.MAX_FEED_BYTES, deps.signatureMaxBytes);
        return texts ? adoptReleaseConfig(options, descriptor, texts) : null;
      } catch (error) {
        await deps.log(`${options.logPrefix}_release_fetch_error`, { message: error && error.message });
        return null;
      }
    }

    async function adoptReleaseConfigText(options, text, expectedVersion) {
      const parsed = parseJson(text);
      if (!parsed) {
        await deps.log(`${options.logPrefix}_release_parse_error`);
        return null;
      }
      const versionMatches = expectedVersion === parsed.configVersion;
      if (!options.validate(parsed) || !versionMatches) {
        await deps.log(`${options.logPrefix}_release_config_invalid`);
        return null;
      }
      return withAdoptionLock(options.cacheKey, async () => {
        const cached = await options.getCached();
        if (cached && deps.compareVersions(parsed.configVersion, cached.configVersion) <= 0) return cached;
        await deps.storage.set({ [options.cacheKey]: parsed });
        return parsed;
      });
    }

    return {
      getStoredReleaseState,
      fetchReleaseManifest,
      getReleaseManifest,
      fetchReleaseConfig,
    };
  }

  root.PawsOffSignedConfigClient = {
    create,
    bothResponsesOk,
    isPinnedConfigUrl,
    PINNED_CONFIG_ORIGIN,
  };
}(typeof self !== 'undefined' ? self : globalThis));
