'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { executeCustomTool, discoverMcpTools, approvalPreview } = require('../custom-tools');

function tool(kind = 'http', config = {}, extra = {}) {
  return {
    id: 'executor-test', name: 'custom_example', label: 'Example', description: 'Test tool',
    kind, enabled: true, requireConfirmation: false, rememberKey: false,
    parameters: [{ name: 'prompt', type: 'string', required: true, description: 'Input' }],
    config: { url: 'https://example.test/run', method: 'POST', auth: 'bearer',
      headers: {}, body: { prompt: '{{args.prompt}}' }, output: 'json', timeoutMs: 2000,
      ...config }, ...extra
  };
}

async function serve(t, handler) {
  const server = http.createServer(async (request, response) => {
    try {
      let body = '';
      for await (const chunk of request) body += chunk;
      await handler(request, response, body ? JSON.parse(body) : null);
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'text/plain' });
      response.end(error.message);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return 'http://127.0.0.1:' + server.address().port;
}

function json(response, payload, status = 200, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  response.end(JSON.stringify(payload));
}

test('HTTP renders typed body and uses fixed URL, model and authentication', async t => {
  let received;
  const url = await serve(t, (request, response, body) => {
    received = { url: request.url, auth: request.headers.authorization, body };
    json(response, { data: { answer: 42 }, echoed: request.headers.authorization });
  });
  const configured = tool('llm', { url: url + '/generate', model: 'fixed-model',
    body: { model: '{{config.model}}', input: '{{args.prompt}}', count: '{{args.count}}' },
    resultPath: 'data' }, { apiKey: 'example-private-key', parameters: [
      { name: 'prompt', type: 'string', required: true },
      { name: 'count', type: 'integer', default: 2 }
    ] });
  assert.deepEqual(await executeCustomTool(configured, { prompt: 'hello' }),
    { output: { answer: 42 }, artifacts: [] });
  assert.deepEqual(received, { url: '/generate', auth: 'Bearer example-private-key',
    body: { model: 'fixed-model', input: 'hello', count: 2 } });
});

test('LLM base URL reaches chat completions and approval shows the actual destination', async t => {
  let received;
  const base = await serve(t, (request, response, body) => {
    received = { url: request.url, body };
    if (request.url !== '/chat/completions') { response.writeHead(404); response.end(); return; }
    json(response, { choices: [{ message: { content: 'connected' } }] });
  });
  const configured = require('../ui/tool-config').createTemplate('llm');
  Object.assign(configured, { name: 'weather_llm', apiKey: 'fake-test-key' });
  Object.assign(configured.config, { url: base + '/', model: 'fixed-model', effort: 'none' });
  const result = await executeCustomTool(configured, { prompt: 'connection check' });
  assert.equal(result.output, 'connected');
  assert.equal(received.url, '/chat/completions');
  assert.equal(received.body.reasoning_effort, 'none');
  assert.equal(approvalPreview(configured, { prompt: 'check' }).url, base + '/chat/completions');
  assert.equal(configured.config.url, base + '/');
});

test('empty HTTP 404 includes actionable configuration guidance', async () => {
  await assert.rejects(executeCustomTool(tool('http'), { prompt: 'check' }, {
    fetchImpl: async () => new Response('', { status: 404 })
  }), error => /HTTP 404/.test(error.message) && /接口地址/.test(error.message) && /重试/.test(error.message));
});

test('invalid arguments fail before approval or network and confirmation fails closed', async () => {
  let calls = 0, approvals = 0;
  const fetchImpl = async () => { calls++; return Response.json({ ok: true }); };
  const configured = tool('http', {}, { requireConfirmation: true });
  await assert.rejects(executeCustomTool(configured, { prompt: 'x', url: 'https://evil.test' },
    { fetchImpl, approve: async () => { approvals++; return true; } }));
  await assert.rejects(executeCustomTool(configured, { prompt: 'x' }, { fetchImpl }), /confirm|approval/i);
  await assert.rejects(executeCustomTool(configured, { prompt: 'x' },
    { fetchImpl, approve: async () => false }), /denied|declined|confirm|approval/i);
  assert.equal(calls, 0);
  assert.equal(approvals, 0);
});

test('approval previews and upstream failures do not disclose API keys', async () => {
  const configured = tool('http', {}, { apiKey: 'private-token-123', requireConfirmation: true });
  const preview = approvalPreview(configured, { prompt: 'private-token-123' });
  assert.doesNotMatch(JSON.stringify(preview), /private-token-123/);
  assert.equal(preview.url, 'https://example.test/run');
  await assert.rejects(executeCustomTool(configured, { prompt: 'x' }, {
    approve: async () => true,
    fetchImpl: async () => new Response('failed with private-token-123', { status: 400 })
  }), error => !error.message.includes('private-token-123') && /400/.test(error.message));
  const output = await executeCustomTool({ ...configured, requireConfirmation: false }, { prompt: 'x' },
    { fetchImpl: async () => Response.json({ echoed: 'private-token-123' }) });
  assert.doesNotMatch(JSON.stringify(output), /private-token-123/);
});

test('HTTP rejects redirects without visiting destination', async t => {
  let visited = 0;
  const url = await serve(t, (request, response) => {
    if (request.url === '/redirect') { response.writeHead(302, { Location: '/destination' }); response.end(); }
    else { visited++; json(response, { ok: true }); }
  });
  await assert.rejects(executeCustomTool(tool('http', { url: url + '/redirect' }), { prompt: 'x' }));
  assert.equal(visited, 0);
});

test('generation polls encoded result fields and returns a safe video artifact', async t => {
  const paths = [];
  const url = await serve(t, (request, response) => {
    paths.push(request.url);
    if (request.url === '/generate') json(response, { id: 'job/with?chars', status: 'queued' });
    else json(response, { status: 'completed', asset: 'https://cdn.example.test/result.mp4' });
  });
  const result = await executeCustomTool(tool('video', { url: url + '/generate', output: 'video',
    poll: { enabled: true, url: url + '/jobs/{{result.id}}', statusPath: 'status',
      successValues: ['completed'], failureValues: ['failed'], intervalMs: 100, maxAttempts: 2,
      resultPath: 'asset' } }), { prompt: 'make a clip' });
  assert.deepEqual(paths, ['/generate', '/jobs/job%2Fwith%3Fchars']);
  assert.deepEqual(result, { output: 'https://cdn.example.test/result.mp4',
    artifacts: [{ type: 'video', url: 'https://cdn.example.test/result.mp4' }] });
});

test('polling refuses cross-origin URLs and reports failed jobs', async () => {
  let calls = 0;
  const config = { output: 'video', poll: { enabled: true,
    url: 'https://elsewhere.test/jobs/{{result.id}}', intervalMs: 100, maxAttempts: 2,
    statusPath: 'status', successValues: ['completed'], failureValues: ['failed'] } };
  await assert.rejects(executeCustomTool(tool('video', config), { prompt: 'x' }, {
    fetchImpl: async () => { calls++; return Response.json({ id: 'a', status: 'queued' }); }
  }));
  assert.equal(calls, 0);
  config.poll.url = 'https://example.test/jobs/{{result.id}}';
  await assert.rejects(executeCustomTool(tool('video', config), { prompt: 'x' }, {
    fetchImpl: async () => Response.json({ id: 'a', status: 'failed' })
  }), /failed/i);
});

test('inline media is rejected and oversized responses are bounded', async () => {
  await assert.rejects(executeCustomTool(tool('image', { output: 'image' }), { prompt: 'x' }, {
    fetchImpl: async () => Response.json({ data: [{ b64_json: 'a'.repeat(200) }] })
  }), /base64|URL/i);
  await assert.rejects(executeCustomTool(tool(), { prompt: 'x' }, {
    fetchImpl: async () => new Response('x'.repeat(2 * 1024 * 1024))
  }), /limit|large|size/i);
});

test('HTTP timeout and user cancellation stop pending requests', async t => {
  const url = await serve(t, () => {});
  await assert.rejects(executeCustomTool(tool('http', { url, timeoutMs: 1000 }), { prompt: 'x' }),
    /timeout|timed out/i);
  const controller = new AbortController();
  const pending = executeCustomTool(tool('http', { url }), { prompt: 'x' }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, error => error.name === 'AbortError');
});

test('CLI requires confirmation, preserves one argument, and inherits no unrelated secrets', async () => {
  const configured = tool('cli', { executable: process.execPath,
    argv: ['-e', 'process.stdout.write(JSON.stringify({arg:process.argv[1],key:process.env.TOOL_API_KEY,other:process.env.LUMA_TEST_SECRET,own:process.env.OWN_VALUE}))', '{{args.prompt}}'],
    env: { OWN_VALUE: 'configured' }, apiKeyEnv: 'TOOL_API_KEY', output: 'json' },
  { apiKey: 'cli-private-token' });
  process.env.LUMA_TEST_SECRET = 'must-not-inherit';
  try {
    await assert.rejects(executeCustomTool(configured, { prompt: 'hello' }), /confirm|approval/i);
    const result = await executeCustomTool(configured, { prompt: 'hello & echo injected' }, {
      approve: async preview => {
        assert.equal(preview.argv.at(-1), 'hello & echo injected');
        assert.doesNotMatch(JSON.stringify(preview), /cli-private-token/);
        return true;
      }
    });
    assert.equal(result.output.arg, 'hello & echo injected');
    assert.equal(result.output.own, 'configured');
    assert.equal(result.output.other, undefined);
    assert.doesNotMatch(JSON.stringify(result), /cli-private-token/);
  } finally { delete process.env.LUMA_TEST_SECRET; }
});

test('CLI refuses shell launchers and stops oversized or cancelled processes', async () => {
  for (const executable of ['task.cmd', 'task.bat', 'cmd.exe', 'powershell.exe']) {
    await assert.rejects(executeCustomTool(tool('cli', { executable, argv: [] }), { prompt: 'x' },
      { approve: async () => true }), /shell|executable|batch/i);
  }
  await assert.rejects(executeCustomTool(tool('cli', { executable: process.execPath,
    argv: ['-e', 'process.stdout.write("x".repeat(2*1024*1024))'] }), { prompt: 'x' },
  { approve: async () => true }), /limit|large|size/i);
  const controller = new AbortController();
  const pending = executeCustomTool(tool('cli', { executable: process.execPath,
    argv: ['-e', 'setInterval(()=>{},1000)'] }), { prompt: 'x' },
  { approve: async () => true, signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, error => error.name === 'AbortError');
});

test('MCP initializes, paginates discovery with negotiated headers, and cleans its session', async t => {
  const calls = [];
  const url = await serve(t, (request, response, body) => {
    calls.push({ method: request.method, headers: request.headers, body });
    if (request.method === 'DELETE') { response.writeHead(204); response.end(); return; }
    if (body.method === 'initialize') json(response, { jsonrpc: '2.0', id: body.id,
      result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1' } } },
    200, { 'Mcp-Session-Id': 'session-123' });
    else if (body.method === 'notifications/initialized') { response.writeHead(202); response.end(); }
    else json(response, { jsonrpc: '2.0', id: body.id, result: body.params.cursor ?
      { tools: [{ name: 'second', inputSchema: { type: 'object' } }] } :
      { tools: [{ name: 'first', inputSchema: { type: 'object' } }], nextCursor: 'next' } });
  });
  const found = await discoverMcpTools(tool('mcp', { url, mcpTool: 'first' }, { requireConfirmation: true }));
  assert.deepEqual(found.map(item => item.name), ['first', 'second']);
  assert.deepEqual(calls.map(call => call.body?.method || call.method),
    ['initialize', 'notifications/initialized', 'tools/list', 'tools/list', 'DELETE']);
  assert.equal(calls[0].body.params.protocolVersion, '2025-06-18');
  for (const call of calls.slice(1)) {
    assert.equal(call.headers['mcp-session-id'], 'session-123');
    assert.equal(call.headers['mcp-protocol-version'], '2025-03-26');
  }
});

test('MCP call reads matching SSE result and keeps structured content', async t => {
  let callArgs;
  const url = await serve(t, (request, response, body) => {
    if (request.method === 'DELETE') { response.writeHead(204); response.end(); return; }
    if (body.method === 'initialize') json(response, { jsonrpc: '2.0', id: body.id,
      result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } } });
    else if (body.method === 'notifications/initialized') { response.writeHead(202); response.end(); }
    else {
      callArgs = body.params;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: ' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress' }) + '\n\n');
      response.write('data: ' + JSON.stringify({ jsonrpc: '2.0', id: 'wrong-id', result: { stolen: true } }) + '\n\n');
      response.end('data: ' + JSON.stringify({ jsonrpc: '2.0', id: body.id,
        result: { structuredContent: { score: 9 }, content: [{ type: 'text', text: 'Approved' }] } }) + '\n\n');
    }
  });
  const result = await executeCustomTool(tool('mcp', { url, mcpTool: 'evaluate' },
    { requireConfirmation: true }), { prompt: 'input' }, { approve: async () => true });
  assert.deepEqual(callArgs, { name: 'evaluate', arguments: { prompt: 'input' } });
  assert.deepEqual(result.output.structuredContent, { score: 9 });
  assert.equal(result.output.content[0].text, 'Approved');
  assert.equal(result.output.stolen, undefined);
});

