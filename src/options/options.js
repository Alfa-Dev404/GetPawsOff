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

  // Per-site pause, same allow-list every tier honours (ALLOW_KEY). CG_SITES is
  // a companion map of the domains the user typed here, kept human-readable
  // since the allow-list itself stores only hashes.
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
  // Reuses the shared allow-list (window.PawsOffAllow) - already respected by
  // the DNR, DOM, and ConsentGhost tiers, so this page just adds a UI over it.
  const ALLOW = (typeof window !== 'undefined' && window.PawsOffAllow) ? window.PawsOffAllow : null;

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
  function normDomain(input) {
    if (ALLOW && typeof ALLOW.normDomain === 'function') { try { return ALLOW.normDomain(input); } catch (_) {} }
    if (!input || typeof input !== 'string') return '';
    let s = input.trim().toLowerCase().replace(/^[a-z][a-z0-9+.\-]*:\/\//, '').replace(/^[^@\/]*@/, '');
    s = s.split('/')[0].split('?')[0].split('#')[0].split(':')[0].replace(/^www\./, '');
    if (!/^[a-z0-9.\-]+$/.test(s) || s.indexOf('.') < 0) return '';
    if (s.charAt(0) === '.' || s.charAt(s.length - 1) === '.' || s.indexOf('..') >= 0) return '';
    return s;
  }

  // Companion map of user-typed paused domains: { v:1, hosts: { domain: ts } }.
  // All setters return a fresh object (no mutation of the input).
  function normalizeSiteMap(raw) {
    const st = { v: 1, hosts: {} };
    if (!raw || typeof raw !== 'object' || !raw.hosts || typeof raw.hosts !== 'object') return st;
    Object.keys(raw.hosts).forEach((k) => {
      const nd = normDomain(k);
      const ts = raw.hosts[k];
      if (nd && typeof ts === 'number' && ts > 0) st.hosts[nd] = ts;
    });
    return st;
  }
  function addSiteHost(map, input) {
    const st = normalizeSiteMap(map);
    const nd = normDomain(input);
    if (nd) st.hosts[nd] = Date.now();
    return st;
  }
  function removeSiteHost(map, input) {
    const st = normalizeSiteMap(map);
    const nd = normDomain(input);
    if (nd && st.hosts[nd]) delete st.hosts[nd];
    return st;
  }
  function sortedSiteHosts(map) {
    const st = normalizeSiteMap(map);
    return Object.keys(st.hosts).sort((a, b) => st.hosts[b] - st.hosts[a]); // newest first
  }

  // ── Paw toggle factory (returns a <label> wrapping the hidden checkbox) ────
  function pawToggle(checked) {
    const label = document.createElement('label');
    label.className = 'po-toggle';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!checked;
    const track = document.createElement('span'); track.className = 'track';
    const thumb = document.createElement('span'); thumb.className = 'thumb';
    thumb.innerHTML = '<svg viewBox="0 0 64 64" fill="currentColor"><ellipse cx="32" cy="42" rx="15" ry="12"/><circle cx="14" cy="26" r="6.5"/><circle cx="26" cy="17" r="6.5"/><circle cx="38" cy="17" r="6.5"/><circle cx="50" cy="26" r="6.5"/></svg>';
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
  async function setSitePaused(host, on) {
    const nd = normDomain(host);
    const oh = hashHost(nd);
    if (!oh) return;
    const all = await getAll();
    let allow = (ALLOW && typeof ALLOW.normalizeState === 'function')
      ? ALLOW.normalizeState(all[ALLOW_KEY])
      : (all[ALLOW_KEY] && typeof all[ALLOW_KEY] === 'object' ? all[ALLOW_KEY] : { v: 1, sites: {} });
    if (ALLOW && typeof ALLOW.setPaused === 'function') {
      allow = ALLOW.setPaused(allow, oh, !!on);
    } else {
      allow.sites = allow.sites || {};
      if (on) { allow.sites[oh] = allow.sites[oh] || { paused: 0, domains: {} }; allow.sites[oh].paused = Date.now(); }
      else if (allow.sites[oh]) { allow.sites[oh].paused = 0; }
    }
    await setKeys({ [ALLOW_KEY]: allow });
    // Mirror the popup's unbreak flow so background DNR state follows the toggle.
    await msgBg({ type: 'pawsoff_allow_apply', op: on ? 'pauseSite' : 'unpauseSite', site: nd });
  }

  async function renderSites() {
    const input = document.getElementById('cg-sites-input');
    const addBtn = document.getElementById('cg-sites-add');
    const list = document.getElementById('cg-sites-list');
    if (!list) return;

    async function refresh() {
      const cur = await getAll();
      const hosts = sortedSiteHosts(cur[CG_SITES]);
      list.textContent = '';
      if (!hosts.length) {
        const e = document.createElement('div'); e.className = 'po-sub'; e.textContent = 'No paused sites yet.';
        list.appendChild(e); return;
      }
      hosts.forEach((host) => {
        const item = document.createElement('div'); item.className = 'item';
        const name = document.createElement('div'); name.className = 'po-grow'; name.textContent = host;
        const rm = document.createElement('button'); rm.className = 'po-btn'; rm.textContent = 'Remove';
        rm.setAttribute('aria-label', 'Stop pausing ' + host);
        rm.addEventListener('click', async () => {
          const s = await getAll();
          await setKeys({ [CG_SITES]: removeSiteHost(s[CG_SITES], host) });
          await setSitePaused(host, false);
          refresh();
        });
        item.appendChild(name); item.appendChild(rm);
        list.appendChild(item);
      });
    }

    async function add() {
      const nd = normDomain(input && input.value);
      if (!nd) { if (input) { input.value = ''; input.placeholder = 'Enter a valid domain, e.g. example.com'; } return; }
      const s = await getAll();
      await setKeys({ [CG_SITES]: addSiteHost(s[CG_SITES], nd) });
      await setSitePaused(nd, true);
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
  function activityDetail(r) {
    const e = r.e;
    if (r.kind === 'ConsentGhost') return (e.status || '') + (e.framework ? ' · ' + e.framework : '');
    if (r.kind === 'PixelBlock') return (e.blocked_count || 0) + ' blocked' + (e.provider ? ' · ' + e.provider : '');
    if (r.kind === 'ToS Shield') return (e.total || 0) + ' clauses' + (e.domain ? ' · ' + e.domain : '');
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
        normalizeSiteMap,
        addSiteHost,
        removeSiteHost,
        sortedSiteHosts,
        ALLOW_KEY,
        CG_SITES,
      };
    }
  } catch (_) { /* ignore */ }

  document.addEventListener('DOMContentLoaded', init);
}());
