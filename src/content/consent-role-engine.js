/* PawsOff constrained consent-role state machine.
 *
 * Remote data may identify selectors by one of three reviewed roles. It cannot
 * add verbs, timeouts, branching, XPath, JavaScript, or arbitrary action order.
 * This local engine owns the complete state transition:
 *   explicit reject → verify, OR preferences → explicit reject → verify.
 * If a CMP needs a separate Save click, the engine stands down: a selector
 * labelled "save" cannot prove it is not "save and accept".
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  try { root.PawsOffConsentRoleEngine = api; } catch (_) { /* ignore */ }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const TARGET_WAIT_MS = 3000;
  const COMPLETION_WAIT_MS = 1400;
  const POLL_MS = 100;
  const COMPLETION_ABSENT_POLLS = 3;

  function rolePermission(deps) {
    if (typeof deps.canAct === 'function') return deps.canAct;
    const checks = [deps.isForbidden, deps.isAccept]
      .filter((check) => typeof check === 'function');
    if (!checks.length) return () => false;
    return (target, role) => checks.every((check) => !check(target, role));
  }

  function createConsentRoleEngine(deps) {
    const d = deps || {};
    const doc = d.doc;
    const queryAll = d.queryAll;
    const isVisible = d.isVisible;
    const canAct = rolePermission(d);
    const clickAllowed = d.clickAllowed;
    const sleep = d.sleep;

    function current(check) {
      try { return !check || check(); } catch (_) { return false; }
    }

    function firstAllowedCandidate(candidates, role) {
      return candidates.find((candidate) => isVisible(candidate) && canAct(candidate, role)) || null;
    }

    function firstTarget(root, selectors, pierce, role) {
      if (!root) return null;
      if (!Array.isArray(selectors)) return null;
      if (typeof queryAll !== 'function') return null;
      for (const selector of selectors) {
        const candidate = firstAllowedCandidate(queryAll(root, selector, pierce), role);
        if (candidate) return candidate;
      }
      return null;
    }

    async function waitForTarget(options) {
      for (let elapsed = 0; elapsed <= options.timeoutMs; elapsed += POLL_MS) {
        if (!current(options.check)) return null;
        const target = firstTarget(options.root, options.selectors, options.pierce, options.role);
        if (target) return target;
        if (elapsed < options.timeoutMs) await sleep(POLL_MS);
      }
      return null;
    }

    function hasVisibleCompletionSurface(selectors, pierce) {
      if (!Array.isArray(selectors) || !selectors.length) return false;
      for (const selector of selectors) {
        const candidates = queryAll(doc, selector, pierce);
        if (candidates.some((candidate) => isVisible(candidate))) return true;
      }
      return false;
    }

    async function waitForCompletion(selectors, pierce, check, wasVisible) {
      if (!Array.isArray(selectors) || !selectors.length) return false;
      if (!wasVisible) return false;
      let absentPolls = 0;
      for (let elapsed = 0; elapsed <= COMPLETION_WAIT_MS; elapsed += POLL_MS) {
        if (!current(check)) return false;
        if (hasVisibleCompletionSurface(selectors, pierce)) absentPolls = 0;
        else absentPolls += 1;
        if (elapsed < COMPLETION_WAIT_MS) await sleep(POLL_MS);
      }
      return absentPolls >= COMPLETION_ABSENT_POLLS;
    }

    function canClick(target, check, role) {
      const checks = [
        !!target,
        current(check),
        !!target && canAct(target, role),
        clickAllowed(),
      ];
      return checks.every(Boolean);
    }

    function click(target, check, role) {
      if (!canClick(target, check, role)) return false;
      try { target.click(); return true; } catch (_) { return false; }
    }

    async function finishAfterReject(flow, pierce, check, completionWasVisible) {
      if (await waitForCompletion(flow.completion, pierce, check, completionWasVisible)) {
        return { completed: true, acted: true, stage: 'reject' };
      }
      return { completed: false, acted: true, stage: 'reject-unverified' };
    }

    async function tryDirectReject(flow, container, pierce, check) {
      const direct = firstTarget(container, flow.directReject, pierce, 'directReject');
      if (!direct) return null;
      const completionWasVisible = hasVisibleCompletionSurface(flow.completion, pierce);
      if (!click(direct, check, 'directReject')) return { completed: false, acted: false, stage: 'blocked' };
      return finishAfterReject(flow, pierce, check, completionWasVisible);
    }

    async function tryPreferencesReject(flow, container, pierce, check) {
      const preferences = firstTarget(container, flow.openPreferences, pierce, 'openPreferences');
      if (!preferences) return { completed: false, acted: false, stage: 'no-action' };
      const completionWasVisible = hasVisibleCompletionSurface(flow.completion, pierce);
      if (!click(preferences, check, 'openPreferences')) return { completed: false, acted: false, stage: 'no-action' };
      // Keep the second-layer lookup inside the consent surface we already
      // identified. Portalized controls outside it cannot be safely associated
      // with this CMP, so they are deliberately left for the user.
      const reject = await waitForTarget({
        root: container,
        selectors: flow.directReject,
        pierce,
        timeoutMs: TARGET_WAIT_MS,
        check,
        role: 'directReject',
      });
      if (!reject) return { completed: false, acted: true, stage: 'reject-missing' };
      if (!click(reject, check, 'directReject')) return { completed: false, acted: true, stage: 'reject-missing' };
      return finishAfterReject(flow, pierce, check, completionWasVisible);
    }

    async function run(flow, container, pierce, check) {
      const runnable = [!!flow, !!container, current(check)].every(Boolean);
      if (!runnable) return { completed: false, acted: false, stage: 'idle' };
      const directResult = await tryDirectReject(flow, container, pierce, check);
      return directResult || tryPreferencesReject(flow, container, pierce, check);
    }

    return Object.freeze({ firstTarget, run });
  }

  return Object.freeze({
    COMPLETION_WAIT_MS,
    COMPLETION_ABSENT_POLLS,
    POLL_MS,
    TARGET_WAIT_MS,
    createConsentRoleEngine,
  });
}));
