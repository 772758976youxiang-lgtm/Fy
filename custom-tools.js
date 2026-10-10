'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const { normalizeTool, validateArguments, renderTemplate, extractPath, resolveRequestURL } = require('./ui/tool-config');

const MAX_BYTES = 1024 * 1024;
const MAX_MCP_PAGES = 20;
const MAX_MCP_TOOLS = 500;
const MCP_VERSION = '2025-06-18';
const MCP_VERSIONS = new Set([MCP_VERSION, '2025-03-26']);

function prepared(input) {
  const tool = normalizeTool(structuredClone(input));
  tool.apiKey = typeof input.apiKey === 'string' ? input.apiKey : '';
  return tool;
}

function secrets(tool) {
  const values = [tool.apiKey];
  for (const [name, value] of Object.entries(tool.config.headers || {})) {
    if (/authorization|key|token|secret|password/i.test(name) || name.toLowerCase() === tool.config.authHeader?.toLowerCase()) {
      values.push(value, String(value).replace(/^(?:Bearer|Basic)\s+/i, ''));
    }
  }
  for (const [name, value] of Object.entries(tool.config.env || {})) {
    if (/key|token|secret|password/i.test(name)) values.push(value);
  }
  return [...new Set(values.filter(value => typeof value === 'string' && value))].sort((a, b) => b.length - a.length);
}

function redact(value, tool) {
  const hidden = secrets(tool);
  function walk(item) {
    if (typeof item === 'string') {
      for (const secret of hidden) item = item.split(secret).join('[redacted]');
      return item;
    }
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [walk(key), walk(child)]));
    return item;
  }
  return walk(value);
}

function safeError(error, tool) {
  const result = new Error(redact(String(error?.message || error), tool));
  result.name = error?.name || 'Error';
  if (error?.status) result.status = error.status;
  return result;
}

function fixedUrl(value) {
  if (typeof value !== 'string' || /{{|}}/.test(value)) throw new Error('A fixed HTTP URL is required');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only HTTP(S) URLs without credentials are supported');
  return url;
}

function displayUrl(value) {
  const url = new URL(value);
  for (const key of url.searchParams.keys()) if (/key|token|secret|password|authorization/i.test(key)) url.searchParams.set(key, '[redacted]');
  return url.href;
}

function cliArguments(tool, args) {
  const executable = tool.config.executable;
  const name = path.win32.basename(path.posix.basename(executable || '')).toLowerCase();
  if (!executable || /{{|}}|[\x00\r\n]/.test(executable) || /\.(cmd|bat)$/i.test(name) ||
      /^(?:cmd|powershell|pwsh|sh|bash|zsh|dash|fish|csh|tcsh|wscript|cscript)(?:\.exe)?$/i.test(name)) {
    throw new Error('A direct executable is required; shell and batch launchers are not supported');
  }
  const argv = renderTemplate(tool.config.argv || [], { args, config: tool.config });
  if (!Array.isArray(argv) || argv.some(value => !['string', 'number', 'boolean'].includes(typeof value))) throw new Error('CLI argv entries must be scalar values');
  const strings = argv.map(String);
  if (strings.some(value => value.includes('\0'))) throw new Error('CLI arguments cannot contain null bytes');
  return { executable, argv: strings };
}

function previewFor(tool, args) {
  const preview = { label: tool.label, kind: tool.kind, args };
  if (tool.kind === 'cli') Object.assign(preview, cliArguments(tool, args));
  else preview.url = displayUrl(fixedUrl(resolveRequestURL(tool)).href);
  return redact(preview, tool);
}

function approvalPreview(input, args) {
  const tool = prepared(input);
  try { return previewFor(tool, validateArguments(tool, args)); }
  catch (error) { throw safeError(error, tool); }
}

function budget(parent, timeoutMs) {
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    const error = new Error('Tool execution timed out');
    error.name = 'TimeoutError';
    controller.abort(error);
  }, timeoutMs);
  return { signal: controller.signal, close() { clearTimeout(timer); parent?.removeEventListener('abort', abort); } };
}

