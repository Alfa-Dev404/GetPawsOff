/* PawsOff — Tier-1 unit tests for the settings page logic (options.js).
 *
 * options.js is mostly DOM (toggles built with createElement + textContent, no
 * innerHTML, for CSP/XSS safety), which is Tier-2 (jsdom). What IS pure and
 * worth locking down is the activity-log plumbing that turns raw storage keys
 * into human-readable rows:
 *   - activityKindOf(): which feature wrote a given storage key (or null)
 *   - collectActivityRows(): gather only activity records, newest first
 *   - activityDetail(): the per-feature one-line summary
 * Plus the PB_PROVIDERS / TS_CATEGORIES taxonomies, which MUST stay in lockstep
 * with pixel-block.js and tos-shield.js or the settings page silently drifts.
 *
 * The harness injects a `module` to read the page's __test hook; init() is gated
 * on DOMContentLoaded so no DOM/storage work runs under test.
 */
'use strict';

const { test, assert, eq } = require('./harness/framework');
const { loadOptions } = require('./harness/sandbox');

const O = loadOptions().internals || {};
const {
  activityKindOf,
  collectActivityRows,
  activityDetail,
  PB_PROVIDERS,
  TS_CATEGORIES,
  PB_SETTINGS,
  TS_SETTINGS,
  CG_DISABLED,
  modeFromEnforcerStatus,
  adaptiveStatusText,
  deltaStatusText,
  statusFromResponse,
  EP_DELTA_ENABLED,
} = O;

test('options: the test hook exposes the pure helpers + taxonomies', () => {
  ['activityKindOf', 'collectActivityRows', 'activityDetail'].forEach((k) => {
    assert(typeof O[k] === 'function', k + ' is a function');
  });
  assert(Array.isArray(PB_PROVIDERS) && Array.isArray(TS_CATEGORIES), 'taxonomies exported');
});

test('activityKindOf: maps each feature key prefix (else null)', () => {
  eq(activityKindOf('__pawsOff_consentGhost_log_123'), 'ConsentGhost');
  eq(activityKindOf('__pawsOff_pixelBlock_event_123'), 'PixelBlock');
  eq(activityKindOf('__pawsOff_tosShield_event_123'), 'ToS Shield');
  eq(activityKindOf('__pawsOff_catch_123'), null, 'catch entries are not activity rows');
  eq(activityKindOf('something_else'), null);
});

test('collectActivityRows: keeps only activity records, newest first', () => {
  const all = {
    '__pawsOff_consentGhost_log_a': { ts: 100 },
    '__pawsOff_pixelBlock_event_b': { ts: 300 },
    '__pawsOff_tosShield_event_c': { ts: 200 },
    '__pawsOff_catch_d': { ts: 999 },      // not an activity record
    '__pawsOff_master_enabled': true,      // unrelated
  };
  const rows = collectActivityRows(all);
  eq(rows.length, 3, 'three activity rows, catch + flag excluded');
  eq(rows[0].ts, 300, 'sorted newest first');
  eq(rows[1].ts, 200);
  eq(rows[2].ts, 100);
  eq(rows[0].kind, 'PixelBlock', 'kind carried through');
});

test('activityDetail: ConsentGhost — status with optional framework', () => {
  eq(activityDetail({ kind: 'ConsentGhost', e: { status: 'rejected', framework: 'OneTrust' } }), 'rejected · OneTrust');
  eq(activityDetail({ kind: 'ConsentGhost', e: { status: 'rejected' } }), 'rejected', 'framework optional');
});

test('activityDetail: PixelBlock — blocked count with optional provider', () => {
  eq(activityDetail({ kind: 'PixelBlock', e: { blocked_count: 3, provider: 'gmail' } }), '3 blocked · gmail');
  eq(activityDetail({ kind: 'PixelBlock', e: {} }), '0 blocked', 'defaults to 0');
});

