'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../storage');
const { createService } = require('../server');

let chromium;
try { ({ chromium } = require('playwright')); } catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

test('browser: backstage notes stay folded, separate from real tools, and out of copied/exported answers',
  {skip:!chromium,timeout:25000},async t=>{
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'luma-backstage-layout-'));
    const store=new Store(directory);store.saveSettings({apiKey:'fake-layout-key'});
    const raw='雨仍在下。\n\n⟨幕后⟩\nscene_build → {"hidden":["secret-state"]}\n<img src=x onerror=alert(1)>\n'+('long_note_'.repeat(60))+'\n⟨/幕后⟩\n\n你准备去哪里？';
    store.putSession({id:'backstage',title:'幕后展示检查',createdAt:1,updatedAt:1,apiMessages:[{role:'assistant',content:raw}],
      messages:[{id:'question',role:'user',content:'开始'},
        {id:'backstage-answer',role:'assistant',status:'done',content:raw,tools:[{id:'real-call',name:'get_current_time',label:'获取时间',state:'已完成'}]}]});
    let emit,begin;
    const started=new Promise(resolve=>{begin=resolve;});
    const service=createService({store,fetchImpl:async()=>new Response(new ReadableStream({start(controller){
      emit=(content,done=false)=>{
        controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{index:0,delta:{content},finish_reason:done?'stop':null}]})+'\n\n'));
        if(done){controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));controller.close();}
      };begin();
    }}),{headers:{'Content-Type':'text/event-stream'}})});
    await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
    const browser=await chromium.launch({channel:process.env.LUMA_TEST_BROWSER||'chrome',headless:true});
    t.after(async()=>{await browser.close();await service.close();fs.rmSync(directory,{recursive:true,force:true});});
    const page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'});page.setDefaultTimeout(4000);
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    const base='http://127.0.0.1:'+service.server.address().port;
    await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin:base});
    await page.goto(base);await page.waitForFunction(()=>document.querySelector('#backend-state').textContent==='已连接');
    const reply=page.locator('#msg-backstage-answer'),answer=reply.locator('.answer-body');
    assert.doesNotMatch(await answer.textContent(),/幕后|scene_build|secret-state|long_note/);
    assert.match(await answer.textContent(),/雨仍在下/);assert.match(await answer.textContent(),/你准备去哪里/);
    assert.equal(await reply.locator('.reasoning-toggle').getAttribute('aria-expanded'),'false');
    assert.equal(await reply.locator('.model-notes').isVisible(),false);
    await reply.locator('.reasoning-toggle').click();
    assert.match(await reply.locator('.model-notes').textContent(),/模型生成/);
    assert.match(await reply.locator('.model-notes').textContent(),/scene_build/);
    assert.equal(await reply.locator('.tool-event').count(),1,'Only the real tool call gets an event row');
    assert.equal(await reply.locator('.model-notes img, .model-notes script').count(),0);
    for(const width of [1280,320]){
      await page.setViewportSize({width,height:width===320?740:900});
      if(width===320)await page.waitForFunction(()=>document.querySelector('#sidebar').getBoundingClientRect().right<=0);
      const sizes=await reply.locator('.reasoning-body').evaluate(el=>({scroll:el.scrollWidth,client:el.clientWidth}));
      assert.ok(sizes.scroll<=sizes.client,JSON.stringify(sizes));
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await reply.scrollIntoViewIfNeeded();
      const screenshot=path.join(os.tmpdir(),'luma-backstage-'+width+'-'+process.pid+'.png');
      await page.screenshot({path:screenshot,fullPage:true});console.log('Backstage screenshot: '+screenshot);
    }
    await page.setViewportSize({width:1280,height:900});
    await reply.getByRole('button',{name:'复制回答',exact:true}).click();
    const copied=await page.evaluate(()=>navigator.clipboard.readText());
    assert.match(copied,/雨仍在下/);assert.doesNotMatch(copied,/幕后|secret-state/);
    await page.locator('#chat-menu-button').click();
    const downloaded=page.waitForEvent('download');await page.locator('[data-chat-action="export"]').click();
    const download=await downloaded;
    const exported=fs.readFileSync(await download.path(),'utf8');
    assert.match(exported,/雨仍在下/);assert.doesNotMatch(exported,/secret-state|scene_build/);
    assert.equal(store.getSession('backstage').messages[1].content,raw);
    assert.equal(store.getSession('backstage').apiMessages[0].content,raw);
    await page.reload();await page.waitForFunction(()=>document.querySelector('#backend-state').textContent==='已连接');
    assert.equal(await reply.locator('.reasoning-toggle').getAttribute('aria-expanded'),'false');
    assert.doesNotMatch(await answer.textContent(),/secret-state/);

    await page.locator('#new-chat').click();await page.locator('#message-input').fill('继续');await page.locator('#send-button').click();await started;
    emit('新正文\n⟨幕');
    await page.waitForFunction(()=>document.querySelector('.answer-body')?.textContent.includes('新正文'));
    assert.doesNotMatch(await page.locator('.answer-body').textContent(),/⟨|幕/);
    emit('后⟩\nstreamed-state\n⟨/幕');
    await page.locator('.model-notes').waitFor({state:'attached'});
    assert.equal(await page.locator('.model-notes').isVisible(),false);
    assert.doesNotMatch(await page.locator('.answer-body').textContent(),/streamed-state|幕/);
    await page.locator('.reasoning-toggle').click();
    assert.doesNotMatch(await page.locator('.model-notes').textContent(),/⟨\/幕/);
    emit('后⟩\n后续正文',true);
    await page.waitForFunction(()=>!document.querySelector('#message-input').disabled);
    assert.match(await page.locator('.answer-body').textContent(),/后续正文/);
    assert.doesNotMatch(await page.locator('.answer-body').textContent(),/streamed-state/);
    assert.equal(await page.locator('.reasoning-toggle').getAttribute('aria-expanded'),'true');
    assert.equal(await page.locator('.tool-event').count(),0,'Model notes do not become tool events');
    const saved=store.listSessions().find(s=>s.id!=='backstage');
    assert.match(saved.messages.at(-1).content,/⟨幕后⟩\nstreamed-state/);
    assert.match(saved.apiMessages.at(-1).content,/streamed-state/);
    assert.deepEqual(errors,[]);
  });

