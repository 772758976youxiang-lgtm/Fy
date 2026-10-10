'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../storage');
const ToolConfig = require('../ui/tool-config');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-tool-storage-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, store: new Store(directory) };
}
const input = (changes = {}) => ({ name: 'my_tool', label: 'My Tool', kind: 'http', parameters: [{ name: 'text', type: 'string', required: true }], config: { url: 'https://example.com', body: { text: '{{args.text}}' } }, ...changes });

test('custom tool storage API is available', t => {
  const { store } = fixture(t);
  for (const name of ['listTools', 'getTools', 'getTool', 'saveTool', 'removeTool']) assert.equal(typeof store[name], 'function', name);
});

test('duplicating every tool kind preserves configuration and creates an independent disabled tool', t => {
  const { store } = fixture(t);
  for (const { value: kind } of ToolConfig.KINDS) {
    const template = ToolConfig.createTemplate(kind);
    const source = store.saveTool({ ...template, name: 'source_' + kind, label: 'Source ' + kind,
      description: 'Keep this description', enabled: true, requireConfirmation: true,
      config: { ...template.config, url: 'https://example.com/run', executable: process.execPath,
        mcpTool: 'remote_tool', model: 'example-model', effort: 'high', systemPrompt: 'Fixed instructions' } });
    const before = store.getTool(source.id);
    const duplicate = store.duplicateTool(source.id);
    assert.notEqual(duplicate.id, source.id);
    assert.equal(duplicate.name, source.name + '_copy');
    assert.equal(duplicate.label, source.label + '（副本）');
    assert.equal(duplicate.enabled, false);
    assert.equal(duplicate.hasApiKey, false);
    assert.equal(duplicate.apiKey, undefined);
    for (const key of ['kind', 'config', 'parameters', 'description', 'requireConfirmation', 'rememberKey']) {
      assert.deepEqual(duplicate[key], source[key], kind + '.' + key);
    }
    store.saveTool({ ...duplicate, config: { ...duplicate.config, systemPrompt: 'Changed copy' } });
    store.removeTool(duplicate.id);
    assert.deepEqual(store.getTool(source.id), before);
  }
});

test('duplicated credentials preserve memory-only and remembered policies with independent bindings', t => {
  const { store, directory } = fixture(t);
  for (const rememberKey of [false, true]) {
    const secret = rememberKey ? 'persisted-copy-key' : 'temporary-copy-key';
    const source = store.saveTool(input({ name: 'source_' + rememberKey, rememberKey, apiKey: secret }));
    const duplicate = store.duplicateTool(source.id);
    assert.equal(duplicate.hasApiKey, true);
    assert.doesNotMatch(JSON.stringify(duplicate), /copy-key|"apiKey":/);
    assert.equal(store.getTool(duplicate.id).apiKey, secret);
    assert.equal(new Store(directory).getTool(duplicate.id).apiKey, rememberKey ? secret : '');
    assert.doesNotMatch(fs.readFileSync(path.join(directory, 'tools.json'), 'utf8'), /copy-key|"apiKey":/);
    if (rememberKey) {
      const records = JSON.parse(fs.readFileSync(path.join(directory, 'tool-credentials.json'), 'utf8'));
      assert.notEqual(records[source.id].configHash, records[duplicate.id].configHash);
      assert.doesNotMatch(JSON.stringify(records), /temporary-copy-key/);
    } else assert.equal(fs.existsSync(path.join(directory, 'tool-credentials.json')), false);
    store.saveTool({ ...duplicate, apiKey: 'replacement-copy-key' });
    assert.equal(store.getTool(source.id).apiKey, secret);
    store.removeTool(source.id);
    assert.equal(store.getTool(duplicate.id).apiKey, 'replacement-copy-key');
  }
});

