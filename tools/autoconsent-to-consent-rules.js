'use strict';
// autoconsent-to-consent-rules.js
//
// Clean-room converter: reads DuckDuckGo `autoconsent` rule JSON (MPL-2.0)
// and emits two ConsentGhost signed-config shapes:
//   { schemaVersion:1, configVersion, source, frameworks:[ {name,
//     containerSelector, rejectSelectors, pierceShadow, enabled} ] }
//   { schemaVersion:2, configVersion, source, frameworks:[ {name,
//     selectors:{containers,directReject,openPreferences,save:[],completion}} ] }
//
// Both outputs contain declarative selectors only, never action `steps`. V2
// assigns selectors to constrained semantic roles; local reviewed code owns
// the only allowed state transitions and verifies completion before success.

const fs = require('fs');
const path = require('path');

const SHADOW = />>>/; // autoconsent shadow-piercing combinator
const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_INPUT_BYTES = 40 * 1024 * 1024;
const MAX_INPUT_RULES = 5000;
const MAX_RULE_NODES = 1000;
const MAX_RULE_DEPTH = 16;
const MAX_SELECTORS_PER_RULE = 256;
const MAX_SELECTOR_SOURCE_LENGTH = 8192;
const MAX_NAME_LENGTH = 160;
const MAX_FRAMEWORKS_V1 = 1200;
const MAX_FRAMEWORKS_V2 = 600;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const SELECTOR_NESTING = Object.freeze({
  '[': ['square', 1],
  ']': ['square', -1],
  '(': ['round', 1],
  ')': ['round', -1],
});

function splitSelectors(sel) {
  if (typeof sel !== 'string') return [];
  const out = [];
  const state = { start: 0, square: 0, round: 0, quote: '', invalid: false };
  for (let i = 0; i < sel.length; i += 1) {
    if (selectorBoundary(sel, i, state)) {
      pushSelectorPart(sel, state.start, i, out);
      state.start = i + 1;
    }
  }
  if (!selectorStateClosed(state)) return [];
  pushSelectorPart(sel, state.start, sel.length, out);
  return out;
}

function selectorStateClosed(state) {
  if (state.invalid) return false;
  if (state.quote) return false;
  return state.square === 0 && state.round === 0;
}

function pushSelectorPart(selector, start, end, out) {
  const part = selector.slice(start, end).trim();
  if (part) out.push(part);
}

function isEscapedAt(selector, index) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && selector[cursor] === '\\'; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function updateSelectorNesting(ch, state) {
  const nesting = SELECTOR_NESTING[ch];
  if (!nesting) return;
  const [field, change] = nesting;
  if (change < 0 && state[field] === 0) state.invalid = true;
  state[field] += change;
}

function consumeQuotedCharacter(selector, index, state) {
  if (!state.quote) return false;
  const closesQuote = selector[index] === state.quote && !isEscapedAt(selector, index);
  if (closesQuote) state.quote = '';
  return true;
}

function openSelectorQuote(ch, state) {
  if (ch !== '"' && ch !== "'") return false;
  state.quote = ch;
  return true;
}

function consumeSelectorSyntax(selector, index, state) {
  if (consumeQuotedCharacter(selector, index, state)) return true;
  if (isEscapedAt(selector, index)) return true;
  return openSelectorQuote(selector[index], state);
}

function selectorBoundary(selector, index, state) {
  const ch = selector[index];
  if (consumeSelectorSyntax(selector, index, state)) return false;
  updateSelectorNesting(ch, state);
  if (ch !== ',') return false;
  if (state.square) return false;
  if (state.round) return false;
  return true;
}

function uniq(arr) { return Array.from(new Set(arr)); }

function ruleBudget() {
  return { nodes: 0, selectors: 0 };
}

function consumeRuleNode(state) {
  state.nodes += 1;
  if (state.nodes > MAX_RULE_NODES) throw new Error('AutoConsent rule exceeds its node cap');
}

function consumeSelector(state) {
  state.selectors += 1;
  if (state.selectors > MAX_SELECTORS_PER_RULE) {
    throw new Error('AutoConsent rule exceeds its selector cap');
  }
}

