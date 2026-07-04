/*
 * consent-rules-engine.js, PawsOff
 *
 * Dependency-free interpreter for a subset of the autoconsent rule DSL
 * (exists/visible/waitFor/waitForVisible/click/waitForThenClick/wait/hide/
 * removeClass/setStyle/addStyle/cookieContains/if-then-else/any/negated/
 * optional), including array "selector chains" that pierce open shadow DOM
 * and same-origin iframes.
 *
 * Licensing: original PawsOff code, not a port of autoconsent's engine and
 * not a derivative of the MPL-2.0 vendored data in ./vendor/ - it only reads
 * that data (rules + phrase banks) at runtime. Keep it that way.
 *
 * Every side-effecting dependency (document, window, the circuit-breaker
 * gate, page-world eval, the clock) is injected via createConsentEngine(ctx),
 * so it's unit-testable in Node with a fake DOM and safe inside an MV3
 * content script.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PawsOffConsentEngine = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var SUPPORTED_RULE_STEP_VERSION = 2; // we implement v1 + v2 (removeClass/setStyle/addStyle)
  var DEFAULT_STEP_TIMEOUT = 1000;

  function toRegex(p) {
    if (p instanceof RegExp) return p;
    // plain-string phrase -> whole-label, case-insensitive match
    var esc = String(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('^\\s*' + esc + '\\s*$', 'i');
  }

  function anyMatch(text, patterns) {
    if (!text) return false;
    for (var i = 0; i < patterns.length; i++) {
      var p = patterns[i];
      try {
        if (p instanceof RegExp) { p.lastIndex = 0; if (p.test(text)) return true; }
        else if (text.toLowerCase().indexOf(String(p).toLowerCase()) !== -1) return true;
      } catch (_) {}
    }
    return false;
  }

  /**
   * @param {Object} ctx
   *   doc          {Document}  document to operate on (defaults to global)
   *   win          {Window}    window (defaults to global)
   *   clickAllowed {()=>bool}  circuit-breaker gate; clicks are skipped if false
   *   onClick      {(el)=>void}optional notifier after a click is issued
   *   evalInPage   {(id)=>Promise<any>} optional main-world eval bridge
   *   isVisible    {(el)=>bool}optional visibility override (for tests)
   *   neverMatch   {Array}     paywall/subscribe phrase bank (NEVER_MATCH_PATTERNS)
   *   now          {()=>number}clock (defaults to Date.now)
   *   sleep        {(ms)=>Promise} timer (defaults to setTimeout)
   *   log          {(...)=>void} optional debug logger
   */
  function createConsentEngine(ctx) {
    ctx = ctx || {};
    var doc = ctx.doc || (typeof document !== 'undefined' ? document : null);
    var win = ctx.win || (typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null));
    // Fail-open default: with NO breaker wired, stand down (never click) rather
    // than click freely. Production always passes consentClickAllowed.
    var clickAllowed = typeof ctx.clickAllowed === 'function' ? ctx.clickAllowed : function () { return false; };
    var onClick = typeof ctx.onClick === 'function' ? ctx.onClick : function () {};
    var evalInPage = typeof ctx.evalInPage === 'function' ? ctx.evalInPage : null;
    var neverMatch = ctx.neverMatch || [];
    var now = ctx.now || function () { return Date.now(); };
    var sleep = ctx.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var log = ctx.log || function () {};

    function visible(el) {
      if (!el) return false;
      if (typeof ctx.isVisible === 'function') return !!ctx.isVisible(el);
      try {
        if (el.__visible !== undefined) return !!el.__visible; // test hook
        var rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        if (rect && (rect.width === 0 && rect.height === 0)) return false;
        if (win && win.getComputedStyle) {
          var cs = win.getComputedStyle(el);
          if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0)) return false;
        }
        if ('offsetParent' in el && el.offsetParent === null && rect && rect.width === 0) return false;
        return true;
      } catch (_) { return false; } // can't determine visibility → treat as not actionable
    }

    // ---- selector resolution (string | xpath/ | array-chain w/ piercing) ----
    function queryAllIn(scope, sel) {
      if (!scope) return [];
      try {
        if (typeof sel === 'string' && sel.indexOf('xpath/') === 0) {
          var xp = sel.slice('xpath/'.length);
          var ev = (doc && doc.evaluate) ? doc.evaluate(xp, scope, null, 7 /*ORDERED_NODE_SNAPSHOT*/, null) : null;
          var out = [];
          if (ev) for (var i = 0; i < ev.snapshotLength; i++) out.push(ev.snapshotItem(i));
          return out;
        }
        if (scope.querySelectorAll) return Array.prototype.slice.call(scope.querySelectorAll(sel));
      } catch (_) {}
      return [];
    }

    function pierce(node) {
      // Step into open shadow root / same-origin iframe for the NEXT selector.
      if (node && node.shadowRoot) return node.shadowRoot;
      if (node && node.contentDocument) return node.contentDocument;
      return node;
    }

    function querySelectorChain(selectors, rootNode) {
      var scopes = [rootNode || doc];
      for (var s = 0; s < selectors.length; s++) {
        var next = [];
        for (var i = 0; i < scopes.length; i++) {
          var scope = (s === 0) ? scopes[i] : pierce(scopes[i]);
          var found = queryAllIn(scope, selectors[s]);
          for (var j = 0; j < found.length; j++) next.push(found[j]);
        }
        if (!next.length) return [];
        scopes = next;
      }
      return scopes;
    }

    function elementSelector(sel, rootNode) {
      if (Array.isArray(sel)) return querySelectorChain(sel, rootNode);
      return queryAllIn(rootNode || doc, sel);
    }

    function elementExists(sel, rootNode) { return elementSelector(sel, rootNode).length > 0; }

    function elementVisible(sel, check, rootNode) {
      var els = elementSelector(sel, rootNode);
      var mode = check || 'all';
      if (mode === 'none') return els.every(function (e) { return !visible(e); });
      if (mode === 'any') return els.some(function (e) { return visible(e); });
      return els.length > 0 && els.every(function (e) { return visible(e); });
    }

    async function waitFor(predicate, timeout) {
      var deadline = now() + (timeout || DEFAULT_STEP_TIMEOUT);
      // try immediately, then poll
      do {
        if (predicate()) return true;
        await sleep(200);
      } while (now() < deadline);
      return predicate();
    }

    function waitForElement(sel, timeout, rootNode) {
      return waitFor(function () { return elementExists(sel, rootNode); }, timeout);
    }

    function waitForVisible(sel, timeout, check, rootNode) {
      return waitFor(function () { return elementVisible(sel, check, rootNode); }, timeout);
    }

    function doClick(el) {
      if (!el) return false;
      if (!visible(el)) { log('click skipped: target not visible'); return false; } // only act on visible targets
      if (!clickAllowed()) { log('click vetoed by circuit-breaker'); return false; }
      try { el.click(); onClick(el); return true; } catch (_) { return false; }
    }

    function click(sel, all, rootNode) {
      var els = elementSelector(sel, rootNode);
      if (!els.length) return false;
      if (all) {
        var any = false;
        for (var i = 0; i < els.length; i++) { if (doClick(els[i])) any = true; }
        return any;
      }
      return doClick(els[0]);
    }

    async function waitForThenClick(sel, timeout, all, rootNode) {
      await waitForElement(sel, timeout, rootNode);
      return click(sel, all, rootNode);
    }

    function hide(sel, method, rootNode) {
      var els = elementSelector(sel, rootNode);
      els.forEach(function (el) {
        try {
          if (method === 'opacity') { el.style.opacity = '0'; el.style.pointerEvents = 'none'; }
          else el.style.display = 'none';
        } catch (_) {}
      });
      return els.length > 0;
    }

    function removeClass(sel, className, rootNode) {
      var els = elementSelector(sel, rootNode);
      els.forEach(function (el) { try { el.classList && el.classList.remove(className); } catch (_) {} });
      return true;
    }
    function setStyle(sel, css, rootNode) {
      var els = elementSelector(sel, rootNode);
      els.forEach(function (el) { try { el.style.cssText = css; } catch (_) {} });
      return true;
    }
    function addStyle(sel, css, rootNode) {
      var els = elementSelector(sel, rootNode);
      els.forEach(function (el) { try { el.style.cssText = (el.style.cssText ? el.style.cssText + ';' : '') + css; } catch (_) {} });
      return true;
    }

    function cookieContains(sub) {
      try { return (doc && doc.cookie ? doc.cookie : '').indexOf(sub) !== -1; } catch (_) { return false; }
    }

    // ---- step interpreter -----------------------------------------------------
    async function runStep(step, rootNode) {
      if (!step || typeof step !== 'object') return false;
      var negated = !!step.negated;
      var optional = !!step.optional;
      var ok = await runStepInner(step, rootNode);
      if (negated) ok = !ok;
      if (!ok && optional) return true;
      return ok;
    }

    async function runStepInner(step, rootNode) {
      if ('exists' in step) return elementExists(step.exists, rootNode);
      if ('visible' in step) return elementVisible(step.visible, step.check, rootNode);
      if ('waitFor' in step) return await waitForElement(step.waitFor, step.timeout, rootNode);
      if ('waitForVisible' in step) return await waitForVisible(step.waitForVisible, step.timeout, step.check, rootNode);
      if ('click' in step) return click(step.click, step.all, rootNode);
      if ('waitForThenClick' in step) return await waitForThenClick(step.waitForThenClick, step.timeout, step.all, rootNode);
      if ('wait' in step) { await sleep(step.wait); return true; }
      if ('hide' in step) return hide(step.hide, step.method, rootNode);
      if ('removeClass' in step) return removeClass(step.selector, step.removeClass, rootNode);
      if ('setStyle' in step) return setStyle(step.selector, step.setStyle, rootNode);
      if ('addStyle' in step) return addStyle(step.selector, step.addStyle, rootNode);
      if ('cookieContains' in step) return cookieContains(step.cookieContains);
      if ('eval' in step) {
        if (!evalInPage) return false; // page-world eval unsupported in this context
        try { return !!(await evalInPage(step.eval)); } catch (_) { return false; }
      }
      if ('any' in step) {
        for (var i = 0; i < step.any.length; i++) { if (await runStep(step.any[i], rootNode)) return true; }
        return false;
      }
      if ('if' in step) {
        var cond = await runStep(step.if, rootNode);
        var branch = cond ? step.then : step.else;
        if (!branch) return true; // missing else => no-op success (condition itself never fails the step)
        return await runSteps(branch, rootNode);
      }
      return false; // unknown step type
    }

    async function runSteps(steps, rootNode) {
      if (!Array.isArray(steps)) return false;
      for (var i = 0; i < steps.length; i++) {
        var ok = await runStep(steps[i], rootNode);
        if (!ok) return false; // abort chain on first hard failure
      }
      return true;
    }

    // ---- detection helpers (all steps must pass; no waiting in detect) --------
    async function allTrue(steps, rootNode) {
      if (!Array.isArray(steps) || !steps.length) return false;
      for (var i = 0; i < steps.length; i++) { if (!(await runStep(steps[i], rootNode))) return false; }
      return true;
    }

    function ruleStepVersionOk(rule) {
      return (rule.minimumRuleStepVersion || 1) <= SUPPORTED_RULE_STEP_VERSION;
    }

    function runContextOk(rule, isTop) {
      var rc = rule.runContext || {};
      var main = rc.main !== undefined ? rc.main : true;
      var frame = rc.frame !== undefined ? rc.frame : false;
      if (isTop && !main) return false;
      if (!isTop && !frame) return false;
      if (rc.urlPattern) {
        try {
          var href = (win && win.location && win.location.href) || (doc && doc.location && doc.location.href) || '';
          if (!new RegExp(rc.urlPattern).test(href)) return false;
        } catch (_) { return false; } // invalid urlPattern → stand down, don't run the rule
      }
      return true;
    }

    // Gather visible popup text (capped) to screen for paywalls.
    function popupText(rule) {
      var sels = [].concat(rule.prehideSelectors || []);
      // Also screen the detectPopup targets, that's where the banner/wall text
      // actually lives; prehideSelectors alone can miss a pay-or-consent wall.
      (rule.detectPopup || []).forEach(function (step) {
        if (!step || typeof step !== 'object') return;
        var s = step.visible || step.exists || step.waitFor || step.waitForVisible;
        if (s) sels.push(s);
      });
      var txt = '';
      try {
        for (var i = 0; i < sels.length && txt.length < 4000; i++) {
          var els = elementSelector(sels[i]);
          for (var j = 0; j < els.length; j++) {
            txt += ' ' + ((els[j].innerText || els[j].textContent || '').slice(0, 2000));
          }
        }
      } catch (_) {}
      return txt.slice(0, 4000);
    }

    /**
     * Try a single rule against the current page.
     * @returns {Promise<{name, detected, popup, paywall, optedOut, verified}>}
     */
    async function runRule(rule, opts) {
      opts = opts || {};
      var isTop = opts.isTop !== undefined ? opts.isTop : true;
      var res = { name: rule.name, detected: false, popup: false, paywall: false, optedOut: false, verified: null };
      if (!ruleStepVersionOk(rule) || !runContextOk(rule, isTop)) return res;
      res.detected = await allTrue(rule.detectCmp, null);
      if (!res.detected) return res;
      res.popup = rule.detectPopup ? await allTrue(rule.detectPopup, null) : true;
      if (!res.popup) return res;
      // Paywall guard: a "pay or consent" wall has no free reject. We do not
      // engage it; we surface it so the caller can stand down + log honestly.
      if (neverMatch.length && anyMatch(popupText(rule), neverMatch)) {
        res.paywall = true;
        return res;
      }
      if (rule.cosmetic) {
        // cosmetic rules only hide; never claim a real reject
        res.optedOut = await runSteps(rule.optOut, null);
        res.verified = false; // cosmetic = not a verified consent rejection
        return res;
      }
      res.optedOut = await runSteps(rule.optOut, null);
      if (res.optedOut && Array.isArray(rule.test) && rule.test.length) {
        // Only DOM/cookie tests can be verified here; eval tests stay null.
        var verifiable = rule.test.every(function (t) { return !('eval' in t) || evalInPage; });
        if (verifiable) {
          try { res.verified = await allTrue(rule.test, null); } catch (_) { res.verified = null; }
        }
      }
      return res;
    }

    /**
     * Run a list of rules, stopping at the first that opts out (or hits a wall).
     * @returns {Promise<{handled, paywall, rule, verified, attempts}>}
     */
    async function run(rules, opts) {
      opts = opts || {};
      var attempts = 0;
      for (var i = 0; i < rules.length; i++) {
        var rule = rules[i];
        var r;
        try { r = await runRule(rule, opts); } catch (e) { log('rule error', rule && rule.name, e); continue; }
        if (!r.detected) continue;
        attempts++;
        if (r.paywall) return { handled: false, paywall: true, rule: rule.name, verified: null, attempts: attempts };
        if (r.optedOut) return { handled: true, paywall: false, rule: rule.name, verified: r.verified, cosmetic: !!rule.cosmetic, attempts: attempts };
      }
      return { handled: false, paywall: false, rule: null, verified: null, attempts: attempts };
    }

    return {
      // high-level
      run: run,
      runRule: runRule,
      // primitives (exposed for tests + reuse)
      runStep: runStep,
      runSteps: runSteps,
      elementSelector: elementSelector,
      elementExists: elementExists,
      elementVisible: elementVisible,
      querySelectorChain: querySelectorChain,
      waitForElement: waitForElement,
      waitForVisible: waitForVisible,
      click: click,
      waitForThenClick: waitForThenClick,
      hide: hide,
      cookieContains: cookieContains,
      popupText: popupText,
      _visible: visible,
      SUPPORTED_RULE_STEP_VERSION: SUPPORTED_RULE_STEP_VERSION
    };
  }

  return {
    createConsentEngine: createConsentEngine,
    _helpers: { toRegex: toRegex, anyMatch: anyMatch }
  };
});