test('duplicate names avoid case-insensitive collisions and respect maximum field lengths', t => {
  const { store } = fixture(t);
  const source = store.saveTool(input({ name: 'a'.repeat(64), label: 'L'.repeat(120) }));
  store.saveTool(input({ name: 'a'.repeat(59).toUpperCase() + '_COPY', label: 'Existing' }));
  const second = store.duplicateTool(source.id);
  const third = store.duplicateTool(source.id);
  assert.equal(second.name, 'a'.repeat(57) + '_copy_2');
  assert.equal(third.name, 'a'.repeat(57) + '_copy_3');
  assert.equal(second.label, 'L'.repeat(114) + '（副本 2）');
  assert.equal(second.label.length, 120);
  assert.equal(third.label.length, 120);
  const nested = store.duplicateTool(second.id);
  assert.notEqual(nested.id, second.id);
  assert.ok(nested.name.length <= 64);
  assert.ok(nested.label.length <= 120);
  assert.equal(new Set(store.listTools().map(tool => tool.name.toLowerCase())).size, 5);
});

test('missing tools and full stores do not create partial copies', t => {
  const { store } = fixture(t);
  assert.equal(store.duplicateTool('missing'), null);
  assert.throws(() => store.duplicateTool('../invalid'));
  for (let i = 0; i < 64; i++) store.saveTool(input({ name: 'tool_' + i }));
  const before = store.listTools();
  assert.throws(() => store.duplicateTool(before[0].id), /64/);
  assert.deepEqual(store.listTools(), before);
});

test('failed duplication rolls back configuration and credentials without changing the source', t => {
  const { store, directory } = fixture(t);
  const source = store.saveTool(input({ rememberKey: true, apiKey: 'original-key' }));
  const before = store.listTools();
  const original = store.getTool(source.id);
  const atomic = store.atomic.bind(store);
  store.atomic = (name, value) => {
    if (name === 'tool-credentials.json') throw new Error('injected copy failure');
    return atomic(name, value);
  };
  assert.throws(() => store.duplicateTool(source.id), /injected copy failure/);
  assert.deepEqual(store.listTools(), before);
  assert.deepEqual(new Store(directory).listTools(), before);
  assert.deepEqual(store.getTool(source.id), original);
  assert.deepEqual(new Store(directory).getTool(source.id), original);
});

test('custom credentials stay in memory by default and public config is redacted', { skip: !Store.prototype.saveTool }, t => {
  const { store, directory } = fixture(t);
  const saved = store.saveTool(input({ apiKey: 'first-secret' }));
  assert.ok(saved.id);
  assert.equal(saved.hasApiKey, true);
  assert.equal(saved.apiKey, undefined);
  assert.equal(store.getTool(saved.id).apiKey, 'first-secret');
  assert.doesNotMatch(fs.readFileSync(path.join(directory, 'tools.json'), 'utf8'), /first-secret|"apiKey":/);
  assert.equal(fs.existsSync(path.join(directory, 'tool-credentials.json')), false);
  const result = store.getTools(); result[0].config.url = 'https://other.example';
  assert.equal(store.getTool(saved.id).config.url, 'https://example.com');
  const reopened = new Store(directory);
  assert.equal(reopened.listTools()[0].hasApiKey, false);
  assert.equal(reopened.getTool(saved.id).apiKey, '');
});