test('browser: stored process details stay folded and fit long content',
  { skip: !chromium && 'Install Playwright to run browser integration checks', timeout: 20000 }, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-conversation-layout-'));
    const service = createService({ store: new Store(directory), token: 'layout-test-token',
      fetchImpl: async () => { throw new Error('Layout tests must not call upstream APIs'); } });
    await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ channel: process.env.LUMA_TEST_BROWSER || 'chrome', headless: true });
    t.after(async () => {
      await browser.close();
      await service.close();
      fs.rmSync(directory, { recursive: true, force: true });
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(4000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/bootstrap', route => route.fulfill({ status: 403,
      contentType: 'application/json', body: '{"error":"Layout fixture"}' }));
    await page.route('https://**/*', route => route.abort());
    const sources = Array.from({ length: 8 }, (_, index) => ({
      title: index ? '来源标题'.repeat(80) : '<img src=x onerror=alert(1)>',
      url: 'https://example.com/source-' + index
    }));
    sources.push({ title: 'Unsafe source', url: 'javascript:alert(1)' });
    const message = (id, fields) => ({ id, role: 'assistant', status: 'done', content: '这是排版验证的示例回答。', ...fields });
    const session = { id: 'layout', title: '过程布局检查', apiMessages: [], createdAt: 1, updatedAt: 1, messages: [
      { id: 'question', role: 'user', content: '查询天气并整理可核实的参考来源。' },
      message('combined', { seconds: 2, reasoning: '先核对查询地点与时间，再检查资料的相关性。\n\n'.repeat(30),
        tools: [
          { name: 'get_current_time', state: '已完成' },
          { name: 'web_search', state: '已完成' },
          { name: 'web_fetch', state: '执行失败' }
        ], sources, error: '测试错误：一个来源暂时不可用。' }),
      message('source-only', { sources: [sources[1]] }),
      message('tool-only', { tools: [{ name: 'web_search', state: '已完成' }] }),
      message('reason-only', { reasoning: 'Only a reasoning paragraph.' }),
      message('plain', {})
    ] };
    await page.addInitScript(chat => {
      localStorage.setItem('luma.chats', JSON.stringify([chat]));
      localStorage.setItem('luma.active', JSON.stringify(chat.id));
      sessionStorage.setItem('luma.keys', JSON.stringify({ apiKey: 'layout-test-key' }));
    }, session);
    await page.goto('http://127.0.0.1:' + service.server.address().port);
    for (const id of ['combined', 'source-only', 'tool-only', 'reason-only']) {
      const reply = page.locator('#msg-' + id);
      assert.equal(await reply.locator('.reasoning-toggle').getAttribute('aria-expanded'), 'false');
      assert.equal(await reply.locator('.reasoning-body').isVisible(), false);
      assert.equal(await reply.locator('.answer-body').isVisible(), true);
      assert.equal(await reply.locator(':scope > .assistant-content > .tool-event, :scope > .assistant-content > .sources').count(), 0);
    }
    assert.equal(await page.locator('#msg-plain .reasoning').count(), 0);
    assert.equal(await page.locator('#msg-combined .error-card').isVisible(), true, 'Errors must not be hidden with optional process details');
    const toggle = page.locator('#msg-combined .reasoning-toggle');
    await toggle.focus();
    await toggle.press('Enter');
    const body = page.locator('#msg-combined .reasoning-body');
    assert.equal(await body.isVisible(), true);
    assert.equal(await body.locator('.sources a').count(), 8, 'Unsafe source URLs are excluded');
    assert.equal(await body.locator('img, script').count(), 0, 'Source titles render as text');
    assert.equal(await body.evaluate(element => element.scrollHeight > element.clientHeight), true, 'Long details scroll inside the process area');
    for (const width of [1440, 320]) {
      await page.setViewportSize({ width, height: width === 320 ? 740 : 1000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const widths = await body.evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth,
        overflow: [...element.querySelectorAll('*')].filter(child => child.getBoundingClientRect().right > element.getBoundingClientRect().right + 1)
          .map(child => ({ name: child.className, client: child.clientWidth, scroll: child.scrollWidth, right: child.getBoundingClientRect().right })) }));
      assert.ok(widths.scroll <= widths.client, 'Long text and source links must not overflow: ' + JSON.stringify(widths));
      await body.evaluate(element => { element.scrollTop = element.scrollHeight; });
      await page.locator('#chat-scroll').evaluate(element => { element.scrollTop = 0; });
      const screenshot = path.join(os.tmpdir(), 'luma-process-long-' + width + '-' + process.pid + '.png');
      await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled' });
      console.log('Long process screenshot: ' + screenshot);
    }
    await toggle.focus();
    await toggle.press('Space');
    assert.equal(await body.isVisible(), false);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');

    await page.evaluate(() => {
      const originalFetch = window.fetch;
      window.fetch = (url, init) => {
        if (!String(url).endsWith('/chat/completions')) return originalFetch.call(window, url, init);
        const stream = new ReadableStream({ start(controller) {
          const encoder = new TextEncoder();
          window.emitTestDelta = (delta, done = false) => {
            controller.enqueue(encoder.encode('data: ' + JSON.stringify({ choices: [{ index: 0, delta,
              finish_reason: done ? 'stop' : null }] }) + '\n\n'));
            if (done) { controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); }
          };
        } });
        return Promise.resolve(new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }));
      };
    });
    await page.locator('#mobile-menu').click();
    await page.locator('#new-chat').click();
    await page.locator('#message-input').fill('Stream a long process');
    await page.locator('#send-button').click();
    await page.waitForFunction(() => typeof window.emitTestDelta === 'function');
    await page.evaluate(() => window.emitTestDelta({ reasoning_content: 'A line of streaming process details.\n'.repeat(100) }));
    await page.locator('.reasoning-toggle').click();
    const streamingBody = page.locator('.reasoning-body');
    await streamingBody.evaluate(element => { element.scrollTop = 200; });
    await page.evaluate(() => window.emitTestDelta({ reasoning_content: 'Another process line.' }));
    await page.waitForFunction(() => document.querySelector('.reasoning-text')?.textContent.includes('Another process line.'));
    assert.equal(await streamingBody.evaluate(element => element.scrollTop), 200, 'Reasoning deltas preserve the reader position');
    await page.evaluate(() => window.emitTestDelta({ content: 'First answer chunk.' }));
    await page.waitForFunction(() => document.querySelector('.answer-body')?.textContent.includes('First answer chunk.'));
    assert.equal(await streamingBody.evaluate(element => element.scrollTop), 200, 'Answer deltas preserve the process scroll');
    await page.evaluate(() => window.emitTestDelta({ content: ' Final answer chunk.' }, true));
    await page.waitForFunction(() => !document.querySelector('#message-input').disabled);
    assert.equal(await streamingBody.evaluate(element => element.scrollTop), 200, 'Final rendering preserves the process scroll');
    assert.equal(await page.locator('.reasoning-toggle').getAttribute('aria-expanded'), 'true');
    assert.deepEqual(errors, []);
  });
