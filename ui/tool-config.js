(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LumaToolConfig = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const KINDS = [
    { value: 'llm', label: 'LLM 模型' }, { value: 'judge', label: '评判模型' },
    { value: 'image', label: '图片生成' }, { value: 'video', label: '视频生成' },
    { value: 'http', label: 'HTTP 请求' }, { value: 'mcp', label: 'MCP 工具' },
    { value: 'cli', label: '本地命令' }
  ];
  const TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array'];
  const PROTOTYPE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
  const RESERVED_PARAMETERS = new Set(['url', 'model', 'effort', 'apikey', 'systemprompt', 'executable', 'argv', 'cwd', 'env', 'headers']);
  const BUILTINS = new Set(['web_search', 'web_fetch', 'get_current_time']);
  const TEMPLATE_CONFIG = new Set(['model', 'effort', 'systemPrompt', 'mcpTool', 'output']);
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  function invalid(message) { const error = new Error(message); error.status = 400; throw error; }
  function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function boundedJSON(value, limit = 262144) {
    let nodes = 0;
    const active = new Set();
    function visit(item, depth) {
      if (++nodes > 10000 || depth > 20) invalid('数据嵌套或数量过大');
      if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
      if (typeof item === 'number' && Number.isFinite(item)) return;
      if ((!Array.isArray(item) && !plain(item)) || active.has(item)) invalid('仅支持有限的 JSON 数据');
      active.add(item);
      for (const key of Object.keys(item)) {
        if (PROTOTYPE_KEYS.has(key.toLowerCase())) invalid('不安全的字段名：' + key);
        visit(item[key], depth + 1);
      }
      active.delete(item);
    }
    visit(value, 0);
    if (JSON.stringify(value).length > limit) invalid('数据内容过大');
    return value;
  }
  function text(value, fallback, max, field) {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || value.length > max || value.includes('\0')) invalid('字段无效：' + field);
    return value;
  }
  function boolean(value, fallback, field) {
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') invalid('字段须为布尔值：' + field);
    return value;
  }
  function integer(value, fallback, min, max, field) {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value < min || value > max) invalid('数值范围无效：' + field);
    return value;
  }
  function choice(value, fallback, values, field) {
    if (value === undefined) return fallback;
    if (!values.includes(value)) invalid('选项无效：' + field);
    return value;
  }
  function identifier(value, field, max = 64) {
    if (typeof value !== 'string' || !new RegExp('^[A-Za-z_][A-Za-z0-9_-]{0,' + (max - 1) + '}$').test(value) || PROTOTYPE_KEYS.has(value.toLowerCase())) invalid('名称无效：' + field);
    return value;
  }
  function pathParts(path) {
    if (typeof path !== 'string' || path.length > 500) invalid('结果路径无效');
    if (!path) return [];
    const parts = path.split('.');
    if (parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part) || PROTOTYPE_KEYS.has(part.toLowerCase()))) invalid('结果路径无效：' + path);
    return parts;
  }
  function extractPath(value, path) {
    for (const part of pathParts(path)) {
      if (value === null || typeof value !== 'object' || !own(value, part)) return undefined;
      value = value[part];
    }
    return value;
  }
  function fixedURL(value, allowResult) {
    if (!value) return '';
    let checked = value;
    if (allowResult) checked = value.replace(/\{\{\s*(result(?:\.[A-Za-z0-9_-]+)+)\s*\}\}/g, (_, path) => { pathParts(path); return 'result'; });
    if (/[{}]/.test(checked)) invalid('请求地址须固定；轮询地址仅支持 result 占位符');
    let parsed;
    try { parsed = new URL(checked); } catch { invalid('请求地址无效'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) invalid('请求地址须为不含凭据与片段的 HTTP(S) URL');
    if (allowResult && /\{\{/.test(value.split('/').slice(0, 3).join('/'))) invalid('轮询地址的协议与主机须固定');
    return value;
  }
  function createTemplate(kind = 'http') {
    if (!KINDS.some(item => item.value === kind)) invalid('未知工具类型');
    const label = KINDS.find(item => item.value === kind).label;
    const config = {
      url: '', method: 'POST', model: '', effort: 'none', systemPrompt: '',
      auth: 'bearer', authHeader: 'X-API-Key', headers: {}, body: {}, resultPath: '',
      output: 'json', timeoutMs: 60000,
      poll: { enabled: false, url: '', statusPath: 'status', successValues: ['completed', 'succeeded'], failureValues: ['failed', 'cancelled'], intervalMs: 2000, maxAttempts: 30, resultPath: '' },
      executable: '', argv: [], cwd: '', env: {}, apiKeyEnv: 'TOOL_API_KEY', mcpTool: ''
    };
    const parameters = [{ name: 'prompt', type: 'string', description: '任务内容', required: true }];
    if (kind === 'llm' || kind === 'judge') {
      config.body = { model: '{{config.model}}', messages: [{ role: 'system', content: '{{config.systemPrompt}}' }, { role: 'user', content: '{{args.prompt}}' }], reasoning_effort: '{{config.effort}}', stream: false };
      config.resultPath = 'choices.0.message.content'; config.output = 'text';
      if (kind === 'judge') config.systemPrompt = '评估提供的内容，给出结论、理由和改进建议。';
    } else if (kind === 'image') {
      config.body = { model: '{{config.model}}', prompt: '{{args.prompt}}' };
      config.resultPath = 'data.0.url'; config.output = 'image';
    } else if (kind === 'video') {
      config.body = { prompt: '{{args.prompt}}' }; config.output = 'video';
    } else if (kind === 'http') config.body = { prompt: '{{args.prompt}}' };
    else if (kind === 'cli') { config.auth = 'none'; config.argv = ['{{args.prompt}}']; config.output = 'text'; }
    else parameters.length = 0;
    return { name: '', label, description: '', kind, enabled: true, requireConfirmation: kind === 'cli' || kind === 'mcp', rememberKey: false, parameters, config };
  }
  function resolveRequestURL(tool) {
    const config = tool.config;
    if (!config.url || !['llm', 'judge'].includes(tool.kind) || (config.method || 'POST') !== 'POST' || !Array.isArray(config.body?.messages)) return config.url;
    const url = new URL(config.url), pathname = url.pathname.replace(/\/+$/, '');
    // Only conventional chat base addresses are expanded; custom endpoints stay exact.
    if (pathname && !/\/v1$/.test(pathname)) return config.url;
    url.pathname = pathname + '/chat/completions';
    return url.href;
  }
  function checkValue(value, parameter) {
    const type = parameter.type;
    const valid = type === 'integer' ? Number.isInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : type === 'object' ? plain(value) : type === 'array' ? Array.isArray(value) : typeof value === type;
    if (!valid) invalid('参数类型无效：' + parameter.name + '（' + type + '）');
    if (parameter.enum && !parameter.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) invalid('参数不在允许选项中：' + parameter.name);
    if (type === 'array' && parameter.itemsType) for (const item of value) checkValue(item, { name: parameter.name, type: parameter.itemsType });
  }
  function parameters(input) {
    if (!Array.isArray(input) || input.length > 64) invalid('参数最多为 64 个');
    const names = new Set();
    return input.map(value => {
      if (!plain(value)) invalid('参数格式无效');
      const name = identifier(value.name, 'parameter');
      if (RESERVED_PARAMETERS.has(name.toLowerCase()) || names.has(name.toLowerCase())) invalid('参数名称重复或属于固定配置：' + name);
      names.add(name.toLowerCase());
      const parameter = { name, type: choice(value.type, 'string', TYPES, 'type'), description: text(value.description, '', 2000, 'description'), required: boolean(value.required, false, 'required') };
      if (value.itemsType !== undefined) {
        if (parameter.type !== 'array') invalid('只有数组参数可设置 itemsType');
        parameter.itemsType = choice(value.itemsType, 'string', TYPES, 'itemsType');
      }
      if (value.enum !== undefined) {
        if (!Array.isArray(value.enum) || !value.enum.length || value.enum.length > 100) invalid('参数选项数量无效');
        parameter.enum = copy(boundedJSON(value.enum));
        for (const item of parameter.enum) checkValue(item, { ...parameter, enum: undefined });
      }
      if (own(value, 'default')) { boundedJSON(value.default); checkValue(value.default, parameter); parameter.default = copy(value.default); }
      return parameter;
    });
  }
  function stringMap(value, field, header = false) {
    if (!plain(value) || Object.keys(value).length > 100) invalid('字段格式无效：' + field);
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      if (PROTOTYPE_KEYS.has(key.toLowerCase()) || !(header ? /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/ : /^[A-Za-z_][A-Za-z0-9_]*$/).test(key)) invalid('字段名称无效：' + field);
      result[key] = text(entry, '', 8192, field);
      if (header && /[\r\n]/.test(entry)) invalid('请求头不能包含换行');
    }
    return result;
  }
  function normalizeTool(input) {
    if (!plain(input)) invalid('工具格式无效');
    // Save-only secret fields are deliberately outside the public configuration.
    const checked = { ...input };
    for (const key of ['apiKey', 'removeKey', 'hasApiKey']) delete checked[key];
    for (const key of Object.keys(checked)) if (checked[key] === undefined) delete checked[key];
    boundedJSON(checked);
    const kind = choice(input.kind, 'http', KINDS.map(item => item.value), 'kind');
    const template = createTemplate(kind);
    const name = identifier(input.name, 'name');
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) invalid('工具名称仅支持字母、数字和下划线');
    if (BUILTINS.has(name.toLowerCase())) invalid('工具名称与内置工具冲突');
    const tool = { name, label: text(input.label, name, 120, 'label').trim() || name, description: text(input.description, '', 8000, 'description'), kind,
      enabled: boolean(input.enabled, true, 'enabled'), requireConfirmation: kind === 'cli' ? true : boolean(input.requireConfirmation, kind === 'mcp', 'requireConfirmation'),
      rememberKey: boolean(input.rememberKey, false, 'rememberKey'), parameters: parameters(input.parameters === undefined ? template.parameters : input.parameters) };
    if (input.id !== undefined) {
      if (typeof input.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(input.id) || PROTOTYPE_KEYS.has(input.id.toLowerCase())) invalid('工具 ID 无效');
      tool.id = input.id;
    }
    if (input.config !== undefined && !plain(input.config)) invalid('固定配置格式无效');
    const source = input.config || {}, defaults = template.config;
    if (Object.keys(source).some(key => !own(defaults, key))) invalid('固定配置包含未知字段');
    const config = {
      url: fixedURL(text(source.url, defaults.url, 4000, 'url'), false),
      method: choice(source.method, defaults.method, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], 'method'),
      model: text(source.model, '', 200, 'model'), effort: choice(source.effort, 'none', ['none', 'low', 'high', 'max'], 'effort'),
      systemPrompt: text(source.systemPrompt, defaults.systemPrompt, 24000, 'systemPrompt'),
      auth: choice(source.auth, defaults.auth, ['bearer', 'header', 'none'], 'auth'), authHeader: text(source.authHeader, defaults.authHeader, 100, 'authHeader'),
      headers: stringMap(source.headers === undefined ? {} : source.headers, 'headers', true), body: copy(source.body === undefined ? defaults.body : source.body),
      resultPath: text(source.resultPath, defaults.resultPath, 500, 'resultPath'), output: choice(source.output, defaults.output, ['text', 'json', 'image', 'video'], 'output'),
      timeoutMs: integer(source.timeoutMs, 60000, 100, 600000, 'timeoutMs'), executable: text(source.executable, '', 2000, 'executable'),
      cwd: text(source.cwd, '', 2000, 'cwd'), env: stringMap(source.env === undefined ? {} : source.env, 'env'), apiKeyEnv: text(source.apiKeyEnv, defaults.apiKeyEnv, 100, 'apiKeyEnv'),
      mcpTool: text(source.mcpTool, '', 200, 'mcpTool')
    };
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(config.authHeader)) invalid('密钥请求头名称无效');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.apiKeyEnv) || PROTOTYPE_KEYS.has(config.apiKeyEnv.toLowerCase())) invalid('密钥环境变量名称无效');
    const argv = source.argv === undefined ? defaults.argv : source.argv;
    if (!Array.isArray(argv) || argv.length > 100) invalid('命令参数数量无效');
    config.argv = argv.map(value => text(value, '', 16000, 'argv'));
    for (const key of ['executable', 'cwd', 'model', 'effort', 'mcpTool', 'apiKeyEnv']) if (/\{\{/.test(config[key])) invalid('固定配置不能引用调用参数：' + key);
    if (kind === 'cli' && !config.executable.trim()) invalid('本地命令不能为空');
    if (kind !== 'cli' && !config.url) invalid('请求地址不能为空');
    if ((kind === 'llm' || kind === 'judge') && !config.model.trim()) invalid('模型 ID 不能为空');
    pathParts(config.resultPath);
    const pollInput = source.poll === undefined ? {} : source.poll;
    if (!plain(pollInput)) invalid('轮询配置格式无效');
    const pollDefaults = defaults.poll;
    if (Object.keys(pollInput).some(key => !own(pollDefaults, key))) invalid('轮询配置包含未知字段');
    config.poll = {
      enabled: boolean(pollInput.enabled, false, 'poll.enabled'), url: fixedURL(text(pollInput.url, '', 4000, 'poll.url'), true),
      statusPath: text(pollInput.statusPath, 'status', 500, 'poll.statusPath'), resultPath: text(pollInput.resultPath, '', 500, 'poll.resultPath'),
      intervalMs: integer(pollInput.intervalMs, 2000, 100, 60000, 'poll.intervalMs'), maxAttempts: integer(pollInput.maxAttempts, 30, 1, 300, 'poll.maxAttempts')
    };
    for (const key of ['successValues', 'failureValues']) {
      const values = pollInput[key] === undefined ? pollDefaults[key] : pollInput[key];
      if (!Array.isArray(values) || !values.length || values.length > 20) invalid('轮询状态值无效');
      config.poll[key] = values.map(value => text(value, '', 100, key));
    }
    pathParts(config.poll.statusPath); pathParts(config.poll.resultPath);
    if (config.poll.enabled && !config.poll.url) invalid('轮询地址不能为空');
    if (config.poll.url && config.url && new URL(config.poll.url.replace(/\{\{[^{}]+\}\}/g, 'result')).origin !== new URL(config.url).origin) invalid('轮询地址须与请求地址同源');
    tool.config = config;
    boundedJSON(tool);
    return tool;
  }
  function definition(tool) {
    const normalized = normalizeTool(tool), properties = {}, required = [];
    for (const parameter of normalized.parameters) {
      const value = { type: parameter.type, description: parameter.description };
      if (parameter.enum) value.enum = copy(parameter.enum);
      if (own(parameter, 'default')) value.default = copy(parameter.default);
      if (parameter.type === 'array') value.items = parameter.itemsType ? { type: parameter.itemsType } : {};
      properties[parameter.name] = value;
      if (parameter.required) required.push(parameter.name);
    }
    return { name: normalized.name, description: normalized.description || normalized.label, parameters: { type: 'object', properties, required, additionalProperties: false } };
  }
  function validateArguments(tool, args) {
    const normalized = normalizeTool(tool);
    if (!plain(args)) invalid('工具参数须为对象');
    boundedJSON(args, 1000000);
    const declared = new Set(normalized.parameters.map(value => value.name));
    for (const key of Object.keys(args)) if (!declared.has(key)) invalid('未知调用参数：' + key);
    const result = copy(args);
    for (const parameter of normalized.parameters) {
      if (!own(result, parameter.name)) {
        if (own(parameter, 'default')) result[parameter.name] = copy(parameter.default);
        else if (parameter.required) invalid('缺少必填参数：' + parameter.name);
        else continue;
      }
      checkValue(result[parameter.name], parameter);
    }
    return result;
  }
  function renderTemplate(value, context = {}) {
    boundedJSON(value, 1000000);
    function resolve(path) {
      const parts = pathParts(path), root = parts.shift();
      if (!['args', 'config', 'result'].includes(root) || !parts.length) invalid('模板变量无效：' + path);
      if (root === 'config' && !TEMPLATE_CONFIG.has(parts[0])) invalid('模板不能读取此固定配置：' + path);
      const found = extractPath(context[root], parts.join('.'));
      if (found === undefined) invalid('模板变量不存在：' + path);
      boundedJSON(found, 1000000);
      return copy(found);
    }
    function render(item) {
      if (Array.isArray(item)) return item.map(render);
      if (plain(item)) return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, render(entry)]));
      if (typeof item !== 'string') return item;
      const whole = item.match(/^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/);
      if (whole) return resolve(whole[1]);
      if (/\{\{|\}\}/.test(item.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, ''))) invalid('模板表达式无效');
      const rendered = item.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_, path) => {
        const found = resolve(path);
        if (found !== null && typeof found === 'object') invalid('嵌入式模板仅支持标量：' + path);
        return String(found);
      });
      return rendered;
    }
    const result = render(value);
    boundedJSON(result, 1000000);
    return result;
  }
  return { KINDS, createTemplate, normalizeTool, definition, validateArguments, renderTemplate, extractPath, resolveRequestURL };
});