test('remembering a key is per-tool and clearing or forgetting removes persisted secrets', { skip: !Store.prototype.saveTool }, t => {
  const { store, directory } = fixture(t);
  let saved = store.saveTool(input({ apiKey: 'remembered-secret', rememberKey: true }));
  assert.equal(new Store(directory).getTool(saved.id).apiKey, 'remembered-secret');
  saved = store.saveTool({ ...saved, label: 'Renamed', apiKey: '' });
  assert.equal(store.getTool(saved.id).apiKey, 'remembered-secret');
  store.saveTool({ ...saved, apiKey: undefined });
  assert.equal(store.getTool(saved.id).apiKey, 'remembered-secret');
  store.saveTool(input({ name: 'second_tool', apiKey: 'temporary-secret' }));
  assert.doesNotMatch(fs.readFileSync(path.join(directory, 'tool-credentials.json'), 'utf8'), /temporary-secret/);
  saved = store.saveTool({ ...saved, rememberKey: false });
  assert.equal(store.getTool(saved.id).apiKey, 'remembered-secret');
  assert.equal(fs.existsSync(path.join(directory, 'tool-credentials.json')), false);
  saved = store.saveTool({ ...saved, removeKey: true });
  assert.equal(saved.hasApiKey, false);
  store.saveTool({ ...saved, rememberKey: true, apiKey: 'forgotten-secret' });
  store.forgetCredentials();
  assert.ok(store.listTools().every(x => !x.hasApiKey && !x.rememberKey));
  assert.equal(fs.existsSync(path.join(directory, 'tool-credentials.json')), false);
  assert.ok(new Store(directory).listTools().every(x => !x.hasApiKey));
});

test('tool names are unique, removal cleans credentials, and invalid save does not mutate state', { skip: !Store.prototype.saveTool }, t => {
  const { store, directory } = fixture(t);
  const saved = store.saveTool(input({ apiKey: 'delete-secret', rememberKey: true }));
  assert.throws(() => store.saveTool(input({ name: 'MY_TOOL' })));
  assert.throws(() => store.saveTool({ ...saved, config: { url: 'file:///tmp/x' } }));
  assert.equal(store.listTools().length, 1);
  assert.equal(store.getTool(saved.id).apiKey, 'delete-secret');
  assert.equal(store.removeTool(saved.id), true);
  assert.equal(store.removeTool(saved.id), false);
  assert.equal(store.getTool(saved.id), null);
  assert.equal(fs.existsSync(path.join(directory, 'tool-credentials.json')), false);
});

test('corrupt tool config and credentials fail closed with useful file-specific errors', { skip: !Store.prototype.saveTool }, t => {
  const { directory } = fixture(t);
  fs.writeFileSync(path.join(directory, 'tools.json'), '{bad');
  assert.throws(() => new Store(directory), /tools\.json/);
  fs.writeFileSync(path.join(directory, 'tools.json'), JSON.stringify([input({ id: 'test' })]));
  fs.writeFileSync(path.join(directory, 'tool-credentials.json'), JSON.stringify({ test: 42 }));
  assert.throws(() => new Store(directory), /tool-credentials\.json/);
});

test('remembered credentials are bound to the saved normalized tool configuration', t => {
  const { store, directory } = fixture(t);
  const saved = store.saveTool(input({ apiKey: 'bound-secret', rememberKey: true }));
  const record = JSON.parse(fs.readFileSync(path.join(directory, 'tool-credentials.json'), 'utf8'))[saved.id];
  assert.deepEqual(Object.keys(record).sort(), ['apiKey', 'configHash']);
  assert.equal(record.apiKey, 'bound-secret');
  assert.match(record.configHash, /^[a-f0-9]{64}$/);
  assert.equal(new Store(directory).getTool(saved.id).apiKey, 'bound-secret');
  fs.writeFileSync(path.join(directory, 'tool-credentials.json'), JSON.stringify({ [saved.id]: 'unbound-secret' }));
  assert.throws(() => new Store(directory), /tool-credentials\.json/);
});

test('failed credential rotation rolls back both files without changing live state', t => {
  const { store, directory } = fixture(t);
  const saved = store.saveTool(input({ apiKey: 'old-secret', rememberKey: true }));
  const previousTools = fs.readFileSync(path.join(directory, 'tools.json'), 'utf8');
  const previousCredentials = fs.readFileSync(path.join(directory, 'tool-credentials.json'), 'utf8');
  const atomic = store.atomic.bind(store);
  store.atomic = (name, value) => {
    if (name === 'tool-credentials.json') throw new Error('injected credential write failure');
    return atomic(name, value);
  };
  assert.throws(() => store.saveTool({ ...saved, apiKey: 'new-secret', config: { ...saved.config, url: 'https://other.example/api' } }), /injected credential write failure/);
  assert.equal(store.getTool(saved.id).config.url, 'https://example.com');
  assert.equal(store.getTool(saved.id).apiKey, 'old-secret');
  assert.equal(fs.readFileSync(path.join(directory, 'tools.json'), 'utf8'), previousTools);
  assert.equal(fs.readFileSync(path.join(directory, 'tool-credentials.json'), 'utf8'), previousCredentials);
  const reopened = new Store(directory).getTool(saved.id);
  assert.equal(reopened.config.url, 'https://example.com');
  assert.equal(reopened.apiKey, 'old-secret');
});

