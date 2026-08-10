// options.js, PawsOff settings page.
//
// Loaded as an external file using addEventListener only, to satisfy the
// extension-pages CSP. Reads and writes chrome.storage.local in the shapes the
// content scripts expect, so their storage.onChanged listeners apply changes
// live. All DOM is built with createElement + textContent (never innerHTML) so
// log-derived or page-derived text cannot inject markup.

(function () {
  'use strict';

  const PB_SETTINGS = '__pawsOff_pixelBlock_settings';
  const TS_SETTINGS = '__pawsOff_tosShield_settings';
  const CG_DISABLED = '__pawsOff_consentGhost_disabled';
  const EP_DELTA_ENABLED = '__pawsOff_ep_delta_enabled';

  // Per-site pause, same allow-list every tier honours (ALLOW_KEY). CG_SITES is
  // a hash-only companion map used to list and remove settings-page pauses.
  const ALLOW_KEY = '__pawsOff_allowlist';
  const CG_SITES  = '__pawsOff_consentGhost_sites';

  const PB_EVENT = '__pawsOff_pixelBlock_event_';
  const CG_LOG   = '__pawsOff_consentGhost_log_';
  const TS_EVENT = '__pawsOff_tosShield_event_';

  // Mirrors PROVIDER_CONFIG ids/names in pixel-block.js + the iCloud limitation.
  const PB_PROVIDERS = [
    { id: 'gmail', name: 'Gmail' },
    { id: 'protonmail', name: 'ProtonMail' },
    { id: 'zoho', name: 'Zoho Mail' },
    { id: 'yahoo', name: 'Yahoo Mail' },
    { id: 'outlook', name: 'Outlook' },
    { id: 'fastmail', name: 'Fastmail' },
    { id: 'hey', name: 'HEY' },
    { id: 'tutanota', name: 'Tutanota / Tuta' },
    { id: 'icloud', name: 'iCloud Mail', note: 'Supported with limitations. Email renders in a cross-origin iframe extensions can\u2019t read.' },
  ];

  // Mirrors the ToS Shield category taxonomy (id + label).
  const TS_CATEGORIES = [
    { id: 'data_sale', label: 'Sells or rents your data' },
    { id: 'third_party_sharing', label: 'Shares data with third parties' },
    { id: 'tracking_surveillance', label: 'Tracks you across sites or devices' },
    { id: 'data_retention', label: 'Keeps your data indefinitely' },
    { id: 'content_license', label: 'Claims a licence to your content' },
    { id: 'unilateral_change', label: 'Can change the terms at any time' },
    { id: 'unilateral_termination', label: 'Can suspend or delete your account anytime' },
    { id: 'arbitration_classwaiver', label: 'Forces arbitration / waives class action' },
    { id: 'liability_waiver', label: 'Disclaims liability' },
    { id: 'jurisdiction_choiceoflaw', label: 'Disputes governed by their chosen courts' },
    { id: 'consent_by_use', label: 'You agree just by using the site' },
    { id: 'marketing_sharing', label: 'Uses your data for ads or marketing' },
  ];

  const getAll = () => new Promise((res) => { try { chrome.storage.local.get(null, (r) => res(r || {})); } catch (_) { res({}); } });
  const setKeys = (o) => new Promise((res) => { try { chrome.storage.local.set(o, () => res()); } catch (_) { res(); } });
  // Notify the service worker so a pause/unpause updates DNR allow rules too , 
  // otherwise already-loaded trackers keep being blocked until a reload.
  const msgBg = (o) => new Promise((res) => { try { chrome.runtime.sendMessage(o, (r) => { void chrome.runtime.lastError; res(r); }); } catch (_) { res(); } });
  const removeKeys = (keys) => new Promise((res) => { try { chrome.storage.local.remove(keys, () => res()); } catch (_) { res(); } });

  // ── Per-site pause helpers (pure; mirror popup.js / po-allow.js) ───────────
  // Reuses the shared allow-list (window.PawsOffAllow) — already respected by
  // the DNR, DOM, and ConsentGhost tiers, so this page just adds a UI over it.
  const ALLOW = (typeof window !== 'undefined' && window.PawsOffAllow) ? window.PawsOffAllow : null;
  const ADAPTIVE = (typeof window !== 'undefined' && window.PawsOffAdaptiveMode) ? window.PawsOffAdaptiveMode : null;

  // FNV-1a/32 host digest, identical to po-catch.js / popup.js so the hash we
  // pause matches the hash the content scripts check. Keep in lockstep.
  function hashHost(host) {
    if (!host || typeof host !== 'string') return null;
    let h = 0x811c9dc5;
    const s = host.toLowerCase();
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return 'h:' + h.toString(16).padStart(8, '0');
  }

  // Normalize typed input to a bare domain. Prefer the shared implementation
  // (window.PawsOffAllow) when present so the rules can never drift; fall back to
  // a copy for the (test) realms where the shared model isn't loaded.
  function sharedNormalizedDomain(input) {
    if (!ALLOW) return null;
    if (typeof ALLOW.normDomain !== 'function') return null;
    try { return ALLOW.normDomain(input); } catch (_) { return ''; }
  }

  function hasValidDomainSyntax(domain) {
    if (!/^[a-z0-9.\-]+$/.test(domain)) return false;
    return domain.indexOf('.') >= 0;
  }

  function hasInvalidDomainBoundary(domain) {
    if (domain.charAt(0) === '.') return true;
    if (domain.charAt(domain.length - 1) === '.') return true;
    return domain.indexOf('..') >= 0;
  }

  function normDomain(input) {
    const shared = sharedNormalizedDomain(input);
    if (shared !== null) return shared;
    if (!input || typeof input !== 'string') return '';
    let s = input.trim().toLowerCase().replace(/^[a-z][a-z0-9+.\-]*:\/\//, '').replace(/^[^@\/]*@/, '');
    s = s.split('/')[0].split('?')[0].split('#')[0].split(':')[0].replace(/^www\./, '');
    if (!hasValidDomainSyntax(s)) return '';
    if (hasInvalidDomainBoundary(s)) return '';
    return s;
  }

  function siteHosts(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (!raw.hosts || typeof raw.hosts !== 'object') return null;
    return raw.hosts;
  }

  function validSiteTimestamp(value) {
    if (typeof value !== 'number') return false;
    return value > 0;
  }

  function isSiteHash(value) {
    return typeof value === 'string' && /^h:[0-9a-f]{8}$/.test(value);
  }

  function siteHash(input) {
    if (isSiteHash(input)) return input;
    const domain = normDomain(input);
    return domain ? hashHost(domain) : null;
  }

  // Hash-only companion map: { v:1, hosts: { "h:xxxxxxxx": ts } }.
  // Plaintext keys from older builds are migrated in memory and persisted by
  // renderSites(). All setters return a fresh object.
  function normalizeSiteMap(raw) {
    const st = { v: 1, hosts: {} };
    const hosts = siteHosts(raw);
    if (!hosts) return st;
    Object.keys(hosts).forEach((k) => {
      const key = siteHash(k);
      const ts = hosts[k];
      if (!key) return;
      if (!validSiteTimestamp(ts)) return;
      st.hosts[key] = Math.max(st.hosts[key] || 0, ts);
    });
    return st;
  }
  function addSiteHost(map, input) {
    const st = normalizeSiteMap(map);
    const key = siteHash(input);
    if (key) st.hosts[key] = Date.now();
    return st;
  }
  function removeSiteHost(map, input) {
    const st = normalizeSiteMap(map);
    const key = siteHash(input);
    if (key && st.hosts[key]) delete st.hosts[key];
    return st;
  }
  function sortedSiteHosts(map) {
    const st = normalizeSiteMap(map);
    return Object.keys(st.hosts).sort((a, b) => st.hosts[b] - st.hosts[a]); // newest first
  }

  // ── Paw toggle factory (returns a <label> wrapping the hidden checkbox) ────
  function pawIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 64 64');
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    const shapes = [
      ['ellipse', { cx: '32', cy: '42', rx: '15', ry: '12' }],
      ['circle', { cx: '14', cy: '26', r: '6.5' }],
      ['circle', { cx: '26', cy: '17', r: '6.5' }],
      ['circle', { cx: '38', cy: '17', r: '6.5' }],
      ['circle', { cx: '50', cy: '26', r: '6.5' }],
    ];
    shapes.forEach(([tag, attrs]) => {
      const shape = document.createElementNS(ns, tag);
      Object.keys(attrs).forEach((key) => shape.setAttribute(key, attrs[key]));
      svg.appendChild(shape);
    });
    return svg;
  }

  function pawToggle(checked) {
    const label = document.createElement('label');
    label.className = 'po-toggle';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!checked;
    const track = document.createElement('span'); track.className = 'track';
    const thumb = document.createElement('span'); thumb.className = 'thumb';
    thumb.appendChild(pawIcon());
    track.appendChild(thumb);
    label.appendChild(input); label.appendChild(track);
    return { label, input };
  }

  // opts: { name, desc?, checked, onChange, note? }
  function row(opts) {
    const item = document.createElement('div'); item.className = 'item';
    const text = document.createElement('div'); text.className = 'po-grow';
    const n = document.createElement('div'); n.className = 'name'; n.textContent = opts.name;
    text.appendChild(n);
    if (opts.desc) { const d = document.createElement('div'); d.className = 'desc'; d.textContent = opts.desc; text.appendChild(d); }
    if (opts.note) { const d = document.createElement('div'); d.className = 'desc'; d.textContent = opts.note; d.style.color = 'var(--po-accent-2)'; text.appendChild(d); }
    const { label, input } = pawToggle(opts.checked);
    input.addEventListener('change', () => opts.onChange(input.checked));
    item.appendChild(text); item.appendChild(label);
    return item;
  }

  // ── Renderers ──────────────────────────────────────────────────────────
  async function renderConsent(all) {
    const cb = document.getElementById('cg-enabled');
    cb.checked = all[CG_DISABLED] !== true;
    cb.addEventListener('change', () => setKeys({ [CG_DISABLED]: !cb.checked }));
  }

  // Reconcile one host's pause flag into the SHARED allow-list, then persist it.
  function normalizedAllowState(all) {
    if (ALLOW && typeof ALLOW.normalizeState === 'function') return ALLOW.normalizeState(all[ALLOW_KEY]);
    const stored = all[ALLOW_KEY];
    return stored && typeof stored === 'object' ? stored : { v: 1, sites: {} };
  }

  function fallbackPauseState(allow, originHash, on) {
    allow.sites = allow.sites || {};
    if (on) {
      allow.sites[originHash] = allow.sites[originHash] || { paused: 0, domains: {} };
      allow.sites[originHash].paused = Date.now();
    } else if (allow.sites[originHash]) {
      allow.sites[originHash].paused = 0;
    }
    return allow;
  }

  function pauseState(allow, originHash, on) {
    if (ALLOW && typeof ALLOW.setPaused === 'function') return ALLOW.setPaused(allow, originHash, !!on);
    return fallbackPauseState(allow, originHash, on);
  }

  async function setSitePaused(hostOrHash, on) {
    const nd = normDomain(hostOrHash);
    const oh = siteHash(hostOrHash);
    if (!oh) return false;
    let response;
    if (on) {
      if (!nd) return false;
      response = await msgBg({ type: 'pawsoff_allow_apply', op: 'pauseSite', site: nd });
    } else if (isSiteHash(hostOrHash)) {
      response = await msgBg({ type: 'pawsoff_allow_apply', op: 'unpauseSiteHash', siteHash: oh });
    } else if (nd) {
      response = await msgBg({ type: 'pawsoff_allow_apply', op: 'unpauseSite', site: nd });
    } else {
      return false;
    }
    if (!response || response.ok !== true) return false;
    const all = await getAll();
    const allow = pauseState(normalizedAllowState(all), oh, on);
    await setKeys({ [ALLOW_KEY]: allow });
    return true;
  }

  async function renderSites() {
    const input = document.getElementById('cg-sites-input');
    const addBtn = document.getElementById('cg-sites-add');
    const list = document.getElementById('cg-sites-list');
    if (!list) return;

    async function refresh() {
      const cur = await getAll();
      const normalized = normalizeSiteMap(cur[CG_SITES]);
      if (JSON.stringify(cur[CG_SITES] || null) !== JSON.stringify(normalized)) {
        await setKeys({ [CG_SITES]: normalized });
      }
      const hosts = sortedSiteHosts(normalized);
      list.textContent = '';
      if (!hosts.length) {
        const e = document.createElement('div'); e.className = 'po-sub'; e.textContent = 'No paused sites yet.';
        list.appendChild(e); return;
      }
      hosts.forEach((host) => {
        const item = document.createElement('div'); item.className = 'item';
        const label = 'Paused site ' + host.slice(-4).toUpperCase();
        const name = document.createElement('div'); name.className = 'po-grow'; name.textContent = label;
        const rm = document.createElement('button'); rm.className = 'po-btn'; rm.textContent = 'Remove';
        rm.setAttribute('aria-label', 'Stop pausing ' + label);
        rm.addEventListener('click', async () => {
          if (!(await setSitePaused(host, false))) return;
          const s = await getAll();
          await setKeys({ [CG_SITES]: removeSiteHost(s[CG_SITES], host) });
          refresh();
        });
        item.appendChild(name); item.appendChild(rm);
        list.appendChild(item);
      });
    }

    async function add() {
      const nd = normDomain(input && input.value);
      if (!nd) { if (input) { input.value = ''; input.placeholder = 'Enter a valid domain, e.g. example.com'; } return; }
      if (!(await setSitePaused(nd, true))) return;
      const s = await getAll();
      await setKeys({ [CG_SITES]: addSiteHost(s[CG_SITES], nd) });
      if (input) input.value = '';
      refresh();
    }

    if (addBtn) addBtn.addEventListener('click', add);
    if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    refresh();
  }

  // Shared renderer for a master toggle + a list of per-item toggles. The
  // PixelBlock and ToS Shield sections are the same shape; only the storage key,
  // default settings, DOM ids, sub-map name and item list differ.
  async function renderToggleSection(cfg) {
    const all = cfg.all;
    const settings = (all[cfg.settingsKey] && typeof all[cfg.settingsKey] === 'object') ? all[cfg.settingsKey] : cfg.defaults();
    if (!settings[cfg.mapKey]) settings[cfg.mapKey] = {};

    const master = document.getElementById(cfg.masterId);
    master.checked = settings[cfg.masterFlag] !== false;
    master.addEventListener('change', async () => {
      const s = await cfg.read(); s[cfg.masterFlag] = master.checked; await setKeys({ [cfg.settingsKey]: s });
    });

    const wrap = document.getElementById(cfg.listId);
    wrap.textContent = '';
    for (const it of cfg.items) {
      const on = settings[cfg.mapKey][it.id] !== false;
      wrap.appendChild(row({
        name: cfg.labelOf(it),
        checked: on,
        note: cfg.noteOf ? cfg.noteOf(it) : null,
        onChange: async (checked) => {
          const s = await cfg.read(); if (!s[cfg.mapKey]) s[cfg.mapKey] = {}; s[cfg.mapKey][it.id] = checked; await setKeys({ [cfg.settingsKey]: s });
        },
      }));
    }
  }

  function renderPixel(all) {
    return renderToggleSection({
      all,
      settingsKey: PB_SETTINGS,
      defaults: () => ({ globalEnabled: true, providers: {} }),
      masterId: 'pb-enabled',
      masterFlag: 'globalEnabled',
      listId: 'pb-providers',
      mapKey: 'providers',
      items: PB_PROVIDERS,
      labelOf: (p) => p.name,
      noteOf: (p) => p.note,
      read: readPB,
    });
  }
  async function readPB() {
    const all = await getAll();
    return (all[PB_SETTINGS] && typeof all[PB_SETTINGS] === 'object') ? all[PB_SETTINGS] : { globalEnabled: true, providers: {} };
  }

  function modeFromEnforcerStatus(status) {
    return ADAPTIVE && typeof ADAPTIVE.mode === 'function' ? ADAPTIVE.mode(status) : 'standard';
  }

  function adaptiveStatusText(status) {
    const mode = modeFromEnforcerStatus(status);
    const meta = (status && status.meta) || {};
    if (mode === 'preview') {
      return `${Number(meta.wouldBlock) || 0} would block · ${Number(meta.wouldCookieStrip) || 0} would limit cookies`;
    }
    if (mode === 'adaptive') {
      return `${Number(meta.blocked) || 0} blocked · ${Number(meta.cookieStripped) || 0} cookie-limited · ${Number(status.exceptions) || 0} exceptions`;
    }
    return 'Local learning is active; no adaptive network rules are applied.';
  }

  function deltaStatusText(status) {
    if (status && status.unavailable === true) return 'Status unavailable · bundled EasyPrivacy protection remains active.';
    if (status && status.enabled === false) return 'Off · the bundled EasyPrivacy list still protects you.';
    const meta = statusMeta(status);
    const version = deltaVersionSuffix(meta);
    if (status && status.shadow === true) return `${numericStatusValue(meta.wouldApply)} verified rules ready in preview${version}.`;
    if (Number(meta.applied) > 0) return `${Number(meta.applied)} signed tracker rules active between Store updates${version}.`;
    return 'On · new verified rules apply automatically between Store updates.';
  }

  function statusMeta(status) {
    return status && status.meta ? status.meta : {};
  }

  function numericStatusValue(value) {
    return Number(value) || 0;
  }

  function deltaVersionSuffix(meta) {
    if (typeof meta.configVersion !== 'string') return '';
    return meta.configVersion ? ` · list ${meta.configVersion}` : '';
  }

  function statusFromResponse(response) {
    if (!response || response.ok !== true) return null;
    if (response.status && typeof response.status === 'object') return response.status;
    if (response.meta && typeof response.meta === 'object') return response;
    return { ...response, meta: response };
  }

  async function renderListUpdates(all) {
    const input = document.getElementById('ep-delta-enabled');
    const statusNode = document.getElementById('ep-delta-status');
    if (!input || !statusNode) return;

    function show(status) {
      input.checked = status.enabled !== false;
      statusNode.textContent = deltaStatusText(status);
    }

    const fallbackStatus = {
      enabled: !all || all[EP_DELTA_ENABLED] !== false,
      shadow: false,
      meta: null,
      unavailable: true,
    };
    const response = await msgBg({ type: 'pawsoff_ep_delta_status' });
    show(statusFromResponse(response) || fallbackStatus);
    input.addEventListener('change', async () => {
      const previousEnabled = !input.checked;
      input.disabled = true;
      statusNode.textContent = input.checked ? 'Enabling and reconciling signed rules…' : 'Removing live update rules…';
      const result = await msgBg({ type: 'pawsoff_ep_delta_setEnabled', enabled: input.checked });
      input.disabled = false;
      if (statusFromResponse(result)) show(statusFromResponse(result));
      else {
        const current = await msgBg({ type: 'pawsoff_ep_delta_status' });
        const status = statusFromResponse(current);
        if (status) show(status);
        else {
          input.checked = previousEnabled;
          statusNode.textContent = 'Could not update signed rules. Previous setting preserved.';
        }
      }
    });
  }

  async function renderAdaptive() {
    const radios = Array.from(document.querySelectorAll('input[name="pv-mode"]'));
    const statusNode = document.getElementById('pv-status');
    const syncButton = document.getElementById('pv-sync');
    if (!radios.length || !statusNode) return;
    let displayedMode = 'standard';

    function show(status) {
      const mode = modeFromEnforcerStatus(status);
      displayedMode = mode;
      radios.forEach((radio) => { radio.checked = radio.value === mode; });
      statusNode.textContent = adaptiveStatusText(status);
    }
    async function refresh() {
      const response = await msgBg({ type: 'pawsoff_pv_enforce_status' });
      const status = statusFromResponse(response);
      if (!status) return false;
      show(status);
      return true;
    }
    radios.forEach((radio) => {
      radio.addEventListener('change', async () => {
        if (!radio.checked) return;
        const previousMode = displayedMode;
        radios.forEach((item) => { item.disabled = true; });
        statusNode.textContent = 'Applying mode and reconciling local rules…';
        const response = await msgBg({ type: 'pawsoff_pv_enforce_setMode', mode: radio.value });
        radios.forEach((item) => { item.disabled = false; });
        if (statusFromResponse(response)) show(statusFromResponse(response));
        else if (!(await refresh())) {
          radios.forEach((item) => { item.checked = item.value === previousMode; });
          statusNode.textContent = 'Could not update local rules. Try Recalculate.';
        }
      });
    });
    if (syncButton) syncButton.addEventListener('click', async () => {
      syncButton.disabled = true;
      statusNode.textContent = 'Recalculating from local observations…';
      const response = await msgBg({ type: 'pawsoff_pv_enforce_sync' });
      syncButton.disabled = false;
      const status = statusFromResponse(response);
      if (status) show(status);
      else if (!(await refresh())) statusNode.textContent = 'Could not recalculate local rules. Try again.';
    });
    if (!(await refresh())) statusNode.textContent = 'Local rule status is unavailable.';
  }

  function renderTos(all) {
    return renderToggleSection({
      all,
      settingsKey: TS_SETTINGS,
      defaults: () => ({ enabled: true, categories: {} }),
      masterId: 'ts-enabled',
      masterFlag: 'enabled',
      listId: 'ts-categories',
      mapKey: 'categories',
      items: TS_CATEGORIES,
      labelOf: (c) => c.label,
      read: readTS,
    });
  }
  async function readTS() {
    const all = await getAll();
    return (all[TS_SETTINGS] && typeof all[TS_SETTINGS] === 'object') ? all[TS_SETTINGS] : { enabled: true, categories: {} };
  }

  // Which feature produced a given storage key (null = not an activity record).
  function activityKindOf(k) {
    if (k.startsWith(CG_LOG)) return 'ConsentGhost';
    if (k.startsWith(PB_EVENT)) return 'PixelBlock';
    if (k.startsWith(TS_EVENT)) return 'ToS Shield';
    return null;
  }

  // Gather every activity record from storage, newest first.
  function collectActivityRows(all) {
    const rows = [];
    for (const k of Object.keys(all)) {
      const kind = activityKindOf(k);
      if (!kind) continue;
      const e = all[k] || {};
      rows.push({ ts: e.ts || 0, kind, e });
    }
    rows.sort((a, b) => b.ts - a.ts);
    return rows;
  }

  // Human-readable, per-feature detail string for one activity row.
  function detailSuffix(value) {
    return value ? ' · ' + value : '';
  }

  function activityDetail(r) {
    const e = r.e;
    if (r.kind === 'ConsentGhost') return (e.status || '') + detailSuffix(e.framework);
    if (r.kind === 'PixelBlock') return (e.blocked_count || 0) + ' blocked' + detailSuffix(e.provider);
    if (r.kind === 'ToS Shield') return (e.total || 0) + ' clauses' + detailSuffix(e.domain);
    return '';
  }

  // Build the DOM line for one activity row.
  function activityLine(r) {
    const line = document.createElement('div');
    line.style.padding = '4px 0';
    line.style.borderBottom = '1px dashed var(--po-grid)';
    const when = r.ts ? new Date(r.ts).toLocaleString() : '';
    line.textContent = `[${r.kind}] ${activityDetail(r)}  ·  ${when}`;
    return line;
  }

  function renderActivity(all) {
    const box = document.getElementById('activity');
    box.textContent = '';
    const rows = collectActivityRows(all);
    if (!rows.length) { box.textContent = 'No activity recorded yet.'; return; }
    for (const r of rows.slice(0, 40)) box.appendChild(activityLine(r));
  }

  async function clearLogs() {
    const all = await getAll();
    const keys = Object.keys(all).filter((k) => k.startsWith(CG_LOG) || k.startsWith(PB_EVENT) || k.startsWith(TS_EVENT)
      || k.startsWith('__pawsOff_pixelBlock_log_') || k.startsWith('__pawsOff_tosShield_log_'));
    await removeKeys(keys);
    renderActivity(await getAll());
  }

  async function init() {
    try {
      const all = await getAll();
      await renderConsent(all);
      await renderSites();
      await renderPixel(all);
      await renderListUpdates(all);
      await renderAdaptive();
      await renderTos(all);
      renderActivity(all);
      document.getElementById('clear-logs').addEventListener('click', clearLogs);
      document.getElementById('cg-count').textContent = '10';
    } catch (_) { /* silent */ }
  }

  // ── Test-only export ──────────────────────────────────────────────────────
  // Inert in the browser (extension pages have no CommonJS `module`); the Node
  // test harness injects a `module` object to read these pure helpers without
  // touching the DOM. Mirrors the content scripts' existing __test hook.
  try {
    if (typeof module !== 'undefined' && module.exports) {
      module.exports.__test = {
        activityKindOf,
        collectActivityRows,
        activityDetail,
        PB_PROVIDERS,
        TS_CATEGORIES,
        PB_SETTINGS,
        TS_SETTINGS,
        CG_DISABLED,
        hashHost,
        normDomain,
        isSiteHash,
        siteHash,
        normalizeSiteMap,
        addSiteHost,
        removeSiteHost,
        sortedSiteHosts,
        modeFromEnforcerStatus,
        adaptiveStatusText,
        deltaStatusText,
        statusFromResponse,
        renderListUpdates,
        renderAdaptive,
        renderSites,
        setSitePaused,
        EP_DELTA_ENABLED,
        ALLOW_KEY,
        CG_SITES,
      };
    }
  } catch (_) { /* ignore */ }

  document.addEventListener('DOMContentLoaded', init);
}());
