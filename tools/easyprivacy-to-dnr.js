'use strict';

/*
 * EasyPrivacy (Adblock Plus filter syntax) -> MV3 declarativeNetRequest static
 * ruleset converter.
 *
 * Clean-room: our own parser reading the public EasyPrivacy filter text (a
 * data list, not code) and emitting DNR JSON - no third-party extension code
 * copied. Supports only the network-blocking subset of ABP syntax; cosmetic
 * (##), redirect, csp, removeparam, regex (/.../), and other engine-specific
 * filters are skipped because DNR can't express them.
 *
 * Pure + dependency-free so the test harness can exercise it directly. The
 * CLI at the bottom (guarded by require.main) does the file IO for builds.
 */

// Adblock resource-type token -> DNR resourceType.
var RESOURCE_MAP = {
	script: 'script',
	image: 'image',
	stylesheet: 'stylesheet',
	object: 'object',
	xmlhttprequest: 'xmlhttprequest',
	subdocument: 'sub_frame',
	ping: 'ping',
	beacon: 'ping',
	websocket: 'websocket',
	media: 'media',
	font: 'font',
	other: 'other',
	document: 'main_frame',
	csp_report: 'csp_report',
};

// Options we accept but that need no structural change (default DNR behaviour
// already matches, or the nuance is not worth a dropped rule).
// `important` is handled explicitly (it changes precedence), so it is NOT here.
var IGNORE_OPTS = { all: 1, popup: 1 };

// ── Consent-manager CORE assets - NEVER block these ────────────────────────
// A CMP's own bootstrap script / web-worker / IAB Global Vendor List is HOW a
// consent banner renders and how the user's reject is applied. If we block it,
// the banner can't initialise -> can't be rejected -> it re-injects/reloads
// forever (the repubblica/GEDI + sourcepoint loops). Blocking a consent manager
// does NOT protect privacy; it makes the page WORSE, which violates PawsOff's
// fail-open rule. So we drop these BLOCK rules at conversion time.
//
// IMPORTANT: this only ever suppresses `block` rules. `@@` exception/allow
// rules pass through untouched, and the CMP's ANALYTICS sub-paths (e.g.
// `/?log=`, `/analytics?`, collector/ping endpoints) are matched by OTHER
// EasyPrivacy rules and remain blocked - we only spare the consent core.
var CONSENT_MANAGER_ASSET_PATTERNS = [
	/(?:^|[^a-z0-9])cmpworker\./i, // sourcepoint consent web-worker
	/\/s?cmp\d*\.js(?:[?^]|$)/i, // /cmp.js /cmp2.js /cmp3.js /scmp.js
	/\/cmp\/messaging\.js/i, // sourcepoint messaging bridge
	/\/sourcepoint\.js/i, // sourcepoint loader
	/\/bundles\/cmp\.js/i, // bundled cmp loader
	/\bgvl\.json/i, // IAB TCF Global Vendor List
];

/** True if a urlFilter points at a consent manager's own core asset. */
function isConsentManagerAsset(urlFilter) {
	if (!urlFilter) return false;
	var u = String(urlFilter);
	for (var i = 0; i < CONSENT_MANAGER_ASSET_PATTERNS.length; i++) {
		if (CONSENT_MANAGER_ASSET_PATTERNS[i].test(u)) return true;
	}
	return false;
}

function dedupe(arr) {
	var out = [];
	var seen = {};
	for (var i = 0; i < arr.length; i++) {
		if (!seen[arr[i]]) { seen[arr[i]] = 1; out.push(arr[i]); }
	}
	return out;
}

/**
 * Parse a single filter line into a normalized { type, condition } object, or
 * null if the line is a comment / cosmetic / unsupported / inexpressible.
 */
