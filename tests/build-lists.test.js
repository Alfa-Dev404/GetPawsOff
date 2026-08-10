'use strict';

const { test, assert, eq } = require('./harness/framework');

let helpers;
async function buildHelpers() {
  if (!helpers) helpers = await import('../tools/build-lists.mjs');
  return helpers;
}

function streamedResponse(text, url = 'https://allowed.example/feed') {
  const bytes = new TextEncoder().encode(text);
  return {
    url,
    headers: { get() { return null; } },
    body: {
      getReader() {
        let sent = false;
        return {
          read() {
            if (sent) return Promise.resolve({ done: true });
            sent = true;
            return Promise.resolve({ done: false, value: bytes });
          },
          cancel() { return Promise.resolve(); },
          releaseLock() {},
        };
      },
    },
  };
}

function chunkedResponse(chunks) {
  let cancelled = false;
  return {
    response: {
      url: 'https://allowed.example/feed',
      headers: { get() { return null; } },
      body: {
        getReader() {
          let index = 0;
          return {
            read() {
              if (index >= chunks.length) return Promise.resolve({ done: true });
              return Promise.resolve({ done: false, value: new TextEncoder().encode(chunks[index++]) });
            },
            cancel() { cancelled = true; return Promise.resolve(); },
            releaseLock() {},
          };
        },
      },
    },
    wasCancelled: () => cancelled,
  };
}

test('build lists: config version is explicit and release-shaped', async () => {
  const { requiredConfigVersion } = await buildHelpers();
  eq(requiredConfigVersion({ PAWSOFF_CONFIG_VERSION: '20260715123045' }), '20260715123045');
  for (const value of [undefined, '', '2026-07-15', '123']) {
    let rejected = false;
    try { requiredConfigVersion({ PAWSOFF_CONFIG_VERSION: value }); } catch (_) { rejected = true; }
    assert(rejected, `invalid version rejected: ${value}`);
  }
});

test('build lists: upstream bodies and redirect origins fail closed', async () => {
  const { fetchWithTimeout, readBoundedText, requireResponseOrigin } = await buildHelpers();
  eq(await readBoundedText(streamedResponse('hello'), 5), 'hello');
  let oversized = false;
  try { await readBoundedText(streamedResponse('hello!'), 5); } catch (_) { oversized = true; }
  assert(oversized, 'streaming byte cap enforced');
  requireResponseOrigin(streamedResponse('', 'https://allowed.example/feed'), 'https://allowed.example');
  let redirected = false;
  try { requireResponseOrigin(streamedResponse('', 'https://evil.example/feed'), 'https://allowed.example'); }
  catch (_) { redirected = true; }
  assert(redirected, 'cross-origin final URL rejected');

  const chunked = chunkedResponse(['abc', 'def']);
  let combinedRejected = false;
  try { await readBoundedText(chunked.response, 5); } catch (_) { combinedRejected = true; }
  assert(combinedRejected, 'combined chunks cannot exceed the byte cap');
  assert(chunked.wasCancelled(), 'oversized multi-chunk response cancels its reader');

  const originalFetch = global.fetch;
  let requestOptions;
  let requests = 0;
  global.fetch = async (_url, options) => {
    requests += 1;
    requestOptions = options;
    return { ok: false, status: 302, url: 'https://allowed.example/feed' };
  };
  try {
    let autoFollowRejected = false;
    try { await fetchWithTimeout('https://allowed.example/feed', 100, 100); }
    catch (_) { autoFollowRejected = true; }
    assert(autoFollowRejected, 'redirect response is rejected');
    eq(requestOptions.redirect, 'manual', 'fetch never follows a redirect automatically');
    eq(requests, 1, 'no redirected request is issued');
  } finally {
    global.fetch = originalFetch;
  }
});

test('build lists: malformed ToS;DR page schemas fail closed', async () => {
  const { parseTosdrPage } = await buildHelpers();
  eq(parseTosdrPage('{"services":[],"page":{"total":0}}').services.length, 0, 'valid page accepted');
  for (const text of [
    '{}',
    '{"services":{}}',
    '{"services":[]}',
    '{"services":[],"page":{"total":"0"}}',
    '{"services":[],"page":{"total":-1}}',
    'null',
  ]) {
    let rejected = false;
    try { parseTosdrPage(text); } catch (_) { rejected = true; }
    assert(rejected, `malformed page rejected: ${text}`);
  }
});

test('build lists: ToS;DR rate-limit waits are clamped to a bounded window', async () => {
  const { tosdrRateLimitError } = await buildHelpers();
  function retryAfter(value) {
    return tosdrRateLimitError({ headers: { get() { return value; } } }).retryAfterMs;
  }
  eq(retryAfter('-20'), 1500, 'negative reset is clamped to one second');
  eq(retryAfter('120'), 60500, 'large reset is clamped to sixty seconds');
  eq(retryAfter('nope'), 10500, 'invalid reset uses the conservative default');
});

test('build lists: ToS;DR pagination has a cumulative raw-service byte budget', async () => {
  const { appendTosdrServices } = await buildHelpers();
  const services = [];
  const budget = { bytes: 0, maxBytes: 20 };
  appendTosdrServices(services, { services: [{ id: 1 }] }, budget);
  eq(services.length, 1);
  let rejected = false;
  try { appendTosdrServices(services, { services: [{ id: 'oversized-service' }] }, budget); }
  catch (_) { rejected = true; }
  assert(rejected, 'aggregate raw service data cannot exceed its budget');
  eq(services.length, 1, 'rejected page is not retained');
});
