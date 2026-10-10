/* Native-search request and citation mapping adapted from DeepSeek Harness
 * d743267388641bc76f17c45ce8b4c231aed1d32c (MIT). See THIRD_PARTY_NOTICES.txt. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LumaSearch = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULTS = Object.freeze({
    provider: 'deepseek-official',
    baseURL: 'https://api.deepseek.com/anthropic/v1',
    model: 'deepseek-v4-flash',
    apiVersion: '2023-06-01',
    maxTokens: 4096,
    maxUses: 5,
    timeoutMs: 60000,
    maxResults: 8,
    maxResponseBytes: 2 * 1024 * 1024,
  });

  function providerError(message, code) {
    const error = new Error(message);
    error.code = code || 'WEB_PROVIDER_ERROR';
    return error;
  }

  function cancellationError(timedOut) {
    const error = providerError(timedOut ? 'DeepSeek search timed out after 60 seconds' : 'DeepSeek search aborted', timedOut ? 'WEB_TIMEOUT' : 'WEB_ABORTED');
    error.name = timedOut ? 'TimeoutError' : 'AbortError';
    return error;
  }

  function searchEndpoint(base) {
    let endpoint;
    try {
      if (typeof base !== 'string' || !base.trim()) throw new Error();
      endpoint = new URL(base.trim());
    } catch (_) {
      throw providerError('Search endpoint must be a valid HTTPS URL or a localhost HTTP URL');
    }
    const local = endpoint.hostname === 'localhost' || endpoint.hostname === '127.0.0.1' || endpoint.hostname === '[::1]';
    if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && local)) {
      throw providerError('Search endpoint requires HTTPS; HTTP is allowed only on localhost');
    }
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw providerError('Search endpoint cannot contain URL credentials, a query string, or a fragment');
    }
    const pathname = endpoint.pathname.replace(/\/+$/, '');
    endpoint.pathname = pathname.endsWith('/messages') ? pathname : pathname + '/messages';
    return endpoint.toString();
  }

  function resultLimit(value) {
    if (!Number.isInteger(value) || value < 1) throw providerError('maxResults must be a positive integer');
    return Math.min(value, DEFAULTS.maxResults);
  }

  function detailOf(value) {
    if (!value || typeof value !== 'object') return '';
    if (typeof value.error === 'string') return value.error;
    if (value.error && typeof value.error.message === 'string') return value.error.message;
    if (typeof value.message === 'string') return value.message;
    if (typeof value.error_code === 'string') return value.error_code;
    return '';
  }

  function rejectStructuredError(value) {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'error' || (typeof value.type === 'string' && value.type.endsWith('_error'))) {
      throw providerError('DeepSeek native search error: ' + (detailOf(value) || value.type));
    }
  }

  function mapNativeResponse(payload, maxResults) {
    const limit = resultLimit(maxResults === undefined ? DEFAULTS.maxResults : maxResults);
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.content)) {
      const detail = detailOf(payload);
      throw providerError(detail ? 'DeepSeek native search error: ' + detail : 'DeepSeek returned an unprocessable native search response');
    }
    rejectStructuredError(payload);
    if (payload.error != null) throw providerError('DeepSeek native search error: ' + (detailOf(payload) || 'Unknown provider error'));
    const blocks = payload.content;
    const snippets = new Map();
    const resultBlocks = [];
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      rejectStructuredError(block);
      if (block.type === 'web_search_tool_result') resultBlocks.push(block);
      if (block.type !== 'text' || !Array.isArray(block.citations)) continue;
      for (const citation of block.citations) {
        if (!citation || typeof citation.url !== 'string' || !citation.url || typeof citation.cited_text !== 'string' || !citation.cited_text || snippets.has(citation.url)) continue;
        snippets.set(citation.url, citation.cited_text);
      }
    }
    if (!resultBlocks.length) {
      throw providerError('DeepSeek returned no web_search_tool_result blocks; the request may not have triggered native web search');
    }
    const seen = new Set();
    const sources = [];
    for (const block of resultBlocks) {
      rejectStructuredError(block.content);
      if (block.content != null && !Array.isArray(block.content)) throw providerError('DeepSeek returned unprocessable web_search_tool_result content');
      for (const item of block.content || []) {
        if (!item || typeof item !== 'object') continue;
        rejectStructuredError(item);
        if (item.type !== 'web_search_result' || typeof item.url !== 'string' || !item.url.trim() || seen.has(item.url)) continue;
        seen.add(item.url);
        const source = {
          title: typeof item.title === 'string' && item.title ? item.title : item.url,
          url: item.url,
          content: snippets.get(item.url) || '',
        };
        if (typeof item.page_age === 'string' && item.page_age) source.publishedAt = item.page_age;
        sources.push(source);
      }
    }
    return sources.slice(0, limit);
  }

  function throwIfAborted(signal) {
    if (signal.aborted) throw signal.reason;
  }

  function abortable(operation, signal) {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise(function (resolve, reject) {
      const onAbort = function () { reject(signal.reason); };
      signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve(operation).then(function (value) {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      }, function (error) {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      });
    });
  }

  function cancelBody(body) {
    if (!body || typeof body.cancel !== 'function') return;
    try { Promise.resolve(body.cancel()).catch(function () {}); } catch (_) { /* already locked */ }
  }

  async function boundedText(response, signal) {
    const declaredLength = response.headers && response.headers.get('content-length');
    if (declaredLength && Number(declaredLength) > DEFAULTS.maxResponseBytes) {
      cancelBody(response.body);
      throw providerError('DeepSeek response is too large (2 MiB limit)');
    }
    if (!response.body) return '';
    if (typeof response.body.getReader !== 'function') throw providerError('DeepSeek response body is not a readable stream');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = '';
    try {
      while (true) {
        throwIfAborted(signal);
        const chunk = await abortable(reader.read(), signal);
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > DEFAULTS.maxResponseBytes) throw providerError('DeepSeek response is too large (2 MiB limit)');
        text += decoder.decode(chunk.value, { stream: true });
      }
      throwIfAborted(signal);
      return text + decoder.decode();
    } catch (error) {
      cancelBody(reader);
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  function redact(message, apiKey) {
    let safe = String(message);
    // Redact before truncating so a long key cannot leak as a partial prefix.
    for (const secret of [apiKey, encodeURIComponent(apiKey)]) {
      if (secret) safe = safe.split(secret).join('[redacted]');
    }
    return safe.slice(0, 1500);
  }

  async function search(query, options, externalSignal) {
    if (externalSignal && externalSignal.aborted) throw cancellationError(false);
    options = options || {};
    // Snapshot all request settings before dispatch; later edits apply to the next search.
    const { baseURL, model, apiKey: suppliedKey, maxResults, fetchImpl } = options;
    const snapshot = {
      baseURL: baseURL === undefined ? DEFAULTS.baseURL : baseURL,
      model: model === undefined ? DEFAULTS.model : model,
      apiKey: suppliedKey,
      maxResults: maxResults === undefined ? DEFAULTS.maxResults : maxResults,
      fetchImpl: fetchImpl === undefined ? (typeof fetch === 'function' ? fetch.bind(globalThis) : undefined) : fetchImpl,
    };
    if (typeof query !== 'string' || !query.trim()) throw providerError('Search query cannot be empty');
    if (typeof snapshot.apiKey !== 'string' || !snapshot.apiKey.trim()) throw providerError('DeepSeek search requires an API key', 'WEB_PROVIDER_CREDENTIAL_MISSING');
    if (/[\r\n\x00]/.test(snapshot.apiKey)) throw providerError('API key contains invalid characters');
    const apiKey = snapshot.apiKey.trim();
    if (typeof snapshot.model !== 'string' || !snapshot.model.trim()) throw providerError('Search model cannot be empty');
    const endpoint = searchEndpoint(snapshot.baseURL);
    const limit = resultLimit(snapshot.maxResults);
    if (typeof snapshot.fetchImpl !== 'function') throw providerError('Native search requires fetch support');
    const controller = new AbortController();
    const signal = controller.signal;
    const onExternalAbort = function () { controller.abort(cancellationError(false)); };
    if (externalSignal) {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      if (externalSignal.aborted) onExternalAbort();
    }
    const timer = setTimeout(function () { controller.abort(cancellationError(true)); }, DEFAULTS.timeoutMs);
    try {
      throwIfAborted(signal);
      const response = await abortable(snapshot.fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'x-api-key': apiKey,
          authorization: 'Bearer ' + apiKey,
          'anthropic-version': DEFAULTS.apiVersion,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          model: snapshot.model.trim(),
          max_tokens: DEFAULTS.maxTokens,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'Perform a web search for the query: ' + query.trim() }] }],
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: DEFAULTS.maxUses }],
        }),
        signal,
      }), signal);
      throwIfAborted(signal);
      if (!response || typeof response.ok !== 'boolean') throw providerError('DeepSeek returned an unprocessable HTTP response');
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        cancelBody(response.body);
        throw providerError('DeepSeek search redirects are not allowed');
      }
      if (!response.ok) {
        let message = 'DeepSeek API error (HTTP ' + response.status + ')';
        try {
          const detail = detailOf(JSON.parse(await boundedText(response, signal)));
          if (detail) message += ': ' + detail;
        } catch (error) {
          throwIfAborted(signal);
          if (error && error.code === 'WEB_PROVIDER_ERROR') message += ': ' + error.message;
          // Gateways may return HTML or an empty body; retain the real HTTP status.
        }
        throw providerError(message);
      }
      let payload;
      try { payload = JSON.parse(await boundedText(response, signal)); }
      catch (error) {
        throwIfAborted(signal);
        if (error && error.code === 'WEB_PROVIDER_ERROR') throw error;
        throw providerError('DeepSeek returned unprocessable JSON');
      }
      throwIfAborted(signal);
      return mapNativeResponse(payload, limit);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error && error.name === 'AbortError') throw cancellationError(false);
      const message = error && error.message ? error.message : String(error);
      // Do not retain raw provider errors as causes: a cause or stack could expose the key.
      throw providerError(redact(message, apiKey));
    } finally {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }

  return Object.freeze({ DEFAULTS, searchEndpoint, mapNativeResponse, search });
});