function abortable(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const done = () => { signal.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function headersFor(tool, extra = {}) {
  const headers = new Headers(tool.config.headers || {});
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (tool.apiKey && tool.config.auth === 'bearer') headers.set('Authorization', 'Bearer ' + tool.apiKey);
  if (tool.apiKey && tool.config.auth === 'header') headers.set(tool.config.authHeader || 'X-API-Key', tool.apiKey);
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return headers;
}

async function request(fetchImpl, url, init, signal) {
  signal.throwIfAborted();
  if (typeof init.body === 'string' && Buffer.byteLength(init.body) > MAX_BYTES) throw new Error('Tool request exceeds the 1 MiB size limit');
  const response = await abortable(fetchImpl(url, { ...init, signal, redirect: 'error' }), signal);
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    throw new Error('HTTP redirects are not supported');
  }
  return response;
}

async function readText(response, signal) {
  const declared = Number(response.headers.get('Content-Length'));
  if (declared > MAX_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Tool response exceeds the 1 MiB size limit');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '', bytes = 0;
  try {
    while (true) {
      const { value, done } = await abortable(reader.read(), signal);
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw new Error('Tool response exceeds the 1 MiB size limit');
      text += decoder.decode(value, { stream: true });
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function parseOutput(text, requireJson = false) {
  if (!text.trim()) return null;
  try { return JSON.parse(text); }
  catch { if (requireJson) throw new Error('Tool returned invalid JSON'); return text; }
}

async function httpResult(response, signal) {
  const text = await readText(response, signal);
  if (!response.ok) {
    const hint = response.status === 404 ? '接口或资源不存在，请检查完整接口地址与资源、模型配置后再重试' : '';
    const detail = [hint, text.trim().slice(0, 2000)].filter(Boolean).join('；');
    throw new Error('HTTP ' + response.status + ': ' + (detail || response.statusText || '工具请求失败'));
  }
  return parseOutput(text, /json/i.test(response.headers.get('Content-Type') || ''));
}

function pollUrl(tool, result) {
  const template = tool.config.poll.url;
  if (typeof template !== 'string' || !template) throw new Error('Polling requires a fixed URL template');
  const rendered = template.replace(/{{\s*([^{}]+?)\s*}}/g, (_, expression) => {
    if (!/^result(?:\.[A-Za-z0-9_-]+)+$/.test(expression)) throw new Error('Poll URLs only support result field placeholders');
    const value = result === undefined ? 'validation' : extractPath(result, expression.slice(7));
    if (!['string', 'number', 'boolean'].includes(typeof value)) throw new Error('Poll URL result fields must be scalar values');
    if (value === '.' || value === '..') throw new Error('Poll URL fields cannot contain traversal segments');
    return encodeURIComponent(String(value));
  });
  const url = fixedUrl(rendered);
  if (url.origin !== fixedUrl(tool.config.url).origin) throw new Error('Polling must use the configured URL origin');
  return url.href;
}

async function executeHttp(tool, args, fetchImpl, signal) {
  const config = tool.config;
  const method = config.method || 'POST';
  const body = renderTemplate(config.body, { args, config });
  const init = { method, headers: headersFor(tool) };
  if (method !== 'GET' && method !== 'HEAD') init.body = JSON.stringify(body);
  let result = await httpResult(await request(fetchImpl, resolveRequestURL(tool), init, signal), signal);
  let selectedPath = config.resultPath;
  if (config.poll?.enabled) {
    const poll = config.poll;
    let url;
    let complete = false;
    for (let attempt = 0; attempt <= poll.maxAttempts; attempt++) {
      const status = extractPath(result, poll.statusPath);
      if (poll.failureValues.includes(status)) throw new Error('Generation failed with status: ' + status);
      if (poll.successValues.includes(status)) { complete = true; break; }
      if (attempt === poll.maxAttempts) break;
      url ||= pollUrl(tool, result);
      await pause(poll.intervalMs, signal);
      result = await httpResult(await request(fetchImpl, url, { method: 'GET', headers: headersFor(tool) }, signal), signal);
    }
    if (!complete) throw new Error('Generation polling exceeded its attempt limit');
    selectedPath = poll.resultPath || selectedPath;
  }
  ensureNoInlineMedia(result);
  return selectedPath ? extractPath(result, selectedPath) : result;
}

function cliEnvironment(tool) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/^(?:path|systemroot|windir|temp|tmp)$/i.test(name)) env[name] = value;
  }
  for (const [name, value] of Object.entries(tool.config.env || {})) {
    for (const existing of Object.keys(env)) if (existing.toLowerCase() === name.toLowerCase()) delete env[existing];
    env[name] = value;
  }
  if (tool.apiKey) env[tool.config.apiKeyEnv || 'TOOL_API_KEY'] = tool.apiKey;
  return env;
}

function executeCli(tool, args, signal) {
  signal.throwIfAborted();
  const { executable, argv } = cliArguments(tool, args);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, { shell: false, windowsHide: true,
      cwd: tool.config.cwd || undefined, env: cliEnvironment(tool), stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    let bytes = 0, failure;
    const stop = error => { failure ||= error; child.kill('SIGKILL'); };
    const abort = () => stop(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) stop(new Error('CLI output exceeds the 1 MiB size limit'));
      else chunks.push(chunk);
    });
    child.on('error', error => { failure ||= error; });
    child.on('close', code => {
      signal.removeEventListener('abort', abort);
      if (failure) return reject(failure);
      const output = Buffer.concat(stdout).toString('utf8');
      if (code !== 0) return reject(new Error('CLI exited with code ' + code + ': ' + Buffer.concat(stderr).toString('utf8').slice(0, 2000)));
      try {
        const result = parseOutput(output, tool.config.output === 'json');
        ensureNoInlineMedia(result);
        resolve(tool.config.resultPath ? extractPath(result, tool.config.resultPath) : result);
      } catch (error) { reject(error); }
    });
  });
}

