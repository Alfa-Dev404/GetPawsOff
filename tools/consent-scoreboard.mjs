// Measures ConsentGhost on live sites.
//
//   CHROME_PATH=/path/to/chromium node tools/consent-scoreboard.mjs [sites-file] [out.json]
//
// Each site is visited three times in a fresh profile:
//   baseline   no extension, to see whether a consent banner appears from here
//   full       the packaged extension as shipped
//   heuristic  the extension with every named-CMP rule set removed, so only
//              the generic banner heuristics can act
//
// Needs a Chromium build that still honours --load-extension (branded Chrome
// 137+ does not). No npm dependencies: it speaks the DevTools protocol over
// Node's built-in WebSocket. Banner presence depends on where you browse from,
// so the baseline pass decides which sites count.
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_PATH;
const sitesFile = resolve(process.argv[2] || join(root, 'tools/consent-sites.txt'));
const outFile = resolve(process.argv[3] || join(root, 'consent-scoreboard.json'));
const CONCURRENCY = 4;
const LOAD_TIMEOUT_MS = 20000;
const SETTLE_MS = 8000;

if (!CHROME || !existsSync(CHROME)) {
  console.error('Set CHROME_PATH to a Chromium binary that supports --load-extension.');
  process.exit(1);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// Runs in the page. Reports a consent banner two ways: a known CMP container,
// or any fixed, visible box that talks about cookies and offers a consent button.
const DETECTOR = `(() => {
  const KNOWN = ['#onetrust-banner-sdk', '#onetrust-pc-sdk', '#CybotCookiebotDialog', '#didomi-popup', '#didomi-notice',
    '.qc-cmp2-container', '[id^="sp_message_container"]', '.cky-consent-container', '#cmpbox', '.fc-consent-root',
    '#truste-consent-track', '.osano-cm-dialog', '#cookie-law-info-bar', '.cc-window', '#axeptio_overlay',
    '.iubenda-cs-container', '#cookiescript_injected', '.cmplz-cookiebanner', '#BorlabsCookieBox', '.klaro .cookie-notice',
    '.klaro .cookie-modal', '#hs-eu-cookie-confirmation', '#usercentrics-root', '#uc-center-container', '.cmp-container',
    '#cookie-banner', '#cookieBanner', '.cookie-banner', '#gdpr-banner', '.evidon-banner', '#ccc', '#cookie-consent'];
  const TOPIC = /cookie|consent|privacy|datenschutz|donn[ée]es|vie priv[ée]e|privacidad|privacy|gegevens|samtykke|integritet/i;
  const BUTTON = /accept|agree|allow|akzeptieren|zustimmen|einverstanden|accepter|autoriser|aceptar|accetta|accetto|akkoord|accepteren|godk[äa]nn|tillad|got it|i understand|ok\\b/i;
  const vw = innerWidth, vh = innerHeight;
  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 20) return false;
    if (r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.05;
  }
  const scrollLocked = getComputedStyle(document.documentElement).overflowY === 'hidden' || getComputedStyle(document.body || document.documentElement).overflowY === 'hidden';
  const base = { host: location.hostname, scrollLocked };
  for (const sel of KNOWN) {
    let el = null;
    try { el = document.querySelector(sel); } catch (_) {}
    if (!el || !visible(el)) continue;
    // Usercentrics renders inside a shadow root; an empty host is not a banner.
    if (el.shadowRoot && !el.shadowRoot.querySelector('button')) continue;
    return { ...base, banner: true, how: sel };
  }
  for (const frame of document.querySelectorAll('iframe')) {
    const tag = (frame.id + ' ' + frame.name + ' ' + frame.title + ' ' + frame.src).toLowerCase();
    if (/sp_message|privacy-mgmt|consent|cmp|cookie/.test(tag) && visible(frame)) {
      const r = frame.getBoundingClientRect();
      if (r.width * r.height > 20000) return { ...base, banner: true, how: 'iframe' };
    }
  }
  const boxes = document.querySelectorAll('div, section, aside, dialog, form, footer');
  for (const el of boxes) {
    const pos = getComputedStyle(el).position;
    if (pos !== 'fixed' && pos !== 'sticky' && el.getAttribute('role') !== 'dialog') continue;
    if (!visible(el)) continue;
    const text = (el.innerText || '').slice(0, 1500);
    if (text.length < 30 || !TOPIC.test(text)) continue;
    const controls = el.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]');
    for (const control of controls) {
      const label = (control.innerText || control.value || control.getAttribute('aria-label') || '').trim();
      if (label.length < 40 && BUTTON.test(label) && visible(control)) return { ...base, banner: true, how: 'generic' };
    }
  }
  return { ...base, banner: false, how: '' };
})()`;

function hashHost(host) {
  let h = 0x811c9dc5;
  const s = String(host || '').toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return 'h:' + h.toString(16).padStart(8, '0');
}

function replaceOnce(file, from, to) {
  const text = readFileSync(file, 'utf8');
  if (text.split(from).length !== 2) throw new Error(`heuristic build: expected one match in ${file}`);
  writeFileSync(file, text.replace(from, to));
}

/** Copies what `npm run pack` ships. heuristicOnly strips every named-CMP rule set. */
function buildExtension(heuristicOnly) {
  const dir = mkdtempSync(join(tmpdir(), 'pawsoff-ext-'));
  for (const item of ['manifest.json', 'src', 'icons']) cpSync(join(root, item), join(dir, item), { recursive: true });
  if (heuristicOnly) {
    const content = join(dir, 'src/content');
    const emptyRules = (name) => `(function(){ (typeof self !== 'undefined' ? self : globalThis).${name} = { rules: [] }; })();\n`;
    writeFileSync(join(content, 'vendor/autoconsent-rules.js'), emptyRules('PawsOffConsentRules'));
    writeFileSync(join(content, 'pawsoff-consent-rules.js'), emptyRules('PawsOffOwnConsentRules'));
    writeFileSync(join(content, 'cmp-api-main.js'), '');
    writeFileSync(join(content, 'consent-prehide.js'), '');
    const ghost = join(content, 'consent-ghost.js');
    replaceOnce(ghost, 'let activeConfig = BUNDLED_CONSENT_CONFIG;', 'let activeConfig = [];');
    replaceOnce(ghost, 'if (normalized) activeConfig = normalized;', '');
  }
  return dir;
}

class Browser {
  constructor(extensionDir) {
    this.profile = mkdtempSync(join(tmpdir(), 'pawsoff-profile-'));
    const args = [
      '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--mute-audio',
      '--window-size=1366,900', '--lang=en-GB', '--remote-debugging-port=0', `--user-data-dir=${this.profile}`,
    ];
    if (extensionDir) args.push(`--load-extension=${extensionDir}`, `--disable-extensions-except=${extensionDir}`);
    this.proc = spawn(CHROME, args, { stdio: 'ignore' });
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    const portFile = join(this.profile, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
    const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n');
    this.ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    await new Promise((done, fail) => { this.ws.onopen = done; this.ws.onerror = fail; });
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const waiter = message.id && this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.fail(new Error(message.error.message));
      else waiter.done(message.result);
    };
  }

  send(method, params, sessionId) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
    return new Promise((done, fail) => {
      this.pending.set(id, { done, fail });
      setTimeout(() => { if (this.pending.delete(id)) fail(new Error(`${method} timed out`)); }, 45000);
    });
  }

  async open(url) {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    await this.send('Page.enable', {}, sessionId);
    // Not awaited: some pages never fire load, and the settle wait covers them.
    this.send('Page.navigate', { url }, sessionId).catch(() => {});
    return { targetId, sessionId };
  }

  async evaluate(sessionId, expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    return result.result ? result.result.value : undefined;
  }

  async extensionId() {
    for (let i = 0; i < 50; i++) {
      const { targetInfos } = await this.send('Target.getTargets');
      // Chromium ships built-in extensions with workers of their own, so match ours by path.
      const worker = targetInfos.find((t) => t.type === 'service_worker' && t.url.endsWith('/src/background/background.js'));
      if (worker) return new URL(worker.url).host;
      await sleep(200);
    }
    throw new Error('extension service worker did not start');
  }

  async storage(extensionId) {
    const page = await this.open(`chrome-extension://${extensionId}/src/options/options.html`);
    await sleep(1500);
    const all = await this.evaluate(page.sessionId, 'chrome.storage.local.get(null)');
    await this.send('Target.closeTarget', { targetId: page.targetId });
    return all || {};
  }

  close() {
    try { this.ws.close(); } catch (_) { /* already closed */ }
    this.proc.kill('SIGKILL');
    try { rmSync(this.profile, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
}

async function visit(browser, site) {
  let page;
  try {
    page = await browser.open(`https://${site}/`);
    const started = Date.now();
    while (Date.now() - started < LOAD_TIMEOUT_MS) {
      await sleep(500);
      const state = await browser.evaluate(page.sessionId, 'document.readyState').catch(() => '');
      if (state === 'complete') break;
    }
    await sleep(SETTLE_MS);
    const seen = await browser.evaluate(page.sessionId, DETECTOR);
    return seen || { error: 'no result' };
  } catch (error) {
    return { error: String(error.message || error).slice(0, 80) };
  } finally {
    if (page) await browser.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
  }
}

async function runPass(label, sites, extensionDir) {
  const browser = new Browser(extensionDir);
  await browser.connect();
  const extensionId = extensionDir ? await browser.extensionId() : null;
  const results = {};
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < sites.length) {
      const site = sites[next++];
      results[site] = await visit(browser, site);
      console.error(`[${label}] ${site}: ${results[site].error || (results[site].banner ? 'banner ' + results[site].how : 'no banner')}`);
    }
  }));
  if (extensionId) {
    const all = await browser.storage(extensionId);
    const byOrigin = {};
    console.error(`[${label}] read ${Object.keys(all).length} storage keys`);
    if (process.env.SCOREBOARD_DEBUG) writeFileSync(`${outFile}.${label}.storage.json`, JSON.stringify(all, null, 1));
    for (const key of Object.keys(all)) {
      const record = all[key];
      if (!key.startsWith('__pawsOff_catch_') || !record || record.feature !== 'banner') continue;
      (byOrigin[record.originHash] = byOrigin[record.originHash] || []).push(record.wall ? 'wall' : record.detail);
    }
    // Diagnostic notes are keyed by the frame's own host, so these cover the top frame only.
    const notes = {};
    for (const key of Object.keys(all)) {
      const record = all[key];
      if (!key.startsWith('__pawsOff_consentGhost_log_') || !record) continue;
      (notes[record.domain] = notes[record.domain] || []).push(record.status + (record.framework ? ':' + record.framework : ''));
    }
    for (const site of sites) {
      const result = results[site];
      if (!result.host) continue;
      result.actions = byOrigin[hashHost(result.host)] || [];
      result.notes = notes[hashHost(result.host)] || [];
    }
  }
  browser.close();
  if (extensionDir) rmSync(extensionDir, { recursive: true, force: true });
  return results;
}

const sites = readFileSync(sitesFile, 'utf8').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
const baseline = await runPass('baseline', sites, null);
const full = await runPass('full', sites, buildExtension(false));
const heuristic = await runPass('heuristic', sites, buildExtension(true));

const rows = sites.map((site) => ({ site, baseline: baseline[site], full: full[site], heuristic: heuristic[site] }));
const counted = rows.filter((row) => row.baseline.banner);
const cleared = (pass) => counted.filter((row) => row[pass] && !row[pass].error && !row[pass].banner).length;
const summary = {
  sites: sites.length,
  bannerShownFromHere: counted.length,
  clearedByFullExtension: cleared('full'),
  clearedByHeuristicsOnly: cleared('heuristic'),
};
writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), summary, rows }, null, 1) + '\n');
console.log(JSON.stringify(summary, null, 1));
console.error(`wrote ${outFile}`);