test('activityDetail: ToS Shield — clause count with optional domain', () => {
  eq(activityDetail({ kind: 'ToS Shield', e: { total: 5, domain: 'x.com' } }), '5 clauses · x.com');
  eq(activityDetail({ kind: 'ToS Shield', e: {} }), '0 clauses');
});

test('PB_PROVIDERS: stays in lockstep with pixel-block (9 providers, iCloud noted)', () => {
  eq(PB_PROVIDERS.length, 9, 'nine webmail providers');
  assert(PB_PROVIDERS.some((p) => p.id === 'gmail'), 'gmail present');
  const icloud = PB_PROVIDERS.find((p) => p.id === 'icloud');
  assert(icloud && typeof icloud.note === 'string' && /iframe/i.test(icloud.note), 'iCloud carries its iframe caveat');
  PB_PROVIDERS.forEach((p) => assert(p.id && p.name, 'every provider has id + name'));
});

test('TS_CATEGORIES: stays in lockstep with tos-shield (12 categories, labelled)', () => {
  eq(TS_CATEGORIES.length, 12, 'twelve clause categories');
  assert(TS_CATEGORIES.some((c) => c.id === 'data_sale'), 'data_sale present');
  TS_CATEGORIES.forEach((c) => assert(c.id && c.label, 'every category has id + label'));
});

test('storage key constants are the shapes the content scripts read', () => {
  eq(PB_SETTINGS, '__pawsOff_pixelBlock_settings');
  eq(TS_SETTINGS, '__pawsOff_tosShield_settings');
  eq(CG_DISABLED, '__pawsOff_consentGhost_disabled');
});

test('adaptive settings: mode and status copy never imply preview is blocking', () => {
  eq(modeFromEnforcerStatus(null), 'standard');
  eq(modeFromEnforcerStatus({ enabled: true, shadow: true }), 'preview');
  eq(modeFromEnforcerStatus({ enabled: true, shadow: false }), 'adaptive');
  assert(/no adaptive network rules/.test(adaptiveStatusText(null)), 'standard is explicit');
  assert(/would block/.test(adaptiveStatusText({
    enabled: true, shadow: true, meta: { wouldBlock: 4, wouldCookieStrip: 2 },
  })), 'preview uses conditional language');
  assert(/4 blocked/.test(adaptiveStatusText({
    enabled: true, shadow: false, exceptions: 1, meta: { blocked: 4, cookieStripped: 2 },
  })), 'adaptive reports active count');
});

test('signed list update copy distinguishes active, preview, and off states', () => {
  eq(EP_DELTA_ENABLED, '__pawsOff_ep_delta_enabled');
  assert(/bundled EasyPrivacy/.test(deltaStatusText({ enabled: false })), 'off explains bundled protection remains');
  assert(/ready in preview/.test(deltaStatusText({ enabled: true, shadow: true, meta: { wouldApply: 7 } })), 'preview is conditional');
  assert(/7 signed tracker rules active/.test(deltaStatusText({ enabled: true, shadow: false, meta: { applied: 7 } })), 'active reports applied count');
  assert(/Status unavailable/.test(deltaStatusText({ enabled: false, unavailable: true })), 'unavailable status is not presented as a confirmed off state');
});

function control(value) {
  const listeners = {};
  return {
    value: value || '',
    checked: false,
    disabled: false,
    textContent: '',
    addEventListener(type, listener) { listeners[type] = listener; },
    fire(type) { return listeners[type] ? listeners[type]({}) : undefined; },
  };
}

test('options status response wiring unwraps envelopes and rejects failures', () => {
  const status = { enabled: true, meta: { applied: 3 } };
  eq(statusFromResponse({ ok: true, status }), status);
  eq(statusFromResponse({ ok: true, enabled: false }).enabled, false);
  eq(statusFromResponse({ ok: false, status }), null);
  eq(statusFromResponse(null), null);
});

