'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../storage');
const {createService}=require('../server');
let chromium;try{({chromium}=require('playwright'));}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}

const candidate={name:'image_helper',label:'图像助手',description:'根据文字生成图像',kind:'image',parameters:[{name:'prompt',type:'string',description:'画面描述',required:true}],config:{url:'https://images.example.test/create',model:'image-model',body:{model:'{{config.model}}',prompt:'{{args.prompt}}'},resultPath:'data.0.url',output:'image'}};
const response=(tool=candidate)=>Response.json({choices:[{message:{content:JSON.stringify(tool)},finish_reason:'stop'}]});
async function fixture(t,upstream){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'luma-authoring-browser-'));
 const store=new Store(dir);store.saveSettings({baseURL:'https://model.example.test',apiKey:'main-test-key',model:'deepseek-flash',effort:'high'});
 const service=createService({store,fetchImpl:upstream});await new Promise(r=>service.server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({channel:process.env.LUMA_TEST_BROWSER||'chrome',headless:true});const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(6000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 t.after(async()=>{await browser.close();await service.close();fs.rmSync(dir,{recursive:true,force:true});assert.deepEqual(errors,[]);});
 await page.goto('http://127.0.0.1:'+service.server.address().port);await page.waitForFunction(()=>document.querySelector('#backend-state').textContent==='已连接');
 await page.locator('#settings-button').click();assert.equal(await page.locator('#tool-authoring-button').isVisible(),false);
 await page.locator('[data-tab="tools"]').click();await page.getByRole('button',{name:'添加工具',exact:true}).waitFor();
 return {page,store};
}

test('AI authoring previews complete configuration, preserves keys and applies without saving', {skip:!chromium,timeout:30000},async t=>{
 const calls=[];const {page,store}=await fixture(t,async(url,init)=>{calls.push({url,payload:JSON.parse(init.body)});return response();});
 let outbound;
 page.on('request',r=>{if(r.url().endsWith('/api/custom-tools/generate'))outbound=r.postData();});
 await page.getByRole('button',{name:'添加工具',exact:true}).click();
 await page.getByLabel('显示名称',{exact:true}).fill('保留的旧名称');await page.getByLabel('API Key',{exact:true}).fill('tool-private-browser-key');
 await page.locator('#tool-authoring-button').click();
 await page.getByLabel('创作需求与接口文档',{exact:true}).fill('生成一个图像工具，接口为 https://images.example.test/create，模型为 image-model');
 await page.getByRole('button',{name:'生成配置',exact:true}).click();
 await page.getByRole('button',{name:'应用到表单',exact:true}).waitFor();
 assert.equal(await page.getByLabel('显示名称',{exact:true}).inputValue(),'保留的旧名称');
 assert.equal(await page.getByLabel('API Key',{exact:true}).inputValue(),'tool-private-browser-key');
 assert.equal(store.listTools().length,0);assert.equal(store.listSessions().length,0);assert.equal(calls.length,1);
 assert.doesNotMatch(outbound,/tool-private-browser-key/);assert.doesNotMatch(JSON.stringify(calls[0].payload),/tool-private-browser-key/);assert.equal(calls[0].payload.tools,undefined);
 for(const width of [1280,320]){
  await page.setViewportSize({width,height:width===320?740:900});await page.locator('.settings-content').evaluate(x=>{x.scrollTop=0;});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  const header=await page.locator('.settings-header').evaluate(x=>{const buttons=[...x.querySelectorAll('button')].filter(b=>!b.hidden);return buttons.every(b=>b.getBoundingClientRect().right<=x.getBoundingClientRect().right);});assert.equal(header,true);
  const file=path.join(os.tmpdir(),'luma-ai-tool-'+width+'-'+process.pid+'.png');await page.screenshot({path:file});console.log('AI authoring screenshot: '+file);
 }
 await page.getByRole('button',{name:'应用到表单',exact:true}).click();
 assert.equal(await page.getByLabel('工具名称',{exact:true}).inputValue(),'image_helper');assert.equal(await page.getByLabel('API Key',{exact:true}).inputValue(),'tool-private-browser-key');
 assert.equal(store.listTools().length,0);assert.match(await page.locator('#custom-tool-manager [data-message]').textContent(),/尚未保存/);
 await page.getByRole('button',{name:'保存工具',exact:true}).click();await page.getByRole('button',{name:'编辑 图像助手',exact:true}).waitFor();
 assert.equal(store.listTools().length,1);assert.equal(store.getTools()[0].apiKey,'tool-private-browser-key');assert.equal(calls.length,1);
});

test('AI authoring handles missing fields, errors, stale form changes and cancellation', {skip:!chromium,timeout:30000},async t=>{
 let count=0,aborted=false;
 let startWaiting,stopWaiting;
 const waitingStarted=new Promise(resolve=>{startWaiting=resolve;});
 const waitingStopped=new Promise(resolve=>{stopWaiting=resolve;});
 const {page,store}=await fixture(t,async(url,init)=>{
  count++;
  if(count===1)return Response.json({error:{message:'Temporary provider failure'}},{status:503});
  if(count===2)return response({...candidate,config:{...candidate.config,url:'',model:''}});
  if(count===3)return response();
  startWaiting();
  return new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>{aborted=true;stopWaiting();reject(init.signal.reason);},{once:true}));
 });
 await page.locator('#tool-authoring-button').click();await page.getByLabel('创作需求与接口文档',{exact:true}).fill('创建一个生图工具');
 await page.getByRole('button',{name:'生成配置',exact:true}).click();await page.locator('[data-authoring-error]').filter({hasText:'Temporary'}).waitFor();
 assert.equal(await page.getByRole('button',{name:'应用到表单',exact:true}).count(),0);
 await page.getByRole('button',{name:'生成配置',exact:true}).click();await page.getByRole('button',{name:'应用到表单',exact:true}).waitFor();
 assert.match(await page.locator('[data-authoring-missing]').textContent(),/接口地址/);
 await page.getByLabel('显示名称',{exact:true}).fill('手动修改');await page.getByRole('button',{name:'应用到表单',exact:true}).click();
 assert.match(await page.locator('[data-authoring-error]').textContent(),/表单已更改/);assert.equal(await page.getByLabel('显示名称',{exact:true}).inputValue(),'手动修改');
 await page.getByRole('button',{name:'生成配置',exact:true}).click();await page.getByRole('button',{name:'应用到表单',exact:true}).waitFor();
 await page.getByRole('button',{name:'放弃草稿',exact:true}).click();assert.equal(await page.getByLabel('显示名称',{exact:true}).inputValue(),'手动修改');
 await page.getByRole('button',{name:'生成配置',exact:true}).click();await page.getByRole('button',{name:'停止生成配置',exact:true}).waitFor();
 await waitingStarted;
 await page.getByRole('button',{name:'停止生成配置',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('[data-authoring-generate]').disabled);
 await waitingStopped;assert.equal(aborted,true);assert.equal(store.listTools().length,0);
 await page.getByRole('button',{name:'生成配置',exact:true}).click();await page.getByRole('button',{name:'停止生成配置',exact:true}).waitFor();
 await page.locator('#settings-close').click();await page.locator('#settings-button').click();await page.locator('[data-tab="tools"]').click();
 assert.equal(await page.locator('[data-authoring-preview]').count(),0);assert.equal(store.listTools().length,0);
});