// Collect click-type selectors from an optOut step list, recursing into
// then/else branches. Semantic classification happens before publication so
// preference, Save, and Accept controls can never become reject actions.
function collectClickSelectors(steps, out, state = ruleBudget(), depth = 0) {
  if (!Array.isArray(steps)) return out;
  if (depth > MAX_RULE_DEPTH) throw new Error('AutoConsent rule exceeds its recursion cap');
  for (const step of steps) {
    consumeRuleNode(state);
    collectStepClicks(step, out, state, depth);
  }
  return out;
}

function appendClickSelectors(value, out, state) {
  if (typeof value !== 'string') return;
  if (value.length > MAX_SELECTOR_SOURCE_LENGTH) {
    throw new Error('AutoConsent selector source exceeds its length cap');
  }
  for (const selector of splitSelectors(value)) {
    consumeSelector(state);
    out.push(selector);
  }
}

function collectStepClicks(step, out, state, depth) {
  if (!step || typeof step !== 'object') return;
  appendClickSelectors(step.click, out, state);
  appendClickSelectors(step.waitForThenClick, out, state);
  collectClickSelectors(step.then, out, state, depth + 1);
  collectClickSelectors(step.else, out, state, depth + 1);
}

// Container indicators come from detectPopup (preferred — it is the visible
// banner) then detectCmp (presence of the CMP at all).
function collectDetectorSelectors(rule, state = ruleBudget()) {
  const out = [];
  appendDetectorSelectors(rule.detectPopup, out, state);
  appendDetectorSelectors(rule.detectCmp, out, state);
  return out;
}

function detectorSelector(detector) {
  if (!detector || typeof detector !== 'object') return null;
  if (typeof detector.visible === 'string') return detector.visible;
  if (typeof detector.exists === 'string') return detector.exists;
  return null;
}

function appendDetectorSelectors(detectors, out, state) {
  if (!Array.isArray(detectors)) return;
  for (const detector of detectors) {
    consumeRuleNode(state);
    appendClickSelectors(detectorSelector(detector), out, state);
  }
}

function normalizedRuleName(rule) {
  if (!rule || typeof rule !== 'object') return null;
  if (typeof rule.name !== 'string') return null;
  const name = rule.name.trim();
  if (!name) return null;
  if (name.length > MAX_NAME_LENGTH) throw new Error('AutoConsent rule name exceeds its length cap');
  return name;
}

function parseRule(rule) {
  const name = normalizedRuleName(rule);
  if (!name) return null;
  const state = ruleBudget();
  const detectors = uniq(collectDetectorSelectors(rule, state)).filter(isSafeSelector);
  const rejects = uniq(collectClickSelectors(rule.optOut, [], state))
    .filter((selector) => selectorRole(selector) === 'directReject');
  if (!detectors.length) return null;
  if (!rejects.length) return null;
  const pierceShadow = detectors.concat(rejects).some((s) => SHADOW.test(s));
  return {
    name,
    containerSelector: detectors.join(', '),
    rejectSelectors: rejects,
    pierceShadow,
    enabled: true,
  };
}

const REJECT_HINT = /(?:reject|declin|deny|denied|refus|disagree|opt[\s_-]?out|accept[\s_-]?(?:none|nothing|necessary|essential)|only[\s_-]?(?:necessary|essential)|necessary[\s_-]?only|essential[\s_-]?only|disable|all[\s_-]?off|do[\s_-]?not[\s_-]?(?:consent|sell)|no[\s_-]?consent|without[\s_-]?accept)/i;
const NEGATIVE_ACCEPT_HINT = /accept[\s_-]?(?:none|nothing|necessary|essential)/i;
const PREFERENCES_HINT = /(?:preference|setting|manage|configure|customi[sz]|adjust|options?|choices?|detail)/i;
const ACCEPT_HINT = /(?:^|[^a-z0-9])(?:accept|agree|allow)(?:$|[^a-z0-9])|consent[\s_-]?all|save[\s_-]?(?:and|&)[\s_-]?accept|confirm[\s_-]?accept/i;
const SAVE_HINT = /(?:save|confirm|submit)/i;

function validSelectorSegment(segment) {
  const state = { square: 0, round: 0, quote: '', invalid: false };
  for (let i = 0; i < segment.length; i += 1) {
    if (!consumeSelectorSyntax(segment, i, state)) {
      updateSelectorNesting(segment[i], state);
    }
  }
  return selectorStateClosed(state);
}

