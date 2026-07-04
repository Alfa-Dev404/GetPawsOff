/* Self-check for the signed public config blob (config.getpawsoff.app).
 *
 * Guards that the COMMITTED artifacts are internally consistent so a bad or
 * stale signature fails CI, not the extension in the field:
 *   - config/rules-v1.json.sig verifies against config/rules-v1.json bytes using
 *     the committed public JWK (tools/config-signing-public-key.json), with the
 *     EXACT scheme the extension verifier uses (ECDSA P-256 / SHA-256, raw r||s,
 *     base64) - same as tests/eraser-sign.test.js and tools/sign-adapter.js.
 *   - config/latest.json points at those files and carries the right keyId/alg.
 *   - the payload is a PUBLIC tracker-domain list with no smell of PII.
 *
 * The private key lives only in .keys/ (gitignored); this test needs only the
 * public key + the two published files, so it runs in CI without any secret.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { test, assert, eq } = require('./harness/framework');

const subtle =
  (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle)
    ? globalThis.crypto.subtle
    : require('crypto').webcrypto.subtle;

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'tools', 'config-signing-public-key.json');
const RULES = path.join(ROOT, 'config', 'rules-v1.json');
const SIG = path.join(ROOT, 'config', 'rules-v1.json.sig');
const LATEST = path.join(ROOT, 'config', 'latest.json');

function b64ToBytes(b64) { return new Uint8Array(Buffer.from(String(b64).trim(), 'base64')); }

test('signed config: rules-v1.json.sig verifies against rules-v1.json bytes', async () => {
  for (const p of [PUB, RULES, SIG, LATEST]) assert(fs.existsSync(p), 'missing artifact: ' + p);

  const publicJwk = JSON.parse(fs.readFileSync(PUB, 'utf8'));
  const bytes = fs.readFileSync(RULES);                 // EXACT signed bytes
  const sig = b64ToBytes(fs.readFileSync(SIG, 'utf8')); // 64-byte raw r||s

  eq(sig.length, 64, 'P-256 raw r||s signature is 64 bytes');
  const key = await subtle.importKey('jwk', publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, bytes);
  assert(ok === true, 'signature must verify against the committed public key');

  // Negative control: a flipped byte must NOT verify (proves the check has teeth).
  const tampered = Buffer.from(bytes); tampered[0] ^= 0x01;
  const bad = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, tampered);
  assert(bad === false, 'a tampered payload must fail verification');
});

test('signed config: latest.json is the correct pointer', () => {
  const latest = JSON.parse(fs.readFileSync(LATEST, 'utf8'));
  const pub = JSON.parse(fs.readFileSync(PUB, 'utf8'));
  eq(latest.version, 1);
  eq(latest.alg, 'ES256');
  eq(latest.url, '/config/rules-v1.json');
  eq(latest.sig, '/config/rules-v1.json.sig');
  // keyId = RFC 7638 JWK thumbprint of the public key.
  const { createHash } = require('crypto');
  const canonical = `{"crv":"${pub.crv}","kty":"${pub.kty}","x":"${pub.x}","y":"${pub.y}"}`;
  eq(latest.keyId, createHash('sha256').update(canonical).digest('base64url'), 'keyId is the public-key thumbprint');
});

test('signed config: payload is a PUBLIC domain list with no PII', () => {
  const rules = JSON.parse(fs.readFileSync(RULES, 'utf8'));
  eq(rules.version, 1);
  assert(Array.isArray(rules.domains) && rules.domains.length > 0, 'has domains');
  eq(rules.count, rules.domains.length, 'count matches domains length');
  const pii = /(@|mailto:|\+?\d[\d ().-]{6,}\d)/i;
  const host = /^[a-z0-9.-]+\.[a-z]{2,}$/i;
  for (const d of rules.domains) {
    assert(typeof d === 'string' && host.test(d), 'each entry is a hostname: ' + d);
    assert(!pii.test(d), 'no PII-looking value: ' + d);
  }
});
