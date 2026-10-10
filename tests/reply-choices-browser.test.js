'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {setTimeout:delay}=require('node:timers/promises');
const {Store}=require('../storage');
const {createService}=require('../server');
let chromium;
try{({chromium}=require('playwright'));}catch(error){if(error.code!=='MODULE_NOT_FOUND')throw error;}

const raw='雨仍在下。手机上的倒计时还剩两分钟。\n\n**你要做什么？** 直接说就行，也可以从下面挑：\n\n- **接。** 上坡，去德平路 21 号，看看那扇卷帘门后面是什么。\n- **先不接。** 趁这两分钟，向何雨再打听打听“老周”。\n- **放过去。** 关掉屏幕，等系统转派，今晚就当没看见这单。\n\n（或任何列表之外的事。）';
const next='你走到了街角。\n\n可选行动：\n- 查看门牌。\n- 回到便利店。';
const last='你决定继续等一会儿。\n\n可选行动：\n- 打开地图。\n- 询问路人。';
const session={id:'choices',title:'行动选项测试',createdAt:1,updatedAt:1,
  messages:[{id:'u1',role:'user',content:'开始'},
    {id:'old',role:'assistant',status:'done',content:'之前的剧情。\n\n可选行动：\n- 旧选项甲\n- 旧选项乙'},
    {id:'u2',role:'user',content:'继续'},
    {id:'latest',role:'assistant',status:'done',content:raw}],
  apiMessages:[{role:'user',content:'开始'},{role:'assistant',content:raw}]};