function structurallySafeSelector(value) {
  if (/^(?:\/\/|\(\/\/)/.test(value)) return false;
  const segments = value.split('>>>').map((part) => part.trim());
  if (segments.some((part) => !part)) return false;
  return segments.every(validSelectorSegment);
}

function isSafeSelector(selector) {
  if (typeof selector !== 'string') return false;
  const value = selector.trim();
  if (!value || value.length > 512) return false;
  if (/(?:xpath|javascript:|[{}\0])/i.test(value)) return false;
  return structurallySafeSelector(value);
}

function selectorRole(selector) {
  if (!isSafeSelector(selector)) return null;
  const value = selector.trim();
  const rejectHint = REJECT_HINT.test(value);
  const acceptHint = ACCEPT_HINT.test(value);
  if (SAVE_HINT.test(value)) return null;
  if (acceptHint && !NEGATIVE_ACCEPT_HINT.test(value)) return null;
  if (rejectHint) return 'directReject';
  if (PREFERENCES_HINT.test(value)) return 'openPreferences';
  return null;
}

function collectRoleSelectors(steps, roles, state = ruleBudget(), depth = 0) {
  if (!Array.isArray(steps)) return roles;
  if (depth > MAX_RULE_DEPTH) throw new Error('AutoConsent rule exceeds its recursion cap');
  for (const step of steps) {
    consumeRuleNode(state);
    collectStepRoles(step, roles, state, depth);
  }
  return roles;
}

function collectVerbRoles(step, verb, roles, state) {
  if (typeof step[verb] !== 'string') return;
  if (step[verb].length > MAX_SELECTOR_SOURCE_LENGTH) {
    throw new Error('AutoConsent selector source exceeds its length cap');
  }
  for (const selector of splitSelectors(step[verb])) {
    consumeSelector(state);
    const role = selectorRole(selector);
    if (role) roles[role].push(selector);
  }
}

function collectStepRoles(step, roles, state, depth) {
  if (!step || typeof step !== 'object') return;
  collectVerbRoles(step, 'click', roles, state);
  collectVerbRoles(step, 'waitForThenClick', roles, state);
  collectRoleSelectors(step.then, roles, state, depth + 1);
  collectRoleSelectors(step.else, roles, state, depth + 1);
}

function parseRuleV2(rule) {
  const name = normalizedRuleName(rule);
  if (!name) return null;
  const state = ruleBudget();
  const containers = uniq(collectDetectorSelectors(rule, state)).filter(isSafeSelector);
  const roles = collectRoleSelectors(rule.optOut, {
    directReject: [],
    openPreferences: [],
  }, state);
  roles.directReject = uniq(roles.directReject);
  roles.openPreferences = uniq(roles.openPreferences);
  if (!containers.length) return null;
  if (!roles.directReject.length) return null;
  return {
    name,
    enabled: true,
    pierceShadow: containers.concat(roles.directReject, roles.openPreferences)
      .some((selector) => SHADOW.test(selector)),
    selectors: {
      containers,
      directReject: roles.directReject,
      openPreferences: roles.openPreferences,
      save: [],
      completion: containers,
    },
  };
}

// Accept: array of rules | { autoconsent:[...] } | a single rule object.
function normalizeRules(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.autoconsent)) return parsed.autoconsent;
  if (!parsed || typeof parsed !== 'object') return [];
  if (parsed.detectCmp) return [parsed];
  if (parsed.optOut) return [parsed];
  return [];
}