function rpcMessage(message, id) {
  if (!message || message.jsonrpc !== '2.0' || message.id !== id) throw new Error('MCP response id does not match the request');
  if (message.error) throw new Error('MCP error: ' + String(message.error.message || 'Unknown protocol error'));
  if (!Object.hasOwn(message, 'result')) throw new Error('MCP response is missing its result');
  return message.result;
}

async function readRpc(response, id, signal, onRequest) {
  if (!response.ok) return httpResult(response, signal);
  if (!(response.headers.get('Content-Type') || '').includes('text/event-stream')) {
    return rpcMessage(parseOutput(await readText(response, signal), true), id);
  }
  if (!response.body) throw new Error('MCP SSE response is empty');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', bytes = 0, lines = [], skipLF = false;
  async function consume(line) {
    if (line !== '') { if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^ /, '')); return null; }
    if (!lines.length) return null;
    const data = lines.join('\n'); lines = [];
    if (data === '[DONE]') return null;
    const message = parseOutput(data, true);
    if (message?.method && Object.hasOwn(message, 'id')) await onRequest(message);
    if (message?.id === id && !message.method) return { result: rpcMessage(message, id) };
    return null;
  }
  try {
    while (true) {
      const { value, done } = await abortable(reader.read(), signal);
      if (value) {
        bytes += value.byteLength;
        if (bytes > MAX_BYTES) throw new Error('MCP response exceeds the 1 MiB size limit');
      }
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (skipLF && buffer.length) {
        if (buffer[0] === '\n') buffer = buffer.slice(1);
        skipLF = false;
      }
      let newline;
      while ((newline = buffer.search(/[\r\n]/)) !== -1) {
        const line = buffer.slice(0, newline), cr = buffer[newline] === '\r';
        buffer = buffer.slice(newline + 1);
        if (cr && buffer[0] === '\n') buffer = buffer.slice(1);
        else if (cr && !buffer.length) skipLF = true;
        const matched = await consume(line);
        if (matched) return matched.result;
      }
      if (done) {
        if (buffer) await consume(buffer.replace(/\r$/, ''));
        const matched = await consume('');
        if (matched) return matched.result;
        throw new Error('MCP stream ended without a matching response id');
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

async function mcpSession(tool, fetchImpl, signal, action) {
  let sessionId, protocol, nextId = 1, pendingId;
  const headers = () => headersFor(tool, { Accept: 'application/json, text/event-stream',
    ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    ...(protocol ? { 'MCP-Protocol-Version': protocol } : {}) });
  const send = async (message, activeSignal = signal) => {
    const response = await request(fetchImpl, tool.config.url, { method: 'POST', headers: headers(), body: JSON.stringify(message) }, activeSignal);
    if (!Object.hasOwn(message, 'id') || Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')) {
      if (!response.ok) await httpResult(response, activeSignal);
      else await response.body?.cancel().catch(() => {});
      return;
    }
    if (message.method === 'initialize') {
      const assigned = response.headers.get('Mcp-Session-Id');
      if (assigned && (!/^[\x21-\x7e]+$/.test(assigned) || assigned.length > 4096)) throw new Error('MCP returned an invalid session id');
      sessionId = assigned || undefined;
    }
    return readRpc(response, message.id, activeSignal, incoming => send({ jsonrpc: '2.0', id: incoming.id,
      ...(incoming.method === 'ping' ? { result: {} } : { error: { code: -32601, message: 'Client capability not supported' } }) }, activeSignal));
  };
  const call = async (method, params) => {
    const id = nextId++; pendingId = id;
    const result = await send({ jsonrpc: '2.0', id, method, params });
    pendingId = undefined;
    return result;
  };
  try {
    const initialized = await call('initialize', { protocolVersion: MCP_VERSION, capabilities: {},
      clientInfo: { name: 'luma', version: '1.0.0' } });
    if (!MCP_VERSIONS.has(initialized?.protocolVersion)) throw new Error('MCP protocol version is not supported');
    protocol = initialized.protocolVersion;
    if (!initialized.capabilities?.tools) throw new Error('MCP server does not advertise tools capability');
    await send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return await action(call);
  } finally {
    if (sessionId || (pendingId && signal.aborted)) {
      const cleanup = budget(undefined, 1000);
      try {
        if (pendingId && signal.aborted && protocol) await send({ jsonrpc: '2.0', method: 'notifications/cancelled',
          params: { requestId: pendingId, reason: 'Client cancelled the request' } }, cleanup.signal).catch(() => {});
        if (sessionId) {
          const response = await request(fetchImpl, tool.config.url, { method: 'DELETE', headers: headers() }, cleanup.signal);
          await response.body?.cancel().catch(() => {});
        }
      } catch {} finally { cleanup.close(); }
    }
  }
}

function ensureNoInlineMedia(value, depth = 0) {
  if (depth > 50) throw new Error('Tool result nesting exceeds the depth limit');
  if (typeof value === 'string' && /data:[^\s;,]+(?:;[^,]*)?;base64,/i.test(value)) throw new Error('Inline base64 media is not supported; configure the provider to return an HTTP(S) URL');
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:b64_json|base64|blob)$/i.test(key) && typeof child === 'string' && child) throw new Error('Inline base64 media is not supported; configure the provider to return an HTTP(S) URL');
    if (key === 'data' && typeof child === 'string' && /^(?:image|audio|video)$/.test(value.type || '')) throw new Error('Inline base64 media is not supported; configure the MCP tool to return an HTTP(S) resource link');
    ensureNoInlineMedia(child, depth + 1);
  }
}

