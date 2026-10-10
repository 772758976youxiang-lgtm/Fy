'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../storage');
const { runAgent, toolRegistry } = require('../agent');

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-search-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new Store(directory);
  store.saveSettings({ apiKey: 'test-key', searchEnabled: true, toolsEnabled: false, ...options });
  return store;
}

function completion(delta, finishReason = 'stop') {
  return new Response('data: ' + JSON.stringify({
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  }) + '\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
}

function searchCall() {
  return completion({ tool_calls: [{ index: 0, id: 'search-1', type: 'function',
    function: { name: 'web_search', arguments: JSON.stringify({ queries: ['latest release'] }) }
  }] }, 'tool_calls');
}

function searchResults() {
  return Response.json({ content: [
    { type: 'web_search_tool_result', content: [
      { type: 'web_search_result', title: 'Release notes', url: 'https://example.com/releases' }
    ] },
    { type: 'text', text: 'Release details', citations: [
      { url: 'https://example.com/releases', cited_text: 'Version 2 is available.' }
    ] }
  ] });
}

for (const toolsEnabled of [false, true]) {
  test('greeting skips search with toolsEnabled=' + toolsEnabled, async t => {
    const store = fixture(t, { toolsEnabled });
    const calls = [], events = [];
    const session = await runAgent({ store,
      request: { sessionId: 'greeting', message: 'Hello' },
      emit: (type, data) => events.push({ type, data: structuredClone(data) }),
      fetchImpl: async (url, init) => {
        calls.push({ url, payload: JSON.parse(init.body) });
        return url.endsWith('/messages') ? searchResults() : completion({ content: 'Hello!' });
      }
    });
    assert.deepEqual(calls.map(call => new URL(call.url).pathname), ['/chat/completions']);
    assert.equal(calls[0].payload.tool_choice, 'auto');
    assert.ok(calls[0].payload.tools.some(tool => tool.function.name === 'web_search'));
    assert.equal(session.apiMessages[0].content, 'Hello');
    assert.equal(session.messages.at(-1).status, 'done');
    assert.deepEqual(session.messages.at(-1).sources, []);
    assert.ok(!events.some(event => event.type === 'sources'));
    assert.doesNotMatch(events[0].data.session.messages.at(-1).phase, /搜索/);
  });
}

test('search runs only after a model tool call, even with other tools disabled', async t => {
  const store = fixture(t);
  const calls = [];
  let completions = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, payload: JSON.parse(init.body) });
    if (url.endsWith('/messages')) return searchResults();
    return completions++ === 0 ? searchCall() : completion({ content: 'Version 2 is available.' });
  };
  const session = await runAgent({ store, fetchImpl,
    request: { sessionId: 'lookup', message: 'Find the latest release' } });
  assert.deepEqual(calls.map(call => new URL(call.url).pathname),
    ['/chat/completions', '/anthropic/v1/messages', '/chat/completions']);
  assert.deepEqual(calls[0].payload.tools.map(tool => tool.function.name), ['web_search']);
  assert.equal(session.messages.at(-1).status, 'done');
  assert.equal(session.messages.at(-1).sources[0].url, 'https://example.com/releases');
  assert.equal(session.messages.at(-1).tools.length, 1);
  const evidence = calls[2].payload.messages.find(message => message.role === 'tool');
  assert.equal(evidence.tool_call_id, 'search-1');
  assert.equal(JSON.parse(evidence.content).untrusted_web_content, true);
  assert.match(evidence.content, /Version 2/);
  await runAgent({ store, fetchImpl,
    request: { sessionId: 'lookup', message: 'Thanks' } });
  assert.equal(calls.length, 4);
  assert.ok(calls[3].url.endsWith('/chat/completions'));
});

test('search toggle independently controls advertisement and execution', async () => {
  let searches = 0;
  const registry = toolRegistry({ apiKey: 'test-key' }, async () => {
    searches++;
    return searchResults();
  }, () => {});
  const names = settings => registry.definitions(settings).map(tool => tool.function.name).sort();
  assert.deepEqual(names({ searchEnabled: true, toolsEnabled: false }), ['web_search']);
  assert.deepEqual(names({ searchEnabled: false, toolsEnabled: true }), ['get_current_time', 'web_fetch']);
  assert.deepEqual(names({ searchEnabled: false, toolsEnabled: false }), []);
  assert.deepEqual(names({ searchEnabled: true, toolsEnabled: true }), ['get_current_time', 'web_fetch', 'web_search']);
  const output = await registry.execute({ id: 'disabled-search',
    function: { name: 'web_search', arguments: '{"queries":["news"]}' }
  }, { settings: { searchEnabled: false, toolsEnabled: true } });
  assert.equal(searches, 0);
  assert.ok(JSON.parse(output.content).error);
});

test('disabled search cannot run when the model requests it through other tools', async t => {
  const store = fixture(t, { searchEnabled: false, toolsEnabled: true });
  let searches = 0, completions = 0;
  const session = await runAgent({ store,
    request: { sessionId: 'disabled', message: 'Hello' },
    fetchImpl: async url => {
      if (url.endsWith('/messages')) { searches++; return searchResults(); }
      return completions++ === 0 ? searchCall() : completion({ content: 'Search is unavailable.' });
    }
  });
  assert.equal(searches, 0);
  assert.equal(session.messages.at(-1).status, 'done');
  assert.ok(JSON.parse(session.apiMessages.find(message => message.role === 'tool').content).error);
});

test('search failure returns a tool error so the model can still answer', async t => {
  const store = fixture(t);
  let completions = 0;
  const session = await runAgent({ store,
    request: { sessionId: 'failure', message: 'Find the latest release' },
    fetchImpl: async url => {
      if (url.endsWith('/messages')) return Response.json({ error: { message: 'Search unavailable' } }, { status: 503 });
      return completions++ === 0 ? searchCall() : completion({ content: 'I could not verify the latest release.' });
    }
  });
  assert.equal(session.messages.at(-1).status, 'done');
  assert.equal(completions, 2);
  assert.deepEqual(session.messages.at(-1).sources, []);
  assert.match(session.apiMessages.find(message => message.role === 'tool').content, /Search unavailable/);
});

test('cancel during requested search stops the turn without a follow-up completion', async t => {
  const store = fixture(t);
  const controller = new AbortController();
  let completions = 0;
  const session = await runAgent({ store, signal: controller.signal,
    request: { sessionId: 'cancelled', message: 'Find the latest release' },
    fetchImpl: async url => {
      if (url.endsWith('/messages')) { controller.abort(); return searchResults(); }
      completions++;
      return searchCall();
    }
  });
  assert.equal(completions, 1);
  assert.equal(session.messages.at(-1).status, 'stopped');
  assert.deepEqual(session.apiMessages.map(message => message.role), ['user']);
});
