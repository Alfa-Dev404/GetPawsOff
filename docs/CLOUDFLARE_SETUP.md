# Hosting the signed config feed (Cloudflare Pages)

This extension works completely on its own with the rules bundled inside the
package. Nothing below is required to install or use it. This document is
for anyone who forks the project and wants to run their **own** signed
update feed, or who wants to understand/audit how `config.getpawsoff.app`
works.

Nothing in this repo can publish to that feed. The private signing key never
leaves the maintainer's machine and is not part of this codebase. What
follows is the contract the extension expects, so you can stand up your own
feed on your own domain if you fork the project.

## 1. What the extension fetches

`src/background/background.js` polls four URLs, always as a `(file, file.sig)`
pair, over plain HTTPS GET with `credentials: 'omit'`:

| Feed | Path | Schema |
|---|---|---|
| ToS Shield | `/tos-shield/patterns.json` | `{ schemaVersion: 1, configVersion: string, categories: [...], patterns: [...], pageDetection, segmentation, negation, scoring }` |
| ConsentGhost | `/consent-ghost/consent-config.json` | `{ schemaVersion: 1, configVersion: string, frameworks: [...] }` (non-empty array) |
| PixelBlock | `/pixel-block/pixel-config.json` | `{ schemaVersion: 1, configVersion: string, providers: [...] }` |
| EasyPrivacy delta | `/easyprivacy-delta/domains.json` | `{ schemaVersion: 1, configVersion: string, domains: [{ domain: string, resourceTypes?: string[] }] }` |

Every fetch is:
- **read-only**: a plain GET, nothing about the user is sent;
- **fail-open**: any missing file, network error, bad signature, or schema
  mismatch leaves the bundled/cached copy in place; nothing breaks;
- **rate-limited on the client**: the extension decides when to poll, not
  the server.

`configVersion` is compared as a dotted numeric string (`compareVersions` in
`background.js`); a fetched config only replaces the cached one if its
version is strictly newer.

## 2. Signing

Each `<file>` needs a matching `<file>.sig`: a base64-encoded, **detached**
ECDSA signature over the exact bytes of `<file>`, using curve P-256 and a
SHA-256 hash. `verifyConfigSignature()` in `background.js` verifies it like
this:

```js
const key = await crypto.subtle.importKey(
  'jwk', PINNED_PUBLIC_KEY_JWK, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
);
const ok = await crypto.subtle.verify(
  { name: 'ECDSA', hash: 'SHA-256' }, key, signatureBytes, fileBytes,
);
```

The signature bytes are the raw `(r || s)` pair (64 bytes for P-256), not
DER-encoded. `crypto.subtle.sign`/`verify` with the Web Crypto API already
produce/expect this format, so no extra encoding step is needed if you sign
with the same API.

### Generating your own key pair

If you're forking this project to run your own feed, generate a fresh P-256
key pair. Do not reuse the one baked into `PINNED_PUBLIC_KEY_JWK` in
`src/background/background.js`, since you don't hold its private half:

```js
const { publicKey, privateKey } = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
);
console.log(JSON.stringify(await crypto.subtle.exportKey('jwk', publicKey)));
console.log(JSON.stringify(await crypto.subtle.exportKey('jwk', privateKey)));
```

Paste the public JWK into `PINNED_PUBLIC_KEY_JWK`. Keep the private JWK out
of git entirely: store it as a GitHub Actions secret or a local file covered
by `.gitignore` (this repo already ignores `keys/`, `*.jwk.json`, and
`*.pem`).

## 3. Cloudflare Pages

1. In the Cloudflare dashboard, create a new **Pages** project (Workers &
   Pages -> Create -> Pages -> direct upload, or connect a git repo if you
   want push-to-deploy).
2. Under the project's **Custom domains**, attach the domain you'll hardcode
   into the four `*_CONFIG_URL` constants (e.g. `config.yourdomain.app`).
   Cloudflare issues the TLS certificate automatically once DNS is proxied
   through Cloudflare.
3. Deploy a folder containing the four subdirectories from the table above,
   each with its `.json` and `.json.sig` pair:
   ```
   /tos-shield/patterns.json
   /tos-shield/patterns.json.sig
   /consent-ghost/consent-config.json
   /consent-ghost/consent-config.json.sig
   /pixel-block/pixel-config.json
   /pixel-block/pixel-config.json.sig
   /easyprivacy-delta/domains.json
   /easyprivacy-delta/domains.json.sig
   ```
   You can deploy this with the Cloudflare dashboard's drag-and-drop upload,
   or with `wrangler pages deploy <folder> --project-name=<project>` from
   the CLI once you have a Cloudflare API token.
4. Until a file exists at a given path, that fetch 404s. The extension
   treats that exactly like any other fetch failure and keeps using its
   bundled copy. You can publish the four feeds independently and on your
   own schedule.

## 4. Automating publishes with GitHub Actions

This repo does not include a publish workflow. That lives in the private
project this extension is developed from, because it needs the private
signing key. If you want to automate your own fork's publishing, the shape
is:

1. Add repo secrets in **Settings -> Secrets and variables -> Actions**:
   - `CONFIG_SIGNING_PRIVATE_JWK`: the private JWK from step 2, as a single
     JSON string.
   - `CLOUDFLARE_API_TOKEN`: a token scoped to `Cloudflare Pages: Edit` for
     your account.
   - `CLOUDFLARE_ACCOUNT_ID`: from the Cloudflare dashboard sidebar.
2. In the workflow: build each config JSON, sign it with the private JWK
   (Node's `crypto.subtle` works in Actions' `node:20`+ runners), write the
   `.sig` file next to it, then run `wrangler pages deploy` (via
   `cloudflare/wrangler-action` or the `wrangler` CLI directly) with the two
   secrets above as environment variables.
3. Never `console.log` or otherwise print the private JWK in a workflow.
   Treat it exactly like a TLS private key.

If you don't want to run any of this, that's fine, the extension is fully
functional on the bundled rules alone. This whole feed is additive, not
required.
