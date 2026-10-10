'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(__dirname, '../ui/tool-config.js');
const T = fs.existsSync(file) ? require(file) : {};

function tool(kind = 'http', changes = {}) {
  const input = T.createTemplate(kind);
  input.name = 'sample_tool';
  input.config.url = 'https://example.com/api';
  input.config.model = 'sample-model';
  input.config.executable = 'node';
  input.config.mcpTool = 'search';
  return { ...input, ...changes };
}

test('tool configuration exports a shared API', () => {
  for (const name of ['createTemplate', 'normalizeTool', 'definition', 'validateArguments', 'renderTemplate', 'extractPath'])
    assert.equal(typeof T[name], 'function', name);
});

test('chat URL resolution only expands compatible LLM base addresses and preserves saved normalization', () => {
  assert.equal(typeof T.resolveRequestURL, 'function');
  for (const kind of ['llm', 'judge']) {
    const configured = tool(kind);
    for (const [url, expected] of [
      ['https://api.deepseek.com', 'https://api.deepseek.com/chat/completions'],
      ['https://api.deepseek.com/', 'https://api.deepseek.com/chat/completions'],
      ['https://gateway.test/v1/', 'https://gateway.test/v1/chat/completions'],
      ['https://gateway.test/openai/v1?tenant=test', 'https://gateway.test/openai/v1/chat/completions?tenant=test'],
      ['https://gateway.test/v1/chat/completions', 'https://gateway.test/v1/chat/completions'],
      ['https://gateway.test/custom-handler', 'https://gateway.test/custom-handler']
    ]) {
      configured.config.url = url;
      assert.equal(T.resolveRequestURL(configured), expected);
      assert.equal(T.normalizeTool(configured).config.url, url, 'normalization must not invalidate stored credential hashes');
    }
    configured.config.url = 'https://gateway.test';
    configured.config.body = { input: '{{args.prompt}}' };
    assert.equal(T.resolveRequestURL(configured), configured.config.url);
    configured.config.body = { messages: [] }; configured.config.method = 'GET';
    assert.equal(T.resolveRequestURL(configured), configured.config.url);
  }
  for (const kind of ['http', 'image', 'video', 'mcp']) {
    const configured = tool(kind); configured.config.url = 'https://example.com/v1'; configured.config.body = { messages: [] };
    assert.equal(T.resolveRequestURL(configured), configured.config.url);
  }
  assert.equal(T.resolveRequestURL(T.createTemplate('llm')), '');
});

test('kind templates separate fixed provider configuration from call arguments', { skip: !T.createTemplate }, () => {
  assert.deepEqual(T.KINDS.map(x => x.value), ['llm', 'judge', 'image', 'video', 'http', 'mcp', 'cli']);
  for (const { value } of T.KINDS) {
    const input = tool(value);
    const normalized = T.normalizeTool(input);
    const definition = T.definition(normalized);
    assert.equal(definition.name, input.name);
    assert.equal(definition.parameters.additionalProperties, false);
    assert.equal(Object.hasOwn(definition, 'config'), false);
    assert.equal(Object.hasOwn(definition.parameters.properties, 'model'), false);
    assert.equal(Object.hasOwn(normalized, 'apiKey'), false);
  }
  const one = T.createTemplate('llm'), two = T.createTemplate('llm');
  one.config.body.messages[0].content = 'changed';
  assert.notEqual(two.config.body.messages[0].content, 'changed');
});

test('normalization validates names, destinations, fixed fields, and execution confirmation', { skip: !T.normalizeTool }, () => {
  for (const name of ['web_search', 'web_fetch', 'get_current_time', 'bad name', 'bad-name', '__proto__'])
    assert.throws(() => T.normalizeTool(tool('http', { name })));
  for (const url of ['file:///tmp/a', 'https://user:pass@example.com/api', 'https://example.com/#frag', 'https://{{args.host}}/api']) {
    const input = tool(); input.config.url = url;
    assert.throws(() => T.normalizeTool(input));
  }
  for (const name of ['url', 'MODEL', 'effort', 'apiKey', 'systemPrompt', 'executable', 'argv', 'cwd', 'env', 'headers'])
    assert.throws(() => T.normalizeTool(tool('http', { parameters: [{ name, type: 'string' }] })));
  assert.equal(T.normalizeTool(tool('cli', { requireConfirmation: false })).requireConfirmation, true);
  assert.equal(T.normalizeTool({ ...tool('mcp'), requireConfirmation: undefined }).requireConfirmation, true);
  assert.throws(() => T.normalizeTool({ ...tool(), config: { url: '' } }));
  assert.throws(() => T.normalizeTool({ ...tool('llm'), config: { url: 'https://example.com', model: '' } }));
  assert.throws(() => T.normalizeTool({ ...tool('cli'), config: { executable: '' } }));
  assert.throws(() => T.normalizeTool({ ...tool(), config: { url: 'https://example.com', apiKey: 'secret' } }));
});

