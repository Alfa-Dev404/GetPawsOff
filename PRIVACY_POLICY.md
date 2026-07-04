# GetPawsOff Privacy Policy

**Effective date:** 18 June 2026
**Applies to:** GetPawsOff (Chrome extension), version 1.0.0
**Contact:** pawssoff.me@gmail.com

## Summary

GetPawsOff is built to protect your privacy, so it collects as little as
possible: **nothing about you leaves your device.** We do not operate servers
that receive your data, we have no analytics or telemetry, we do not use
tracking or advertising IDs, and we do not sell or share any personal
information. Everything the extension does happens locally in your browser.

## What the extension does

GetPawsOff provides three on-device privacy features:

- **Consent Ghost**: automatically rejects cookie-consent banners.
- **Pixel Block**: blocks email tracking pixels in supported webmail apps.
- **ToS Shield**: flags predatory clauses on Terms-of-Service / privacy pages.

## Information we collect

**We do not collect any personal information.** We have no account system, no
sign-in, and no backend that receives user data.

### Stored locally on your device (never transmitted)

The extension uses your browser's local storage (`chrome.storage.local`) to keep:

- **Your settings**: which features are on or off, and your ToS clause-category
  preferences.
- **Aggregate counters**: for example, the total number of consent banners
  rejected, tracking pixels blocked, and ToS clauses flagged, so the popup can
  show you these numbers.
- **Short diagnostic logs**: small, capped, automatically pruned records used to
  keep the features working. These do **not** contain message content, email
  subjects, senders, recipients, page text, or full URLs. Any site hostname kept
  for diagnostics is stored only as a **one-way hash**, not as readable text, so
  the stored logs cannot be read back as a browsing history.

All of the above stays on your device. You can erase it at any time by removing
the extension or clearing its storage in your browser.

## Information we do **not** collect

- No browsing history sent anywhere.
- No email content, subjects, senders, or recipients.
- No page content, form input, or full URLs.
- No personal identifiers, advertising IDs, or device fingerprints.
- No location data.

## Network connections

The only network request the extension makes is an **outbound** fetch from
`https://config.getpawsoff.app` to download updated protection rules (cookie-consent
selectors, known tracker domains, and ToS clause patterns). These are static,
cryptographically signed data files that are verified against a pinned key before
use. **No information about you is included in this request**, and the response
contains only rule data, never executable code.

## How permissions are used

- **storage**: save your settings and local aggregate counters/diagnostics.
- **declarativeNetRequest / declarativeNetRequestFeedback**: block known email
  tracking-pixel requests and count how many were blocked (for local display).
- **alarms**: schedule infrequent refresh of the signed rule files and local
  counter maintenance.
- **Host access to webmail and consent-platform domains**: run the pixel
  blocker on supported mail apps and apply "reject" inside cookie-consent frames.
- **Broad page access**: cookie banners and Terms-of-Service pages can appear on
  any website, so two features run locally on pages you visit. They store no
  page content and transmit nothing.

## Data sharing and sale

We do **not** sell, rent, trade, or share any user data with anyone. There are no
third-party analytics, advertising, or tracking services in this extension.

## Data retention

Locally stored settings persist until you change or remove them. Diagnostic logs
and counters are capped and automatically pruned, and are deleted when you remove
the extension or clear its storage.

## Children's privacy

The extension is not directed to children and does not knowingly collect any data
from anyone, including children.

## Changes to this policy

If this policy changes, we will update the effective date above and post the
revised policy at the published privacy policy URL.

## Contact

Questions about this policy: **pawssoff.me@gmail.com**
