/**
 * Health check for the signed config channel at config.getpawsoff.app.
 *
 * Read-only and key-less BY DESIGN. It holds the PUBLIC verification key only,
 * so a compromise of this Worker cannot produce a signed feed -- the worst it
 * can do is lie about health. Signing stays offline in CI. Never add the
 * private key here, and never let this Worker publish.
 *
 *   GET /   -> JSON report, 200 healthy / 503 degraded (point uptime checks here)
 *   cron    -> same checks; throws on failure so it surfaces as a failed run
 */

// Must stay identical to PINNED_PUBLIC_KEY_JWK in src/background/background.js.
// If they ever diverge, every client rejects the feed and this Worker is the
// only thing that would notice.
const PUBLIC_JWK = {
  kty: 'EC',
  crv: 'P-256',
  x: '4fDL20b_S9gr9ieY4K5tE502h_ZedTrZizcIU7fFnww',
  y: 'BIWrF4Tb5XzDQl0tXKc-4tbu-TCXxVR1bvXljNk0FGY',
};

const ORIGIN = 'https://config.getpawsoff.app';
// The publish cron is daily. Alert well before clients would notice, but leave
// room for one missed run so a single blip is not paged.
const MAX_MANIFEST_AGE_HOURS = 36;
// Clients stop trusting a manifest at expiresAt; warn while there is still time.
const MIN_EXPIRY_HEADROOM_HOURS = 24;

function b64ToBytes(b64) {
  const bin = atob(b64.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function importKey() {
  return crypto.subtle.importKey('jwk', PUBLIC_JWK, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
}

async function fetchPair(path) {
  const [res, sigRes] = await Promise.all([
    fetch(ORIGIN + path, { cf: { cacheTtl: 0 } }),
    fetch(ORIGIN + path + '.sig', { cf: { cacheTtl: 0 } }),
  ]);
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  if (!sigRes.ok) throw new Error(`${path}.sig -> HTTP ${sigRes.status}`);
  return { bytes: new Uint8Array(await res.arrayBuffer()), sig: await sigRes.text() };
}

async function verified(key, path) {
  const { bytes, sig } = await fetchPair(path);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64ToBytes(sig), bytes);
  if (!ok) throw new Error(`${path} -> SIGNATURE INVALID`);
  return bytes;
}

async function runChecks() {
  const checks = [];
  const record = (name, fn) => fn().then(
    (detail) => { checks.push({ name, ok: true, detail }); },
    (err) => { checks.push({ name, ok: false, detail: String(err.message || err) }); },
  );

  const key = await importKey();
  let manifest = null;

  await record('manifest signature', async () => {
    manifest = JSON.parse(new TextDecoder().decode(await verified(key, '/release-manifest.json')));
    return `release ${manifest.releaseId} seq ${manifest.sequence}`;
  });

  if (manifest) {
    await record('manifest freshness', async () => {
      const ageH = (Date.now() - Date.parse(manifest.generatedAt)) / 3600000;
      if (!Number.isFinite(ageH)) throw new Error('generatedAt unparseable');
      if (ageH > MAX_MANIFEST_AGE_HOURS) {
        throw new Error(`stale: generated ${ageH.toFixed(1)}h ago (publish cron may be dead)`);
      }
      return `${ageH.toFixed(1)}h old`;
    });

    await record('expiry headroom', async () => {
      const leftH = (Date.parse(manifest.expiresAt) - Date.now()) / 3600000;
      if (!Number.isFinite(leftH)) throw new Error('expiresAt unparseable');
      if (leftH < MIN_EXPIRY_HEADROOM_HOURS) {
        throw new Error(`expires in ${leftH.toFixed(1)}h -- clients will fall back to bundled lists`);
      }
      return `${leftH.toFixed(1)}h left`;
    });

    for (const [name, d] of Object.entries(manifest.feeds || {})) {
      await record(`feed ${name}`, async () => {
        const path = d.path.startsWith('/') ? d.path : '/' + d.path;
        const bytes = await verified(key, path);
        if (d.sha256) {
          const got = toHex(await crypto.subtle.digest('SHA-256', bytes));
          if (got !== d.sha256) throw new Error('sha256 mismatch vs manifest descriptor');
        }
        if (d.bytes && d.bytes !== bytes.length) {
          throw new Error(`length ${bytes.length} != descriptor ${d.bytes}`);
        }
        return `${(bytes.length / 1024).toFixed(0)}KB verified`;
      });
    }

    // Store 0.1.0 reads these directly and ignores the manifest. They must keep
    // working for as long as that version is installed anywhere.
    for (const legacy of ['/consent-ghost/consent-config.json', '/easyprivacy-delta/domains.json']) {
      await record(`legacy ${legacy}`, async () => {
        const bytes = await verified(key, legacy);
        return `${(bytes.length / 1024).toFixed(0)}KB verified`;
      });
    }
  }

  const failed = checks.filter((c) => !c.ok);
  return { healthy: failed.length === 0, checkedAt: new Date().toISOString(), failed: failed.length, checks };
}

export default {
  async fetch() {
    const report = await runChecks();
    return new Response(JSON.stringify(report, null, 1), {
      status: report.healthy ? 200 : 503,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  },

  async scheduled() {
    const report = await runChecks();
    if (!report.healthy) {
      // Throwing marks the cron run as failed, which is what surfaces in the
      // dashboard and drives notifications. No alerting integration needed.
      throw new Error(
        'config channel degraded: ' +
        report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('; '),
      );
    }
    console.log(`config channel healthy (${report.checks.length} checks)`);
  },
};