test('AI authoring highlights missing fields after apply and renders model text safely', {skip:!chromium,timeout:20000},async t=>{
 const tool={...candidate,label:'<img src=x onerror=alert(1)>',config:{...candidate.config,url:'',model:''}};
 const {page,store}=await fixture(t,async()=>response(tool));
 await page.locator('#tool-authoring-button').click();
 await page.getByLabel('创作需求与接口文档',{exact:true}).fill('创建一个图像工具，接口和模型待补充');
 await page.getByRole('button',{name:'生成配置',exact:true}).click();
 await page.getByRole('button',{name:'应用到表单',exact:true}).waitFor();
 assert.equal(await page.locator('[data-authoring-preview] img').count(),0);
 assert.match(await page.locator('[data-authoring-preview]').textContent(),/<img src=x/);
 await page.getByRole('button',{name:'应用到表单',exact:true}).click();
 assert.equal(await page.getByLabel('接口地址',{exact:true}).inputValue(),'');
 assert.equal(await page.getByLabel('接口地址',{exact:true}).getAttribute('aria-invalid'),'true');
 assert.match(await page.locator('#custom-tool-manager [data-message]').textContent(),/待补充/);
 assert.equal(store.listTools().length,0);
});

test('AI authoring is blocked while the current tool is running', {skip:!chromium,timeout:20000},async t=>{
 const {page}=await fixture(t,async()=>response());
 let release,started;
 const ready=new Promise(resolve=>{started=resolve;});
 await page.route('**/api/custom-tools/test',async route=>{
  await new Promise(resolve=>{release=resolve;started();});
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({output:'done'})});
 });
 await page.getByRole('button',{name:'添加工具',exact:true}).click();
 await page.getByLabel('工具名称',{exact:true}).fill('original_tool');
 await page.getByLabel('接口地址',{exact:true}).fill('https://tools.example.test');
 await page.getByLabel('模型',{exact:true}).fill('test-model');
 await page.getByLabel('试运行参数',{exact:true}).fill('{"prompt":"hello"}');
 await page.locator('#tool-authoring-button').click();
 await page.getByLabel('创作需求与接口文档',{exact:true}).fill('改为图像工具');
 await page.getByRole('button',{name:'生成配置',exact:true}).click();
 await page.getByRole('button',{name:'应用到表单',exact:true}).waitFor();
 await page.getByRole('button',{name:'试运行',exact:true}).click();
 await ready;
 try{
  await page.waitForFunction(()=>document.querySelector('#custom-tool-manager').getAttribute('aria-busy')==='true');
  assert.equal(await page.getByRole('button',{name:'生成配置',exact:true}).isDisabled(),true);
  assert.equal(await page.getByRole('button',{name:'应用到表单',exact:true}).isDisabled(),true);
 }finally{release?.();}
 await page.waitForFunction(()=>document.querySelector('#custom-tool-manager').getAttribute('aria-busy')==='false');
 assert.equal(await page.getByRole('button',{name:'应用到表单',exact:true}).isEnabled(),true);
});