test('signed-list toggle disables during writes and refreshes after failure', async () => {
  const input = control();
  const statusNode = control();
  const document = {
    addEventListener() {},
    getElementById(id) { return id === 'ep-delta-enabled' ? input : (id === 'ep-delta-status' ? statusNode : null); },
    querySelectorAll() { return []; },
  };
  let setCallback;
  let statusReads = 0;
  const loaded = loadOptions({
    document,
    sendMessage(message, callback) {
      if (message.type === 'pawsoff_ep_delta_status') {
        statusReads += 1;
        callback({ ok: true, status: { enabled: true, shadow: false, meta: { applied: 2 } } });
      } else setCallback = callback;
    },
  });
  await loaded.internals.renderListUpdates({});
  assert(input.checked, 'status envelope rendered');
  input.checked = false;
  const pending = input.fire('change');
  assert(input.disabled, 'toggle disabled while reconciliation is pending');
  setCallback({ ok: false });
  await pending;
  assert(!input.disabled, 'toggle re-enabled after failure');
  assert(input.checked, 'fresh enabled status replaces the failed optimistic choice');
  eq(statusReads, 2, 'failure triggers a status refresh');
});

test('signed-list toggle preserves prior state when update and refresh both fail', async () => {
  const input = control();
  const statusNode = control();
  const document = {
    addEventListener() {},
    getElementById(id) { return id === 'ep-delta-enabled' ? input : (id === 'ep-delta-status' ? statusNode : null); },
    querySelectorAll() { return []; },
  };
  let setCallback;
  let statusReads = 0;
  const loaded = loadOptions({
    document,
    sendMessage(message, callback) {
      if (message.type === 'pawsoff_ep_delta_status') {
        statusReads += 1;
        callback(statusReads === 1 ? { ok: true, status: { enabled: true } } : { ok: false });
      } else setCallback = callback;
    },
  });
  await loaded.internals.renderListUpdates({});
  input.checked = false;
  const pending = input.fire('change');
  setCallback({ ok: false });
  await pending;
  assert(input.checked, 'the previously confirmed enabled state is restored');
  assert(/Previous setting preserved/.test(statusNode.textContent), 'explicit failure remains visible');
});

test('signed-list missing status preserves the stored preference and reports bundled protection', async () => {
  const input = control();
  const statusNode = control();
  const document = {
    addEventListener() {},
    getElementById(id) { return id === 'ep-delta-enabled' ? input : (id === 'ep-delta-status' ? statusNode : null); },
    querySelectorAll() { return []; },
  };
  const loaded = loadOptions({
    document,
    sendMessage(message, callback) { callback({ ok: false }); },
  });
  await loaded.internals.renderListUpdates({ [EP_DELTA_ENABLED]: false });
  assert(!input.checked, 'stored disabled preference is retained when live status is missing');
  await loaded.internals.renderListUpdates({ [EP_DELTA_ENABLED]: true });
  assert(input.checked, 'stored enabled preference is retained when live status is missing');
  assert(/Status unavailable/.test(statusNode.textContent), 'missing status is explicit');
  assert(/bundled EasyPrivacy/.test(statusNode.textContent), 'baseline protection remains clear');
});

test('adaptive mode controls disable during writes and render direct success', async () => {
  const standard = control('standard');
  const preview = control('preview');
  const adaptive = control('adaptive');
  const statusNode = control();
  const document = {
    addEventListener() {},
    getElementById(id) { return id === 'pv-status' ? statusNode : null; },
    querySelectorAll() { return [standard, preview, adaptive]; },
  };
  let setCallback;
  const loaded = loadOptions({
    document,
    sendMessage(message, callback) {
      if (message.type === 'pawsoff_pv_enforce_status') callback({ ok: true, status: { enabled: false, shadow: false } });
      else setCallback = callback;
    },
  });
  await loaded.internals.renderAdaptive();
  adaptive.checked = true;
  const pending = adaptive.fire('change');
  assert(standard.disabled && preview.disabled && adaptive.disabled, 'all mode controls disabled during reconciliation');
  setCallback({ ok: true, enabled: true, shadow: false, blocked: 4 });
  await pending;
  assert(!standard.disabled && !preview.disabled && !adaptive.disabled, 'controls re-enabled after success');
  assert(adaptive.checked, 'direct mutation response rendered as adaptive');
  assert(/4 blocked/.test(statusNode.textContent), 'real result count rendered');
});

