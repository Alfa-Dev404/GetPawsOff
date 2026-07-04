/* PawsOff, PSL-lite (minimal public-suffix -> registrable domain / eTLD+1)
 *
 * Used by the observe-only Prevalence tier to group hostnames into their
 * registrable domain so we can tell first-party from third-party.
 *
 * Not the full Public Suffix List - a curated set of common multi-label
 * suffixes (co.uk, com.au, ...) plus a few platform ones (github.io,
 * blogspot.com, ...). Swap MULTI for a generated full-PSL copy if accuracy
 * matters more than bundle size; until then it degrades to the last two
 * labels for anything not listed.
 *
 * Attaches to self.PawsOffPSL; loaded via importScripts() before
 * prevalence-learner.js.
 */
'use strict';
(function (root) {
  // Common multi-label public suffixes (ICANN) + a few private/platform ones.
  var MULTI = new Set([
    // United Kingdom
    'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk', 'ac.uk', 'gov.uk', 'nhs.uk', 'police.uk', 'mod.uk',
    // Australia / New Zealand
    'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au', 'asn.au',
    'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz', 'school.nz',
    // Japan / Korea / China / Taiwan / HK
    'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp', 'gr.jp', 'ad.jp', 'ed.jp', 'lg.jp',
    'co.kr', 'ne.kr', 'or.kr', 'go.kr', 're.kr', 'pe.kr',
    'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
    'com.tw', 'net.tw', 'org.tw', 'gov.tw', 'edu.tw',
    'com.hk', 'net.hk', 'org.hk', 'gov.hk', 'edu.hk', 'idv.hk',
    // South / SE Asia
    'co.in', 'net.in', 'org.in', 'gen.in', 'firm.in', 'ind.in', 'gov.in', 'ac.in', 'edu.in', 'res.in',
    'com.my', 'net.my', 'org.my', 'gov.my', 'edu.my',
    'com.ph', 'net.ph', 'org.ph', 'gov.ph', 'edu.ph',
    'com.sg', 'net.sg', 'org.sg', 'gov.sg', 'edu.sg',
    'co.id', 'net.id', 'or.id', 'go.id', 'ac.id', 'web.id',
    'co.th', 'net.th', 'or.th', 'go.th', 'ac.th', 'in.th',
    'com.vn', 'net.vn', 'org.vn', 'gov.vn', 'edu.vn',
    'com.pk', 'net.pk', 'org.pk', 'gov.pk', 'edu.pk',
    'com.bd', 'net.bd', 'org.bd', 'gov.bd', 'edu.bd',
    // Middle East / Africa
    'co.il', 'net.il', 'org.il', 'gov.il', 'ac.il', 'muni.il',
    'com.sa', 'net.sa', 'org.sa', 'gov.sa', 'edu.sa',
    'com.eg', 'net.eg', 'org.eg', 'gov.eg', 'edu.eg',
    'com.ng', 'net.ng', 'org.ng', 'gov.ng', 'edu.ng',
    'co.za', 'org.za', 'net.za', 'gov.za', 'ac.za', 'web.za',
    // Americas
    'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
    'com.mx', 'org.mx', 'net.mx', 'gob.mx', 'edu.mx',
    'com.ar', 'net.ar', 'org.ar', 'gob.ar', 'edu.ar',
    'com.co', 'net.co', 'org.co', 'gov.co', 'edu.co',
    'com.pe', 'com.ec', 'com.uy', 'com.do', 'com.gt', 'com.py', 'com.bo', 'com.ve',
    // Europe / Eurasia
    'com.tr', 'net.tr', 'org.tr', 'gov.tr', 'edu.tr', 'k12.tr',
    'com.ua', 'net.ua', 'org.ua', 'gov.ua', 'edu.ua',
    'com.pl', 'net.pl', 'org.pl', 'gov.pl', 'edu.pl', 'waw.pl',
    'com.ru', 'net.ru', 'org.ru', 'msk.ru', 'spb.ru',
    'com.gr', 'net.gr', 'org.gr', 'gov.gr', 'edu.gr',
    // Private / platform suffixes worth treating as an eTLD for attribution
    'github.io', 'githubusercontent.com', 'blogspot.com', 'wordpress.com',
    'herokuapp.com', 'pages.dev', 'workers.dev', 'netlify.app', 'vercel.app',
    'firebaseapp.com', 'web.app', 'azurewebsites.net', 'cloudfront.net',
    's3.amazonaws.com', 'myshopify.com', 'zendesk.com', 'wixsite.com'
  ]);

  function isIp(host) {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true; // IPv4
    if (host.indexOf(':') !== -1) return true;             // IPv6-ish
    return false;
  }

  /**
   * Return the registrable domain (eTLD+1) for a hostname.
   * Examples:
   *   www.bbc.co.uk      -> bbc.co.uk
   *   foo.bar.example.com-> example.com
   *   x.s3.amazonaws.com -> x.s3.amazonaws.com (3-label suffix)
   *   localhost          -> localhost
   *   127.0.0.1          -> 127.0.0.1
   */
  function getBaseDomain(hostname) {
    if (!hostname || typeof hostname !== 'string') return '';
    var host = hostname.toLowerCase().trim().replace(/\.$/, '');
    if (!host) return '';
    if (isIp(host)) return host;
    var labels = host.split('.');
    if (labels.length <= 2) return host; // localhost, example.com
    var last3 = labels.slice(-3).join('.');
    var last2 = labels.slice(-2).join('.');
    if (MULTI.has(last3)) return labels.slice(-4).join('.'); // suffix(3) + 1 label
    if (MULTI.has(last2)) return labels.slice(-3).join('.'); // suffix(2) + 1 label
    return last2;                                            // default eTLD+1
  }

  root.PawsOffPSL = { getBaseDomain: getBaseDomain };
})(typeof self !== 'undefined' ? self : this);
