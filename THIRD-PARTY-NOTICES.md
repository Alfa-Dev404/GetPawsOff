# Third-Party Notices

GetPawsOff bundles a small amount of third-party data and derived rules. Each
component below stays under its own license; GetPawsOff's own code is separate and
governed by the project `LICENSE`.

---

## DuckDuckGo autoconsent: MPL-2.0

Cookie-consent opt-out patterns and rules, derived from the DuckDuckGo
**autoconsent** project and licensed under the **Mozilla Public License, v. 2.0**.

Files:
- `src/content/vendor/autoconsent-patterns.js` (from `lib/heuristic-patterns.ts`)
- `src/content/vendor/autoconsent-rules.json` (from `rules/autoconsent/*.json`)
- `src/content/vendor/autoconsent-rules.js` (generated wrapper of the `.json`)

- Upstream: https://github.com/duckduckgo/autoconsent
- License text: https://mozilla.org/MPL/2.0/
- Full notice + obligations: `src/content/vendor/AUTOCONSENT-NOTICE.txt`

MPL-2.0 is file-level (weak) copyleft: these files stay under MPL-2.0 and remain
source-available; GetPawsOff's own consent engine
(`src/content/consent-rules-engine.js`) reads this data at runtime and is **not**
a derivative of the MPL files.

---

## EasyPrivacy (EasyList project): GPL-3.0 / CC-BY-SA 3.0

The network-blocking ruleset is **data** derived from the EasyPrivacy filter
lists, dual-licensed under **GPL-3.0** and **CC-BY-SA 3.0**.

Files:
- `src/rules/easyprivacy.json` (generated MV3 declarativeNetRequest rules)
- `src/rules/easyprivacy-meta.json` (rule id to label map)
- `src/rules/easyprivacy-domains.json` (derived bare-domain index)

- Upstream: https://easylist.to/ and https://github.com/easylist/easylist
- Full notice + scope of the derived subset: `src/rules/EASYPRIVACY-NOTICE.txt`

Only the network-blocking `easyprivacy/` subset is bundled, converted to MV3 DNR
rules through GetPawsOff's own clean-room converter. No upstream filter text is
copied verbatim into shipped code.

---

If you redistribute GetPawsOff, keep this file and the referenced per-component
notices intact.
