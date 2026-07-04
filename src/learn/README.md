# PawsOff - Local Prevalence Tier (observe-only v1)

A Privacy Badger-style **local, on-device** tracker learner - re-derived from the
*method only* (clean-room; no Privacy Badger code, no GPL/AGPL data).

## What it does
Learns **which third-party domains appear across many unrelated first-party
sites** (the classic tracker signal), scores them with **time-decay**, and
assigns a verdict: `allow` → `observing` → `would-cookieblock` → `would-block`.

## Why it can't break anything (v1)
- The sensor (`prevalence-collector.js`) uses the **Performance Timeline**
  (resource timing) to read URLs the page **already loaded**. It never
  intercepts, blocks, modifies, delays, or initiates a request.
- It is **observe-only**: the learner records + scores but takes **no action**.
  No `declarativeNetRequest` rule is written. Enforcement is a later milestone.
- **No new permissions** (uses `storage` + messaging you already have).
- Reports **hostnames only** - never URLs, paths, queries, cookies, or content.

## Files
| File | Context | Role |
|---|---|---|
| `psl-lite.js` | SW (importScripts) | eTLD+1 / registrable-domain helper (curated PSL subset) |
| `prevalence-collector.js` | content (top frame) | resource-timing sensor → sends hostnames to background |
| `prevalence-learner.js` | service worker | decaying snitch-map, scoring, verdicts, self-registered listeners |

## Wiring (already applied)
- `manifest.json`: added `src/learn/prevalence-collector.js` as a top-frame
  content script on `http(s)://*/*`.
- `src/background/background.js`: line 5 now
  `importScripts('../learn/psl-lite.js', '../learn/prevalence-learner.js');`

## Improvements over the classic algorithm
- **Time-decayed score** (30-day half-life) instead of a flat lifetime count.
- **First-party sets** (same-owner domains aren't third-party to each other).
- **Yellowlist → cookieblock** instead of full block for site-critical domains.
- **Bounded storage** (per-tracker site cap, global tracker cap, TTL compaction).

## Tuning (top of `prevalence-learner.js`)
`HALF_LIFE_DAYS=30`, `BLOCK_THRESHOLD=3`, `OBSERVE_FLOOR=1`,
`MAX_SITES_PER_TRACKER=64`, `MAX_TRACKERS=6000`, `SITE_TTL_DAYS=180`.

## Inspect what it has learned
In the service-worker console (chrome://extensions → PawsOff → *service worker*):
```js
await __pawsOff_prevalence.getStats()      // summary + top trackers + verdicts
await __pawsOff_prevalence.getVerdict('doubleclick.net')
await __pawsOff_prevalence.reset()         // wipe learned data
```
Or from any extension page via messaging:
```js
chrome.runtime.sendMessage({ type: 'pawsoff_prevalence_getStats', topN: 25 }, console.log)
```

## Toggle off
Set `__pawsOff_prevalence_enabled = false` (or the master switch
`__pawsOff_master_enabled = false`) in `chrome.storage.local` to stop observing.

## Known limits (honest)
- Top-frame only: resources loaded *inside* cross-origin iframes aren't attributed
  yet (correct-but-incomplete; frame attribution is a phase-2 item).
- `psl-lite.js` is a curated subset, not the full Public Suffix List - swap in the
  full PSL for production-grade edge cases.
- No CNAME uncloaking on Chrome (no `dns.resolve`); a subdomain heuristic is a
  later option.

## Enforcement (wired but DORMANT)
`prevalence-enforcer.js` translates `would-block` verdicts into dynamic
`declarativeNetRequest` block rules. It is now importScripted by
`src/background/background.js` (previously it was never loaded, so enforcement
could not run at all) but is **DORMANT BY DEFAULT**: `__pawsOff_pv_enforce_enabled`
defaults false and **no UI flips it** - loading it changes nothing until
enforcement is explicitly opted in from the SW console.

The promotion warm-up gates are now IMPLEMENTED (v1.2): hard blocks require
score >= 5 on >= 5 distinct sites known >= 7 days, start beacon-only
(ping/image/xhr), add scripts only at score >= 8, and never touch
sub_frame/websocket/media. Candidates below the bar (and yellowlisted
`cookieblock` verdicts) get cookie-STRIPPING (modifyHeaders) instead of a
block. Shadow mode (`__pawsOff_pv_enforce_shadow`, default true) computes and
stores the would-plan without applying anything; pausing a site auto-excepts
its flagged domains. Because the snitch map is hash-only, enforceable
candidates are named by joining the radar snapshots' plaintext spotted
domains - fresh local evidence is required, no new plaintext is stored.
Rollout order stays: enable → watch shadow META → flip shadow off.

### `cookieblock` is now enforceable (v1.2)
The learner downgrades site-critical (yellowlisted) domains to a `cookieblock`
verdict. Historically there was no enforcement path because DNR `modifyHeaders`
requires broad host permissions - the manifest has since gained `http://*/*` +
`https://*/*` (for the toolbar-badge webRequest tier), so the enforcer can now
materialize `cookieblock` as cookie-STRIPPING rules: `modifyHeaders` removes
`Cookie`/`Set-Cookie` on third-party requests, the resource still loads, the
tracker sees an anonymous fetch. The ESSENTIAL_DOMAINS safelist gates this tier
too - stripping cookies on SSO/payment domains (google.com, stripe.com) breaks
logins, so those stay untouched. Note `background.js`'s `sanitizeRules()`
("force block") applies only to the PixelBlock content-script registration
funnel, not to the enforcer's own service-worker rule writes.