test('MCP rejects mismatched JSON ids and server tool errors', async () => {
  const responses = mode => async (url, init) => {
    const request = JSON.parse(init.body);
    if (request.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: request.id,
      result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } } });
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
    return Response.json({ jsonrpc: '2.0', id: mode === 'wrong' ? -1 : request.id,
      result: { isError: true, content: [{ type: 'text', text: 'cannot run' }] } });
  };
  for (const mode of ['wrong', 'error']) await assert.rejects(executeCustomTool(
    tool('mcp', { mcpTool: 'test' }), { prompt: 'x' }, { fetchImpl: responses(mode) }),
  mode === 'wrong' ? /id|response/i : /cannot run|tool.*error/i);
});

test('confirmation uses a configuration snapshot and cancellation never reaches HTTP', async () => {
  const configured = tool('http', {}, { requireConfirmation: true, enabled: false });
  const called = [];
  await executeCustomTool(configured, { prompt: 'original' }, {
    approve: async preview => {
      configured.config.url = 'https://changed.test';
      configured.config.body = { changed: true };
      preview.args.prompt = 'changed';
      return true;
    },
    fetchImpl: async (url, init) => { called.push({ url, body: JSON.parse(init.body) }); return Response.json({ ok: true }); }
  });
  assert.deepEqual(called, [{ url: 'https://example.test/run', body: { prompt: 'original' } }]);
  const controller = new AbortController();
  const pending = executeCustomTool(configured, { prompt: 'x' }, {
    signal: controller.signal, approve: () => new Promise(() => {}),
    fetchImpl: async () => { throw new Error('Network must not run'); }
  });
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
});