function resultEnvelope(output, tool) {
  ensureNoInlineMedia(output);
  if (output === undefined) throw new Error('Configured result path was not found in the tool response');
  const artifacts = [];
  function add(type, value) {
    if (typeof value !== 'string') return;
    try {
      const url = fixedUrl(value);
      if (!artifacts.some(item => item.type === type && item.url === url.href)) artifacts.push({ type, url: url.href });
    } catch {}
  }
  function scan(value, mediaType) {
    if (typeof value === 'string') { if (mediaType) add(mediaType, value); return; }
    if (Array.isArray(value)) { for (const item of value) scan(item, mediaType); return; }
    if (!value || typeof value !== 'object') return;
    const type = /^(image|video)\//.exec(value.mimeType || '')?.[1] || mediaType;
    if (type) { add(type, value.url); add(type, value.uri); }
    for (const [key, child] of Object.entries(value)) {
      if (['url', 'uri'].includes(key)) continue;
      const childType = /^(?:image_url|images)$/.test(key) ? 'image' : /^(?:video_url|videos)$/.test(key) ? 'video' : type;
      if (child && typeof child === 'object' || childType && ['image_url', 'video_url', 'output', 'result', 'asset'].includes(key)) scan(child, childType);
    }
  }
  const outputType = tool.config.output;
  scan(output, ['image', 'video'].includes(outputType) ? outputType : undefined);
  if (['image', 'video'].includes(outputType) && !artifacts.length) throw new Error('Tool returned no usable HTTP(S) ' + outputType + ' URL; check the result path and provider output format');
  return redact({ output, artifacts }, tool);
}

