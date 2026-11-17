# Security

## Reporting a vulnerability

Please report security issues privately through GitHub: open the repository's
**Security** tab and choose **Report a vulnerability**. Do not open a public
issue for anything that could put users at risk.

Include what you found, how to reproduce it, and the extension version. You
should hear back within a week.

## What counts

- Anything that makes the extension send data off the device.
- Anything that lets a web page turn protection off, read extension storage,
  or make the extension click something other than a consent rejection.
- Weaknesses in the signed config feed (signature, rollback, or origin checks).
- Anything that records browsing activity in incognito.

## Trust model in brief

- No accounts, analytics, or telemetry. The only network request is a signed
  rules update from `config.getpawsoff.app`, verified against a key pinned in
  the extension; any failure falls back to the bundled rules.
- Settings-changing messages are accepted from the popup and options page
  only, never from content scripts.
- Site names are stored as short hashes to keep them out of plain view. This
  is not encryption; see the README.
