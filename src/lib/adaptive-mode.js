/* Shared adaptive-protection mode derivation for extension pages. */
(function (root, factory) {
  'use strict';
  const api = factory();
  try { root.PawsOffAdaptiveMode = api; } catch (_) { /* ignore */ }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  function mode(status) {
    if (!status || status.enabled !== true) return 'standard';
    return status.shadow === false ? 'adaptive' : 'preview';
  }

  return Object.freeze({ mode });
}));
