'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let chromium;
try { ({ chromium } = require('playwright')); } catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

const ui = path.join(__dirname, '../ui');

async function editorFixture(t) {
  const browser = await chromium.launch({ channel: process.env.LUMA_TEST_BROWSER || 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(3000);
  await page.setContent('<main><div id="manager"></div></main>');
  await page.addStyleTag({ path: path.join(ui, 'tool-manager.css') });
  for (const file of ['tool-config.js', 'tool-manager.js']) await page.addScriptTag({ path: path.join(ui, file) });
  await page.evaluate(async () => {
    window.remoteTools = [];
    window.savedTools = [];
    const backend = { connected: true, async request(route, options = {}) {
      if (route === 'custom-tools/discover') return { tools: window.remoteTools };
      if (options.method === 'POST') {
        const tool = { ...options.data, id: 'existing-tool', hasApiKey: Boolean(options.data.apiKey) };
        delete tool.apiKey;
        window.savedTools = [tool];
        return { tool };
      }
      return { tools: window.savedTools };
    } };
    window.manager = LumaToolManager.create({ root: document.querySelector('#manager'), getBackend: () => backend });
    await window.manager.open();
  });
  await page.getByRole('button', { name: '添加工具', exact: true }).click();
  return page;
}

test('browser: saving LLM base URL persists the resolved chat endpoint', { skip: !chromium, timeout: 10000 }, async t => {
  const page = await editorFixture(t);
  await page.getByLabel('工具名称', { exact: true }).fill('base_url_llm');
  await page.getByLabel('显示名称', { exact: true }).fill('Base URL LLM');
  await page.getByLabel('接口地址', { exact: true }).fill('https://gateway.test/v1/');
  await page.getByLabel('模型', { exact: true }).fill('test-model');
  await page.getByRole('button', { name: '保存工具', exact: true }).click();
  await page.getByRole('button', { name: '编辑 Base URL LLM', exact: true }).click();
  assert.equal(await page.getByLabel('接口地址', { exact: true }).inputValue(), 'https://gateway.test/v1/chat/completions');
});

test('browser: changing tool kind preserves entered and saved configuration',
  { skip: !chromium && 'Install Playwright to run browser integration checks', timeout: 20000 }, async t => {
    const page = await editorFixture(t);
    await page.getByLabel('工具名称', { exact: true }).fill('review');
    await page.getByLabel('显示名称', { exact: true }).fill('保留配置');
    await page.getByLabel('接口地址', { exact: true }).fill('https://example.com/chat');
    await page.getByLabel('模型', { exact: true }).fill('saved-model');
    await page.getByLabel('思考强度', { exact: true }).selectOption('high');
    await page.getByLabel('API Key', { exact: true }).fill('entered-secret');
    await page.getByLabel('系统提示词', { exact: true }).fill('custom system');
    await page.getByLabel('记住密钥（本机，未加密）').check();
    await page.getByLabel('启用工具').uncheck();
    await page.locator('summary').click();
    await page.getByLabel('鉴权方式', { exact: true }).selectOption('header');
    await page.getByLabel('密钥请求头名称').fill('X-Custom-Key');
    await page.getByLabel('请求头 JSON').fill('{"X-Client":"luma"}');
    await page.getByLabel('请求体 JSON').fill('{"text":"{{args.text}}"}');
    await page.getByLabel('超时（毫秒）').fill('120000');
    await page.getByLabel('参数名称').fill('text');
    await page.getByLabel('工具类型').selectOption('judge');
    assert.equal(await page.getByLabel('接口地址', { exact: true }).inputValue(), 'https://example.com/chat');
    assert.equal(await page.getByLabel('模型', { exact: true }).inputValue(), 'saved-model');
    assert.equal(await page.getByLabel('思考强度').inputValue(), 'high');
    assert.equal(await page.getByLabel('API Key', { exact: true }).inputValue(), 'entered-secret');
    assert.equal(await page.getByLabel('系统提示词', { exact: true }).inputValue(), 'custom system');
    assert.equal(await page.getByLabel('鉴权方式').inputValue(), 'header');
    assert.equal(await page.getByLabel('密钥请求头名称').inputValue(), 'X-Custom-Key');
    assert.deepEqual(JSON.parse(await page.getByLabel('请求头 JSON').inputValue()), { 'X-Client': 'luma' });
    assert.deepEqual(JSON.parse(await page.getByLabel('请求体 JSON').inputValue()), { text: '{{args.text}}' });
    assert.equal(await page.getByLabel('超时（毫秒）').inputValue(), '120000');
    assert.equal(await page.getByLabel('参数名称').inputValue(), 'text');
    assert.equal(await page.getByLabel('记住密钥（本机，未加密）').isChecked(), true);
    assert.equal(await page.getByLabel('启用工具').isChecked(), false);
    await page.getByRole('button', { name: '保存工具', exact: true }).click();
    await page.getByRole('button', { name: '编辑 保留配置', exact: true }).click();
    await page.getByLabel('移除已保存的密钥').check();
    await page.getByLabel('工具类型').selectOption('http');
    assert.equal(await page.getByLabel('API Key', { exact: true }).inputValue(), '');
    assert.match(await page.getByLabel('API Key', { exact: true }).getAttribute('placeholder'), /已配置/);
    assert.equal(await page.getByLabel('移除已保存的密钥').isChecked(), true);
    assert.deepEqual(JSON.parse(await page.getByLabel('请求体 JSON').inputValue()), { text: '{{args.text}}' });
    assert.equal(await page.getByLabel('参数名称').inputValue(), 'text');
    await page.getByLabel('工具类型').selectOption('llm');
    assert.equal(await page.getByLabel('模型', { exact: true }).inputValue(), 'saved-model');
    assert.equal(await page.getByLabel('系统提示词', { exact: true }).inputValue(), 'custom system');
    await page.getByRole('button', { name: '取消编辑', exact: true }).last().click();
    await page.getByRole('button', { name: '添加工具', exact: true }).click();
    await page.locator('summary').click();
    await page.getByLabel('请求体 JSON').fill('{"custom":"{{args.prompt}}"}');
    await page.getByLabel('工具类型').selectOption('mcp');
    assert.equal(await page.getByLabel('参数名称').inputValue(), 'prompt', 'An edited body retains its declared arguments');
    assert.deepEqual(JSON.parse(await page.getByLabel('请求体 JSON').inputValue()), { custom: '{{args.prompt}}' });
  });

test('browser: MCP imports reject unsupported schemas without changing the draft',
  { skip: !chromium && 'Install Playwright to run browser integration checks', timeout: 20000 }, async t => {
    const page = await editorFixture(t);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.getByLabel('工具类型').selectOption('mcp');
    await page.getByLabel('工具名称', { exact: true }).fill('local_mcp');
    await page.getByLabel('工具说明').fill('Keep this description');
    await page.getByLabel('接口地址', { exact: true }).fill('https://example.com/mcp');
    await page.getByLabel('MCP 工具名称').fill('original_remote');
    await page.getByLabel('API Key', { exact: true }).fill('preserved-secret');
    await page.getByRole('button', { name: '添加参数', exact: true }).click();
    await page.getByLabel('参数名称').fill('original_argument');
    await page.getByLabel('参数说明').fill('Original parameter');
    const before = await page.locator('#manager [data-field]').evaluateAll(elements => elements.map(element => ({ field: element.dataset.field, value: element.value, checked: element.checked })));
    const schemas = [
      { type: 'object', properties: { assignee: { type: ['string', 'null'], default: null } } },
      { type: 'object', properties: { ticket: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
      { type: 'object', properties: { value: { anyOf: [{ type: 'string' }, { type: 'number' }] } } },
      { type: 'object', properties: { tickets: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } } } },
      { type: 'object', properties: { code: { type: 'string', pattern: '^[a-z]+$' } } },
      { type: 'object', properties: { model: { type: 'string' } } },
      { type: 'object', properties: { count: { type: 'integer', default: 'one' } } }
    ];
    for (const inputSchema of schemas) {
      await page.evaluate(inputSchema => { window.remoteTools = [{ name: 'new_remote', description: 'New description', inputSchema }]; }, inputSchema);
      await page.getByRole('button', { name: '发现 MCP 工具', exact: true }).click();
      await page.getByRole('button', { name: '导入参数', exact: true }).click();
      assert.match(await page.locator('#manager [role=alert]').textContent(), /无法导入/);
      const after = await page.locator('#manager [data-field]').evaluateAll(elements => elements.filter(element => element.dataset.field !== 'discoveredTool').map(element => ({ field: element.dataset.field, value: element.value, checked: element.checked })));
      assert.deepEqual(after, before, JSON.stringify(inputSchema));
    }
    await page.evaluate(() => { window.remoteTools = [{ name: 'supported_remote', inputSchema: { type: 'object', properties: {
      city: { type: 'string', enum: ['北京', '上海'], default: '北京' },
      count: { type: 'integer', default: 2 },
      flags: { type: 'array', items: { type: 'boolean' }, default: [true] }
    }, required: ['city'], additionalProperties: false } }]; });
    await page.getByRole('button', { name: '发现 MCP 工具', exact: true }).click();
    await page.getByRole('button', { name: '导入参数', exact: true }).click();
    assert.equal(await page.getByLabel('MCP 工具名称').inputValue(), 'supported_remote');
    assert.equal(await page.locator('[data-parameter]').count(), 3);
    await page.getByRole('button', { name: '保存工具', exact: true }).click();
    const parameters = await page.evaluate(() => window.savedTools[0].parameters);
    assert.equal(parameters[0].default, '北京');
    assert.deepEqual(parameters[0].enum, ['北京', '上海']);
    assert.equal(parameters[0].required, true);
    assert.equal(parameters[1].default, 2);
    assert.equal(parameters[2].itemsType, 'boolean');
    assert.deepEqual(parameters[2].default, [true]);
    assert.deepEqual(errors, []);
  });

test('tool manager exposes its settings lifecycle', () => {
  assert.ok(fs.existsSync(path.join(ui, 'tool-manager.js')), 'Custom tool manager is implemented');
  assert.equal(typeof require('../ui/tool-manager').create, 'function');
});

test('browser: custom tools keep configuration separate, preserve secrets, confirm execution and fit mobile',
  { skip: !chromium && 'Install Playwright to run browser integration checks', timeout: 60000 }, async t => {
    const browser = await chromium.launch({ channel: process.env.LUMA_TEST_BROWSER || 'chrome', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(4000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(fs.readFileSync(path.join(ui, 'index.html'), 'utf8').replace(/<script[^>]*>[\s\S]*?<\/script>/g, ''));
    for (const file of ['styles.css', 'backend.css', 'tool-manager.css']) await page.addStyleTag({ path: path.join(ui, file) });
    for (const file of ['tool-config.js', 'tool-manager.js']) await page.addScriptTag({ path: path.join(ui, file) });
    await page.evaluate(() => {
      document.querySelector('#settings-overlay').hidden = false;
      document.querySelectorAll('[data-panel]').forEach(panel => { panel.hidden = panel.dataset.panel !== 'tools'; });
      document.querySelectorAll('[data-tab]').forEach(button => button.classList.toggle('active', button.dataset.tab === 'tools'));
      document.querySelector('#settings-panel-title').textContent = '工具调用';
      window.toolRequests = [];
      window.toolItems = [];
      window.toolBackend = { connected: true, async request(route, options = {}) {
        const { method = 'GET', data, signal } = options;
        window.toolRequests.push({ route, method, data: data === undefined ? undefined : JSON.parse(JSON.stringify(data)), hasSignal: Boolean(signal) });
        if (window.failNext) { window.failNext = false; throw new Error('连接暂时不可用'); }
        if (route === 'custom-tools/discover') return { tools: [{ name: 'weather', description: 'Weather lookup',
          inputSchema: { type: 'object', properties: { city: { type: 'string', description: '城市' } }, required: ['city'] } }] };
        if (route === 'custom-tools/test') return data.confirmed
          ? { output: { ok: true, text: '<img src=x onerror=alert(1)>' }, artifacts: [
            { type: 'image', url: 'https://example.com/result.png' }, { type: 'image', url: 'javascript:alert(1)' }
          ] }
          : { requiresConfirmation: true, preview: { command: 'node example.js' } };
        if (method === 'DELETE') { window.toolItems = window.toolItems.filter(tool => route !== 'custom-tools/' + tool.id); return { ok: true }; }
        if (method === 'POST') {
          const saved = { ...data, id: data.id || 'tool-1', hasApiKey: Boolean(data.apiKey) || !data.removeKey && Boolean(window.toolItems.find(tool => tool.id === data.id)?.hasApiKey) };
          delete saved.apiKey;
          window.toolItems = [...window.toolItems.filter(tool => tool.id !== saved.id), saved];
          return { tool: saved };
        }
        return { tools: window.toolItems };
      } };
      window.manager = LumaToolManager.create({ root: document.querySelector('#custom-tool-manager'), getBackend: () => window.toolBackend });
      return window.manager.open();
    });

    await page.getByRole('button', { name: '添加工具', exact: true }).click();
    assert.equal(await page.locator('[data-panel=tools] > .tool-card').first().isVisible(), false);
    assert.equal(await page.locator('.settings-footer').isVisible(), false, 'Tool editors have their own actions');
    assert.equal(await page.locator('.settings-content').evaluate(element => element.scrollTop), 0);
    await page.getByLabel('显示名称', { exact: true }).fill('模型评审');
    await page.getByLabel('工具名称', { exact: true }).fill('review_model');
    await page.getByLabel('工具说明', { exact: true }).fill('评审用户提交的文本');
    await page.getByLabel('接口地址', { exact: true }).fill('https://example.com/v1/chat/completions');
    await page.getByLabel('模型', { exact: true }).fill('review-model');
    await page.getByLabel('API Key', { exact: true }).fill('temporary-secret');
    await page.locator('#custom-tool-manager').getByLabel('系统提示词', { exact: true }).fill('固定评审规则');
    await page.getByRole('button', { name: '保存工具', exact: true }).click();
    await page.getByRole('button', { name: '编辑 模型评审', exact: true }).waitFor();
    assert.equal(await page.locator('[data-panel=tools] > .tool-card').first().isVisible(), true);
    assert.equal(await page.locator('.settings-footer').isVisible(), true);
    const saved = await page.evaluate(() => window.toolRequests.find(request => request.method === 'POST').data);
    assert.equal(saved.config.model, 'review-model');
    assert.equal(saved.config.systemPrompt, '固定评审规则');
    assert.equal(saved.apiKey, 'temporary-secret');
    assert.ok(!saved.parameters.some(parameter => ['model', 'apiKey', 'systemPrompt', 'url'].includes(parameter.name)));
    assert.equal(await page.locator('input[type=password]').filter({ visible: true }).count(), 0);

    await page.getByRole('button', { name: '编辑 模型评审', exact: true }).click();
    assert.equal(await page.getByLabel('API Key', { exact: true }).inputValue(), '');
    assert.match(await page.getByLabel('API Key', { exact: true }).getAttribute('placeholder'), /已配置/);
    await page.getByLabel('思考强度', { exact: true }).selectOption('max');
    await page.getByLabel('试运行参数', { exact: true }).fill('{invalid');
    await page.getByRole('button', { name: '试运行', exact: true }).click();
    assert.match(await page.locator('#custom-tool-manager [role=alert]').textContent(), /JSON/);
    assert.equal(await page.evaluate(() => window.toolRequests.filter(request => request.route === 'custom-tools/test').length), 0);
    await page.getByLabel('试运行参数', { exact: true }).fill('{"prompt":"评审这段文本"}');
    await page.getByRole('button', { name: '试运行', exact: true }).click();
    await page.getByRole('button', { name: '确认执行', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.toolRequests.filter(request => request.route === 'custom-tools/test').length), 1);
    await page.getByRole('button', { name: '确认执行', exact: true }).click();
    await page.locator('[data-test-result]').filter({ hasText: 'ok' }).waitFor();
    assert.equal(await page.locator('[data-test-result] img, [data-test-result] script').count(), 0);
    assert.equal(await page.locator('[data-test-result] a').count(), 1);
    assert.equal(await page.locator('[data-test-result] a').getAttribute('href'), 'https://example.com/result.png');
    const trial = await page.evaluate(() => window.toolRequests.filter(request => request.route === 'custom-tools/test'));
    assert.equal(trial[1].data.confirmed, true);
    assert.equal(trial[1].data.tool.config.effort, 'max');
    assert.ok(trial.every(request => request.hasSignal));

    await page.getByRole('button', { name: '添加参数', exact: true }).click();
    const row = page.locator('[data-parameter]').last();
    await row.getByLabel('参数名称').fill('count');
    await row.getByLabel('参数类型').selectOption('integer');
    await row.getByLabel('默认值 JSON').fill('2');
    await row.getByLabel('可选值 JSON').fill('[1,2,3]');
    for (const width of [1440, 320]) {
      await page.setViewportSize({ width, height: width === 320 ? 740 : 1000 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const overflow = await page.locator('#custom-tool-manager').evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth,
        children: [...element.querySelectorAll('*')].filter(child => child.getBoundingClientRect().right > element.getBoundingClientRect().right + 1)
          .map(child => ({ tag: child.tagName, name: child.className, width: child.getBoundingClientRect().width, right: child.getBoundingClientRect().right })) }));
      assert.ok(overflow.scroll <= overflow.client, JSON.stringify(overflow));
      const screenshot = path.join(os.tmpdir(), 'luma-tool-editor-' + width + '-' + process.pid + '.png');
      await page.locator('#custom-tool-manager').scrollIntoViewIfNeeded();
      await page.screenshot({ path: screenshot, fullPage: true });
      console.log('Tool editor screenshot: ' + screenshot);
    }
    await page.getByRole('button', { name: '保存工具', exact: true }).click();
    await page.getByRole('button', { name: '编辑 模型评审', exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.toolItems[0].parameters.find(parameter => parameter.name === 'count')), {
      name: 'count', type: 'integer', description: '', required: false, default: 2, enum: [1, 2, 3]
    });
    await page.getByRole('switch', { name: '启用 模型评审', exact: true }).click();
    await page.waitForFunction(() => window.toolItems[0].enabled === false);

    await page.getByRole('button', { name: '编辑 模型评审', exact: true }).click();
    await page.getByLabel('工具类型', { exact: true }).selectOption('mcp');
    await page.getByLabel('接口地址', { exact: true }).fill('https://example.com/mcp');
    await page.getByRole('button', { name: '发现 MCP 工具', exact: true }).click();
    await page.getByLabel('远程工具', { exact: true }).selectOption('0');
    await page.getByRole('button', { name: '导入参数', exact: true }).click();
    assert.equal(await page.locator('[data-parameter]').getByLabel('参数名称').inputValue(), 'city');
    assert.equal(await page.getByLabel('MCP 工具名称', { exact: true }).inputValue(), 'weather');
    await page.getByRole('button', { name: '取消编辑', exact: true }).last().click();
    await page.getByRole('button', { name: '删除 模型评审', exact: true }).click();
    assert.equal(await page.evaluate(() => window.toolItems.length), 1);
    await page.getByRole('button', { name: '确认删除', exact: true }).click();
    await page.waitForFunction(() => !window.toolItems.length);

    await page.getByRole('button', { name: '添加工具', exact: true }).click();
    await page.getByLabel('API Key', { exact: true }).fill('discarded-secret');
    await page.getByLabel('工具名称', { exact: true }).fill('cancel_trial');
    await page.getByLabel('接口地址', { exact: true }).fill('https://example.com/v1/chat/completions');
    await page.getByLabel('模型', { exact: true }).fill('review-model');
    await page.getByLabel('试运行参数', { exact: true }).fill('{"prompt":"pending"}');
    await page.evaluate(() => {
      const request = window.toolBackend.request;
      window.toolBackend.request = function(route, options) {
        if (route !== 'custom-tools/test') return request.call(this, route, options);
        window.pendingSignal = options.signal;
        return new Promise(resolve => { window.releaseTrial = resolve; });
      };
    });
    await page.getByRole('button', { name: '试运行', exact: true }).click();
    await page.waitForFunction(() => Boolean(window.releaseTrial));
    assert.equal(await page.getByRole('button', { name: '取消编辑', exact: true }).last().isDisabled(), false);
    await page.getByRole('button', { name: '取消编辑', exact: true }).last().click();
    assert.equal(await page.evaluate(() => window.pendingSignal.aborted), true);
    await page.evaluate(() => window.releaseTrial({ output: 'stale output' }));
    assert.equal(await page.locator('#custom-tool-manager [data-test-result]').count(), 0);
    await page.getByRole('button', { name: '添加工具', exact: true }).click();
    await page.getByLabel('API Key', { exact: true }).fill('discarded-secret');
    await page.evaluate(() => window.manager.close());
    assert.equal(await page.locator('#custom-tool-manager input[type=password]').count(), 0);
    await page.evaluate(() => { window.toolBackend.connected = false; return window.manager.open(); });
    assert.equal(await page.getByRole('button', { name: '添加工具', exact: true }).isDisabled(), true);
    assert.match(await page.locator('#custom-tool-manager').textContent(), /未连接/);
    await page.evaluate(() => { window.toolBackend.connected = true; window.failNext = true; return window.manager.open(); });
    assert.match(await page.locator('#custom-tool-manager [role=alert]').textContent(), /连接暂时不可用/);
    await page.getByRole('button', { name: '刷新工具列表', exact: true }).click();
    await page.getByRole('button', { name: '添加工具', exact: true }).waitFor();
    assert.deepEqual(errors, []);
  });
