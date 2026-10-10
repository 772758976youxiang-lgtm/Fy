'use strict';

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const dns = require('node:dns').promises;

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const TIMEOUT_MS = 30_000;
const BLOCK_TAGS = new Set(('address article aside blockquote br dd div dl dt fieldset figcaption figure footer ' +
  'form h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section table tbody td th thead tr ul').split(' '));
const INLINE_TAGS = new Set(('a abbr b bdi bdo cite code del em i ins kbd label mark q s samp small span strong ' +
  'sub sup time u var wbr html body').split(' '));
const ENTITIES = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', hellip: '…', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', bull: '•', middot: '·', euro: '€', pound: '£', yen: '¥',
  cent: '¢', times: '×', divide: '÷', Tab: '\t', NewLine: '\n' });

function ipv6Number(address) {
  let text = address.toLowerCase();
  if (text.includes('.')) {
    const lastColon = text.lastIndexOf(':');
    const octets = text.slice(lastColon + 1).split('.').map(Number);
    text = text.slice(0, lastColon + 1) + ((octets[0] << 8) | octets[1]).toString(16) + ':' +
      ((octets[2] << 8) | octets[3]).toString(16);
  }
  const parts = text.split('::');
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts[1] ? parts[1].split(':') : [];
  const words = parts.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return words.reduce((value, word) => (value << 16n) | BigInt(parseInt(word, 16)), 0n);
}

// Conservative public-unicast policy based on the IANA special-purpose registries:
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
const BLOCKED_V6 = [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]
  .map(([prefix, bits]) => ({ prefix: ipv6Number(prefix) >> BigInt(128 - bits), shift: BigInt(128 - bits) }));

function isPublicIP(address) {
  if (typeof address !== 'string' || address.includes('%')) return false;
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && ((b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99) || b === 168)) return false;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (family !== 6) return false;
  const value = ipv6Number(address);
  if (value >> 32n === 0xffffn) {
    const ipv4 = Number(value & 0xffffffffn);
    return isPublicIP([ipv4 >>> 24, (ipv4 >>> 16) & 255, (ipv4 >>> 8) & 255, ipv4 & 255].join('.'));
  }
  // Reject translation, local, multicast, unspecified, and other reserved space.
  if (value >> 125n !== 1n) return false; // 2000::/3, currently global unicast.
  return !BLOCKED_V6.some(({ prefix, shift }) => value >> shift === prefix);
}

function decodeEntities(text) {
  return text.replace(/&(#(?:x[0-9a-f]+|[0-9]+)|[a-z][a-z0-9]*);/gi, (match, entity) => {
    if (entity[0] !== '#') return ENTITIES[entity] ?? match;
    const hex = entity[1].toLowerCase() === 'x';
    const value = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ?
      String.fromCodePoint(value) : '\uFFFD';
  });
}

function cleanText(text) {
  return text.replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n+/g, '\n').trim();
}

function clipText(text, maxChars) {
  if (text.length <= maxChars) return text;
  let end = maxChars;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return text.slice(0, end);
}