test('polling accepts immediate completion and stops after its configured attempt count', async () => {
  const config = { output: 'json', poll: { enabled: true, url: 'https://example.test/job/{{result.id}}',
    intervalMs: 100, maxAttempts: 2, resultPath: 'answer' } };
  const immediate = await executeCustomTool(tool('http', config), { prompt: 'x' }, {
    fetchImpl: async () => Response.json({ status: 'completed', answer: 7 })
  });
  assert.equal(immediate.output, 7);
  let calls = 0;
  await assert.rejects(executeCustomTool(tool('http', config), { prompt: 'x' }, {
    fetchImpl: async () => { calls++; return Response.json({ id: 'a', status: 'pending' }); }
  }), /attempt limit/i);
  assert.equal(calls, 3);
});

test('MCP discovery permits an empty tool name but execution rejects it before network', async () => {
  let calls = 0;
  await assert.rejects(executeCustomTool(tool('mcp'), { prompt: 'x' }, {
    fetchImpl: async () => { calls++; throw new Error('Network must not run'); }
  }), /MCP tool name/i);
  assert.equal(calls, 0);
  const discovered = await discoverMcpTools(tool('mcp'), { fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id,
      result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } } });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    return Response.json({ jsonrpc: '2.0', id: body.id, result: { tools: [] } });
  } });
  assert.deepEqual(discovered, []);
});