async function executeCustomTool(input, inputArgs, { fetchImpl = fetch, signal, approve } = {}) {
  const tool = prepared(input);
  let scope;
  try {
    const args = validateArguments(tool, structuredClone(inputArgs));
    signal?.throwIfAborted();
    const preview = previewFor(tool, args);
    if (tool.config.poll?.enabled) pollUrl(tool);
    if (tool.kind === 'cli' || tool.requireConfirmation) {
      if (typeof approve !== 'function') throw new Error('Tool confirmation approval is required');
      if (await abortable(Promise.resolve().then(() => approve(preview)), signal) !== true) throw new Error('Tool confirmation approval was denied');
    }
    scope = budget(signal, tool.config.timeoutMs);
    let output;
    if (tool.kind === 'cli') output = await executeCli(tool, args, scope.signal);
    else if (tool.kind === 'mcp') {
      if (!tool.config.mcpTool.trim()) throw new Error('Select an MCP tool name before execution');
      output = await mcpSession(tool, fetchImpl, scope.signal, async call => {
      const result = await call('tools/call', { name: tool.config.mcpTool, arguments: args });
      if (result?.isError) throw new Error('MCP tool error: ' + JSON.stringify(result.content || result).slice(0, 2000));
      ensureNoInlineMedia(result);
      return tool.config.resultPath ? extractPath(result, tool.config.resultPath) : result;
      });
    }
    else output = await executeHttp(tool, args, fetchImpl, scope.signal);
    scope.signal.throwIfAborted();
    return resultEnvelope(output, tool);
  } catch (error) { throw safeError(scope?.signal.aborted ? scope.signal.reason : error, tool); }
  finally { scope?.close(); }
}

async function discoverMcpTools(input, { fetchImpl = fetch, signal } = {}) {
  const tool = prepared(input);
  if (tool.kind !== 'mcp') throw new Error('MCP discovery requires an MCP tool');
  fixedUrl(tool.config.url);
  const scope = budget(signal, tool.config.timeoutMs);
  try {
    const tools = await mcpSession(tool, fetchImpl, scope.signal, async call => {
      const list = [], cursors = new Set();
      let cursor;
      for (let page = 0; page < MAX_MCP_PAGES; page++) {
        const result = await call('tools/list', cursor ? { cursor } : {});
        if (!Array.isArray(result?.tools)) throw new Error('MCP tools/list returned an invalid tools array');
        list.push(...result.tools);
        if (list.length > MAX_MCP_TOOLS || Buffer.byteLength(JSON.stringify(list)) > MAX_BYTES) throw new Error('MCP discovery exceeds its size limit');
        if (!result.nextCursor) return list;
        if (typeof result.nextCursor !== 'string' || result.nextCursor.length > 4096 || cursors.has(result.nextCursor)) throw new Error('MCP discovery returned an invalid or repeated cursor');
        cursor = result.nextCursor; cursors.add(cursor);
      }
      throw new Error('MCP discovery exceeded its page limit');
    });
    ensureNoInlineMedia(tools);
    return redact(tools, tool);
  } catch (error) { throw safeError(scope.signal.aborted ? scope.signal.reason : error, tool); }
  finally { scope.close(); }
}

module.exports = { executeCustomTool, discoverMcpTools, approvalPreview };