for(const mode of ['backend','direct'])test('browser: '+mode+' choices send once and disappear after one round or a new chat',
  {skip:!chromium,timeout:35000},async t=>{
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'luma-reply-choices-'));
    const store=new Store(directory);store.saveSettings({apiKey:'fake-choices-key'});
    if(mode==='backend')store.putSession(session);
    const calls=[];
    const service=createService({store,fetchImpl:async(url,init)=>{
      assert.equal(mode,'backend');
      const call={body:JSON.parse(init.body)};calls.push(call);
      return new Response(new ReadableStream({start(controller){call.controller=controller;}}),{headers:{'Content-Type':'text/event-stream'}});
    }});
    await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
    const browser=await chromium.launch({channel:process.env.LUMA_TEST_BROWSER||'chrome',headless:true});
    t.after(async()=>{await browser.close();await service.close();fs.rmSync(directory,{recursive:true,force:true});});
    const page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'});page.setDefaultTimeout(4000);
    const base='http://127.0.0.1:'+service.server.address().port,errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin:base});
    await page.route('https://**/*',route=>route.abort());
    if(mode==='direct'){
      await page.route('**/api/bootstrap',route=>route.fulfill({status:403,contentType:'application/json',body:'{"error":"Direct fixture"}'}));
      await page.addInitScript(chat=>{
        if(!localStorage.getItem('choice-test-seeded')){
          localStorage.setItem('luma.chats',JSON.stringify([chat]));localStorage.setItem('luma.active',JSON.stringify(chat.id));
          localStorage.setItem('choice-test-seeded','true');
        }
        sessionStorage.setItem('luma.keys',JSON.stringify({apiKey:'fake-choices-key'}));
        const original=window.fetch;window.choiceRequests=[];
        window.fetch=(url,init)=>{
          if(!String(url).endsWith('/chat/completions'))return original(url,init);
          const call={body:JSON.parse(init.body)};window.choiceRequests.push(call);
          return Promise.resolve(new Response(new ReadableStream({start(controller){call.controller=controller;}}),{headers:{'Content-Type':'text/event-stream'}}));
        };
      },session);
    }
    async function emit(content,done=false){
      const chunk='data: '+JSON.stringify({choices:[{index:0,delta:{content},finish_reason:done?'stop':null}]})+'\n\n'+(done?'data: [DONE]\n\n':'');
      if(mode==='backend'){
        calls.at(-1).controller.enqueue(new TextEncoder().encode(chunk));if(done)calls.at(-1).controller.close();
      }else await page.evaluate(({chunk,done})=>{const controller=window.choiceRequests.at(-1).controller;controller.enqueue(new TextEncoder().encode(chunk));if(done)controller.close();},{chunk,done});
    }
    async function request(index){
      if(mode==='backend'){
        for(let i=0;i<100&&!calls[index]?.controller;i++)await delay(20);
        assert.ok(calls[index]?.controller,'Expected upstream request');return calls[index].body;
      }
      await page.waitForFunction(index=>!!window.choiceRequests[index]?.controller,index);
      return page.evaluate(index=>window.choiceRequests[index].body,index);
    }
    await page.goto(base);
    if(mode==='backend')await page.waitForFunction(()=>document.querySelector('#backend-state').textContent==='已连接'&&!document.querySelector('#message-input').disabled);
    await page.locator('[data-reply-choice]').first().waitFor();
    assert.equal(await page.locator('[data-reply-choice]').count(),3);
    assert.doesNotMatch(await page.locator('#msg-old .answer-body').textContent(),/旧选项|可选行动/);
    assert.equal(await page.locator('#msg-latest .answer-body li').count(),0,'Choices must replace, not duplicate, the list');
    for(const width of [1280,320]){
      await page.setViewportSize({width,height:width===320?740:900});
      if(width===320)await page.waitForFunction(()=>document.querySelector('#sidebar').getBoundingClientRect().right<=0);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      const sizes=await page.locator('.reply-choice').evaluateAll(els=>els.map(el=>({client:el.clientWidth,scroll:el.scrollWidth})));
      assert.ok(sizes.every(s=>s.scroll<=s.client),JSON.stringify(sizes));
      await page.locator('.reply-choices').scrollIntoViewIfNeeded();
      const screenshot=path.join(os.tmpdir(),'luma-choices-'+mode+'-'+width+'-'+process.pid+'.png');
      await page.screenshot({path:screenshot,fullPage:true});console.log('Choices screenshot: '+screenshot);
    }
    await page.setViewportSize({width:1280,height:900});
    if(mode==='backend'){
      const button=page.locator('[data-reply-choice]').nth(1);await button.focus();await button.press('Enter');
    }else await page.locator('[data-reply-choice]').nth(1).evaluate(button=>{button.click();button.click();});
    assert.equal(await page.locator('[data-reply-choice]').count(),0,'Buttons disappear immediately, before response');
    assert.doesNotMatch(await page.locator('#msg-latest .answer-body').textContent(),/可选行动|先不接|放过去|下面挑/);
    const sent=await request(0);
    assert.equal(sent.messages.at(-1).content,'先不接。 趁这两分钟，向何雨再打听打听“老周”。');
    await emit(next);
    await page.waitForFunction(()=>document.querySelector('.message-assistant:last-child .answer-body')?.textContent.includes('街角'));
    assert.equal(await page.locator('[data-reply-choice]').count(),0,'Incomplete streaming choices cannot be sent');
    await emit('',true);
    await page.waitForFunction(()=>!document.querySelector('#message-input').disabled);
    assert.equal(await page.locator('[data-reply-choice]').count(),2);
    assert.equal(mode==='backend'?calls.length:await page.evaluate(()=>window.choiceRequests.length),1);
    await page.locator('#msg-latest [data-copy-id]').click();
    assert.equal((await page.evaluate(()=>navigator.clipboard.readText())).trim(),'雨仍在下。手机上的倒计时还剩两分钟。');

    // A stale message ID must not send a new action, even when idle.
    await page.locator('#messages').evaluate(el=>{const b=document.createElement('button');b.dataset.replyChoice='0';b.dataset.replyId='latest';el.append(b);b.click();b.remove();});
    assert.equal(await page.locator('#message-input').isDisabled(),false);
    await page.locator('#message-input').fill('自由输入：等一会儿');await page.locator('#send-button').click();
    assert.equal(await page.locator('[data-reply-choice]').count(),0);
    assert.equal((await request(1)).messages.at(-1).content,'自由输入：等一会儿');
    await emit(last,true);await page.waitForFunction(()=>!document.querySelector('#message-input').disabled);
    assert.equal(await page.locator('[data-reply-choice]').count(),2);
    assert.doesNotMatch(await page.locator('.message-assistant').nth(2).textContent(),/查看门牌|回到便利店/);

    await page.locator('#new-chat').click();
    assert.equal(await page.locator('[data-reply-choice]').count(),0);
    assert.equal(await page.locator('.message').count(),0);
    await page.locator('[data-chat-id="choices"]').click();
    assert.equal(await page.locator('[data-reply-choice]').count(),0,'Retired choices must not return when revisiting history');
    assert.doesNotMatch(await page.locator('.message-assistant').allTextContents().then(x=>x.join('\n')),/打开地图|询问路人|旧选项|查看门牌|先不接/);
    await page.reload();
    if(mode==='backend')await page.waitForFunction(()=>document.querySelector('#backend-state').textContent==='已连接'&&!document.querySelector('#message-input').disabled);
    await page.locator('#msg-latest').waitFor();
    assert.equal(await page.locator('[data-reply-choice]').count(),0,'Retirement survives reload');
    await page.locator('#chat-menu-button').click();
    const downloaded=page.waitForEvent('download');await page.locator('[data-chat-action="export"]').click();
    const file=await downloaded,exported=fs.readFileSync(await file.path(),'utf8');
    assert.doesNotMatch(exported,/可选行动|旧选项|查看门牌|打开地图|放过去/);
    assert.match(exported,/先不接。/,'The user-selected message remains');
    const saved=mode==='backend'?store.getSession('choices'):await page.evaluate(()=>JSON.parse(localStorage.getItem('luma.chats')).find(chat=>chat.id==='choices'));
    assert.equal(saved.messages.find(m=>m.id==='latest').content,raw,'Raw history/context must not be destroyed');
    assert.deepEqual(errors,[]);
  });

