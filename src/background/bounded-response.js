/* Bounded UTF-8 response reader for signed remote artifacts. */
'use strict';
(function (root) {
  function contentLength(response) {
    try { return response && response.headers ? response.headers.get('content-length') : null; }
    catch (_) { return false; }
  }

  function headerWithinLimit(response, maxBytes) {
    var raw = contentLength(response);
    if (raw === false) return false;
    if (!raw) return true;
    if (!/^\d+$/.test(raw)) return false;
    var bytes = Number(raw);
    return Number.isSafeInteger(bytes) && bytes <= maxBytes;
  }

  function validByteLimit(maxBytes) {
    if (!Number.isSafeInteger(maxBytes)) return false;
    return maxBytes > 0;
  }

  async function cancelReader(reader) {
    try { await reader.cancel(); } catch (_) { /* optional */ }
  }

  function cancelableBody(response) {
    if (!response) return null;
    var body = response.body;
    if (!body) return null;
    return typeof body.cancel === 'function' ? body : null;
  }

  async function cancelBody(response) {
    try {
      var body = cancelableBody(response);
      if (body) await body.cancel();
    } catch (_) { /* optional */ }
  }

  async function readChunks(reader, maxBytes) {
    var chunks = [];
    var total = 0;
    try {
      while (true) {
        var part = await reader.read();
        if (part.done) return { chunks: chunks, total: total };
        total += part.value.byteLength;
        if (total > maxBytes) {
          await cancelReader(reader);
          return null;
        }
        chunks.push(part.value);
      }
    } catch (_) {
      await cancelReader(reader);
      return null;
    } finally {
      try { reader.releaseLock(); } catch (_) { /* optional */ }
    }
  }

  function mergeChunks(result) {
    var bytes = new Uint8Array(result.total);
    var offset = 0;
    for (var i = 0; i < result.chunks.length; i++) {
      var chunk = result.chunks[i];
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  function responseReader(response) {
    var body = response && response.body;
    if (!body) return null;
    if (typeof body.getReader !== 'function') return null;
    return body.getReader();
  }

  async function readText(response, maxBytes) {
    if (!validByteLimit(maxBytes)) {
      await cancelBody(response);
      return null;
    }
    if (!headerWithinLimit(response, maxBytes)) {
      await cancelBody(response);
      return null;
    }
    var reader = responseReader(response);
    if (!reader) return null;
    var result = await readChunks(reader, maxBytes);
    return result ? new TextDecoder().decode(mergeChunks(result)) : null;
  }

  var api = { headerWithinLimit: headerWithinLimit, readText: readText };
  try { root.PawsOffBoundedResponse = api; } catch (_) { /* ignore */ }
  try { if (typeof module !== 'undefined' && module.exports) module.exports = api; } catch (_) { /* ignore */ }
}(typeof self !== 'undefined' ? self : this));
