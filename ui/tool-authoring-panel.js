(function (root) {
  'use strict';
  const labels = { name: '工具名称', 'config.url': '接口地址', 'config.model': '模型名称', 'config.executable': '可执行程序', 'config.mcpTool': 'MCP 工具名称', 'config.poll.url': '轮询地址' };
  const icon = name => '<svg class="icon" aria-hidden="true"><use href="#i-' + name + '"/></svg>';

  function create({ root: host, getBackend, getDraft, onApply, onBusy }) {
    const helpers = root.LumaToolAuthoring;
    let visible = false, running = false, blocked = false, revision = 0, controller = null, timer = null;
    let candidate = null, baseline = '', connection = null;
    const find = selector => host.querySelector(selector);
    const connected = () => Boolean(getBackend()?.connected);
    const connectionIdentity = () => {
      const backend = getBackend();
      return backend ? JSON.stringify([backend.baseURL, backend.token]) : '';
    };
    function error(text) {
      find('[data-authoring-error]').textContent = text;
    }
    function clearCandidate() {
      candidate = null;
      baseline = '';
      connection = null;
      find('[data-authoring-result]')?.replaceChildren();
    }
    function setRunning(next) {
      running = next;
      onBusy?.(next);
      host.setAttribute('aria-busy', String(next));
      find('[data-authoring-prompt]').disabled = next;
      find('[data-authoring-generate]').disabled = next;
      find('[data-authoring-stop]').hidden = !next;
      find('[data-authoring-status]').textContent = next ? '正在生成配置…' : '';
    }
    function setBlocked(next) {
      blocked = next && !running;
      if (!visible) return;
      host.querySelectorAll('[data-authoring-prompt], [data-authoring-generate], [data-authoring-apply], [data-authoring-discard]').forEach(element => { element.disabled = running || blocked; });
    }
    function stop() {
      revision++;
      controller?.abort();
      controller = null;
      clearTimeout(timer);
      timer = null;
      if (running) setRunning(false);
    }
    function close() {
      stop();
      visible = false;
      clearCandidate();
      host.replaceChildren();
      host.hidden = true;
    }
    function showPreview(result) {
      const target = find('[data-authoring-result]');
      target.innerHTML = '<section class="ta-preview" data-authoring-preview><div class="tm-heading"><h5>配置草稿</h5><span data-authoring-summary></span></div><p class="ta-missing" data-authoring-missing></p><pre tabindex="0" aria-label="生成的工具配置"></pre><div class="tm-actions"><button type="button" class="secondary-button" data-authoring-discard>放弃草稿</button><button type="button" class="primary-button" data-authoring-apply>' + icon('check') + '应用到表单</button></div></section>';
      find('[data-authoring-summary]').textContent = (result.tool.label || result.tool.name || '未命名工具') + ' · ' + result.tool.parameters.length + ' 个运行参数';
      const missing = find('[data-authoring-missing]');
      missing.textContent = result.missingFields.length ? '待补充：' + result.missingFields.map(path => labels[path] || path).join('、') : '';
      missing.hidden = !result.missingFields.length;
      find('.ta-preview pre').textContent = JSON.stringify(result.tool, null, 2);
    }
    async function generate() {
      if (running || blocked) return;
      error('');
      clearCandidate();
      let input, snapshot;
      try {
        if (!connected()) throw new Error('请先连接本地后端');
        const prompt = find('[data-authoring-prompt]').value.trim();
        if (!prompt) throw new Error('请填写创作需求或接口文档');
        snapshot = JSON.stringify(getDraft());
        input = helpers.sanitizeInput({ prompt, tool: JSON.parse(snapshot) });
      } catch (failure) { error(failure.message); return; }
      const version = ++revision, identity = connectionIdentity(), requestController = new AbortController();
      controller = requestController;
      timer = setTimeout(() => requestController.abort(), 125000);
      setRunning(true);
      try {
        const response = await getBackend().request('custom-tools/generate', { method: 'POST', data: input, signal: requestController.signal });
        if (!visible || version !== revision || requestController.signal.aborted) return;
        const result = helpers.validateSuggestion(response.tool);
        candidate = result.tool;
        baseline = snapshot;
        connection = identity;
        showPreview(result);
      } catch (failure) {
        if (visible && version === revision) error(failure.name === 'AbortError' ? '生成已取消或超时，请重试' : failure.message);
      } finally {
        snapshot = '';
        if (visible && version === revision) {
          clearTimeout(timer);
          timer = null;
          controller = null;
          setRunning(false);
        }
      }
    }
    function apply() {
      if (!candidate || running || blocked) return;
      try {
        if (!connected() || connection !== connectionIdentity()) throw new Error('后端连接已更改，请重新生成');
        const current = getDraft();
        if (JSON.stringify(current) !== baseline) throw new Error('表单已更改，请重新生成配置后再应用');
        onApply(helpers.applySuggestion(current, candidate));
      } catch (failure) { if (visible) error(failure.message); }
    }
    function open() {
      if (!visible) {
        visible = true;
        host.hidden = false;
        host.innerHTML = '<section class="ta-panel" aria-label="AI 协助创作"><div class="tm-heading"><h4>' + icon('spark') + 'AI 协助创作</h4><button type="button" class="icon-button" data-authoring-close aria-label="关闭 AI 协助创作" title="关闭 AI 协助创作">' + icon('close') + '</button></div><label class="tm-field"><span>创作需求与接口文档</span><textarea data-authoring-prompt aria-label="创作需求与接口文档" rows="5" maxlength="24000" placeholder="描述工具用途，或粘贴接口文档、请求与响应示例" spellcheck="false"></textarea></label><div class="tm-actions ta-generate-actions"><button type="button" class="primary-button" data-authoring-generate>' + icon('spark') + '生成配置</button><button type="button" class="secondary-button" data-authoring-stop hidden>' + icon('close') + '停止生成配置</button><span data-authoring-status role="status" aria-live="polite"></span></div><div class="tm-message tm-error" data-authoring-error role="alert"></div><div data-authoring-result></div></section>';
      }
      find('[data-authoring-prompt]').focus();
      host.scrollIntoView({ block: 'start' });
    }
    host.addEventListener('click', event => {
      if (event.target.closest('[data-authoring-generate]')) generate();
      else if (event.target.closest('[data-authoring-stop]')) { stop(); clearCandidate(); error(''); find('[data-authoring-status]').textContent = '已停止生成'; }
      else if (event.target.closest('[data-authoring-apply]')) apply();
      else if (event.target.closest('[data-authoring-discard]')) { clearCandidate(); error(''); }
      else if (event.target.closest('[data-authoring-close]')) close();
    });
    return { open, close, setBlocked };
  }
  root.LumaToolAuthoringPanel = { create };
})(globalThis);