test('browser: stopped, failed and demo replies have no actions; option text stays safe and wraps',
  {skip:!chromium,timeout:20000},async t=>{
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'luma-choices-states-'));
    const service=createService({store:new Store(directory),fetchImpl:async()=>{throw new Error('Unexpected upstream call');}});
    await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
    const browser=await chromium.launch({channel:process.env.LUMA_TEST_BROWSER||'chrome',headless:true});
    t.after(async()=>{await browser.close();await service.close();fs.rmSync(directory,{recursive:true,force:true});});
    const page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'});page.setDefaultTimeout(4000);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/api/bootstrap',route=>route.fulfill({status:403,contentType:'application/json',body:'{}'}));
    await page.route('https://**/*',route=>route.abort());
    const malicious='<img src=x onerror=alert(1)>',long='long_option_'.repeat(60);
    const content='保留剧情。\n\n可选行动：\n- '+malicious+' '+long+'\n- 阅读 [资料](https://example.com/source?a=1&b=2)。';
    const fixtures=['stopped','error','streaming','with-error','demo','safe'].map((state,index)=>({
      id:state,title:state,createdAt:index+1,updatedAt:index+1,demo:state==='demo',apiMessages:[],messages:[
        {id:state+'-user',role:'user',content:'继续'},
        {id:state+'-answer',role:'assistant',content:state==='safe'?content:raw,status:['safe','with-error','demo'].includes(state)?'done':state,error:state==='with-error'?'Test error':''}
      ]
    }));
    await page.addInitScript(chats=>{
      localStorage.setItem('luma.chats',JSON.stringify(chats));localStorage.setItem('luma.active',JSON.stringify('stopped'));
      sessionStorage.setItem('luma.keys',JSON.stringify({apiKey:'fake-choices-key'}));
      const original=window.fetch;window.choiceRequests=[];
      window.fetch=(url,init)=>{
        if(!String(url).endsWith('/chat/completions'))return original(url,init);
        window.choiceRequests.push(JSON.parse(init.body));
        return Promise.resolve(new Response('data: '+JSON.stringify({choices:[{delta:{content:'已收到。'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}}));
      };
    },fixtures);
    await page.goto('http://127.0.0.1:'+service.server.address().port);
    for(const id of ['stopped','error','streaming','with-error','demo']){
      await page.locator('[data-chat-id="'+id+'"]').click();
      assert.equal(await page.locator('[data-reply-choice]').count(),0,id);
      assert.doesNotMatch(await page.locator('.answer-body').textContent(),/接。|先不接|放过去|下面挑/,id);
    }
    await page.locator('[data-chat-id="safe"]').click();
    assert.equal(await page.locator('[data-reply-choice]').count(),2);
    assert.equal(await page.locator('.reply-choices img,.reply-choices a,.reply-choices script').count(),0);
    assert.match(await page.locator('[data-reply-choice]').first().textContent(),/<img src=x onerror=alert\(1\)>/);
    await page.setViewportSize({width:320,height:740});
    await page.waitForFunction(()=>document.querySelector('#sidebar').getBoundingClientRect().right<=0);
    assert.equal(await page.locator('.reply-choice').first().evaluate(el=>el.scrollWidth<=el.clientWidth),true);
    for(const index of ['-1','10','NaN','0.5']){
      await page.locator('#messages').evaluate((el,index)=>{const b=document.createElement('button');b.dataset.replyChoice=index;b.dataset.replyId='safe-answer';el.append(b);b.click();b.remove();},index);
    }
    assert.equal(await page.evaluate(()=>window.choiceRequests.length),0);
    await page.locator('[data-reply-choice]').nth(1).click();
    await page.waitForFunction(()=>window.choiceRequests.length===1&&!document.querySelector('#message-input').disabled);
    assert.equal(await page.evaluate(()=>window.choiceRequests[0].messages.at(-1).content),'阅读 资料 (https://example.com/source?a=1&b=2)。');
    assert.doesNotMatch(await page.locator('#msg-safe-answer .answer-body').textContent(),/long_option|<img|可选行动/);
    assert.deepEqual(errors,[]);
  });

test('browser: retiring a new round never revives an older conversation after many retired rounds',
  {skip:!chromium,timeout:15000},async t=>{
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'luma-choices-retirement-'));
    const service=createService({store:new Store(directory),fetchImpl:async()=>{throw new Error('No upstream calls expected');}});
    await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
    const browser=await chromium.launch({channel:process.env.LUMA_TEST_BROWSER||'chrome',headless:true});
    t.after(async()=>{await browser.close();await service.close();fs.rmSync(directory,{recursive:true,force:true});});
    const page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'});page.setDefaultTimeout(4000);
    await page.route('**/api/bootstrap',route=>route.fulfill({status:403,contentType:'application/json',body:'{}'}));
    await page.addInitScript(chat=>{
      const retired={...chat,id:'retired',title:'旧聊天',messages:[{...chat.messages.at(-1),id:'retired-answer'}]};
      localStorage.setItem('luma.chats',JSON.stringify([chat,retired]));localStorage.setItem('luma.active',JSON.stringify(chat.id));
      localStorage.setItem('luma.retiredChoices',JSON.stringify(['direct|retired|retired-answer',...Array.from({length:999},(_,i)=>'direct|choices|old-'+i)]));
    },session);
    await page.goto('http://127.0.0.1:'+service.server.address().port);
    await page.locator('[data-reply-choice]').first().waitFor();
    await page.locator('#new-chat').click();
    await page.locator('[data-chat-id="retired"]').click();
    assert.equal(await page.locator('[data-reply-choice]').count(),0);
    assert.doesNotMatch(await page.locator('.answer-body').textContent(),/先不接|下面挑/);
    const retired=await page.evaluate(()=>JSON.parse(localStorage.getItem('luma.retiredChoices')));
    assert.ok(retired.includes('direct|retired|retired-answer'));
    assert.ok(retired.length<=2,'Obsolete earlier-round records can be pruned without losing live history');
  });