test('MCP reads CR-only SSE split across network chunks and closes after its result', async () => {
  let cancelled = false;
  const result = await executeCustomTool(tool('mcp', { mcpTool: 'example' }), { prompt: 'x' }, {
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id,
        result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } } });
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      const data = 'data: ' + JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'done' }] } }) + '\r\r';
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(data.slice(0, 12)));
          controller.enqueue(new TextEncoder().encode(data.slice(12)));
        }, cancel() { cancelled = true; }
      }), { headers: { 'Content-Type': 'text/event-stream' } });
    }
  });
  assert.equal(result.output.content[0].text, 'done');
  assert.equal(cancelled, true);
});

test('MCP cancellation notifies the request id and deletes its session', async t => {
  const calls = [], controller = new AbortController();
  const url = await serve(t, (request, response, body) => {
    calls.push(body || { method: request.method });
    if (request.method === 'DELETE') { response.writeHead(204); response.end(); }
    else if (body.method === 'initialize') json(response, { jsonrpc: '2.0', id: body.id,
      result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } } }, 200, { 'Mcp-Session-Id': 'cancel-session' });
    else if (body.method === 'tools/call') setTimeout(() => controller.abort(), 20);
    else { response.writeHead(202); response.end(); }
  });
  await assert.rejects(executeCustomTool(tool('mcp', { url, mcpTool: 'test' }), { prompt: 'x' },
    { signal: controller.signal }), error => error.name === 'AbortError');
  const cancelled = calls.find(call => call.method === 'notifications/cancelled');
  assert.equal(cancelled.params.requestId, calls.find(call => call.method === 'tools/call').id);
  assert.equal(calls.at(-1).method, 'DELETE');
});

test('MCP discovery rejects repeated cursors', async () => {
  await assert.rejects(discoverMcpTools(tool('mcp'), { fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id,
      result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } } });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    return Response.json({ jsonrpc: '2.0', id: body.id, result: { tools: [], nextCursor: 'again' } });
  } }), /repeated cursor/i);
});

test('CLI cancellation finishes even when a descendant retains output pipes', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const pending = executeCustomTool(tool('cli', { executable: process.execPath,
    argv: ['-e', 'require("node:child_process").spawn(process.execPath,["-e","setTimeout(()=>{},1800)"],{stdio:"inherit",windowsHide:true});setInterval(()=>{},1000)'] }),
  { prompt: 'x' }, { signal: controller.signal, approve: async () => true });
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.ok(Date.now() - started < 1000, 'Cancellation should not wait for inherited pipes');
});