function collectFrameworks(rules, parse, maxFrameworks) {
  const frameworks = [];
  const seen = new Set();
  let skipped = 0;
  for (const rule of rules) {
    const entry = parse(rule);
    const key = entry && entry.name.toLowerCase();
    if (!entry || seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    frameworks.push(entry);
    if (frameworks.length > maxFrameworks) {
      throw new Error('AutoConsent output exceeds its framework cap');
    }
  }
  return { frameworks, skipped };
}

function releaseVersions(opts) {
  if (!/^\d{14}$/.test(opts.configVersion || '')) {
    throw new Error('autoconsent configVersion must be an explicit 14-digit release version');
  }
  if (opts.v2ConfigVersion !== `${opts.configVersion}.2`) {
    throw new Error('autoconsent v2ConfigVersion must explicitly extend configVersion');
  }
  return { v1: opts.configVersion, v2: opts.v2ConfigVersion };
}

function nextInputByteTotal(total, size, file = 'input') {
  const next = total + size;
  if (next > MAX_TOTAL_INPUT_BYTES) {
    throw new Error(`AutoConsent inputs exceed ${MAX_TOTAL_INPUT_BYTES} bytes before reading: ${file}`);
  }
  return next;
}

function consentConfig(input) {
  return {
    schemaVersion: input.schemaVersion,
    configVersion: input.configVersion,
    source: 'autoconsent',
    sourceVersion: input.options.sourceVersion || null,
    sourceUrl: input.options.sourceUrl || 'https://github.com/duckduckgo/autoconsent',
    sourceLicense: 'MPL-2.0',
    attribution: input.attribution,
    frameworks: input.frameworks,
  };
}

function outputByteLimit(opts) {
  const requested = Number.isSafeInteger(opts.maxOutputBytes) && opts.maxOutputBytes > 0
    ? opts.maxOutputBytes
    : MAX_OUTPUT_BYTES;
  return Math.min(requested, MAX_OUTPUT_BYTES);
}

function validateConfigSize(config, opts) {
  if (Buffer.byteLength(JSON.stringify(config)) > outputByteLimit(opts)) {
    throw new Error('AutoConsent output exceeds its serialized byte cap');
  }
}

function convert(rules, opts = {}) {
  const versions = releaseVersions(opts);
  const arr = normalizeRules(rules);
  if (arr.length > MAX_INPUT_RULES) throw new Error('AutoConsent input exceeds its rule cap');
  const v1 = collectFrameworks(arr, parseRule, MAX_FRAMEWORKS_V1);
  const v2 = collectFrameworks(arr, parseRuleV2, MAX_FRAMEWORKS_V2);
  const frameworks = v1.frameworks;
  const roleFrameworks = v2.frameworks;
  const attribution = 'Rules derived from DuckDuckGo AutoConsent; source data remains available under MPL-2.0.';
  const config = consentConfig({
    schemaVersion: 1,
    configVersion: versions.v1,
    frameworks,
    options: opts,
    attribution,
  });
  const v2Config = consentConfig({
    schemaVersion: 2,
    configVersion: versions.v2,
    frameworks: roleFrameworks,
    options: opts,
    attribution,
  });
  validateConfigSize(config, opts);
  validateConfigSize(v2Config, opts);
  return {
    config,
    v2Config,
    stats: {
      total: arr.length,
      emitted: frameworks.length,
      skipped: v1.skipped,
      emittedV2: roleFrameworks.length,
      skippedV2: v2.skipped,
    },
  };
}

module.exports = {
  MAX_FRAMEWORKS_V1,
  MAX_FRAMEWORKS_V2,
  MAX_INPUT_RULES,
  MAX_TOTAL_INPUT_BYTES,
  MAX_NAME_LENGTH,
  MAX_OUTPUT_BYTES,
  MAX_RULE_DEPTH,
  MAX_RULE_NODES,
  MAX_SELECTORS_PER_RULE,
  parseRule, convert, splitSelectors, collectClickSelectors,
  collectDetectorSelectors, normalizeRules, collectRoleSelectors,
  parseRuleV2, selectorRole,
  isEscapedAt, isSafeSelector,
  nextInputByteTotal,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const outFile = args[0];
  const inputs = args.slice(1);
  if (!outFile || !inputs.length) {
    console.error('usage: node autoconsent-to-consent-rules.js <out.json> <input.json|dir...>');
    process.exit(2);
  }
  let rules = [];
  let totalInputBytes = 0;
  for (const f of inputs) {
    const stat = fs.statSync(f);
    const files = stat.isDirectory()
      ? fs.readdirSync(f).filter((n) => n.endsWith('.json')).map((n) => path.join(f, n))
      : [f];
    for (const file of files) {
      const size = fs.statSync(file).size;
      if (size > MAX_INPUT_BYTES) {
        throw new Error(`AutoConsent input exceeds ${MAX_INPUT_BYTES} bytes: ${file}`);
      }
      totalInputBytes = nextInputByteTotal(totalInputBytes, size, file);
      rules = rules.concat(normalizeRules(JSON.parse(fs.readFileSync(file, 'utf8'))));
      if (rules.length > MAX_INPUT_RULES) throw new Error('AutoConsent input exceeds its rule cap');
    }
  }
  const configVersion = process.env.PAWSOFF_CONFIG_VERSION;
  const { config, stats } = convert(rules, {
    configVersion,
    v2ConfigVersion: configVersion ? `${configVersion}.2` : '',
  });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(config, null, 2));
  console.log('autoconsent ->', outFile, JSON.stringify(stats));
}
