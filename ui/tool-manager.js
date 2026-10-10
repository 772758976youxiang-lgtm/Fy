(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LumaToolManager = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const copy = value => JSON.parse(JSON.stringify(value));
  const icon = name => '<svg class="icon" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
  const button = (action, label, symbol, className = 'secondary-button') => '<button type="button" class="' + className + '" data-action="' + action + '" title="' + escape(label) + '" aria-label="' + escape(label) + '">' + (symbol ? icon(symbol) : '') + (className === 'icon-button' ? '' : escape(label)) + '</button>';
  const options = (values, selected) => values.map(entry => { const value = typeof entry === 'string' ? entry : entry.value; return '<option value="' + escape(value) + '"' + (value === selected ? ' selected' : '') + '>' + escape(typeof entry === 'string' ? entry : entry.label) + '</option>'; }).join('');
  const field = (name, label, value, { type = 'text', rows, choices, placeholder = '', required = false } = {}) => '<label class="tm-field"><span>' + escape(label) + '</span>' + (choices
    ? '<select data-field="' + name + '" aria-label="' + escape(label) + '">' + options(choices, value) + '</select>'
    : rows ? '<textarea data-field="' + name + '" rows="' + rows + '" aria-label="' + escape(label) + '" spellcheck="false">' + escape(value) + '</textarea>'
      : '<input data-field="' + name + '" type="' + type + '" value="' + escape(value) + '" placeholder="' + escape(placeholder) + '" aria-label="' + escape(label) + '" autocomplete="off" spellcheck="false"' + (required ? ' required' : '') + '>') + '</label>';
  const check = (name, label, checked, disabled = false) => '<label class="tm-check"><input type="checkbox" data-field="' + name + '"' + (checked ? ' checked' : '') + (disabled ? ' disabled' : '') + '><span>' + escape(label) + '</span></label>';
  const json = value => JSON.stringify(value, null, 2);

  function create({ root, getBackend, authorButton }) {
    if (!root || typeof getBackend !== 'function') throw new Error('Tool manager requires a root and backend accessor');
    const schema = globalThis.LumaToolConfig;
    let items = [], draft = null, active = false, busy = false, revision = 0, controller = null, timeout = null, discovery = [], pendingTrial = null, authoring = null;
    root.classList.add('tool-manager');
    const connected = () => Boolean(getBackend()?.connected);
    const read = name => root.querySelector('[data-field="' + name + '"]');
    const value = name => read(name)?.value || '';
    const checked = name => Boolean(read(name)?.checked);

    function message(text, error = false) {
      const target = root.querySelector('[data-message]');
      if (!target) return;
      target.textContent = text;
      target.setAttribute('role', error ? 'alert' : 'status');
      target.classList.toggle('tm-error', error);
      if (error) target.scrollIntoView({ block: 'nearest' });
    }
    function stop() {
      controller?.abort();
      controller = null;
      clearTimeout(timeout);
      timeout = null;
    }
    function clearEditor() {
      authoring?.close();
      authoring = null;
      root.querySelectorAll('input[type="password"]').forEach(input => { input.value = ''; });
      if (draft) delete draft.apiKey;
      draft = null;
      pendingTrial = null;
      discovery = [];
      delete root.dataset.editing;
    }
    function setBusy(next) {
      busy = next;
      root.setAttribute('aria-busy', String(next));
      root.querySelectorAll('[data-action], input, textarea, select').forEach(element => {
        if (element.closest('[data-authoring-host]')) return;
        element.disabled = element.dataset.action === 'cancel' ? false : next || (!connected() && element.dataset.action !== 'refresh');
      });
      if (draft?.kind === 'cli' && read('requireConfirmation')) read('requireConfirmation').disabled = true;
      if (authorButton) authorButton.disabled = next || !connected();
      authoring?.setBlocked(next);
    }
    function list() {
      clearEditor();
      root.innerHTML = '<div class="tm-heading"><h4>自定义工具</h4><div class="tm-actions">' + button('refresh', '刷新工具列表', 'refresh', 'icon-button') + button('add', '添加工具', 'plus') + '</div></div>'
        + '<div class="tm-connection' + (connected() ? ' connected' : '') + '">' + (connected() ? '本地后端已连接' : '本地后端未连接') + '</div>'
        + '<div data-message class="tm-message" role="status" aria-live="polite"></div>'
        + '<div class="tm-list">' + (items.length ? items.map((tool, index) => '<div class="tm-item" data-index="' + index + '"><span class="tool-icon">' + icon(tool.kind === 'cli' ? 'code' : tool.kind === 'mcp' ? 'tool' : 'bolt') + '</span><div class="tm-item-info"><strong>' + escape(tool.label || tool.name) + '</strong><code>' + escape(tool.name) + '</code><span class="tm-kind">' + escape(schema.KINDS.find(kind => kind.value === tool.kind)?.label || tool.kind) + '</span></div><div class="tm-item-actions"><button type="button" data-action="toggle" class="switch" role="switch" aria-label="启用 ' + escape(tool.label || tool.name) + '" aria-checked="' + Boolean(tool.enabled) + '"><i></i></button>' + button('duplicate', '复制 ' + (tool.label || tool.name), 'copy', 'icon-button') + button('edit', '编辑 ' + (tool.label || tool.name), 'pen', 'icon-button') + button('delete', '删除 ' + (tool.label || tool.name), 'trash', 'icon-button') + '</div></div>').join('') : '<p class="tm-empty">暂无自定义工具</p>') + '</div><div data-confirmation></div>';
      setBusy(busy);
    }
    async function open() {
      active = true;
      const version = ++revision;
      stop();
      busy = false;
      items = [];
      list();
      if (!connected()) return;
      setBusy(true);
      message('正在加载工具…');
      try {
        const response = await getBackend().request('custom-tools');
        if (!active || version !== revision) return;
        items = Array.isArray(response.tools) ? response.tools : [];
        list();
      } catch (error) {
        if (active && version === revision) message(error.message, true);
      } finally { if (active && version === revision) setBusy(false); }
    }
    function close() {
      active = false;
      revision++;
      stop();
      clearEditor();
      items = [];
      busy = false;
      root.replaceChildren();
      root.removeAttribute('aria-busy');
    }
    function parameterMarkup(parameter = {}) {
      return '<div class="tm-parameter" data-parameter><div class="tm-parameter-top">'
        + field('parameter-name', '参数名称', parameter.name || '')
        + field('parameter-type', '参数类型', parameter.type || 'string', { choices: ['string', 'number', 'integer', 'boolean', 'object', 'array'] })
        + check('parameter-required', '必填', parameter.required)
        + button('remove-parameter', '删除参数', 'trash', 'icon-button') + '</div>'
        + field('parameter-description', '参数说明', parameter.description || '')
        + '<div class="tm-grid">' + field('parameter-default', '默认值 JSON', parameter.default === undefined ? '' : json(parameter.default), { placeholder: '"示例" / 1 / true' })
        + field('parameter-enum', '可选值 JSON', parameter.enum === undefined ? '' : json(parameter.enum), { placeholder: '["选项一", "选项二"]' }) + '</div>'
        + '<div data-array-type' + (parameter.type === 'array' ? '' : ' hidden') + '>' + field('parameter-itemsType', '数组元素类型', parameter.itemsType || 'string', { choices: ['string', 'number', 'integer', 'boolean', 'object'] }) + '</div></div>';
    }
    function edit(tool) {
      stop();
      clearEditor();
      draft = copy(tool || schema.createTemplate('llm'));
      delete draft.apiKey;
      editor();
      const scroller = root.closest('.settings-content');
      if (scroller) scroller.scrollTop = 0;
      read('label')?.focus({ preventScroll: true });
    }
    function editor() {
      authoring?.close();
      authoring = null;
      root.dataset.editing = 'true';
      const c = draft.config, cli = draft.kind === 'cli', mcp = draft.kind === 'mcp', ai = ['llm', 'judge', 'image', 'video'].includes(draft.kind);
      const references = json([c.body, c.argv]);
      const modelFields = ai || c.model || c.effort !== 'none' || /\{\{\s*config\.(?:model|effort)\s*\}\}/.test(references);
      const promptField = ai || c.systemPrompt || /\{\{\s*config\.systemPrompt\s*\}\}/.test(references);
      const poll = { enabled: false, url: '', statusPath: 'status', successValues: ['completed', 'succeeded'], failureValues: ['failed', 'cancelled'], intervalMs: 2000, maxAttempts: 30, resultPath: '', ...c.poll };
      root.innerHTML = '<div data-authoring-host hidden></div><form class="tm-editor"><div class="tm-heading"><h4>' + (draft.id ? '编辑工具' : '添加工具') + '</h4>' + button('cancel', '取消编辑', 'close', 'icon-button') + '</div>'
        + '<div data-message class="tm-message" role="status" aria-live="polite"></div>'
        + '<div class="tm-grid">' + field('label', '显示名称', draft.label, { required: true }) + field('name', '工具名称', draft.name, { required: true }) + '</div>'
        + field('description', '工具说明', draft.description, { rows: 2 })
        + field('kind', '工具类型', draft.kind, { choices: schema.KINDS })
        + '<section class="tm-section"><h5>固定配置</h5>'
        + (cli ? field('executable', '可执行程序', c.executable, { placeholder: 'python / node / 程序绝对路径', required: true })
          + field('argv', '命令参数 JSON', json(c.argv || []), { rows: 3 }) + field('cwd', '工作目录', c.cwd)
          + field('env', '环境变量 JSON', json(c.env || {}), { rows: 3 }) + field('apiKeyEnv', '密钥环境变量', c.apiKeyEnv || 'TOOL_API_KEY')
          : field('url', '接口地址', c.url, { type: 'url', required: true }))
        + (modelFields ? '<div class="tm-grid">' + field('model', '模型', c.model) + field('effort', '思考强度', c.effort || 'none', { choices: ['none', 'low', 'high', 'max'] }) + '</div>' : '')
        + field('apiKey', 'API Key', '', { type: 'password', placeholder: draft.hasApiKey ? '已配置，留空保留' : '可选' })
        + '<div class="tm-checks">' + check('rememberKey', '记住密钥（本机，未加密）', draft.rememberKey) + (draft.hasApiKey ? check('removeKey', '移除已保存的密钥', draft.removeKey) : '') + '</div>'
        + (promptField ? field('systemPrompt', '系统提示词', c.systemPrompt, { rows: 4 }) : '')
        + (mcp ? field('mcpTool', 'MCP 工具名称', c.mcpTool) + '<div class="tm-actions tm-discover">' + button('discover', '发现 MCP 工具', 'refresh') + '</div><div data-discovery></div>' : '')
        + '<details class="tm-advanced"><summary>高级配置</summary>'
        + (!cli ? '<div class="tm-grid">' + field('method', '请求方法', c.method || 'POST', { choices: ['POST', 'GET', 'PUT', 'PATCH', 'DELETE'] })
          + field('auth', '鉴权方式', c.auth || 'bearer', { choices: [{ value: 'bearer', label: 'Bearer Token' }, { value: 'header', label: '自定义请求头' }, { value: 'none', label: '无鉴权' }] }) + '</div>'
          + field('authHeader', '密钥请求头名称', c.authHeader || 'X-API-Key')
          + field('headers', '请求头 JSON', json(c.headers || {}), { rows: 3 }) + field('body', '请求体 JSON', json(c.body || {}), { rows: 5 }) : '')
        + '<div class="tm-grid">' + field('output', '输出类型', c.output || 'text', { choices: ['text', 'json', 'image', 'video'] })
        + field('timeoutMs', '超时（毫秒）', c.timeoutMs || 60000, { type: 'number' }) + '</div>'
        + field('resultPath', '结果字段路径', c.resultPath || '')
        + (!cli && !mcp ? '<div class="tm-poll">' + check('pollEnabled', '轮询异步结果', poll.enabled)
          + '<div data-poll-fields' + (poll.enabled ? '' : ' hidden') + '>' + field('pollUrl', '轮询地址', poll.url)
          + '<div class="tm-grid">' + field('pollStatusPath', '状态字段路径', poll.statusPath) + field('pollResultPath', '轮询结果字段路径', poll.resultPath) + '</div>'
          + '<div class="tm-grid">' + field('pollSuccess', '成功状态 JSON', json(poll.successValues)) + field('pollFailure', '失败状态 JSON', json(poll.failureValues)) + '</div>'
          + '<div class="tm-grid">' + field('pollInterval', '轮询间隔（毫秒）', poll.intervalMs, { type: 'number' }) + field('pollAttempts', '最多轮询次数', poll.maxAttempts, { type: 'number' }) + '</div></div></div>' : '')
        + '</details></section><section class="tm-section"><div class="tm-heading"><h5>运行参数</h5>' + button('add-parameter', '添加参数', 'plus') + '</div><div data-parameters>' + (draft.parameters || []).map(parameterMarkup).join('') + '</div></section>'
        + '<div class="tm-checks">' + check('enabled', '启用工具', draft.enabled !== false) + check('requireConfirmation', '执行前确认', cli || draft.requireConfirmation, cli) + '</div>'
        + '<section class="tm-section"><h5>试运行</h5>' + field('testArgs', '试运行参数', '{}', { rows: 4 })
        + '<div class="tm-actions">' + button('test', '试运行', 'bolt') + '</div><div data-trial-confirmation></div><div data-test-result class="tm-result" role="status" aria-live="polite"></div></section>'
        + '<div class="tm-editor-footer">' + button('cancel', '取消编辑', null) + '<button type="submit" class="primary-button" data-action="save">' + icon('check') + '保存工具</button></div></form>';
      setBusy(false);
      if (globalThis.LumaToolAuthoringPanel && globalThis.LumaToolAuthoring) {
        authoring = globalThis.LumaToolAuthoringPanel.create({ root: root.querySelector('[data-authoring-host]'), getBackend,
          getDraft: () => collect(false), onBusy: setBusy,
          onApply(tool) {
            if (busy) throw new Error('请等待当前操作完成');
            const missing = globalThis.LumaToolAuthoring.validateSuggestion(tool).missingFields;
            revision++;
            stop();
            const key = tool.apiKey || '';
            delete tool.apiKey;
            if (pendingTrial) pendingTrial.tool.apiKey = '';
            pendingTrial = null;
            discovery = [];
            draft = tool;
            editor();
            read('apiKey').value = key;
            const fields = missing.map(path => read(path === 'config.poll.url' ? 'pollUrl' : path.split('.').pop())).filter(Boolean);
            for (const element of fields) element.setAttribute('aria-invalid', 'true');
            if (fields.some(element => element.closest('.tm-advanced'))) root.querySelector('.tm-advanced').open = true;
            message('已应用草稿，尚未保存' + (fields.length ? '。待补充：' + fields.map(element => element.getAttribute('aria-label')).join('、') : ''));
            (fields[0] || read('label')).focus();
          }
        });
      }
    }
    function author() {
      if (!active || busy || !connected()) return;
      if (!draft) edit();
      authoring?.open();
    }
    function parse(text, label, shape) {
      let result;
      try { result = JSON.parse(text); } catch { throw new Error(label + '不是有效的 JSON'); }
      if (shape === 'object' && (!result || Array.isArray(result) || typeof result !== 'object')) throw new Error(label + '须为 JSON 对象');
      if (shape === 'array' && !Array.isArray(result)) throw new Error(label + '须为 JSON 数组');
      return result;
    }
    function collect(normalize = true) {
      const tool = copy(draft), c = tool.config;
      for (const name of ['name', 'label', 'description']) tool[name] = value(name).trim();
      for (const name of ['enabled', 'rememberKey', 'requireConfirmation']) tool[name] = checked(name);
      tool.requireConfirmation = tool.kind === 'cli' || tool.requireConfirmation;
      for (const name of ['url', 'model', 'effort', 'systemPrompt', 'method', 'auth', 'authHeader', 'resultPath', 'output', 'executable', 'cwd', 'apiKeyEnv', 'mcpTool']) {
        if (read(name)) c[name] = value(name);
      }
      c.timeoutMs = Number(value('timeoutMs'));
      for (const name of ['headers', 'body', 'env', 'argv']) if (read(name)) c[name] = parse(value(name), read(name).getAttribute('aria-label'), name === 'argv' ? 'array' : 'object');
      if (read('pollEnabled')) c.poll = { enabled: checked('pollEnabled'), url: value('pollUrl'), statusPath: value('pollStatusPath'), resultPath: value('pollResultPath'),
        successValues: parse(value('pollSuccess'), '成功状态', 'array'), failureValues: parse(value('pollFailure'), '失败状态', 'array'), intervalMs: Number(value('pollInterval')), maxAttempts: Number(value('pollAttempts')) };
      tool.parameters = [...root.querySelectorAll('[data-parameter]')].map(row => {
        const get = name => row.querySelector('[data-field="parameter-' + name + '"]');
        const parameter = { name: get('name').value.trim(), type: get('type').value, description: get('description').value, required: get('required').checked };
        for (const name of ['default', 'enum']) if (get(name).value.trim()) parameter[name] = parse(get(name).value, parameter.name + (name === 'enum' ? '可选值' : '默认值'), name === 'enum' ? 'array' : undefined);
        if (parameter.type === 'array') parameter.itemsType = get('itemsType').value;
        return parameter;
      });
      const normalized = normalize ? schema.normalizeTool(tool) : tool;
      if (normalize) normalized.config.url = schema.resolveRequestURL(normalized);
      normalized.apiKey = value('apiKey');
      normalized.removeKey = checked('removeKey');
      return normalized;
    }
    function changeKind(kind) {
      const previousKind = draft.kind;
      try {
        const tool = collect(false), previousTemplate = schema.createTemplate(previousKind), template = schema.createTemplate(kind);
        const key = tool.apiKey, testArgs = value('testArgs'), advancedOpen = root.querySelector('.tm-advanced').open;
        // Only untouched defaults on a new tool follow the new kind's template.
        if (!tool.id) {
          const requestUnchanged = json(tool.config.body) === json(previousTemplate.config.body)
            && json(tool.config.argv) === json(previousTemplate.config.argv) && json(tool.parameters) === json(previousTemplate.parameters);
          if (requestUnchanged) {
            tool.config.body = template.config.body;
            tool.config.argv = template.config.argv;
            tool.parameters = template.parameters;
          }
          for (const name of ['resultPath', 'output', 'poll']) {
            if (json(tool.config[name]) === json(previousTemplate.config[name])) tool.config[name] = template.config[name];
          }
          if (tool.requireConfirmation === previousTemplate.requireConfirmation) tool.requireConfirmation = template.requireConfirmation;
        }
        tool.kind = kind;
        delete tool.apiKey;
        draft = tool;
        if (pendingTrial) pendingTrial.tool.apiKey = '';
        pendingTrial = null;
        discovery = [];
        editor();
        read('apiKey').value = key;
        read('testArgs').value = testArgs;
        root.querySelector('.tm-advanced').open = advancedOpen;
      } catch (error) {
        read('kind').value = previousKind;
        message(error.message, true);
      }
    }
    async function run(action) {
      if (busy) return;
      if (!connected()) { message('本地后端未连接', true); return; }
      const version = revision;
      setBusy(true);
      message('');
      try { await action(() => active && version === revision); }
      catch (error) { if (active && version === revision) message(error.name === 'AbortError' ? '请求已取消或超时' : error.message, true); }
      finally { if (active && version === revision) setBusy(false); }
    }
    async function save() {
      let tool;
      try { tool = collect(); } catch (error) { message(error.message, true); return; }
      await run(async current => {
        const response = await getBackend().request('custom-tools', { method: 'POST', data: tool });
        if (!current()) return;
        items = [...items.filter(item => item.id !== response.tool.id), response.tool];
        list();
        message('工具已保存');
      });
      tool.apiKey = '';
    }
    function confirmation(target, heading, detail, accept, cancel) {
      target.innerHTML = '<div class="tm-confirmation"><strong>' + escape(heading) + '</strong><pre>' + escape(typeof detail === 'string' ? detail : json(detail)) + '</pre><div class="tm-actions">' + button(cancel, '取消', null) + button(accept, accept === 'confirm-delete' ? '确认删除' : '确认执行', accept === 'confirm-delete' ? 'trash' : 'check', 'primary-button') + '</div></div>';
    }
    async function trial(confirmed = false) {
      let payload;
      try {
        payload = confirmed ? pendingTrial : { tool: collect(), args: parse(value('testArgs'), '试运行参数', 'object') };
        if (!payload) return;
        schema.validateArguments(payload.tool, payload.args);
      } catch (error) { message(error.message, true); return; }
      await run(async current => {
        stop();
        const trialController = new AbortController();
        controller = trialController;
        const trialTimeout = setTimeout(() => trialController.abort(), Math.max(1000, payload.tool.config.timeoutMs) + 1000);
        timeout = trialTimeout;
        root.querySelector('[data-trial-confirmation]').replaceChildren();
        root.querySelector('[data-test-result]').textContent = '正在执行…';
        try {
          const response = await getBackend().request('custom-tools/test', { method: 'POST', data: { ...payload, ...(payload.tool.id ? { id: payload.tool.id } : {}), ...(confirmed ? { confirmed: true } : {}) }, signal: trialController.signal });
          if (!current()) return;
          if (response.requiresConfirmation) {
            pendingTrial = payload;
            root.querySelector('[data-test-result]').textContent = '';
            confirmation(root.querySelector('[data-trial-confirmation]'), '确认执行试运行', response.preview || '即将执行工具', 'confirm-test', 'cancel-test');
          } else {
            pendingTrial = null;
            result(response);
            message('试运行完成');
          }
        } catch (error) { if (current()) root.querySelector('[data-test-result]').textContent = ''; throw error; }
        finally {
          clearTimeout(trialTimeout);
          if (controller === trialController) { controller = null; timeout = null; }
          if (pendingTrial !== payload) payload.tool.apiKey = '';
        }
      });
    }
    function result(response) {
      const target = root.querySelector('[data-test-result]');
      const data = response.output === undefined ? response.result === undefined ? response : response.result : response.output;
      target.innerHTML = '<pre>' + escape(typeof data === 'string' ? data : json(data)) + '</pre>';
      const candidates = Array.isArray(response.artifacts) ? response.artifacts : [{ url: typeof data === 'string' ? data : data?.url, type: draft.config.output }];
      for (const artifact of candidates) {
        try {
          const parsed = new URL(artifact.url);
          if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) continue;
          const link = document.createElement('a');
          link.href = parsed.href;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = artifact.type === 'video' ? '打开视频结果' : artifact.type === 'image' ? '打开图片结果' : '打开结果链接';
          target.append(link);
        } catch { /* Results without URLs remain plain text. */ }
      }
    }
    async function discover() {
      let tool;
      try { tool = collect(); } catch (error) { message(error.message, true); return; }
      await run(async current => {
        const response = await getBackend().request('custom-tools/discover', { method: 'POST', data: { tool } });
        if (!current()) return;
        discovery = response.tools || [];
        root.querySelector('[data-discovery]').innerHTML = discovery.length ? field('discoveredTool', '远程工具', '0', { choices: discovery.map((remote, index) => ({ value: String(index), label: remote.name })) }) + button('import', '导入参数', 'download') : '<p class="tm-empty">未发现远程工具</p>';
      });
      tool.apiKey = '';
    }
    function importParameters(input) {
      const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
      const annotations = ['title', 'description', '$comment', 'examples'];
      function supportedKeys(value, allowed, path) {
        const unsupported = Object.keys(value).find(key => !allowed.includes(key));
        if (unsupported) throw new Error(path + ' 不支持 ' + unsupported + '，仅支持基础参数');
      }
      if (!plain(input) || input.type !== 'object') throw new Error('参数 schema 须为基础 object 类型');
      supportedKeys(input, ['type', 'properties', 'required', 'additionalProperties', '$schema', ...annotations], '根参数');
      if (input.additionalProperties !== undefined && input.additionalProperties !== false) throw new Error('不支持开放或动态的额外参数');
      const properties = input.properties === undefined ? {} : input.properties, required = input.required === undefined ? [] : input.required;
      if (!plain(properties) || !Array.isArray(required) || required.some(name => typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(properties, name))) throw new Error('properties 或 required 格式无效');
      return Object.entries(properties).map(([name, property]) => {
        if (!plain(property)) throw new Error(name + ' 的参数 schema 无效');
        supportedKeys(property, ['type', 'default', 'enum', 'items', ...annotations], name);
        if (!['string', 'number', 'integer', 'boolean', 'object', 'array'].includes(property.type)) throw new Error(name + ' 不支持联合类型、null 或未声明的类型');
        const parameter = { name, type: property.type, description: property.description || '', required: required.includes(name),
          ...(Object.prototype.hasOwnProperty.call(property, 'default') ? { default: property.default } : {}),
          ...(Object.prototype.hasOwnProperty.call(property, 'enum') ? { enum: property.enum } : {}) };
        if (property.type === 'array') {
          if (!plain(property.items)) throw new Error(name + ' 仅支持指定基础元素类型的数组');
          supportedKeys(property.items, ['type', ...annotations], name + '.items');
          if (!['string', 'number', 'integer', 'boolean', 'object'].includes(property.items.type)) throw new Error(name + ' 不支持嵌套数组或联合元素类型');
          parameter.itemsType = property.items.type;
        } else if (property.items !== undefined) throw new Error(name + ' 的 items 仅适用于数组');
        return parameter;
      });
    }
    function importTool() {
      const tool = discovery[Number(value('discoveredTool'))];
      if (!tool) return;
      try {
        const parameters = importParameters(tool.inputSchema || tool.parameters);
        const candidate = collect(false);
        candidate.parameters = parameters;
        candidate.config.mcpTool = tool.name;
        if (!candidate.description) candidate.description = tool.description || '';
        delete candidate.apiKey;
        const normalized = schema.normalizeTool(candidate);
        read('mcpTool').value = normalized.config.mcpTool;
        root.querySelector('[data-parameters]').innerHTML = normalized.parameters.map(parameterMarkup).join('');
        read('description').value = normalized.description;
        message('已导入 ' + tool.name + ' 的基础参数');
      } catch (error) { message('无法导入 MCP 参数：' + error.message, true); }
    }
    root.addEventListener('submit', event => { event.preventDefault(); if (draft) save(); });
    root.addEventListener('input', event => { if (event.target.matches('[data-field][aria-invalid="true"]')) event.target.removeAttribute('aria-invalid'); });
    root.addEventListener('change', event => {
      if (event.target.dataset.field === 'kind') {
        changeKind(event.target.value);
      }
      if (event.target.dataset.field === 'parameter-type') event.target.closest('[data-parameter]').querySelector('[data-array-type]').hidden = event.target.value !== 'array';
      if (event.target.dataset.field === 'pollEnabled') root.querySelector('[data-poll-fields]').hidden = !event.target.checked;
    });
    root.addEventListener('click', event => {
      const target = event.target.closest('[data-action]');
      if (!target || target.disabled) return;
      const action = target.dataset.action, item = items[Number(target.closest('[data-index]')?.dataset.index)];
      if (action === 'refresh') open();
      else if (action === 'add') edit();
      else if (action === 'edit') edit(item);
      else if (action === 'duplicate') run(async current => {
        const response = await getBackend().request('custom-tools/' + encodeURIComponent(item.id) + '/duplicate', { method: 'POST' });
        if (!current()) return;
        items = [...items, response.tool];
        edit(response.tool);
        message('副本已创建并保存，当前未启用');
      });
      else if (action === 'cancel') { revision++; stop(); busy = false; list(); }
      else if (action === 'add-parameter') root.querySelector('[data-parameters]').insertAdjacentHTML('beforeend', parameterMarkup());
      else if (action === 'remove-parameter') target.closest('[data-parameter]').remove();
      else if (action === 'test') trial();
      else if (action === 'confirm-test') trial(true);
      else if (action === 'cancel-test') { pendingTrial = null; root.querySelector('[data-trial-confirmation]').replaceChildren(); }
      else if (action === 'discover') discover();
      else if (action === 'import') importTool();
      else if (action === 'toggle') run(async current => {
        const response = await getBackend().request('custom-tools', { method: 'POST', data: { ...item, enabled: !item.enabled } });
        if (current()) { items = items.map(tool => tool.id === item.id ? response.tool : tool); list(); }
      });
      else if (action === 'delete') {
        root.querySelector('[data-confirmation]').dataset.deleteId = item.id;
        confirmation(root.querySelector('[data-confirmation]'), '删除工具', item.label || item.name, 'confirm-delete', 'cancel-delete');
      } else if (action === 'cancel-delete') root.querySelector('[data-confirmation]').replaceChildren();
      else if (action === 'confirm-delete') run(async current => {
        const id = root.querySelector('[data-confirmation]').dataset.deleteId;
        await getBackend().request('custom-tools/' + encodeURIComponent(id), { method: 'DELETE' });
        if (current()) { items = items.filter(tool => tool.id !== id); list(); message('工具已删除'); }
      });
    });
    return { open, close, author };
  }
  return { create };
});
