/* Cross-file hashHost consistency guard (audit item E2).
 *
 * PawsOff hashes hostnames with a one-way FNV-1a/32 digest ("h:" + 8 hex). That
 * exact function is DUPLICATED in 8 files because content scripts run in isolated
 * worlds and CANNOT share a module import - the duplication is a requirement, not
 * a smell, so we must NOT refactor it into one shared source (see CLAUDE.md).
 *
 * The risk of duplication is DRIFT: if one copy diverges, the popup/options can no
 * longer find a site's hashed radar/catch snapshot written by a content script,
 * silently breaking per-site UI. Individual copies are exercised by their own
 * tests; this test is the missing piece - it pins that ALL 8 copies produce
 * byte-for-byte identical output for the same input.
 *
 * It does NOT import the functions (most files have no test hook). Each copy is a
 * pure function of a single `host` string with no closure/DOM/chrome deps, so we
 * extract its source straight from the file and rebuild it in isolation. A bad
 * extraction would throw at `new Function` (syntax error) and fail loudly.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { test, assert, eq } = require('./harness/framework');

const ROOT = path.join(__dirname, '..');

// The 8 isolated-world copies. name = the identifier each file uses.
const COPIES = [
  { file: 'src/background/background.js',        name: 'fnvHash'  },
  { file: 'src/content/tos-shield.js',           name: 'hashHost' },
  { file: 'src/content/pixel-block.js',          name: 'hashHost' },
  { file: 'src/content/consent-ghost.js',        name: 'hashHost' },
  { file: 'src/learn/prevalence-collector.js',   name: 'hashHost' },
  { file: 'src/lib/po-catch.js',                 name: 'hashHost' },
  { file: 'src/options/options.js',              name: 'hashHost' },
  { file: 'src/popup/popup.js',                  name: 'hashHost' },
  { file: 'src/learn/prevalence-learner.js',     name: 'hashHost' },
];

// Pull `function <name>(host) { ... }` out of a source file by brace-matching
// from the declaration. Safe here because these specific functions contain no
// braces inside strings/comments (plain FNV arithmetic + a "h:" prefix).
function extractHashFn(file, name) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const decl = new RegExp('function\\s+' + name + '\\s*\\(\\s*host\\s*\\)\\s*\\{');
  const m = decl.exec(src);
  assert(m, name + '(host) declaration found in ' + file);
  const open = src.indexOf('{', m.index);
  let depth = 0, end = -1;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) { end = j; break; }
  }
  assert(end > -1, 'balanced braces for ' + name + ' in ' + file);
  // Rebuild the isolated pure function as a callable expression.
  return new Function('return (' + src.slice(m.index, end + 1) + ')')();
}

// Extracted at load time: a broken/renamed copy throws here and fails the file.
const fns = COPIES.map((c) => ({ file: c.file, fn: extractHashFn(c.file, c.name) }));

test('E2: all isolated-world hashHost copies produce identical output', () => {
  eq(fns.length, 9, 'all 9 copies extracted');
  for (const f of fns) assert(typeof f.fn === 'function', 'callable: ' + f.file);

  // Multi-label, single char, IDN/punycode, a case-fold pair, plus the null guard.
  const inputs = [
    'example.com', 'WWW.Example.COM', 'www.example.com',
    'sub.domain.co.uk', 'trk.klaviyo.com', 'a', 'xn--80ak6aa92e.com', '',
  ];
  const ref = fns[0].fn;
  for (const input of inputs) {
    const expected = ref(input);
    // Format contract: non-empty host -> "h:" + 8 lowercase hex; ""/falsy -> null.
    if (input) assert(/^h:[0-9a-f]{8}$/.test(expected), 'format for "' + input + '": ' + expected);
    else eq(expected, null, 'empty input hashes to null');
    for (const f of fns) eq(f.fn(input), expected, f.file + ' agrees on "' + input + '"');
  }

  // Case-insensitive: every copy lowercases the host before hashing.
  for (const f of fns) {
    eq(f.fn('WWW.Example.COM'), f.fn('www.example.com'), 'case-fold: ' + f.file);
  }
});