function parseFilterLine(line) {
	if (line == null) return null;
	var s = String(line).trim();
	if (!s) return null;
	if (s.charAt(0) === '!' || s.charAt(0) === '[') return null; // comment / header

	// Cosmetic / scriptlet filters are not expressible in DNR.
	if (s.indexOf('##') !== -1 || s.indexOf('#@#') !== -1 ||
		s.indexOf('#?#') !== -1 || s.indexOf('#$#') !== -1 ||
		s.indexOf('#%#') !== -1) return null;

	var isAllow = false;
	if (s.slice(0, 2) === '@@') { isAllow = true; s = s.slice(2); }

	// Split pattern from options at the first '$'.
	var pattern = s;
	var optStr = '';
	var dollar = s.indexOf('$');
	if (dollar !== -1) { pattern = s.slice(0, dollar); optStr = s.slice(dollar + 1); }
	pattern = pattern.trim();
	if (!pattern) return null;

	// Regex filters (/.../). Skipped: risky to auto-translate to regexFilter.
	if (pattern.length > 1 && pattern.charAt(0) === '/' &&
		pattern.charAt(pattern.length - 1) === '/') return null;

	// DNR urlFilter must be ASCII-only.
	if (/[^\x00-\x7F]/.test(pattern)) return null;

	// Too generic / degenerate.
	if (pattern === '*' || pattern === '||' || pattern === '|' ||
		pattern === '||*' || pattern.length > 1500) return null;

	var cond = {};
	var resourceTypes = [];
	var excludedResourceTypes = [];
	var important = false; // $important: must outrank a matching @@ exception

	if (optStr) {
		var opts = optStr.split(',');
		for (var i = 0; i < opts.length; i++) {
			var opt = opts[i].trim();
			if (!opt) continue;
			var neg = false;
			if (opt.charAt(0) === '~') { neg = true; opt = opt.slice(1); }
			var eq = opt.indexOf('=');
			var key = eq === -1 ? opt : opt.slice(0, eq);
			var val = eq === -1 ? '' : opt.slice(eq + 1);

			if (key === 'third-party' || key === '3p') {
				cond.domainType = neg ? 'firstParty' : 'thirdParty';
				continue;
			}
			if (key === 'first-party' || key === '1p') {
				cond.domainType = neg ? 'thirdParty' : 'firstParty';
				continue;
			}
			if (key === 'match-case') { cond.isUrlFilterCaseSensitive = true; continue; }
			if (key === 'domain' || key === 'from') {
				var inc = [];
				var exc = [];
				val.split('|').forEach(function (d) {
					d = d.trim();
					if (!d) return;
					if (d.charAt(0) === '~') exc.push(d.slice(1)); else inc.push(d);
				});
				if (inc.length) cond.initiatorDomains = inc;
				if (exc.length) cond.excludedInitiatorDomains = exc;
				continue;
			}
			if (Object.prototype.hasOwnProperty.call(RESOURCE_MAP, key)) {
				if (neg) excludedResourceTypes.push(RESOURCE_MAP[key]);
				else resourceTypes.push(RESOURCE_MAP[key]);
				continue;
			}
			if (key === 'important') { important = true; continue; }
			if (Object.prototype.hasOwnProperty.call(IGNORE_OPTS, key)) continue;
			// Anything else (redirect, csp, removeparam, replace, badfilter,
			// genericblock, elemhide, webrtc, cookie, header, denyallow, to,
			// method, ...) -> not expressible -> drop the whole rule.
			return null;
		}
	}

	// DNR forbids both resourceTypes and excludedResourceTypes together; an
	// explicit include list wins.
	if (resourceTypes.length) cond.resourceTypes = dedupe(resourceTypes);
	else if (excludedResourceTypes.length) cond.excludedResourceTypes = dedupe(excludedResourceTypes);

	cond.urlFilter = pattern;
	return { type: isAllow ? 'allow' : 'block', condition: cond, important: important };
}

// DNR precedence (higher wins). Normal: allow(2) > block(1). An ABP `$important`
// rule must beat a matching exception, so important rules are bumped by +2:
// important-allow(4) > important-block(3) > allow(2) > block(1).
function priorityFor(p) {
	var base = p.type === 'allow' ? 2 : 1;
	return p.important ? base + 2 : base;
}

