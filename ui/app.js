(function () {
  'use strict';
  const C=LumaCore, $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
  const icon=(name,cls='')=>`<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const DEFAULTS={baseURL:'https://api.deepseek.com',model:'deepseek-flash',customModel:'',effort:'high',systemPrompt:'你是澄蓝 Luma，一位清晰、耐心、诚实的助手。优先使用中文回答。把复杂问题解释得简单，必要时使用 Markdown。对不确定的事实明确说明。',searchURL:'https://api.deepseek.com/anthropic/v1',searchModel:'deepseek-v4-flash',searchEnabled:false,toolsEnabled:false,remember:false};
  const MODELS=[['deepseek-flash','DeepSeek Flash','轻快、通用的日常助手'],['deepseek-v4-pro','DeepSeek V4 Pro','复杂任务与深入推理']];
  const EFFORTS=[['none','none','不思考'],['low','low','轻度思考'],['high','high','标准思考'],['max','max','深度思考']];
  function read(store,key,fallback) {try{return JSON.parse(store.getItem(key))??fallback;}catch{return fallback;}}
  function write(store,key,value) {try{store.setItem(key,JSON.stringify(value));return true;}catch{return false;}}
  let settings={...DEFAULTS,...read(localStorage,'luma.settings',{})};
  settings.effort=EFFORTS.some(x=>x[0]===settings.effort)?settings.effort:'high';
  let secrets=read(settings.remember?localStorage:sessionStorage,'luma.keys',{});
  if(/^https?:\/\/api\.tavily\.com\//.test(settings.searchURL)){settings.searchURL=DEFAULTS.searchURL;settings.searchModel=DEFAULTS.searchModel;delete secrets.searchKey;write(settings.remember?localStorage:sessionStorage,'luma.keys',secrets);write(localStorage,'luma.settings',settings);}
  const backend=typeof LumaBackend==='object'?new LumaBackend.Client():null;
  const toolManager=typeof LumaToolManager==='object'?LumaToolManager.create({root:$('#custom-tool-manager'),getBackend:()=>backend,authorButton:$('#tool-authoring-button')}):null;
  const pendingApprovals=new Set();
  const approvalsToReveal=new Set();
  let chats=read(localStorage,'luma.chats',[]); if(!Array.isArray(chats))chats=[];
  chats=chats.filter(c=>c&&typeof c.id==='string'&&Array.isArray(c.messages)&&Array.isArray(c.apiMessages)).map(c=>({...c,messages:c.messages.map(m=>m.status==='streaming'?{...m,status:'stopped',error:'上次回答已中断，可重新生成。'}:m)}));
  let current=chats.find(c=>c.id===read(localStorage,'luma.active',''))||blankChat();
  let busy=false,controller=null,settingsDraft=null,returnFocus=null,toastTimer,renderQueued=false,testController=null;
  const expanded=new Set();
  const savedRetiredChoices=read(localStorage,'luma.retiredChoices',[]);
  const retiredChoices=new Set(Array.isArray(savedRetiredChoices)?savedRetiredChoices.filter(id=>typeof id==='string'):[]);
  function uid(){return typeof crypto.randomUUID==='function'?crypto.randomUUID():Date.now().toString(36)+Math.random().toString(36).slice(2);}
  function blankChat(){return {id:uid(),title:'新的对话',messages:[],apiMessages:[],createdAt:Date.now(),updatedAt:Date.now()};}
  function toast(text){clearTimeout(toastTimer);$('#toast').textContent=text;$('#toast').hidden=false;toastTimer=setTimeout(()=>$('#toast').hidden=true,4200);}
  function saveChats(){const prefix=backend?.connected?'luma.backend.':'luma.';if(!write(localStorage,prefix+'chats',chats))toast('本地存储空间不足，请先导出并清理部分对话。');write(localStorage,prefix+'active',current.id);}
  function rememberCurrent(){if(!chats.some(c=>c.id===current.id))chats.unshift(current);current.updatedAt=Date.now();saveChats();renderHistory();}
  function persistSettings(){if(backend?.connected){write(localStorage,'luma.backend.settings',settings);return;}write(localStorage,'luma.settings',settings);const target=settings.remember?localStorage:sessionStorage;const other=settings.remember?sessionStorage:localStorage;try{other.removeItem('luma.keys');}catch{}if(!write(target,'luma.keys',secrets))toast('密钥未能保存到浏览器；当前页面仍可使用。');}
  let controlSave=Promise.resolve();
  function persistControls(){persistSettings();if(!backend?.connected)return;const identity=backend.baseURL+'|'+backend.token;const values={model:settings.model,customModel:settings.customModel,effort:settings.effort,searchEnabled:settings.searchEnabled,toolsEnabled:settings.toolsEnabled};controlSave=controlSave.then(async()=>{if(backend.connected&&identity===backend.baseURL+'|'+backend.token)await backend.saveSettings(values);}).catch(e=>toast(e.message));}
  let menuTrigger=null;
  function closeMenus(restoreFocus=false){const trigger=menuTrigger;$$('.dropdown-menu').forEach(m=>m.hidden=true);$$('[aria-expanded]').filter(b=>!b.classList.contains('reasoning-toggle')).forEach(b=>b.setAttribute('aria-expanded','false'));menuTrigger=null;if(restoreFocus)trigger?.focus();}
  function setPickerView(menu,view,focus=false){
    const models=view==='models';menu.dataset.view=view;
    menu.querySelector('[data-effort-panel]').hidden=models;
    menu.querySelector('[data-model-panel]').hidden=!models;
    menu.querySelector('[data-model-toggle]').setAttribute('aria-expanded',String(models));
    if(focus)(models?menu.querySelector('[aria-checked="true"]'):menu.querySelector('[data-model-toggle]'))?.focus();
  }
  function toggleMenu(button,menu){const open=menu.hidden;closeMenus();if(open){menu.hidden=false;button.setAttribute('aria-expanded','true');menuTrigger=button;if(menu.classList.contains('model-picker'))setPickerView(menu,menu.id==='model-menu'?'models':'effort');}}
  function renderPicker(menu,model){
    if(!menu.querySelector('[data-effort-slider]')){
      menu.innerHTML=`<div data-effort-panel>
        <div class="picker-heading"><span class="picker-symbol" aria-hidden="true">${icon('bolt')}</span>
          <div class="picker-current"><strong class="picker-effort" data-effort-value></strong><button type="button" class="picker-model-toggle" data-model-toggle aria-expanded="false" aria-controls="${menu.id}-models" aria-label="切换模型"><span data-model-name></span>${icon('chevron')}</button></div>
          <button type="button" class="picker-reset" data-effort-reset aria-label="重置思考强度" title="重置为 high">${icon('refresh')}</button>
        </div>
        <div class="picker-range-wrap"><span class="picker-range-track" aria-hidden="true"><span class="picker-range-fill"></span><span class="picker-range-flow"></span><span class="picker-range-particles"></span></span>
          <span class="picker-range-ticks" aria-hidden="true">${EFFORTS.map(()=>'<i></i>').join('')}</span>
          <input type="range" class="picker-range" data-effort-slider min="0" max="3" step="1" aria-label="思考强度">
        </div>
      </div><div data-model-panel hidden><div class="picker-list-heading"><span>选择模型</span><button type="button" class="picker-back" data-model-back aria-label="返回思考强度" title="返回思考强度" ${menu.id==='model-menu'?'hidden':''}>${icon('arrow')}</button></div><div class="picker-model-options" id="${menu.id}-models" data-model-options role="menu" aria-label="选择模型"></div></div>`;
      setPickerView(menu,'effort');
    }
    const effort=EFFORTS.findIndex(item=>item[0]===settings.effort);
    menu.dataset.effort=settings.effort;
    menu.style.setProperty('--effort-progress',String(effort/(EFFORTS.length-1)));
    menu.querySelectorAll('.picker-range-ticks i').forEach((tick,index)=>tick.classList.toggle('active',effort>0&&index<=effort));
    menu.querySelector('[data-effort-value]').textContent=settings.effort;
    const slider=menu.querySelector('[data-effort-slider]');
    slider.value=String(effort);slider.setAttribute('aria-valuetext',settings.effort);slider.title=EFFORTS[effort][2];
    const modelName=MODELS.find(item=>item[0]===model)?.[1]||model;
    menu.querySelector('[data-model-name]').textContent=modelName;
    menu.querySelector('[data-model-toggle]').title=modelName;
    const models=[...MODELS,...(settings.customModel?[['custom',settings.customModel,'自定义模型']]:[])];
    menu.querySelector('[data-model-options]').innerHTML=`<button type="button" role="menuitem" data-model="default" class="picker-model-option picker-default"><span><strong>默认</strong><small>推荐模型集</small></span></button>`+models.map(([id,name,description])=>{
      const selected=id==='custom'?model===settings.customModel:model===id;
      return `<button type="button" role="menuitemradio" aria-checked="${selected}" data-model="${C.escape(id)}" title="${C.escape(description)}" class="picker-model-option${selected?' selected':''}"><span><strong>${C.escape(name)}</strong></span>${selected?icon('check'):''}</button>`;
    }).join('');
  }
  function renderControls(){
    const model=settings.customModel||settings.model;
    $('#model-name').textContent=MODELS.find(m=>m[0]===model)?.[1]||model;
    $('#model-button').title=$('#model-name').textContent;
    $('#effort-label').textContent=EFFORTS.find(x=>x[0]===settings.effort)[1];
    $('#effort-model-name').textContent=$('#model-name').textContent;
    $('#effort-button').title=$('#model-name').textContent+' · '+settings.effort;
    $('#effort-button').setAttribute('aria-label','选择模型与思考强度：'+$('#effort-button').title);
    for(const menu of [$('#model-menu'),$('#effort-menu')])renderPicker(menu,model);
    $('#search-toggle').setAttribute('aria-pressed',String(settings.searchEnabled));$('#tools-toggle').setAttribute('aria-pressed',String(settings.toolsEnabled));
  }
  function renderHistory(){const q=$('#chat-search').value.trim().toLowerCase();const visible=chats.filter(c=>c.messages.length&&(c.title||'').toLowerCase().includes(q)).sort((a,b)=>b.updatedAt-a.updatedAt);$('#history-count').textContent=chats.filter(c=>c.messages.length).length;
    $('#history').innerHTML=visible.length?visible.map(c=>`<button class="history-item ${c.id===current.id?'active':''}" data-chat-id="${C.escape(c.id)}">${icon('chat')}<span>${C.escape(c.title)}</span>${c.demo?'<small>示例</small>':''}</button>`).join(''):'';
  }
  function scrollBottom(force=false){const sc=$('#chat-scroll');if(force||sc.scrollHeight-sc.scrollTop-sc.clientHeight<180)requestAnimationFrame(()=>{sc.scrollTop=sc.scrollHeight;});}
  function sourcesHTML(sources){
    const links=(sources||[]).map((s,i)=>{const url=C.safeURL(s.url);if(!url)return '';const title=s.title||new URL(url).hostname;return `<a class="source-card" href="${C.escape(url)}" title="${C.escape(title+' · '+new URL(url).hostname)}" target="_blank" rel="noopener noreferrer"><strong><span class="source-number">${i+1}</span>${C.escape(title)}</strong>${icon('arrow','source-link-arrow')}</a>`;}).filter(Boolean);
    return links.length?`<div class="sources" aria-label="网页来源">${links.join('')}</div>`:'';
  }
  function choiceScope(){return backend?.connected?backend.baseURL:'direct';}
  function choiceKey(m,chat=current){return [choiceScope(),chat.id,m.id].join('|');}
  function canReplyChoices(m){return !busy&&!current.demo&&m===current.messages.at(-1)&&m.role==='assistant'&&m.status==='done'&&!m.error&&!retiredChoices.has(choiceKey(m));}
  function retireReplyChoices(){
    const m=current.messages.at(-1);
    if(m?.role!=='assistant'||!C.extractReplyChoices(C.splitAssistantContent(m.content).content))return;
    retiredChoices.add(choiceKey(m));
    // Only final replies need retirement records; never evict a live historical reply.
    const liveKeys=new Set([...chats,current].filter(chat=>chat.messages.length).map(chat=>choiceKey(chat.messages.at(-1),chat)));
    for(const key of retiredChoices)if(key.startsWith(choiceScope()+'|')&&!liveKeys.has(key))retiredChoices.delete(key);
    write(localStorage,'luma.retiredChoices',[...retiredChoices]);
  }
  function choiceText(markdown){
    const node=document.createElement('div');node.innerHTML=C.markdown(markdown);
    for(const link of node.querySelectorAll('a'))link.replaceWith(document.createTextNode(link.textContent+' ('+link.getAttribute('href')+')'));
    return node.textContent.trim();
  }
  function answerContent(m){
    if(m.role!=='assistant')return m.content;
    const content=C.splitAssistantContent(m.content,{streaming:m.status==='streaming'}).content,choices=C.extractReplyChoices(content);
    return choices&&!canReplyChoices(m)?choices.content:content;
  }
  function answerHTML(m,content){
    const choices=C.extractReplyChoices(content);
    if(!choices)return C.markdown(content);
    const body=C.markdown(choices.content);
    if(!canReplyChoices(m))return body;
    return body+`<div class="reply-choices" role="group" aria-label="选择下一步行动"><div class="reply-choice-heading">${C.escape(choiceText(choices.heading))}</div>${choices.options.map((option,index)=>`<button type="button" class="reply-choice" data-reply-id="${C.escape(m.id)}" data-reply-choice="${index}" title="发送此选项"><span>${C.escape(choiceText(option))}</span>${icon('arrow')}</button>`).join('')}${choices.footer?`<div class="reply-choice-footer">${C.escape(choiceText(choices.footer))}</div>`:''}</div>`;
  }
  function assistantInner(m){
    const working=m.status==='streaming',open=expanded.has(m.id),sources=sourcesHTML(m.sources),parts=C.splitAssistantContent(m.content,{streaming:working});
    const tools=(m.tools||[]).map(t=>{
      const approval=working&&backend?.connected&&t.approvalId;
      const artifacts=(t.artifacts||[]).map(a=>{const url=C.safeURL(a.url);if(!url||!['image','video'].includes(a.type))return '';const safe=C.escape(url);return `<div class="tool-artifact">${a.type==='image'?`<img src="${safe}" alt="工具生成的图片" loading="lazy" referrerpolicy="no-referrer">`:`<video src="${safe}" controls preload="none"></video>`}<a href="${safe}" target="_blank" rel="noopener noreferrer">${a.type==='image'?'查看图片':'查看视频'}${icon('arrow')}</a></div>`;}).join('');
      const controls=approval?`<div class="tool-approval"><pre>${C.escape(JSON.stringify(t.preview||{},null,2))}</pre><div class="tool-approval-actions"><button type="button" class="secondary-button" data-approval-id="${C.escape(t.approvalId)}" data-allow="false" ${pendingApprovals.has(t.approvalId)?'disabled':''}>拒绝</button><button type="button" class="primary-button" data-approval-id="${C.escape(t.approvalId)}" data-allow="true" ${pendingApprovals.has(t.approvalId)?'disabled':''}>${icon('check')}允许本次</button></div></div>`:'';
      return `<div class="tool-process"><div class="tool-event">${icon(({web_search:'search',web_fetch:'book'})[t.name]||'tool')}<span>${C.escape(t.label||({get_current_time:'获取时间',web_search:'网页搜索',web_fetch:'浏览网页'})[t.name]||t.name)}<small> · ${C.escape(t.state)}</small></span></div>${controls}${t.label&&t.result?`<details class="tool-result" data-tool-result-id="${C.escape(t.id)}"><summary>调用结果</summary><pre>${C.escape(t.result)}</pre></details>`:''}${artifacts}</div>`;
    }).join('');
    const notes=parts.notes.length?`<div class="model-notes"><div class="process-sources-heading">${icon('book')}<span>幕后附注 · 模型生成</span></div>${parts.notes.map(note=>`<div class="model-note-text">${C.escape(note)}</div>`).join('')}</div>`:'';
    const details=(m.reasoning?`<div class="reasoning-text">${C.escape(m.reasoning)}</div>`:'')+tools+notes+(sources?`<div class="process-sources"><div class="process-sources-heading">${icon('globe')}<span>参考来源</span></div>${sources}</div>`:'');
    const reasoning=details?`<div class="reasoning"><button type="button" class="reasoning-toggle" data-reason-id="${C.escape(m.id)}" aria-expanded="${open}" aria-controls="reason-${C.escape(m.id)}">${icon('brain')}<span>${working?'正在思考':'已思考'}${m.seconds?'（用时 '+C.escape(m.seconds)+' 秒）':''}</span>${working?'<i class="stream-pulse"></i>':''}${icon('chevron','reason-arrow')}</button><div class="reasoning-body" id="reason-${C.escape(m.id)}" ${open?'':'hidden'}>${details}</div></div>`:'';
    return `${reasoning}<div class="answer-body">${answerHTML(m,parts.content)}</div>${working&&!parts.content&&!details?`<div class="pending-content"><i class="stream-pulse"></i>${C.escape(m.phase||'正在整理思路…')}</div>`:''}${m.error?`<div class="error-card">${C.escape(m.error)}</div>`:''}`;
  }
  function preserveProcessScroll(container){
    // Streamed markup must not reset the reader's position in expanded details.
    const positions=new Map([...container.querySelectorAll('.reasoning-body')].map(body=>[body.id,body.scrollTop]));
    const results=new Map([...container.querySelectorAll('[data-tool-result-id]')].map(detail=>[detail.dataset.toolResultId,detail.open]));
    return ()=>{container.querySelectorAll('[data-tool-result-id]').forEach(detail=>{detail.open=results.get(detail.dataset.toolResultId)||false;});container.querySelectorAll('.reasoning-body').forEach(body=>{if(positions.has(body.id))body.scrollTop=positions.get(body.id);});};
  }
  function renderMessages(){if(renderQueued){cancelAnimationFrame(renderQueued);renderQueued=false;}const restoreScroll=preserveProcessScroll($('#messages')),has=current.messages.length>0;$('#messages').hidden=!has;$('#conversation-label').hidden=!has;$('#conversation-label').innerHTML=has?`<span>${C.escape(current.title)}</span>${current.demo?'<span class="demo-badge">静态示例 · 未调用 API</span>':''}`:'';
    $('#messages').innerHTML=current.messages.map(m=>m.role==='user'?`<article class="message message-user" aria-label="你的消息"><div class="user-content">${C.escape(m.content)}</div><div class="message-actions user-actions"><button type="button" class="icon-button" data-copy-id="${C.escape(m.id)}" aria-label="复制消息" title="复制消息">${icon('copy')}</button></div></article>`:`<article class="message message-assistant" id="msg-${C.escape(m.id)}" aria-label="Luma 的回复"><div class="assistant-content">${assistantInner(m)}</div><div class="message-actions">${m.content?`<button class="icon-button" data-copy-id="${C.escape(m.id)}" aria-label="复制回答">${icon('copy')}</button>`:''}${m.status!=='streaming'&&!current.demo&&m===current.messages.at(-1)?`<button class="icon-button" data-retry-id="${C.escape(m.id)}" aria-label="重新生成">${icon('refresh')}</button>`:''}<small>${m.status==='stopped'?'已停止':m.status==='streaming'?'':Number.isSafeInteger(m.usage?.total_tokens)&&m.usage.total_tokens>=0?m.usage.total_tokens+' tokens':''}</small></div></article>`).join('');
    restoreScroll();
  }
  function streamRender(m){if(renderQueued)return;renderQueued=requestAnimationFrame(()=>{renderQueued=false;const el=document.getElementById('msg-'+m.id);if(el){const sc=$('#chat-scroll'),near=sc.scrollHeight-sc.scrollTop-sc.clientHeight<160,restoreScroll=preserveProcessScroll(el);el.querySelector('.assistant-content').innerHTML=assistantInner(m);restoreScroll();if(near)sc.scrollTop=sc.scrollHeight;for(const button of el.querySelectorAll('[data-approval-id]'))if(approvalsToReveal.delete(button.dataset.approvalId))button.closest('.tool-approval-actions').scrollIntoView({block:'nearest',inline:'nearest'});}});}
  function setBusy(value){busy=value;$('#send-button').classList.toggle('stop',value);$('#send-button').setAttribute('aria-label',value?'停止生成':'发送消息');$('#send-button').innerHTML=value?'<span class="stop-square"></span>':icon('up');$('#message-input').disabled=value;$('#model-button').disabled=value;$('#effort-button').disabled=value;$('#search-toggle').disabled=value;$('#tools-toggle').disabled=value;const m=current.messages.at(-1),body=m&&document.getElementById('msg-'+m.id)?.querySelector('.answer-body');if(body)body.innerHTML=answerHTML(m,C.splitAssistantContent(m.content,{streaming:m.status==='streaming'}).content);}
  function startNew(){if(busy){toast('请先停止当前回答，再开启新对话。');return;}retireReplyChoices();current=blankChat();$('#message-input').value='';resizeInput();renderMessages();renderHistory();closeSidebar();$('#message-input').focus();}
  function closeSidebar(){$('#sidebar').classList.remove('open');$('#sidebar-mask').hidden=true;$('#mobile-menu').setAttribute('aria-expanded','false');}
  function resizeInput(){const t=$('#message-input');t.style.height='auto';t.style.height=Math.min(t.scrollHeight,160)+'px';}
  async function grantHost(url){if(location.protocol!=='chrome-extension:'||!chrome.permissions)return;const u=new URL(url),orig=u.origin+'/*';if(!(await chrome.permissions.contains({origins:[orig]}))){const allowed=await chrome.permissions.request({origins:[orig]});if(!allowed)throw new Error('未授权此 API 地址，请使用官方地址或授予该主机访问权限。');}}
  function networkError(e){if(e.name==='AbortError')return '已停止生成。';if(e instanceof TypeError)return '网络连接失败。请检查网络与 API 地址；独立 HTML 可能受浏览器跨域限制，推荐使用 Chrome 扩展。';return e.message||'请求发生错误，请稍后重试。';}
  async function send(text,retry=false){
    if(busy)return;const input=text??$('#message-input').value.trim();if(!input)return;
    if(current.demo){startNew();}
    if(backend?.connected){await sendBackend(input,retry);return;}
    if(!secrets.apiKey){openSettings('api');toast('填入 DeepSeek API Key 后，就可以开始对话。');return;}
    const cfg={...settings,model:settings.customModel||settings.model},keys={...secrets};
    retireReplyChoices();
    setBusy(true);
    let url;try{url=C.endpoint(cfg.baseURL);await grantHost(url);if(cfg.searchEnabled)await grantHost(cfg.searchURL);}catch(e){setBusy(false);toast(e.message);return;}
    let user;
    if(retry){const idx=current.messages.findLastIndex(m=>m.role==='user');user=current.messages[idx];current.messages.splice(idx+1);current.apiMessages=C.historyForRetry(current.apiMessages,user.apiStart);user.apiStart=current.apiMessages.length;}
    else {user={id:uid(),role:'user',content:input,apiStart:current.apiMessages.length};current.messages.push(user);if(current.messages.length===1)current.title=input.replace(/\s+/g,' ').slice(0,24);}
    const m={id:uid(),role:'assistant',content:'',reasoning:'',tools:[],sources:[],status:'streaming',model:MODELS.find(x=>x[0]===cfg.model)?.[1]||cfg.model,phase:'正在连接 DeepSeek…'};
    current.messages.push(m);$('#message-input').value='';resizeInput();setBusy(true);closeMenus();renderMessages();rememberCurrent();scrollBottom(true);controller=new AbortController();const signal=controller.signal,start=Date.now();
    let api=[...current.apiMessages],appended=false,staged=false;
    try {
      api.push({role:'user',content:input});appended=true;
      const definitions=LumaTools.definitions(cfg);
      for(let round=0;round<6;round++){
        if(signal.aborted)throw new DOMException('Aborted','AbortError');
        const prefixContent=m.content,prefixReason=m.reasoning;
        m.phase='正在整理思路…';
        const payload=C.createPayload(cfg,api,definitions);if(round===5&&definitions.length)payload.tool_choice='none';
        const res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+keys.apiKey},body:JSON.stringify(payload),signal,redirect:'error'});
        const r=await C.readCompletion(res,(delta,total)=>{m.content=prefixContent+total.content;m.reasoning=prefixReason+total.reasoning_content;streamRender(m);});
        m.usage=r.usage||m.usage;
        if(r.finish_reason==='length')m.error='已达到模型的输出长度上限，内容可能未完结。';
        if(r.finish_reason==='content_filter')m.error='模型服务未能提供完整回答。';
        if(!r.tool_calls.length){api.push({role:'assistant',content:r.content,reasoning_content:r.reasoning_content});staged=true;break;}
        if(!definitions.length)throw new Error('模型请求调用工具，但当前未开启可用工具。');
        if(round===5)throw new Error('工具已执行 5 轮，达到本次调用上限。请简化问题后重试。');
        api.push({role:'assistant',content:r.content||null,reasoning_content:r.reasoning_content,tool_calls:r.tool_calls});
        for(const call of r.tool_calls){if(signal.aborted)throw new DOMException('Aborted','AbortError');const event={name:call.function.name,state:'正在执行'};m.tools.push(event);streamRender(m);const output=await LumaTools.execute(call,{signal,settings:cfg,keys,onSources:sources=>{for(const s of sources)if(!m.sources.some(x=>x.url===s.url))m.sources.push(s);streamRender(m);}});signal.throwIfAborted();api.push(output);event.state=output.content.includes('"error"')?'执行失败':'已完成';event.result=output.content.slice(0,160);streamRender(m);}
        if(m.content)m.content+='\n\n';if(m.reasoning)m.reasoning+='\n\n';
      }
      m.status='done';current.apiMessages=api;
    } catch(e){m.status=e.name==='AbortError'?'stopped':'error';m.error=e.name==='AbortError'?(m.content?'':'已停止，可重新生成。'):networkError(e);if(appended){if(!staged&&m.content&&!api.at(-1)?.tool_calls)api.push({role:'assistant',content:m.content,reasoning_content:m.reasoning});const unresolved=api.findLastIndex(x=>x.role==='assistant'&&x.tool_calls&&x.tool_calls.some(c=>!api.some(t=>t.role==='tool'&&t.tool_call_id===c.id)));if(unresolved>=0)api=api.slice(0,unresolved);current.apiMessages=api;}}
    finally{m.seconds=Math.max(1,Math.round((Date.now()-start)/1000));setBusy(false);controller=null;renderMessages();rememberCurrent();scrollBottom();$('#message-input').focus();}
  }
  function adoptSession(session){if(!session)return;current=session;const i=chats.findIndex(c=>c.id===session.id);if(i>=0)chats[i]=session;else chats.unshift(session);saveChats();renderHistory();}
  async function sendBackend(input,retry){
    if(!backend.settings.hasApiKey){openSettings('api');toast('请配置 DeepSeek API Key');return;}
    const id=current.id;retireReplyChoices();setBusy(true);controller=new AbortController();const signal=controller.signal;let m;
    try{
      // Migrate a browser-only conversation before its first server turn.
      if(current.messages.length&&!chats.some(c=>c.id===id&&c.serverStored)){await backend.importSession(current);current.serverStored=true;}
      $('#message-input').value='';resizeInput();closeMenus();
      await backend.chat({sessionId:id,message:input,retry,options:{model:settings.model,customModel:settings.customModel,effort:settings.effort,systemPrompt:settings.systemPrompt,searchEnabled:settings.searchEnabled,toolsEnabled:settings.toolsEnabled}},(type,data)=>{
        if(type==='start'){adoptSession({...data.session,serverStored:true});m=current.messages.at(-1);renderMessages();scrollBottom(true);}
        else if(type==='delta'&&m){m.content+=data.content||'';m.reasoning+=data.reasoning||'';m.phase='正在整理…';streamRender(m);}
        else if(type==='sources'&&m){m.sources=data.sources;streamRender(m);}
        else if(type==='tool'&&m){const previous=new Set((m.tools||[]).map(t=>t.approvalId).filter(Boolean));m.tools=data.tools;for(const tool of m.tools)if(tool.approvalId&&!previous.has(tool.approvalId)){expanded.add(m.id);approvalsToReveal.add(tool.approvalId);}streamRender(m);}
        else if(type==='error'){if(m){m.error=data.message;m.status=data.status;streamRender(m);}else toast(data.message);}
        else if(type==='done'&&data.session){adoptSession({...data.session,serverStored:true});m=current.messages.at(-1);}
      },signal);
    }catch(e){
      if(signal.aborted){try{await backend.cancel(id);for(let i=0;i<8;i++){const {session}=await backend.getSession(id);if(session?.messages.at(-1)?.status!=='streaming'){adoptSession({...session,serverStored:true});m=current.messages.at(-1);break;}await new Promise(r=>setTimeout(r,100));}}catch{}if(m&&m.status==='streaming'){m.status='stopped';m.error=m.content?'':'已停止';}}
      else if(m){m.status='error';m.error=networkError(e);}else toast(networkError(e));
    }finally{setBusy(false);controller=null;renderMessages();rememberCurrent();scrollBottom();$('#message-input').focus();}
  }
  function download(name,content,type){const blob=new Blob([content],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),2000);}
  function exportCurrent(){if(!current.messages.length){toast('开启一段对话后，就可以导出了。');return;}const text='# '+current.title+'\n\n'+current.messages.map(m=>'## '+(m.role==='user'?'你':'Luma')+'\n\n'+(m.reasoning?'> 思考过程\n\n'+m.reasoning+'\n\n':'')+answerContent(m)+(m.sources?.length?'\n\n来源：\n'+m.sources.map(s=>'- ['+s.title+']('+s.url+')').join('\n'):'')).join('\n\n---\n\n');download('Luma-'+current.title.replace(/[<>:"/\\|?*]/g,'').slice(0,24)+'.md',text,'text/markdown;charset=utf-8');toast('对话已导出。');}
  async function exportAll(){try{const data=backend?.connected?await backend.request('export'):{app:'Luma',version:2,exportedAt:new Date().toISOString(),chats};download('Luma-对话备份.json',JSON.stringify(data,null,2),'application/json;charset=utf-8');toast('备份已下载');}catch(e){toast(e.message);}}
  async function copy(text){try{await navigator.clipboard.writeText(text);toast('已复制。');}catch{const t=document.createElement('textarea');t.value=text;t.className='sr-only';document.body.append(t);t.select();const copied=document.execCommand('copy');t.remove();toast(copied?'已复制。':'浏览器未允许复制，请选中文字复制。');}}
  function modal(title,content,actions,iconName='download'){closeMenus();returnFocus=document.activeElement;$('#small-title').textContent=title;$('#small-content').innerHTML=content;$('#small-icon').innerHTML=icon(iconName);$('#small-actions').replaceChildren();for(const action of actions){const b=document.createElement('button');b.className=action.primary?'primary-button':'secondary-button';b.textContent=action.label;b.addEventListener('click',action.fn);$('#small-actions').append(b);}$('#small-overlay').hidden=false;$('#small-dialog').focus();}
  function closeSmall(){$('#small-overlay').hidden=true;returnFocus?.focus();}
  function confirmAction(title,content,callback){modal(title,'<p>'+C.escape(content)+'</p>',[{label:'取消',fn:closeSmall},{label:'确认',primary:true,fn:()=>{closeSmall();callback();}}],'trash');}
  function install(){const ext=location.protocol==='chrome-extension:';modal(ext?'Luma 已在 Chrome 中':'把 Luma 带进 Chrome',ext?'<p>这是已安装的 Chrome 扩展。点击工具栏中的 Luma 图标，就能随时打开完整聊天页。</p><p>可在 Chrome 扩展管理页，将 Luma 固定到工具栏。</p>':'<p>下载扩展安装包后，只需三个步骤：</p><ol><li>解压 <strong>Luma-Chrome.zip</strong>，保留整个文件夹。</li><li>打开 <code>chrome://extensions</code>，开启右上角「开发者模式」。</li><li>点击「加载已解压的扩展程序」，选择包含 <code>manifest.json</code> 的文件夹。</li></ol><p>首次打开后，在左下角设置中填写你的 DeepSeek API Key。</p>',[{label:'知道了',fn:closeSmall},...(!ext&&backend?.connected?[{label:'下载 Chrome 安装包',primary:true,fn:()=>{const a=document.createElement('a');a.href=backend.baseURL+'/download/chrome';a.download='Luma-Chrome.zip';document.body.append(a);a.click();a.remove();}}]:[]),...(!ext&&window.LUMA_PACKAGE?[{label:'下载 Chrome 安装包',primary:true,fn:()=>{const bytes=Uint8Array.from(atob(window.LUMA_PACKAGE),c=>c.charCodeAt(0));download('Luma-Chrome.zip',bytes,'application/zip');toast('Chrome 安装包已下载。');}}]:[])]);}
  const tabInfo={api:['模型与连接','连接 DeepSeek，让灵感开始流动。'],prompt:['系统提示词','定义角色，让每次回答都合你的心意。'],search:['网页搜索','把问题带到更广阔的世界。'],tools:['工具调用','给助手一条通往行动的路径。'],data:['本地与隐私','管理只属于你的对话空间。']};
  function selectTab(tab){$$('[data-panel]').forEach(p=>p.hidden=p.dataset.panel!==tab);$$('[data-tab]').forEach(b=>{b.classList.toggle('active',b.dataset.tab===tab);b.setAttribute('aria-current',b.dataset.tab===tab?'page':'false');});$('#settings-panel-title').textContent=tabInfo[tab][0];$('.settings-content').scrollTop=0;$('#settings-save').hidden=tab==='tools';$('#settings-cancel').textContent=tab==='tools'?'关闭':'取消';$('#tool-authoring-button').hidden=tab!=='tools';if(tab==='tools')toolManager?.open();else toolManager?.close();}
  function openSettings(tab='api'){closeMenus();closeSidebar();returnFocus=document.activeElement;settingsDraft={remember:settings.remember};$('#settings-save').disabled=false;$('#test-connection').disabled=false;$('#api-key').value=backend?.connected?'':secrets.apiKey||'';$('#search-key').value=backend?.connected?'':secrets.searchKey||'';$('#api-key').placeholder=backend?.settings.hasApiKey?'已配置 · 留空保留':'sk-…';$('#search-key').placeholder=backend?.settings.hasSearchKey?'已配置 · 留空保留':'留空复用 DeepSeek Key';$('#api-key').type='password';$('#search-key').type='password';$('#api-base').value=settings.baseURL;$('#search-base').value=settings.searchURL;$('#search-model').value=settings.searchModel;$('#custom-model').value=settings.customModel;$('#system-prompt').value=settings.systemPrompt;$('#remember-toggle').setAttribute('aria-checked',String(settingsDraft.remember));const connection=read(sessionStorage,'luma.backend',{});$('#backend-url').value=backend?.baseURL||connection.baseURL||'http://127.0.0.1:43821';$('#backend-token').value=backend?.token||connection.token||'';$('#backend-state').textContent=backend?.connected?'已连接':'未连接';$('#test-result').textContent='';$('#settings-feedback').textContent='';selectTab(tab);$('#settings-overlay').hidden=false;$('#settings-dialog').focus();}
  function closeSettings(){testController?.abort();toolManager?.close();$('#settings-overlay').hidden=true;settingsDraft=null;$('#settings-save').disabled=false;$('#test-connection').disabled=false;$('#api-key').value='';$('#search-key').value='';returnFocus?.focus();}
  function searchEndpoint(url){if(typeof LumaSearch==='object')return LumaSearch.searchEndpoint(url).replace(/\/messages$/,'');let u;try{u=new URL(url);}catch{throw new Error('请输入有效的搜索接口地址');}C.endpoint(u.origin);if(u.username||u.password)throw new Error('搜索地址不能包含凭据');return u.href;}
  async function saveSettings(){
    const b=$('#settings-save'),draft=settingsDraft;if(!draft||b.disabled)return;
    const snapshot={baseURL:$('#api-base').value.trim()||DEFAULTS.baseURL,searchURL:$('#search-base').value.trim()||DEFAULTS.searchURL,searchModel:$('#search-model').value.trim()||DEFAULTS.searchModel,customModel:$('#custom-model').value.trim(),systemPrompt:$('#system-prompt').value,remember:draft.remember};
    const keys={apiKey:$('#api-key').value.trim(),searchKey:$('#search-key').value.trim()};
    b.disabled=true;
    try{C.endpoint(snapshot.baseURL);snapshot.searchURL=searchEndpoint(snapshot.searchURL);if(backend?.connected){const values={...settings,...snapshot};if(keys.apiKey)values.apiKey=keys.apiKey;if(keys.searchKey)values.searchKey=keys.searchKey;const result=await backend.saveSettings(values);if(settingsDraft!==draft)return;settings={...settings,...result};secrets={};}else{await grantHost(C.endpoint(snapshot.baseURL));if(settingsDraft!==draft)return;await grantHost(snapshot.searchURL);if(settingsDraft!==draft)return;settings={...settings,...snapshot};secrets=keys;}
      persistSettings();renderControls();closeSettings();toast('已保存');
    }catch(e){if(settingsDraft===draft)$('#settings-feedback').textContent=e.message;}
    finally{if(settingsDraft===draft)b.disabled=false;}
  }
  async function testConnection(){
    const key=$('#api-key').value.trim();if(!key&&!backend?.settings.hasApiKey){$('#test-result').textContent='请先填写 API Key';return;}
    const b=$('#test-connection'),draft=settingsDraft,ctl=new AbortController();b.disabled=true;$('#test-result').textContent='正在验证连接…';testController=ctl;const timeout=setTimeout(()=>ctl.abort(),20000);
    try{const baseURL=$('#api-base').value.trim()||DEFAULTS.baseURL;let data;if(backend?.connected){data=await backend.request('models',{method:'POST',data:{baseURL,apiKey:key},signal:ctl.signal});}else{const url=C.endpoint(baseURL).replace(/\/chat\/completions$/,'/models');await grantHost(url);if(settingsDraft!==draft)return;const r=await fetch(url,{headers:{'Authorization':'Bearer '+key},signal:ctl.signal,redirect:'error'});if(!r.ok)throw new Error('连接失败（'+r.status+'），请检查密钥与地址。');data=await r.json();}if(!Array.isArray(data.data))throw new Error('该接口未返回兼容的模型列表。');if(settingsDraft===draft)$('#test-result').textContent='连接成功 · '+data.data.length+' 个可用模型';}
    catch(e){if(settingsDraft===draft)$('#test-result').textContent=e.name==='AbortError'?'连接超时或已取消':networkError(e);}
    finally{clearTimeout(timeout);if(settingsDraft===draft)b.disabled=false;if(testController===ctl)testController=null;}
  }
  async function connectBackend(auto=false){
    if(!backend)return;const b=$('#connect-backend');if(busy){toast('请先停止当前回答');return;}b.disabled=true;setBusy(true);
    try{const baseURL=auto?location.origin:$('#backend-url').value.trim(),token=auto?'':$('#backend-token').value.trim();await grantHost(baseURL);await controlSave;const state=await backend.connect(baseURL,token,{auto});
      settings={...DEFAULTS,...state.settings};chats=state.chats.map(c=>({...c,serverStored:true}));current=chats.find(c=>c.id===current.id)||chats[0]||blankChat();secrets={};persistSettings();saveChats();write(sessionStorage,'luma.backend',{baseURL:backend.baseURL,token:backend.token});renderControls();renderMessages();renderHistory();$('#backend-state').textContent='已连接';if(settingsDraft)openSettings('api');if(!auto)toast('后端已连接');
    }catch(e){$('#backend-state').textContent=e.message;if(!auto)toast(e.message);}finally{b.disabled=false;setBusy(false);}
  }
  $('#new-chat').addEventListener('click',startNew);$('.brand').addEventListener('click',e=>{e.preventDefault();startNew();});$('#chat-search').addEventListener('input',renderHistory);
  $('#history').addEventListener('click',e=>{const b=e.target.closest('[data-chat-id]');if(!b)return;if(busy){toast('请先停止当前回答，再切换对话。');return;}if(current.id!==b.dataset.chatId)retireReplyChoices();current=chats.find(c=>c.id===b.dataset.chatId);saveChats();renderMessages();renderHistory();closeSidebar();scrollBottom(true);});
  $('#model-button').addEventListener('click',()=>toggleMenu($('#model-button'),$('#model-menu')));$('#effort-button').addEventListener('click',()=>toggleMenu($('#effort-button'),$('#effort-menu')));$('#chat-menu-button').addEventListener('click',()=>toggleMenu($('#chat-menu-button'),$('#chat-menu')));
  for(const menu of [$('#model-menu'),$('#effort-menu')]){
    menu.addEventListener('input',e=>{if(busy||!e.target.matches('[data-effort-slider]'))return;const effort=EFFORTS[Number(e.target.value)];if(effort){settings.effort=effort[0];renderControls();}});
    menu.addEventListener('change',e=>{if(!busy&&e.target.matches('[data-effort-slider]'))persistControls();});
    menu.addEventListener('click',e=>{
      if(busy)return;
      if(e.target.closest('[data-model-toggle]')){setPickerView(menu,'models',true);return;}
      if(e.target.closest('[data-model-back]')){setPickerView(menu,'effort',true);return;}
      if(e.target.closest('[data-effort-reset]')){settings.effort=DEFAULTS.effort;persistControls();renderControls();return;}
      const model=e.target.closest('[data-model]');if(!model)return;
      if(model.dataset.model!=='custom'){settings.model=model.dataset.model==='default'?DEFAULTS.model:model.dataset.model;settings.customModel='';}
      persistControls();renderControls();if(menu.id==='model-menu')closeMenus(true);else setPickerView(menu,'effort',true);
    });
    menu.addEventListener('keydown',e=>{
      if(e.key==='Escape'&&menu.id==='effort-menu'&&menu.dataset.view==='models'){e.preventDefault();e.stopPropagation();setPickerView(menu,'effort',true);return;}
      const option=e.target.closest('[data-model]');if(!option||!['ArrowDown','ArrowUp','Home','End'].includes(e.key))return;
      e.preventDefault();const options=[...menu.querySelectorAll('[data-model]')],index=options.indexOf(option);
      options[e.key==='Home'?0:e.key==='End'?options.length-1:(index+(e.key==='ArrowDown'?1:-1)+options.length)%options.length].focus();
    });
  }
  $('#search-toggle').addEventListener('click',()=>{settings.searchEnabled=!settings.searchEnabled;persistControls();renderControls();});
  $('#tools-toggle').addEventListener('click',()=>{settings.toolsEnabled=!settings.toolsEnabled;persistControls();renderControls();});
  $('#composer').addEventListener('submit',e=>{e.preventDefault();if(busy){controller?.abort();return;}send();});$('#message-input').addEventListener('input',resizeInput);$('#message-input').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();send();}});
  $('#install-button').addEventListener('click',install);
  $('#connect-backend').addEventListener('click',()=>connectBackend());$('#disconnect-backend').addEventListener('click',()=>{if(busy){toast('请先停止当前回答');return;}if(backend)backend.disconnect();sessionStorage.removeItem('luma.backend');settings={...DEFAULTS,...read(localStorage,'luma.settings',{})};secrets=read(settings.remember?localStorage:sessionStorage,'luma.keys',{});chats=read(localStorage,'luma.chats',[]);current=chats.find(c=>c.id===read(localStorage,'luma.active',''))||chats[0]||blankChat();renderControls();renderMessages();renderHistory();$('#backend-state').textContent='已断开';openSettings('api');});
  $('#settings-button').addEventListener('click',()=>openSettings());$('#settings-close').addEventListener('click',closeSettings);$('#settings-cancel').addEventListener('click',closeSettings);$('#settings-save').addEventListener('click',saveSettings);$('#test-connection').addEventListener('click',testConnection);$('#remember-toggle').addEventListener('click',()=>{settingsDraft.remember=!settingsDraft.remember;$('#remember-toggle').setAttribute('aria-checked',String(settingsDraft.remember));});
  $('#tool-authoring-button').addEventListener('click',()=>toolManager?.author());
  $$('[data-tab]').forEach(b=>b.addEventListener('click',()=>selectTab(b.dataset.tab)));$$('[data-reveal]').forEach(b=>b.addEventListener('click',()=>{const t=$('#'+b.dataset.reveal);t.type=t.type==='password'?'text':'password';b.setAttribute('aria-label',t.type==='password'?'显示密钥':'隐藏密钥');}));
  const presets={clear:DEFAULTS.systemPrompt,writing:'你是一位有温度的中文写作伙伴。先了解主题、读者与场景，再帮助打磨文字。保留作者的个性，用具体、有画面感的表达，避免空话。',code:'你是一位严谨、耐心的编程助手。先澄清目标和约束，再给出可运行的代码。解释关键设计与边界情况；不确定的依赖行为明确说明。'};
  $$('[data-preset]').forEach(b=>b.addEventListener('click',()=>{$('#system-prompt').value=presets[b.dataset.preset];}));
  $('#export-all').addEventListener('click',exportAll);$('#clear-chats').addEventListener('click',()=>{if(busy){toast('请先停止当前回答。');return;}confirmAction('清空所有对话？','聊天记录将被删除。',async()=>{try{if(backend?.connected)await backend.clear();chats=[];current=blankChat();saveChats();renderMessages();renderHistory();toast('对话已清空');}catch(e){toast(e.message);}});});
  $('#forget-keys').addEventListener('click',async()=>{if(busy){toast('请先停止当前回答。');return;}testController?.abort();secrets={};settings.remember=false;settingsDraft={remember:false};$('#settings-save').disabled=false;$('#test-connection').disabled=false;$('#remember-toggle').setAttribute('aria-checked','false');$('#api-key').value='';$('#search-key').value='';try{if(backend?.connected){await backend.forget();$('#api-key').placeholder='sk-…';$('#search-key').placeholder='留空复用 DeepSeek Key';}else{localStorage.removeItem('luma.keys');sessionStorage.removeItem('luma.keys');}write(localStorage,backend?.connected?'luma.backend.settings':'luma.settings',settings);renderControls();toast('密钥已移除');}catch(e){toast(e.message);}});
  $('#chat-menu').addEventListener('click',e=>{const b=e.target.closest('[data-chat-action]');if(!b)return;closeMenus();if(busy){toast('请先停止当前回答。');return;}if(!current.messages.length){toast('当前还没有对话。');return;}const action=b.dataset.chatAction;if(action==='export')exportCurrent();if(action==='delete')confirmAction('删除这段对话？','这将删除「'+current.title+'」的本地记录。',async()=>{const id=current.id;try{if(backend?.connected)await backend.remove(id);chats=chats.filter(c=>c.id!==id);if(current.id===id)current=blankChat();saveChats();renderMessages();renderHistory();}catch(e){toast(e.message);}});if(action==='rename'){modal('给对话一个名字','<label class="field-label" for="rename-input">对话名称</label><input class="field-input" id="rename-input" maxlength="60" value="'+C.escape(current.title)+'">',[{label:'取消',fn:closeSmall},{label:'保存',primary:true,fn:async()=>{const id=current.id,name=$('#rename-input').value.trim();if(!name){$('#rename-input').focus();return;}try{if(backend?.connected){const {session}=await backend.rename(id,name);const i=chats.findIndex(c=>c.id===id);if(i>=0)chats[i]={...session,serverStored:true};if(current.id===id)current=chats[i];saveChats();renderHistory();}else{current.title=name;rememberCurrent();}renderMessages();closeSmall();}catch(e){toast(e.message);}}}],'pen');$('#rename-input').focus();$('#rename-input').select();}});
  $('#messages').addEventListener('click',async e=>{const choice=e.target.closest('[data-reply-choice]');if(choice){const m=current.messages.at(-1),index=Number(choice.dataset.replyChoice);if(!m||!canReplyChoices(m)||m.id!==choice.dataset.replyId||!Number.isInteger(index)||index<0)return;const options=C.extractReplyChoices(C.splitAssistantContent(m.content).content)?.options;if(options?.[index])send(choiceText(options[index]));return;}const approval=e.target.closest('[data-approval-id]');if(approval){const id=approval.dataset.approvalId;if(!busy||!backend?.connected||pendingApprovals.has(id))return;pendingApprovals.add(id);const m=current.messages.at(-1);streamRender(m);try{await backend.request('tool-approvals/'+encodeURIComponent(id),{method:'POST',data:{allow:approval.dataset.allow==='true'}});}catch(error){toast(error.message);}finally{pendingApprovals.delete(id);streamRender(m);}return;}const reason=e.target.closest('[data-reason-id]');if(reason){const id=reason.dataset.reasonId;expanded.has(id)?expanded.delete(id):expanded.add(id);reason.setAttribute('aria-expanded',String(expanded.has(id)));reason.nextElementSibling.hidden=!expanded.has(id);return;}const cp=e.target.closest('[data-copy-id]');if(cp){copy(answerContent(current.messages.find(m=>m.id===cp.dataset.copyId)));return;}const retry=e.target.closest('[data-retry-id]');if(retry){const user=current.messages.findLast(m=>m.role==='user');send(user.content,true);return;}const code=e.target.closest('.code-copy');if(code)copy(code.closest('.code-block').querySelector('pre code').textContent);});
  $('#mobile-menu').addEventListener('click',()=>{const open=!$('#sidebar').classList.contains('open');$('#sidebar').classList.toggle('open',open);$('#sidebar-mask').hidden=!open;$('#mobile-menu').setAttribute('aria-expanded',String(open));});$('#sidebar-mask').addEventListener('click',closeSidebar);
  $('#small-close').addEventListener('click',closeSmall);$('#small-overlay').addEventListener('click',e=>{if(e.target===e.currentTarget)closeSmall();});$('#settings-overlay').addEventListener('click',e=>{if(e.target===e.currentTarget)closeSettings();});
  // Selecting a model replaces its option; the original event path stays intact.
  document.addEventListener('click',e=>{if(!e.composedPath().some(node=>node.classList?.contains('dropdown')))closeMenus();});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){if(!$('#small-overlay').hidden)closeSmall();else if(!$('#settings-overlay').hidden)closeSettings();else{closeMenus(true);closeSidebar();}}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();if($('#small-overlay').hidden&&$('#settings-overlay').hidden)startNew();}if(e.key==='Tab'){const overlay=!$('#small-overlay').hidden?$('#small-dialog'):!$('#settings-overlay').hidden?$('#settings-dialog'):null;if(overlay){const focusables=[...overlay.querySelectorAll('button,a[href],input,textarea,[tabindex="0"]')].filter(x=>x.getClientRects().length&&!x.disabled);const first=focusables[0],last=focusables.at(-1);if(e.shiftKey&&(document.activeElement===first||document.activeElement===overlay)){e.preventDefault();last?.focus();}else if(!e.shiftKey&&(document.activeElement===last||document.activeElement===overlay)){e.preventDefault();first?.focus();}}}});
  renderControls();renderHistory();renderMessages();if(current.messages.length)scrollBottom(true);
  if(backend){if(location.protocol==='http:'&&['127.0.0.1','localhost'].includes(location.hostname))connectBackend(true);else{const paired=read(sessionStorage,'luma.backend',null);if(paired){$('#backend-url').value=paired.baseURL;$('#backend-token').value=paired.token;connectBackend();}}}
})();