test('arguments use explicit types, defaults, enums and array item types without coercion', { skip: !T.validateArguments }, () => {
  const input = tool('http', { parameters: [
    { name: 'prompt', type: 'string', required: true, description: 'Input' },
    { name: 'count', type: 'integer', default: 2, enum: [1, 2, 3] },
    { name: 'tags', type: 'array', itemsType: 'string', default: [] },
    { name: 'options', type: 'object', default: { enabled: true } },
    { name: 'ratio', type: 'number' }, { name: 'verbose', type: 'boolean' }
  ] });
  const args = { prompt: 'hello' };
  const result = T.validateArguments(input, args);
  assert.deepEqual(result, { prompt: 'hello', count: 2, tags: [], options: { enabled: true } });
  assert.deepEqual(args, { prompt: 'hello' });
  result.options.enabled = false;
  assert.equal(input.parameters[3].default.enabled, true);
  for (const args of [{}, { prompt: 'x', count: '2' }, { prompt: 'x', count: 4 }, { prompt: 'x', count: 1.5 },
    { prompt: 'x', tags: [1] }, { prompt: 'x', options: null }, { prompt: 'x', unknown: true },
    { prompt: 'x', ratio: Infinity }, { prompt: 'x', verbose: 1 }])
    assert.throws(() => T.validateArguments(input, args));
  assert.deepEqual(T.definition(input).parameters.required, ['prompt']);
  assert.deepEqual(T.definition(input).parameters.properties.tags.items, { type: 'string' });
});

test('schema and argument validation reject prototype keys, malformed defaults and oversized content', { skip: !T.normalizeTool }, () => {
  const polluted = JSON.parse('{"url":"https://example.com","body":{"__proto__":{"polluted":true}}}');
  assert.throws(() => T.normalizeTool({ ...tool(), config: polluted }));
  assert.throws(() => T.normalizeTool(tool('http', { parameters: [{ name: 'x', type: 'integer', default: '2' }] })));
  assert.throws(() => T.normalizeTool(tool('http', { parameters: [{ name: 'x', type: 'string' }, { name: 'x', type: 'string' }] })));
  assert.throws(() => T.normalizeTool(tool('http', { parameters: Array.from({ length: 65 }, (_, i) => ({ name: 'p' + i, type: 'string' })) })));
  assert.throws(() => T.validateArguments(tool('http', { parameters: [{ name: 'x', type: 'object' }] }), JSON.parse('{"x":{"constructor":{}}}')));
  assert.throws(() => T.validateArguments(tool('http', { parameters: [{ name: 'x', type: 'string' }] }), { x: 'x'.repeat(1000001) }));
  assert.equal({}.polluted, undefined);
});

test('template rendering preserves whole placeholder types and limits interpolation to own scalar values', { skip: !T.renderTemplate }, () => {
  const context = { args: { text: 'hello', number: 2, list: ['x'], object: { y: true } }, config: { model: 'fixed', apiKey: 'secret', env: { TOKEN: 'secret' }, headers: { Authorization: 'secret' } }, result: { jobs: [{ id: 'abc' }] } };
  assert.deepEqual(T.renderTemplate({ list: '{{args.list}}', nested: ['{{args.object}}'], prompt: '{{config.model}}: {{args.text}} {{args.number}}', id: '{{result.jobs.0.id}}' }, context),
    { list: ['x'], nested: [{ y: true }], prompt: 'fixed: hello 2', id: 'abc' });
  for (const value of ['{{config.apiKey}}', '{{config.env.TOKEN}}', '{{config.headers.Authorization}}', '{{args.constructor}}', '{{args.missing}}', 'object={{args.object}}', '{{process.env.TOKEN}}'])
    assert.throws(() => T.renderTemplate(value, context));
  assert.deepEqual(T.extractPath(context.result, ''), context.result);
  assert.equal(T.extractPath(context.result, 'jobs.0.id'), 'abc');
  assert.equal(T.extractPath(Object.create({ inherited: true }), 'inherited'), undefined);
  assert.throws(() => T.extractPath({}, '__proto__.polluted'));
});

test('inserted template values remain literal even when they contain template syntax', { skip: !T.renderTemplate }, () => {
  assert.equal(T.renderTemplate('input={{args.text}}', { args: { text: '{{config.apiKey}}' } }), 'input={{config.apiKey}}');
  assert.throws(() => T.renderTemplate('input={{args.text + 1}}', { args: { text: 'ok' } }));
});

test('MCP discovery permits an unselected tool and polling only accepts fixed-origin result paths', { skip: !T.normalizeTool }, () => {
  const discovery = tool('mcp'); discovery.config.mcpTool = '';
  assert.equal(T.normalizeTool(discovery).config.mcpTool, '');
  const input = tool('video');
  input.config.poll = { enabled: true, url: 'https://example.com/jobs/{{result.id}}' };
  assert.equal(T.normalizeTool(input).config.poll.url, input.config.poll.url);
  for (const url of ['https://other.example/jobs/{{result.id}}', 'https://{{result.host}}/jobs', 'https://example.com/jobs/{{args.id}}']) {
    input.config.poll.url = url;
    assert.throws(() => T.normalizeTool(input));
  }
});