/** Build a complete DNR rule (with id + priority) from one filter line. */
function lineToRule(line, id) {
	var p = parseFilterLine(line);
	if (!p) return null;
	// Never block a consent manager's own core asset (see note above).
	if (p.type === 'block' && isConsentManagerAsset(p.condition.urlFilter)) return null;
	return {
		id: id,
		priority: priorityFor(p),
		action: { type: p.type },
		condition: p.condition,
	};
}

/** Human-readable label for the catch feed, derived from the urlFilter. */
function labelFor(condition) {
	var u = (condition && condition.urlFilter) || '';
	var m = u.match(/^\|\|([^\/^*|]+)/);
	if (m) return m[1];
	m = u.match(/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})/i);
	if (m) return m[1];
	return u.replace(/[|^*]/g, '').slice(0, 40) || 'tracker';
}

/**
 * Convert a blob of filter text into { rules, meta, stats }.
 * - rules: array of DNR rules with sequential ids from opts.startId (default 1)
 * - meta:  { ruleId: label } for the catch feed
 * - dedupes structurally-identical conditions
 */
function convert(text, opts) {
	opts = opts || {};
	var id = opts.startId || 1;
	var max = opts.max || 0;
	var rules = [];
	var meta = {};
	var seen = {};
	var kept = 0;
	var skipped = 0;
	var lines = String(text || '').split(/\r?\n/);
	for (var i = 0; i < lines.length; i++) {
		var p = parseFilterLine(lines[i]);
		if (!p) { skipped++; continue; }
		// Never block a consent manager's own core asset (see note above).
		if (p.type === 'block' && isConsentManagerAsset(p.condition.urlFilter)) { skipped++; continue; }
		var key = p.type + '|' + JSON.stringify(p.condition);
		if (seen[key]) { skipped++; continue; }
		seen[key] = 1;
		rules.push({
			id: id,
			priority: priorityFor(p),
			action: { type: p.type },
			condition: p.condition,
		});
		meta[id] = labelFor(p.condition);
		id++;
		kept++;
		if (max && kept >= max) break;
	}
	return { rules: rules, meta: meta, stats: { kept: kept, skipped: skipped, total: kept + skipped } };
}

module.exports = {
	parseFilterLine: parseFilterLine,
	lineToRule: lineToRule,
	labelFor: labelFor,
	convert: convert,
	isConsentManagerAsset: isConsentManagerAsset,
	CONSENT_MANAGER_ASSET_PATTERNS: CONSENT_MANAGER_ASSET_PATTERNS,
	RESOURCE_MAP: RESOURCE_MAP,
};

// ── CLI: node tools/easyprivacy-to-dnr.js <outDir> <file...> ────────────────
if (require.main === module) {
	var fs = require('fs');
	var path = require('path');
	var argv = process.argv.slice(2);
	if (argv.length < 2) {
		console.error('usage: easyprivacy-to-dnr.js <outDir> <filterFile...>');
		process.exit(1);
	}
	var outDir = argv[0];
	var files = argv.slice(1);
	var blob = files.map(function (f) { return fs.readFileSync(f, 'utf8'); }).join('\n');
	var res = convert(blob, { startId: 1 });
	if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
	fs.writeFileSync(path.join(outDir, 'easyprivacy.json'), JSON.stringify(res.rules));
	fs.writeFileSync(path.join(outDir, 'easyprivacy-meta.json'), JSON.stringify(res.meta));
	var blocks = res.rules.filter(function (r) { return r.action.type === 'block'; }).length;
	var allows = res.rules.length - blocks;
	console.log('sources : ' + files.length);
	console.log('kept    : ' + res.stats.kept + ' rules (' + blocks + ' block / ' + allows + ' allow)');
	console.log('skipped : ' + res.stats.skipped + ' lines');
}