/** Extract data only: this parser never executes markup or follows embedded URLs. */
function extractText(markup) {
  let text = String(markup);
  text = text.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  text = text.replace(/<(script|style|noscript|template|svg|iframe|object|canvas)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '');
  const titleMatch = text.match(/<title\b(?:[^"'<>]|"[^"]*"|'[^']*')*>([\s\S]*?)(?:<\/title\s*>|$)/i);
  const title = titleMatch ? clipText(cleanText(decodeEntities(titleMatch[1].replace(/<[^>]*>/g, ''))), 500) : '';
  text = text.replace(/<head\b(?:[^"'<>]|"[^"]*"|'[^']*')*>[\s\S]*?(?:<\/head\s*>|$)/gi, '');
  text = text.replace(/<title\b(?:[^"'<>]|"[^"]*"|'[^']*')*>[\s\S]*?(?:<\/title\s*>|$)/gi, '');
  text = text.replace(/<![^>]*>/g, '');
  text = text.replace(/<\/?([a-z][\w:-]*)\b(?:[^"'<>]|"[^"]*"|'[^']*')*\/?>/gi, (_tag, name) => {
    const tag = name.toLowerCase();
    return BLOCK_TAGS.has(tag) ? '\n' : INLINE_TAGS.has(tag) ? '' : ' ';
  });
  text = text.replace(/<[^>]*$/g, ''); // A byte-capped response may end inside a tag.
  return { title, content: cleanText(decodeEntities(text)) };
}

function parseTarget(input) {
  const source = String(input);
  if (source.length > 8192) throw new Error('Page URL exceeds the allowed length.');
  let url;
  try { url = new URL(source); } catch { throw new Error('Invalid page URL.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only HTTP and HTTPS page URLs are allowed.');
  if (url.username || url.password) throw new Error('Page URL credentials are not allowed.');
  if (url.port && url.port !== '80' && url.port !== '443') throw new Error('Page URLs must use port 80 or 443.');
  url.hash = '';
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  return { url, hostname };
}

function abortError() {
  return new DOMException('Page fetch aborted.', 'AbortError');
}

function waitWithSignal(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(signal.reason); };
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(value => {
      signal.removeEventListener('abort', aborted);
      resolve(value);
    }, error => {
      signal.removeEventListener('abort', aborted);
      reject(error);
    });
  });
}

async function validatedAddress(hostname, lookup, signal) {
  const literalFamily = net.isIP(hostname);
  const records = literalFamily ? [{ address: hostname, family: literalFamily }] :
    await waitWithSignal(Promise.resolve().then(() => lookup(hostname, { all: true, verbatim: true })), signal);
  if (!Array.isArray(records) || records.length === 0) throw new Error('DNS returned no public page addresses.');
  if (records.some(record => !record || !isPublicIP(record.address) || net.isIP(record.address) !== record.family)) {
    throw new Error('Page URL must resolve only to public IP addresses.');
  }
  // Prefer IPv4 where available; many desktop networks do not have IPv6 access.
  return records.find(record => record.family === 4) ?? records[0];
}

function headerValue(headers, name) {
  const value = headers[name];
  return typeof value === 'string' ? value : Array.isArray(value) ? value.join(',') : '';
}

function requestPage(target, address, { signal, maxBytes, requestImpl }) {
  return new Promise((resolve, reject) => {
    let request, response, settled = false;
    const finish = (error, value, close = false) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve(value);
      if (close) {
        response?.destroy();
        request?.destroy();
      }
    };
    const aborted = () => finish(signal.reason, undefined, true);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) { aborted(); return; }
    const options = {
      method: 'GET',
      hostname: target.hostname,
      headers: { 'user-agent': 'LumaLocal/1.0 (read-only page fetch)',
        accept: 'text/html, text/plain, application/json, application/xml;q=0.9',
        'accept-encoding': 'identity' },
      // A fresh native agent bypasses environment proxies and reused sockets.
      agent: false,
      autoSelectFamily: false,
      family: address.family,
      signal,
      lookup(_hostname, lookupOptions, callback) {
        if (typeof lookupOptions === 'function') { callback = lookupOptions; lookupOptions = {}; }
        if (lookupOptions?.all) callback(null, [{ address: address.address, family: address.family }]);
        else callback(null, address.address, address.family);
      }
    };
    const send = requestImpl ?? ((url, requestOptions, callback) =>
      (url.protocol === 'https:' ? https : http).request(url, requestOptions, callback));
    try {
      request = send(target.url, options, incoming => {
        response = incoming;
        response.on('error', error => finish(error, undefined, true));
        response.on('aborted', () => finish(new Error('Page response was interrupted.'), undefined, true));
        response.on('close', () => {
          if (!settled) finish(new Error('Page response closed before completion.'), undefined, true);
        });
        const statusCode = response.statusCode ?? 0;
        const headers = response.headers ?? {};
        if (REDIRECTS.has(statusCode)) {
          finish(null, { statusCode, location: headerValue(headers, 'location') }, true);
          return;
        }
        if (statusCode < 200 || statusCode >= 300) {
          finish(new Error(`Page fetch failed with HTTP ${statusCode}.`), undefined, true);
          return;
        }
        const encoding = headerValue(headers, 'content-encoding').trim().toLowerCase();
        if (encoding && encoding !== 'identity') {
          finish(new Error('Page Content-Encoding is unsupported; uncompressed text is required.'), undefined, true);
          return;
        }
        const contentType = headerValue(headers, 'content-type');
        const mime = contentType.split(';', 1)[0].trim().toLowerCase();
        if (!/^(?:text\/(?:html|plain|xml)|application\/(?:json|xml|xhtml\+xml|[a-z0-9!#$&^_.+-]+\+(?:json|xml)))$/.test(mime)) {
          finish(new Error('Page Content-Type must be HTML, plain text, JSON, or XML.'), undefined, true);
          return;
        }
        const chunks = [];
        let total = 0;
        response.on('data', rawChunk => {
          if (settled) return;
          const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
          const remaining = maxBytes - total;
          if (remaining > 0) chunks.push(chunk.length <= remaining ? chunk : chunk.subarray(0, remaining));
          total += chunk.length;
          if (total > maxBytes) finish(null, { statusCode, mime, contentType,
            bytes: Buffer.concat(chunks), truncated: true }, true);
        });
        response.once('end', () => finish(null, { statusCode, mime, contentType,
          bytes: Buffer.concat(chunks), truncated: false }));
      });
      request.on('error', error => finish(signal.aborted ? signal.reason : error, undefined, true));
      if (settled) request.destroy(); else request.end();
    } catch (error) {
      finish(error, undefined, true);
    }
  });
}

/**
 * Fetch a public text page with a 30-second total deadline. lookup is an async
 * dns.promises.lookup-compatible resolver; requestImpl follows http.request.
 * The returned strings are untrusted page data and must stay in a tool-result
 * message, never become privileged model instructions or executable UI markup.
 */
async function fetchPage(input, { signal, maxBytes = 1_000_000, maxChars = 40_000,
  lookup = dns.lookup, requestImpl } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxChars) || maxChars < 1) {
    throw new Error('Page output limits must be positive integers.');
  }
  if (signal?.aborted) throw abortError();
  let target = parseTarget(input);
  const controller = new AbortController();
  const callerAborted = () => controller.abort(abortError());
  signal?.addEventListener('abort', callerAborted, { once: true });
  const timer = setTimeout(() => {
    const error = new Error('Page fetch timed out after 30 seconds.');
    error.name = 'TimeoutError';
    controller.abort(error);
  }, TIMEOUT_MS);
  try {
    for (let redirects = 0; ; redirects++) {
      if (controller.signal.aborted) throw controller.signal.reason;
      const address = await validatedAddress(target.hostname, lookup, controller.signal);
      const page = await requestPage(target, address, { signal: controller.signal, maxBytes, requestImpl });
      if (REDIRECTS.has(page.statusCode)) {
        if (redirects >= 3) throw new Error('Page fetch exceeded three redirects.');
        if (!page.location) throw new Error('Page redirect has no Location URL.');
        target = parseTarget(new URL(page.location, target.url));
        continue;
      }
      const charsetMatch = page.contentType.match(/;\s*charset\s*=\s*(?:"([^";]+)"|'([^';]+)'|([^;\s]+))/i);
      const charset = charsetMatch ? charsetMatch[1] ?? charsetMatch[2] ?? charsetMatch[3] : 'utf-8';
      let decoder;
      try { decoder = new TextDecoder(charset); }
      catch { throw new Error('Page text charset is unsupported.'); }
      // Streaming decode deliberately drops an incomplete final code point at a byte cap.
      const text = decoder.decode(page.bytes, { stream: page.truncated });
      const extracted = page.mime === 'text/html' || page.mime.endsWith('xml') ? extractText(text) :
        { title: '', content: cleanText(text) };
      return { url: target.url.href, title: extracted.title,
        content: clipText(extracted.content, maxChars),
        truncated: page.truncated || extracted.content.length > maxChars,
        statusCode: page.statusCode };
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', callerAborted);
  }
}

module.exports = { isPublicIP, fetchPage, extractText };
