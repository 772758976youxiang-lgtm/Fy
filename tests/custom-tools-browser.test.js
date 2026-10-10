'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../storage');
const {createService}=require('../server');
let chromium;try{({chromium}=require('playwright'));}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}
const completion=(delta,finish='stop')=>new Response('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:finish}]})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});

test('browser tool duplication: independent saved copy, busy state, errors, closing and mobile layout',
 {skip:!chromium,timeout:40000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'luma-duplicate-browser-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const store=new Store(dir);
 const source=store.saveTool({name:'weather_helper',label:'天气查询助手',kind:'llm',enabled:true,
  config:{url:'https://example.test/chat/completions',model:'test-model',effort:'high',systemPrompt:'Keep instructions'},
  apiKey:'duplicate-private-key',rememberKey:true});
 const before=store.getTool(source.id);let upstreamCalls=0;
 const service=createService({store,fetchImpl:async()=>{upstreamCalls++;throw new Error('No tool execution expected');}});
 await new Promise(r=>service.server.listen(0,'127.0.0.1',r));t.after(()=>service.close());
 const browser=await chromium.launch({channel:process.env.LUMA_TEST_BROWSER||'chrome',headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(5000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:'+service.server.address().port);
 await page.waitForFunction(()=>document.querySelector('#backend-state').textContent==='已连接');
 await page.locator('#settings-button').click();await page.locator('[data-tab="tools"]').click();
 const copyButton=page.getByRole('button',{name:'复制 天气查询助手',exact:true});
 await copyButton.waitFor();
 assert.equal(await copyButton.getAttribute('title'),'复制 天气查询助手');
 assert.equal(await copyButton.locator('use').getAttribute('href'),'#i-copy');
 for(const width of [1280,320]){
  await page.setViewportSize({width,height:width===320?740:900});await page.locator('.tm-item').scrollIntoViewIfNeeded();
  const bounds=await page.locator('.tm-item').evaluate(row=>{
   const r=row.getBoundingClientRect(),info=row.querySelector('.tm-item-info').getBoundingClientRect();
   const buttons=[...row.querySelectorAll('button')].map(x=>x.getBoundingClientRect());
   return {fits:buttons.every(b=>b.left>=r.left&&b.right<=r.right+1),separate:info.right<=buttons[0].left,
    noOverlap:buttons.every((b,i)=>!i||buttons[i-1].right<=b.left)};
  });
  assert.deepEqual(bounds,{fits:true,separate:true,noOverlap:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  const file=path.join(os.tmpdir(),'luma-duplicate-'+width+'-'+process.pid+'.png');
  await page.screenshot({path:file});console.log('Duplicate tool screenshot: '+file);
 }
 await page.setViewportSize({width:1280,height:900});
 const responsePromise=page.waitForResponse(r=>r.url().endsWith('/'+source.id+'/duplicate'));
 await copyButton.click();
 const response=await responsePromise;
 assert.equal(response.status(),200);
 assert.doesNotMatch(await response.text(),/duplicate-private-key|"apiKey":/);
 await page.getByLabel('显示名称',{exact:true}).waitFor();
 assert.equal(await page.getByLabel('显示名称',{exact:true}).inputValue(),'天气查询助手（副本）');
 assert.equal(await page.getByLabel('工具名称',{exact:true}).inputValue(),'weather_helper_copy');
 assert.equal(await page.getByLabel('启用工具',{exact:true}).isChecked(),false);
 assert.equal(await page.getByLabel('API Key',{exact:true}).inputValue(),'');
 assert.match(await page.getByLabel('API Key',{exact:true}).getAttribute('placeholder'),/已配置/);
 assert.equal(await page.getByLabel('记住密钥（本机，未加密）').isChecked(),true);
 assert.equal(await page.locator('#custom-tool-manager').getByLabel('思考强度',{exact:true}).inputValue(),'high');
 assert.match(await page.locator('#custom-tool-manager [data-message]').textContent(),/副本已创建/);
 const duplicate=store.listTools().find(tool=>tool.id!==source.id);
 assert.ok(duplicate);
 assert.equal(store.getTool(duplicate.id).apiKey,'duplicate-private-key');
 await page.getByRole('button',{name:'取消编辑',exact:true}).last().click();
 assert.equal(store.listTools().length,2,'Cancel only discards edits, not the saved copy');
 await page.getByRole('button',{name:'编辑 天气查询助手（副本）',exact:true}).click();
 await page.getByLabel('显示名称',{exact:true}).fill('独立副本');
 await page.getByLabel('模型',{exact:true}).fill('changed-model');
 await page.getByRole('button',{name:'保存工具',exact:true}).click();
 await page.getByRole('button',{name:'编辑 独立副本',exact:true}).waitFor();
 assert.deepEqual(store.getTool(source.id),before);
 assert.equal(store.getTool(duplicate.id).config.model,'changed-model');
 assert.equal(new Store(dir).getTool(duplicate.id).apiKey,'duplicate-private-key');

 const pattern='**/api/custom-tools/*/duplicate';let release,requests=0;
 t.after(()=>release?.());
 let started;const requestStarted=new Promise(resolve=>{started=resolve;});
 const delayed=async route=>{requests++;await new Promise(resolve=>{release=resolve;started();});await route.continue();};
 await page.route(pattern,delayed);
 await copyButton.evaluate(button=>{button.click();button.click();});
 await page.waitForFunction(()=>document.querySelector('#custom-tool-manager').getAttribute('aria-busy')==='true');
 assert.equal(await copyButton.isDisabled(),true);
 await requestStarted;
 assert.equal(requests,1);
 release();
 await page.getByLabel('显示名称',{exact:true}).waitFor();
 assert.equal(await page.getByLabel('工具名称',{exact:true}).inputValue(),'weather_helper_copy_2');
 await page.getByRole('button',{name:'取消编辑',exact:true}).last().click();
 await page.unroute(pattern,delayed);

 await page.route(pattern,route=>route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'复制保存失败'})}));
 await copyButton.click();
 await page.locator('#custom-tool-manager [role="alert"]').waitFor();
 assert.match(await page.locator('#custom-tool-manager [role="alert"]').textContent(),/复制保存失败/);
 assert.equal(store.listTools().length,3);
 assert.equal(await copyButton.isEnabled(),true);
 await page.unroute(pattern);

 let reached;
 const pending=new Promise(resolve=>{reached=resolve;});
 await page.route(pattern,async route=>{await new Promise(resolve=>{release=resolve;reached();});await route.continue();});
 const lateResponse=page.waitForResponse(r=>r.url().endsWith('/duplicate'));
 await copyButton.click();await pending;
 await page.locator('#settings-close').click();release();await lateResponse;
 assert.equal(await page.locator('#custom-tool-manager [data-field]').count(),0);
 await page.locator('#settings-button').click();await page.locator('[data-tab="tools"]').click();
 await page.getByRole('button',{name:'编辑 天气查询助手（副本 3）',exact:true}).waitFor();
 assert.equal(await page.locator('#custom-tool-manager [data-field]').count(),0);
 assert.deepEqual(store.getTool(source.id),before);
 assert.equal(store.listTools().length,4);
 assert.equal(upstreamCalls,0);
 await page.locator('[data-tab="api"]').click();await page.locator('#disconnect-backend').click();
 await page.locator('[data-tab="tools"]').click();
 assert.equal(await page.locator('#custom-tool-manager [data-action="duplicate"]').count(),0);
 assert.match(await page.locator('#custom-tool-manager').textContent(),/未连接/);
 assert.deepEqual(errors,[]);
});

test('browser custom approval: allow/deny, fixed snapshot, folded media and settings manager',
 {skip:!chromium,timeout:40000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'luma-custom-browser-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const store=new Store(dir);store.saveSettings({apiKey:'main-test',toolsEnabled:true,searchEnabled:false});
 const saved=store.saveTool({name:'make_picture',label:'图片生成',description:'Generate picture',kind:'image',requireConfirmation:true,parameters:[{name:'prompt',type:'string',required:true}],config:{url:'https://image.luma.test/create',body:{prompt:'{{args.prompt}}'},resultPath:'url',output:'image'},apiKey:'private-image-key'});
 const calls=[];let finishAnswer; t.after(()=>finishAnswer?.());const service=createService({store,fetchImpl:async(url,init)=>{
  if(url.startsWith('https://image.luma.test')){calls.push({url,init});return Response.json({url:'https://media.luma.test/result.png'});}
  const messages=JSON.parse(init.body).messages,lastUser=messages.findLastIndex(m=>m.role==='user');
  if(messages.slice(lastUser).some(m=>m.role==='tool')){
   if(!calls.length)return completion({content:'处理完成'});
   return new Response(new ReadableStream({start(controller){const encoder=new TextEncoder();controller.enqueue(encoder.encode('data: '+JSON.stringify({choices:[{index:0,delta:{content:'正在整理结果'},finish_reason:null}]})+'\n\n'));let done=false;finishAnswer=()=>{if(done)return;done=true;controller.enqueue(encoder.encode('data: '+JSON.stringify({choices:[{index:0,delta:{content:'，处理完成'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n'));controller.close();};}}),{headers:{'Content-Type':'text/event-stream'}});
  }
  return completion({reasoning_content:'Reviewing the requested generation.\n'.repeat(100),tool_calls:[{index:0,id:'picture-call',type:'function',function:{name:'make_picture',arguments:JSON.stringify({prompt:'A white cup <script>literal</script>'})}}]},'tool_calls');
 }});await new Promise(r=>service.server.listen(0,'127.0.0.1',r));t.after(()=>service.close());
 const browser=await chromium.launch({channel:process.env.LUMA_TEST_BROWSER||'chrome',headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(8000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://media.luma.test/result.png',route=>route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64')}));
 await page.goto('http://127.0.0.1:'+service.server.address().port);await page.waitForFunction(()=>document.querySelector('#backend-state').textContent==='已连接');
 await page.locator('#settings-button').click();await page.locator('[data-tab="tools"]').click();
 await page.locator('#custom-tool-manager strong').getByText('图片生成',{exact:true}).waitFor();
 assert.equal(await page.locator('#settings-save').isVisible(),false);
 await page.getByRole('button',{name:'添加工具',exact:true}).click();
 await page.getByLabel('显示名称',{exact:true}).fill('文本评审');
 await page.getByLabel('工具名称',{exact:true}).fill('text_review');
 await page.getByLabel('工具说明',{exact:true}).fill('检查文本质量并给出建议');
 await page.getByLabel('接口地址',{exact:true}).fill('https://review.luma.test/v1/chat/completions');
 await page.getByLabel('模型',{exact:true}).fill('review-model');
 await page.getByLabel('API Key',{exact:true}).fill('review-private-key');
 for(const width of [1280,320]){
  await page.setViewportSize({width,height:width===320?740:900});await page.locator('.settings-content').evaluate(x=>{x.scrollTop=0;});
  const file=path.join(os.tmpdir(),'luma-tools-live-'+width+'-'+process.pid+'.png');await page.screenshot({path:file});console.log('Connected tool editor screenshot: '+file);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 }
 await page.getByRole('button',{name:'保存工具',exact:true}).click();await page.getByRole('button',{name:'编辑 文本评审',exact:true}).waitFor();
 const review=store.listTools().find(x=>x.name==='text_review');assert.equal(review.hasApiKey,true);assert.doesNotMatch(JSON.stringify(review),/review-private-key/);
 await page.getByRole('button',{name:'删除 文本评审',exact:true}).click();await page.getByRole('button',{name:'确认删除',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('[aria-label="编辑 文本评审"]'));
 assert.equal(store.listTools().length,1);await page.setViewportSize({width:1280,height:900});
 await page.locator('#settings-cancel').click();
 const send=async()=>{await page.locator('#message-input').fill('生成图片');await page.locator('#send-button').click();await page.locator('[data-allow="true"]').waitFor();};
 await send();assert.equal(calls.length,0);assert.equal(await page.locator('.reasoning-toggle').getAttribute('aria-expanded'),'true');
 const bounds=await page.locator('[data-allow="true"]').evaluate(button=>{const r=button.getBoundingClientRect(),parent=button.closest('.reasoning-body'),p=parent.getBoundingClientRect();return {top:r.top,bottom:r.bottom,parentTop:p.top,parentBottom:p.bottom,scroll:parent.scrollTop};});
 assert.ok(bounds.top>=bounds.parentTop&&bounds.bottom<=bounds.parentBottom+1,'New approval must be visible even after long reasoning: '+JSON.stringify(bounds));
 assert.match(await page.locator('.tool-approval pre').textContent(),/<script>literal<\/script>/);assert.equal(await page.locator('.tool-approval script').count(),0);
 assert.doesNotMatch(await page.locator('#messages').textContent(),/private-image-key/);
 await page.locator('[data-allow="false"]').click();await page.waitForFunction(()=>!document.querySelector('#message-input').disabled);assert.equal(calls.length,0);
 await send();store.saveTool({...saved,config:{...saved.config,url:'https://changed.luma.test/create'},apiKey:'changed-key'});
 await page.locator('[data-allow="true"]').click();await page.waitForFunction(()=>[...document.querySelectorAll('.answer-body')].some(x=>x.textContent.includes('正在整理结果')));
 await page.locator('.tool-result summary').last().click();assert.equal(await page.locator('.tool-result').last().evaluate(x=>x.open),true);
 finishAnswer();await page.waitForFunction(()=>!document.querySelector('#message-input').disabled);
 assert.equal(await page.locator('.tool-result').last().evaluate(x=>x.open),true,'Streaming should preserve expanded tool results');
 assert.equal(calls.length,1);assert.equal(calls[0].url,'https://image.luma.test/create');assert.equal(new Headers(calls[0].init.headers).get('Authorization'),'Bearer private-image-key');
 assert.equal(await page.locator('.tool-artifact img').count(),1);assert.equal(await page.locator('.answer-body .tool-artifact').count(),0);
 await page.reload();await page.waitForFunction(()=>document.querySelector('#backend-state').textContent==='已连接');
 assert.equal(await page.locator('[data-approval-id]').count(),0);assert.equal(await page.locator('.tool-artifact img').isVisible(),false);
 await page.setViewportSize({width:320,height:700});await page.locator('.reasoning-toggle').last().click();
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
});