test('adaptive mode preserves its error when the fallback status refresh fails', async () => {
  const standard = control('standard');
  const preview = control('preview');
  const adaptive = control('adaptive');
  const statusNode = control();
  const document = {
    addEventListener() {},
    getElementById(id) { return id === 'pv-status' ? statusNode : null; },
    querySelectorAll() { return [standard, preview, adaptive]; },
  };
  let statusReads = 0;
  let setCallback;
  const loaded = loadOptions({
    document,
    sendMessage(message, callback) {
      if (message.type === 'pawsoff_pv_enforce_status') {
        statusReads += 1;
        callback(statusReads === 1 ? { ok: true, status: { enabled: false, shadow: true } } : { ok: false });
      } else setCallback = callback;
    },
  });
  await loaded.internals.renderAdaptive();
  adaptive.checked = true;
  const pending = adaptive.fire('change');
  setCallback({ ok: false });
  await pending;
  assert(standard.checked && !adaptive.checked, 'last confirmed mode is restored');
  assert(/Could not update local rules/.test(statusNode.textContent), 'failure copy is not replaced by benign status');
});

test('adaptive recalculate disables during work and renders direct success', async () => {
  const standard = control('standard');
  const preview = control('preview');
  const adaptive = control('adaptive');
  const statusNode = control();
  const syncButton = control();
  const document = {
    addEventListener() {},
    getElementById(id) {
      if (id === 'pv-status') return statusNode;
      return id === 'pv-sync' ? syncButton : null;
    },
    querySelectorAll() { return [standard, preview, adaptive]; },
  };
  let syncCallback;
  const loaded = loadOptions({
    document,
    sendMessage(message, callback) {
      if (message.type === 'pawsoff_pv_enforce_status') callback({ ok: true, status: { enabled: true, shadow: false, meta: { blocked: 1 } } });
      else syncCallback = callback;
    },
  });
  await loaded.internals.renderAdaptive();
  const pending = syncButton.fire('click');
  assert(syncButton.disabled, 'Recalculate is disabled while synchronization is pending');
  syncCallback({ ok: true, enabled: true, shadow: false, blocked: 6, cookieStripped: 2 });
  await pending;
  assert(!syncButton.disabled, 'Recalculate is re-enabled after success');
  assert(/6 blocked/.test(statusNode.textContent), 'direct result is rendered');
});

test('adaptive recalculate retains its error when synchronization and refresh fail', async () => {
  const standard = control('standard');
  const preview = control('preview');
  const adaptive = control('adaptive');
  const statusNode = control();
  const syncButton = control();
  const document = {
    addEventListener() {},
    getElementById(id) {
      if (id === 'pv-status') return statusNode;
      return id === 'pv-sync' ? syncButton : null;
    },
    querySelectorAll() { return [standard, preview, adaptive]; },
  };
  let statusReads = 0;
  let syncCallback;
  const loaded = loadOptions({
    document,
    sendMessage(message, callback) {
      if (message.type === 'pawsoff_pv_enforce_status') {
        statusReads += 1;
        callback(statusReads === 1 ? { ok: true, status: { enabled: false, shadow: true } } : { ok: false });
      } else syncCallback = callback;
    },
  });
  await loaded.internals.renderAdaptive();
  const pending = syncButton.fire('click');
  syncCallback({ ok: false });
  await pending;
  assert(!syncButton.disabled, 'Recalculate is re-enabled after failure');
  assert(/Could not recalculate local rules/.test(statusNode.textContent), 'failure remains visible');
});