test('either mixed generation of config and credentials reloads without a usable key', t => {
  const { store, directory } = fixture(t);
  const saved = store.saveTool(input({ apiKey: 'old-secret', rememberKey: true }));
  const oldTools = fs.readFileSync(path.join(directory, 'tools.json'), 'utf8');
  const oldCredentials = fs.readFileSync(path.join(directory, 'tool-credentials.json'), 'utf8');
  store.saveTool({ ...saved, apiKey: 'new-secret', config: { ...saved.config, url: 'https://other.example/api' } });
  const newTools = fs.readFileSync(path.join(directory, 'tools.json'), 'utf8');
  const newCredentials = fs.readFileSync(path.join(directory, 'tool-credentials.json'), 'utf8');
  for (const [tools, credentials, url] of [
    [newTools, oldCredentials, 'https://other.example/api'],
    [oldTools, newCredentials, 'https://example.com']
  ]) {
    fs.writeFileSync(path.join(directory, 'tools.json'), tools);
    fs.writeFileSync(path.join(directory, 'tool-credentials.json'), credentials);
    const reopened = new Store(directory);
    assert.equal(reopened.getTool(saved.id).config.url, url);
    assert.equal(reopened.getTool(saved.id).apiKey, '');
    assert.equal(reopened.listTools()[0].hasApiKey, false);
  }
});

test('credential mismatch remains safe when disk failure also prevents rollback', t => {
  const { store, directory } = fixture(t);
  const saved = store.saveTool(input({ apiKey: 'old-secret', rememberKey: true }));
  const atomic = store.atomic.bind(store);
  let writes = 0;
  store.atomic = (name, value) => {
    if (++writes > 1) throw new Error('persistent injected write failure');
    return atomic(name, value);
  };
  assert.throws(() => store.saveTool({ ...saved, apiKey: 'new-secret', config: { ...saved.config, url: 'https://other.example/api' } }), /persistent injected write failure/);
  assert.equal(store.getTool(saved.id).apiKey, 'old-secret');
  assert.equal(store.getTool(saved.id).config.url, 'https://example.com');
  const reopened = new Store(directory);
  assert.equal(reopened.getTool(saved.id).config.url, 'https://other.example/api');
  assert.equal(reopened.getTool(saved.id).apiKey, '');
});

test('failed credential forgetting retains live tool and settings state', t => {
  const { store, directory } = fixture(t);
  store.saveSettings({ apiKey: 'main-secret', remember: true });
  const saved = store.saveTool(input({ apiKey: 'tool-secret', rememberKey: true }));
  const atomic = store.atomic.bind(store);
  store.atomic = (name, value) => {
    if (name === 'tools.json') throw new Error('injected config write failure');
    return atomic(name, value);
  };
  assert.throws(() => store.forgetCredentials(), /injected config write failure/);
  assert.equal(store.snapshot().apiKey, 'main-secret');
  assert.equal(store.publicSettings().remember, true);
  assert.equal(store.getTool(saved.id).apiKey, 'tool-secret');
  assert.equal(store.getTool(saved.id).rememberKey, true);
  const reopened = new Store(directory);
  assert.equal(reopened.snapshot().apiKey, 'main-secret');
  assert.equal(reopened.getTool(saved.id).apiKey, 'tool-secret');
});
