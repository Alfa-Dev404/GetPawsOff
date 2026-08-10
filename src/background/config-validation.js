(function (root) {
  'use strict';

  function isPlainObject(value) {
    return [!!value, typeof value === 'object', !Array.isArray(value)].every(Boolean);
  }

  function hasExactKeys(value, allowed, required) {
    if (!isPlainObject(value)) return false;
    const keys = Object.keys(value);
    if (!keys.every((key) => allowed.has(key))) return false;
    return required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
  }

  function finiteInRange(value, minimum, maximum) {
    return [Number.isFinite(value), value >= minimum, value <= maximum].every(Boolean);
  }

  function safeIdentifier(value, maxLength) {
    if (typeof value !== 'string') return false;
    return [
      value.length > 0,
      value.length <= maxLength,
      /^[a-z0-9][a-z0-9._-]*$/i.test(value),
    ].every(Boolean);
  }

  function safeLiteral(value, maxLength) {
    if (typeof value !== 'string') return false;
    return [
      value.trim().length > 0,
      value.length <= maxLength,
      !/[\0\r\n]/.test(value),
    ].every(Boolean);
  }

  function canonicalConfigVersion(value) {
    if (typeof value !== 'string') return false;
    if (!/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))*$/.test(value)) return false;
    return value.split('.').map(Number).every(Number.isSafeInteger);
  }

  function validLiteralList(value, maxItems, maxLength, required) {
    if (!Array.isArray(value)) return false;
    return [
      value.length <= maxItems,
      required ? value.length > 0 : true,
      value.every((item) => safeLiteral(item, maxLength)),
    ].every(Boolean);
  }

  function hasRequiredArrays(config) {
    return Array.isArray(config.categories) && Array.isArray(config.patterns);
  }

  function hasRequiredSections(config) {
    return !!config.pageDetection && !!config.segmentation && !!config.negation && !!config.scoring;
  }

  function validDomainLabel(label) {
    if (!label.length || label.length > 63) return false;
    return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label);
  }

  function validDomainLength(domain) {
    return domain.length >= 4 && domain.length <= 253;
  }

  function isValidDomain(domain) {
    if (typeof domain !== 'string') return false;
    return [
      validDomainLength(domain),
      domain === domain.toLowerCase(),
      domain.indexOf('.') >= 1,
      !domain.endsWith('.'),
      domain.split('.').every(validDomainLabel),
    ].every(Boolean);
  }

  function validDeltaResourceTypes(resourceTypes, allowedTypes) {
    if (resourceTypes === undefined) return true;
    if (!Array.isArray(resourceTypes) || !resourceTypes.length) return false;
    return resourceTypes.every((type) => allowedTypes.has(type));
  }

  function validDeltaEntry(entry, allowedTypes) {
    if (!hasExactKeys(entry, DELTA_ITEM_KEYS, ['domain'])) return false;
    if (!isValidDomain(entry.domain)) return false;
    return validDeltaResourceTypes(entry.resourceTypes, allowedTypes);
  }

  function validNamedConsentFramework(framework, allowed, required) {
    if (!hasExactKeys(framework, allowed, required)) return false;
    if (typeof framework.name !== 'string') return false;
    return framework.name.length > 0 && framework.name.length <= 160;
  }

  function updateConsentSelectorDepth(ch, depth) {
    if (ch === '[') depth.square += 1;
    if (ch === ']') depth.square -= 1;
    if (ch === '(') depth.round += 1;
    if (ch === ')') depth.round -= 1;
  }

  function consumeConsentSelectorQuote(segment, index, state) {
    if (!state.quote) return false;
    if (segment[index] === state.quote && segment[index - 1] !== '\\') state.quote = '';
    return true;
  }

  function openConsentSelectorQuote(ch, state) {
    if (ch !== '"' && ch !== "'") return false;
    state.quote = ch;
    return true;
  }

  function balancedConsentSelectorSegment(segment) {
    const state = { square: 0, round: 0, quote: '' };
    for (let i = 0; i < segment.length; i += 1) {
      const ch = segment[i];
      if (consumeConsentSelectorQuote(segment, i, state)) continue;
      if (openConsentSelectorQuote(ch, state)) continue;
      updateConsentSelectorDepth(ch, state);
      if (state.square < 0 || state.round < 0) return false;
    }
    if (state.quote) return false;
    return state.square === 0 && state.round === 0;
  }

  function balancedConsentSelector(value) {
    const segments = value.split('>>>').map((part) => part.trim());
    if (segments.some((part) => !part)) return false;
    return segments.every(balancedConsentSelectorSegment);
  }

  function isSafeConsentSelector(value, maxLength) {
    if (typeof value !== 'string') return false;
    if (!value.trim().length) return false;
    if (value.length > (maxLength || 512)) return false;
    if (/^(?:\/\/|\(\/\/)/.test(value.trim())) return false;
    if (/(?:xpath|javascript:|[{}\0])/i.test(value)) return false;
    return balancedConsentSelector(value);
  }

  function isConsentSelectorList(value, maxItems, required) {
    if (!Array.isArray(value)) return false;
    if (value.length > maxItems) return false;
    if (required && !value.length) return false;
    return value.every((selector) => isSafeConsentSelector(selector));
  }

  function isValidConsentV1Framework(framework) {
    if (!validNamedConsentFramework(
      framework,
      CONSENT_V1_FRAMEWORK_KEYS,
      ['name', 'containerSelector', 'rejectSelectors'],
    )) return false;
    if (!isSafeConsentSelector(framework.containerSelector, 4096)) return false;
    return [
      isConsentSelectorList(framework.rejectSelectors, 32, true),
      validOptionalBoolean(framework.pierceShadow),
      validOptionalBoolean(framework.enabled),
    ].every(Boolean);
  }

  function emptySaveSelectors(selectors) {
    const save = selectors ? selectors.save : undefined;
    return Array.isArray(save) && save.length === 0;
  }

  function isValidConsentV2Framework(framework) {
    const selectors = framework && framework.selectors;
    return [
      validNamedConsentFramework(framework, CONSENT_V2_FRAMEWORK_KEYS, ['name', 'selectors']),
      hasExactKeys(selectors, CONSENT_V2_SELECTOR_KEYS, Array.from(CONSENT_V2_SELECTOR_KEYS)),
      isConsentSelectorList(selectors ? selectors.containers : undefined, 16, true),
      isConsentSelectorList(selectors ? selectors.directReject : undefined, 24, true),
      isConsentSelectorList(selectors ? selectors.openPreferences : undefined, 12, false),
      isConsentSelectorList(selectors ? selectors.completion : undefined, 16, false),
      emptySaveSelectors(selectors),
      validOptionalBoolean(framework && framework.pierceShadow),
      validOptionalBoolean(framework && framework.enabled),
    ].every(Boolean);
  }

  function validReputationPoint(point) {
    if (!hasExactKeys(point, REPUTATION_POINT_KEYS, Array.from(REPUTATION_POINT_KEYS))) return false;
    if (typeof point.title !== 'string' || point.title.length > 140) return false;
    if (typeof point.topic !== 'string' || point.topic.length > 60) return false;
    return point.severity === 'high' || point.severity === 'med';
  }

  function validReputationGrade(grade) {
    if (grade === null) return true;
    return typeof grade === 'string' && /^[A-E]$/.test(grade);
  }

  function boundedString(value, maxLength) {
    return typeof value === 'string' && value.length <= maxLength;
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
  const PIXEL_TOP_KEYS = new Set(['schemaVersion', 'configVersion', 'providers']);
  const PIXEL_PROVIDER_KEYS = new Set(['id', 'emailBodySelectors', 'excludeSelectors', 'legitimateProxies']);
  const CONSENT_TOP_KEYS = new Set([
    'schemaVersion', 'configVersion', 'source', 'sourceVersion', 'sourceUrl',
    'sourceLicense', 'attribution', 'frameworks',
  ]);
  const CONSENT_V1_FRAMEWORK_KEYS = new Set(['name', 'containerSelector', 'rejectSelectors', 'pierceShadow', 'enabled']);
  const CONSENT_V2_FRAMEWORK_KEYS = new Set(['name', 'enabled', 'pierceShadow', 'selectors']);
  const CONSENT_V2_SELECTOR_KEYS = new Set(['containers', 'directReject', 'openPreferences', 'save', 'completion']);
  const REPUTATION_TOP_KEYS = new Set([
    'schemaVersion', 'configVersion', 'source', 'sourceUrl', 'sourceLicense',
    'licenseUrl', 'attribution', 'modifications', 'services',
  ]);
  const REPUTATION_ENTRY_KEYS = new Set(['name', 'grade', 'flagged']);
  const REPUTATION_POINT_KEYS = new Set(['title', 'topic', 'severity']);
  const DELTA_TOP_KEYS = new Set([
    'schemaVersion', 'configVersion', 'source', 'sourceVersion', 'sourceUrl',
    'sourceLicense', 'licenseUrl', 'attribution', 'modifications', 'domains',
  ]);
  const DELTA_ITEM_KEYS = new Set(['domain', 'resourceTypes']);

  function validTosPageDetection(section) {
    const item = isPlainObject(section) ? section : {};
    return [
      hasExactKeys(item, TOS_PAGE_KEYS, Array.from(TOS_PAGE_KEYS)),
      validLiteralList(item.urlTokens, 128, 120, true),
      validLiteralList(item.titleTokens, 128, 160, true),
      validLiteralList(item.legaleseMarkers, 128, 160, true),
      Number.isSafeInteger(item.minWordCount),
      finiteInRange(item.minWordCount, 50, 100000),
      finiteInRange(item.confidenceThreshold, 0, 1),
    ].every(Boolean);
  }

  function validTosSegmentation(section) {
    const item = isPlainObject(section) ? section : {};
    return [
      hasExactKeys(item, TOS_SEGMENTATION_KEYS, Array.from(TOS_SEGMENTATION_KEYS)),
      validLiteralList(item.abbreviations, 128, 40, false),
      validLiteralList(item.clauseDelimiters, 64, 80, true),
    ].every(Boolean);
  }

  function validTosNegation(section) {
    const item = isPlainObject(section) ? section : {};
    return [
      hasExactKeys(item, TOS_NEGATION_KEYS, Array.from(TOS_NEGATION_KEYS)),
      validLiteralList(item.cues, 128, 80, true),
      item.scope === 'clause',
      finiteInRange(item.penalty, 0, 1),
    ].every(Boolean);
  }

  function validTosScoring(section) {
    const item = isPlainObject(section) ? section : {};
    return [
      hasExactKeys(item, TOS_SCORING_KEYS, Array.from(TOS_SCORING_KEYS)),
      finiteInRange(item.presentThreshold, 0, 10),
      finiteInRange(item.modifierBoost, 0, 10),
      validLiteralList(item.aggravatedModifiers, 128, 160, false),
    ].every(Boolean);
  }

  function validTosCategory(category) {
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

  function validOptionalBoolean(value) {
    return value === undefined || typeof value === 'boolean';
  }

  function validOptionalWeight(value) {
    if (value === undefined) return true;
    return finiteInRange(value, 0, 10);
  }

  function validTosPattern(pattern, categoryIds) {
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

  function validTosSections(config) {
    return [
      validTosPageDetection(config.pageDetection),
      validTosSegmentation(config.segmentation),
      validTosNegation(config.negation),
      validTosScoring(config.scoring),
    ].every(Boolean);
  }

  function validTosCollections(config) {
    const categories = Array.isArray(config.categories) ? config.categories : [];
    const patterns = Array.isArray(config.patterns) ? config.patterns : [];
    const categoryIds = new Set(categories.map((category) => category && category.id));
    const patternIds = new Set(patterns.map((pattern) => pattern && pattern.id));
    return [
      categories.length > 0 && categories.length <= 64,
      patterns.length > 0 && patterns.length <= 512,
      categories.every(validTosCategory),
      categoryIds.size === categories.length,
      patternIds.size === patterns.length,
      patterns.every((pattern) => validTosPattern(pattern, categoryIds)),
    ].every(Boolean);
  }

  function validTosHeader(config, options) {
    const required = [
      'schemaVersion', 'configVersion', 'pageDetection', 'segmentation', 'negation',
      'scoring', 'categories', 'patterns',
    ];
    return [
      hasExactKeys(config, TOS_TOP_KEYS, required),
      config && config.schemaVersion === options.tosSchemaVersion,
      canonicalConfigVersion(config && config.configVersion),
      !config || config.minEngineVersion === undefined || canonicalConfigVersion(config.minEngineVersion),
      !config || config.locale === undefined || config.locale === 'en',
    ].every(Boolean);
  }

  function validPixelProvider(provider) {
    if (!hasExactKeys(provider, PIXEL_PROVIDER_KEYS, ['id'])) return false;
    if (!safeIdentifier(provider.id, 80)) return false;
    const selectorFields = ['emailBodySelectors', 'excludeSelectors'];
    if (!selectorFields.every((key) => provider[key] === undefined || isConsentSelectorList(provider[key], 64, false))) return false;
    return provider.legitimateProxies === undefined ||
      (Array.isArray(provider.legitimateProxies) && provider.legitimateProxies.length <= 64 &&
        provider.legitimateProxies.every(isValidDomain));
  }

  function validReputationEntry(entry) {
    return [
      hasExactKeys(entry, REPUTATION_ENTRY_KEYS, Array.from(REPUTATION_ENTRY_KEYS)),
      boundedString(entry && entry.name, 160),
      validReputationGrade(entry && entry.grade),
      Array.isArray(entry && entry.flagged),
      !entry || !Array.isArray(entry.flagged) || entry.flagged.length <= 25,
      !entry || !Array.isArray(entry.flagged) || entry.flagged.every(validReputationPoint),
    ].every(Boolean);
  }

  function validReputationHeader(config, options) {
    return [
      hasExactKeys(config, REPUTATION_TOP_KEYS, ['schemaVersion', 'configVersion', 'source', 'attribution', 'services']),
      config && config.schemaVersion === options.reputationSchemaVersion,
      canonicalConfigVersion(config && config.configVersion),
      config && config.source === 'tosdr',
      typeof (config && config.attribution) === 'string',
      isPlainObject(config && config.services),
      !Array.isArray(config && config.services),
    ].every(Boolean);
  }

  function configField(config, key) {
    return config ? config[key] : undefined;
  }

  function knownConsentSchema(config, options) {
    if (!config) return false;
    return options.consentSchemaVersions.has(config.schemaVersion);
  }

  function hasConsentFrameworks(config) {
    const frameworks = configField(config, 'frameworks');
    return Array.isArray(frameworks) && frameworks.length > 0;
  }

  function validConsentHeader(config, options) {
    return [
      hasExactKeys(
        config,
        CONSENT_TOP_KEYS,
        ['schemaVersion', 'configVersion', 'source', 'sourceLicense', 'attribution', 'frameworks'],
      ),
      configField(config, 'source') === 'autoconsent',
      knownConsentSchema(config, options),
      canonicalConfigVersion(configField(config, 'configVersion')),
      typeof configField(config, 'sourceLicense') === 'string',
      typeof configField(config, 'attribution') === 'string',
      hasConsentFrameworks(config),
    ].every(Boolean);
  }

  function validDeltaHeader(config, options) {
    return [
      hasExactKeys(
        config,
        DELTA_TOP_KEYS,
        ['schemaVersion', 'configVersion', 'source', 'sourceVersion', 'sourceLicense', 'attribution', 'domains'],
      ),
      config && config.schemaVersion === options.deltaSchemaVersion,
      canonicalConfigVersion(config && config.configVersion),
      config && config.source === 'easyprivacy',
      safeLiteral(config && config.sourceVersion, 80),
      safeLiteral(config && config.sourceLicense, 120),
      safeLiteral(config && config.attribution, 500),
    ].every(Boolean);
  }

  function reputationEntryForHost(host, services, getBaseDomain) {
    const direct = services[host];
    if (direct) return direct;
    const base = getBaseDomain(host);
    if (!base || base === host) return null;
    return services[base] || null;
  }

  function publicReputation(entry) {
    return {
      name: entry.name,
      grade: entry.grade,
      flagged: entry.flagged.slice(0, 10).map((point) => ({
        title: point.title,
        topic: point.topic,
        severity: point.severity,
      })),
    };
  }

  function create(options) {
    const opts = options || {};

    function validateTosConfig(config) {
      return [
        validTosHeader(config, opts),
        !!config && validTosSections(config),
        !!config && validTosCollections(config),
      ].every(Boolean);
    }

    function validateDeltaConfig(config) {
      if (!validDeltaHeader(config, opts)) return false;
      if (!Array.isArray(config.domains)) return false;
      if (config.domains.length > opts.maxDeltaRules) return false;
      return config.domains.every((entry) => validDeltaEntry(entry, opts.deltaAllowedTypes));
    }

    function validateTosReputationConfig(config) {
      if (!validReputationHeader(config, opts)) return false;
      const hosts = Object.keys(config.services);
      if (hosts.length > 50000) return false;
      return hosts.every((host) => isValidDomain(host) && validReputationEntry(config.services[host]));
    }

    function lookupTosReputation(host, config) {
      try {
        if (!config) return null;
        if (!config.services) return null;
        if (typeof host !== 'string') return null;
        const normalized = host.toLowerCase().trim().replace(/^www\./, '').replace(/\.$/, '');
        if (!isValidDomain(normalized)) return null;
        const entry = reputationEntryForHost(normalized, config.services, opts.getBaseDomain);
        return entry ? publicReputation(entry) : null;
      } catch (_) {
        return null;
      }
    }

    function validateConsentConfig(config) {
      if (!validConsentHeader(config, opts)) return false;
      const max = config.schemaVersion === 2 ? 600 : 1200;
      if (config.frameworks.length > max) return false;
      const validateFramework = config.schemaVersion === 2 ? isValidConsentV2Framework : isValidConsentV1Framework;
      return config.frameworks.every(validateFramework);
    }

    function validatePixelBlockConfig(config) {
      if (!hasExactKeys(config, PIXEL_TOP_KEYS, Array.from(PIXEL_TOP_KEYS))) return false;
      if (config.schemaVersion !== opts.pixelSchemaVersion) return false;
      if (!canonicalConfigVersion(config.configVersion)) return false;
      if (!Array.isArray(config.providers) || config.providers.length > 32) return false;
      if (!config.providers.every(validPixelProvider)) return false;
      return new Set(config.providers.map((provider) => provider.id)).size === config.providers.length;
    }

    return {
      validateTosConfig,
      validateDeltaConfig,
      validateTosReputationConfig,
      lookupTosReputation,
      validateConsentConfig,
      validatePixelBlockConfig,
    };
  }

  root.PawsOffConfigValidation = {
    create,
    isPlainObject,
    hasRequiredArrays,
    hasRequiredSections,
    isValidDomain,
  };
}(typeof self !== 'undefined' ? self : globalThis));
