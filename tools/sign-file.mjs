#!/usr/bin/env node
/* PawsOff - generic detached config signer (CI tool).
 *
 * Same crypto as tools/sign-config.mjs (WebCrypto ECDSA P-256 / SHA-256, raw
 * IEEE-P1363 r||s signature, base64, self-verify before writing anything the
 * extension would reject) but driven by CLI args instead of hardcoded paths,
 * so a single publish workflow can sign several feeds (ConsentGhost, ToS
 * Shield, PixelBlock, EasyPrivacy delta) without duplicating this file per
 * feed. tools/sign-config.mjs is left untouched - it has its own test
 * coverage tied to its hardcoded config/rules-v1.json path.
 *
 * Private key source (in priority order):
 *   1. --priv <path>              a JWK file on disk (local/dev use)
 *   2. CONFIG_SIGNING_PRIVATE_JWK  the raw JWK JSON as an env var (CI use -
 *      the GitHub Actions secret is written directly into this var, never to
 *      disk, so nothing private ever touches the runner's filesystem)
 * Public key: --pub <path>, defaults to tools/config-signing-public-key.json
 * (the same committed file background.js's PINNED_PUBLIC_KEY_JWK is copied
 * from) - used only for the self-verify step, never to sign.
 *
 * Usage:
 *   node tools/sign-file.mjs <input.json> <output.sig> [--pub <path>] [--priv <path>]
 *   CONFIG_SIGNING_PRIVATE_JWK='{"kty":"EC",...}' node tools/sign-file.mjs dist-lists/consent-ghost/consent-config.json publish/consent-ghost/consent-config.json.sig
 *
 * Zero external deps - Node built-in crypto only.
 */
import { webcrypto } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const subtle = webcrypto.subtle;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PUB_PATH = join(ROOT, 'tools', 'config-signing-public-key.json');

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pub' || a === '--priv') { flags[a.slice(2)] = argv[++i]; continue; }
    positional.push(a);
  }
  return { positional, flags };
}

function loadPrivateJwk(privPath) {
  if (privPath) {
    if (!existsSync(privPath)) throw new Error('missing private key file: ' + privPath);
    return JSON.parse(readFileSync(privPath, 'utf8'));
  }
  const fromEnv = process.env.CONFIG_SIGNING_PRIVATE_JWK;
  if (fromEnv) {
    try { return JSON.parse(fromEnv); }
    catch (e) { throw new Error('CONFIG_SIGNING_PRIVATE_JWK is not valid JSON: ' + e.message); }
  }
  throw new Error(
    'no private key supplied - pass --priv <path> or set CONFIG_SIGNING_PRIVATE_JWK ' +
    '(the CI secret, as raw JWK JSON, never written to disk)'
  );
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [inputPath, outputSigPath] = positional;
  if (!inputPath || !outputSigPath) {
    process.stderr.write('usage: node tools/sign-file.mjs <input.json> <output.sig> [--pub <path>] [--priv <path>]\n');
    process.exit(1);
  }
  if (!existsSync(inputPath)) throw new Error('missing input file: ' + inputPath);

  const pubPath = flags.pub || DEFAULT_PUB_PATH;
  if (!existsSync(pubPath)) throw new Error('missing public key file: ' + pubPath);

  const privateJwk = loadPrivateJwk(flags.priv);
  const publicJwk = JSON.parse(readFileSync(pubPath, 'utf8'));
  const bytes = readFileSync(inputPath); // EXACT bytes we sign - the extension verifies these same bytes

  const signKey = await subtle.importKey('jwk', privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sigBuf = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signKey, bytes);
  const sigB64 = Buffer.from(new Uint8Array(sigBuf)).toString('base64');

  // Self-verify with the PUBLIC key before writing anything - mirrors
  // sign-config.mjs: never publish a signature the extension would reject.
  const verifyKey = await subtle.importKey('jwk', publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifyKey, sigBuf, bytes);
  if (!ok) throw new Error('self-verify FAILED for ' + inputPath + ' - refusing to write a bad signature');

  writeFileSync(outputSigPath, sigB64 + '\n');
  process.stderr.write('signed ' + inputPath + ' -> ' + outputSigPath + ' (' + sigB64.length + ' b64 chars)\n');
}

main().catch((e) => { process.stderr.write('error: ' + (e && e.message) + '\n'); process.exit(1); });