test('AI generated HTTP tools expose fixed model fields referenced by templates', {skip:!chromium,timeout:20000},async t=>{
 const tool={...candidate,kind:'http',config:{...candidate.config,model:'',effort:'high',systemPrompt:'Summarize',body:{model:'{{config.model}}',effort:'{{config.effort}}',instruction:'{{config.systemPrompt}}',input:'{{args.prompt}}'}}};
 const {page}=await fixture(t,async()=>response(tool));
 await page.locator('#tool-authoring-button').click();
 await page.getByLabel('创作需求与接口文档',{exact:true}).fill('生成 HTTP 模型调用配置');
 await page.getByRole('button',{name:'生成配置',exact:true}).click();
 await page.getByRole('button',{name:'应用到表单',exact:true}).click();
 assert.equal(await page.getByLabel('模型',{exact:true}).count(),1);
 assert.equal(await page.getByLabel('模型',{exact:true}).getAttribute('aria-invalid'),'true');
 assert.equal(await page.locator('#custom-tool-manager').getByLabel('系统提示词',{exact:true}).inputValue(),'Summarize');
 await page.getByLabel('模型',{exact:true}).fill('actual-model');
 assert.equal(await page.getByLabel('模型',{exact:true}).getAttribute('aria-invalid'),null);
});
