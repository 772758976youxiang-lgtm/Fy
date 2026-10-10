'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../storage');
const {runAgent}=require('../agent');
const {createService}=require('../server');

function fixture(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'luma-custom-integration-'));
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const store=new Store(directory);store.saveSettings({apiKey:'main-private-key',toolsEnabled:true,searchEnabled:false});return store;
}
function tool(overrides={}){return {name:'helper',label:'Helper',description:'Summarize input',kind:'http',enabled:true,parameters:[{name:'prompt',type:'string',required:true}],config:{url:'https://tools.example.test/run',body:{input:'{{args.prompt}}'},output:'json'},...overrides};}
function completion(delta,finish='stop'){return new Response('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:finish}]})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});}
function call(name='helper',args={prompt:'hello'}){return completion({tool_calls:[{index:0,id:'call-custom',type:'function',function:{name,arguments:JSON.stringify(args)}}]},'tool_calls');}
async function service(t,store,fetchImpl){const s=createService({store,fetchImpl,token:'test-token'});await new Promise(r=>s.server.listen(0,'127.0.0.1',r));t.after(()=>s.close());const base='http://127.0.0.1:'+s.server.address().port;const request=async(route,data,method=data?'POST':'GET')=>{const r=await fetch(base+'/api/'+route,{method,headers:{Authorization:'Bearer test-token','Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});return {status:r.status,data:await r.json()};};return {s,base,request};}

test('custom definitions expose only dynamic arguments and tool execution is on demand',async t=>{
 const store=fixture(t);store.saveTool({...tool(),apiKey:'custom-private-key'});let rounds=0,executions=0;const payloads=[];
 const session=await runAgent({store,request:{sessionId:'custom-chat',message:'Summarize'},fetchImpl:async(url,init)=>{
  if(url==='https://tools.example.test/run'){executions++;assert.equal(new Headers(init.headers).get('Authorization'),'Bearer custom-private-key');assert.deepEqual(JSON.parse(init.body),{input:'hello'});return Response.json({value:'custom-private-key reflected'});}
  payloads.push(JSON.parse(init.body));return rounds++?completion({content:'Done'}):call();
 }});
 assert.equal(executions,1);const exposed=payloads[0].tools.find(x=>x.function.name==='helper');
 assert.deepEqual(Object.keys(exposed.function.parameters.properties),['prompt']);
 assert.doesNotMatch(JSON.stringify(exposed),/custom-private-key|tools\.example|systemPrompt/);
 assert.doesNotMatch(JSON.stringify(session),/custom-private-key/);
 assert.match(session.apiMessages.find(x=>x.role==='tool').content,/redacted|密钥已隐藏/);
 assert.equal(session.messages.at(-1).tools[0].label,'Helper');
 assert.equal(session.messages.at(-1).status,'done');
});

test('disabled custom tool is absent and cannot execute if model requests it',async t=>{
 const store=fixture(t);store.saveTool(tool({enabled:false}));let rounds=0,executions=0;
 const result=await runAgent({store,request:{sessionId:'disabled-custom',message:'Hello'},fetchImpl:async(url,init)=>{
  if(url.includes('tools.example')){executions++;return Response.json({});}
  assert.ok(!JSON.parse(init.body).tools.some(x=>x.function.name==='helper'));
  return rounds++?completion({content:'Unavailable'}):call();
 }});
 assert.equal(executions,0);assert.match(result.apiMessages.find(x=>x.role==='tool').content,/error/);
});

test('custom-tool routes protect keys, support CRUD and validate trial arguments before network',async t=>{
 const store=fixture(t);let executions=0;const {base,request}=await service(t,store,async()=>{executions++;return Response.json({ok:true});});
 assert.equal((await fetch(base+'/api/custom-tools')).status,401);
 const saved=await request('custom-tools',{...tool(),apiKey:'custom-private-key'});assert.equal(saved.status,200);assert.equal(saved.data.tool.hasApiKey,true);assert.doesNotMatch(JSON.stringify(saved.data),/custom-private-key/);
 const id=saved.data.tool.id;
 assert.equal((await request('custom-tools')).data.tools.length,1);
 const invalid=await request('custom-tools/test',{id,args:{prompt:'hello',url:'https://bad.test'}});assert.equal(invalid.status,400);assert.equal(executions,0);
 const result=await request('custom-tools/test',{id,args:{prompt:'hello'}});assert.equal(result.status,200);assert.equal(executions,1);
 const changed=await request('custom-tools',{...saved.data.tool,label:'Updated',apiKey:''});assert.equal(changed.data.tool.hasApiKey,true);
 await request('custom-tools/'+id,undefined,'DELETE');assert.equal((await request('custom-tools')).data.tools.length,0);
});

test('trial confirmation has no side effects and draft errors redact draft keys',async t=>{
 const store=fixture(t);let executions=0;const {request}=await service(t,store,async()=>{executions++;throw new Error('fail draft-private-key');});
 const draft={...tool({requireConfirmation:true}),apiKey:'draft-private-key'};
 const pending=await request('custom-tools/test',{tool:draft,args:{prompt:'hello'}});assert.equal(pending.data.requiresConfirmation,true);assert.equal(executions,0);
 const result=await request('custom-tools/test',{tool:draft,args:{prompt:'hello'},confirmed:true});assert.equal(executions,1);assert.equal(result.status,400);assert.doesNotMatch(JSON.stringify(result),/draft-private-key/);
});

test('duplicate route requires authentication, returns public configuration and never executes tools',async t=>{
 const store=fixture(t);let executions=0;
 const source=store.saveTool({...tool(),apiKey:'copy-private-key',rememberKey:true});
 const {base,request}=await service(t,store,async()=>{executions++;throw new Error('Duplication must not execute');});
 const route='custom-tools/'+source.id+'/duplicate';
 assert.equal((await fetch(base+'/api/'+route,{method:'POST'})).status,401);
 assert.equal(store.listTools().length,1);
 const result=await request(route,{},'POST');
 assert.equal(result.status,200);
 assert.equal(result.data.tool.enabled,false);
 assert.equal(result.data.tool.name,'helper_copy');
 assert.equal(result.data.tool.hasApiKey,true);
 assert.doesNotMatch(JSON.stringify(result.data),/copy-private-key|"apiKey":/);
 assert.equal(store.getTool(result.data.tool.id).apiKey,'copy-private-key');
 assert.equal((await request(route,{},'POST')).data.tool.name,'helper_copy_2');
 assert.equal((await request('custom-tools/missing/duplicate',{},'POST')).status,404);
 assert.equal((await request(route)).status,404);
 assert.equal(store.listTools().length,3);
 assert.equal(executions,0);
});

test('chat confirmation is one-use, denies execution, and remains inside tool process',async t=>{
 const store=fixture(t);store.saveTool(tool({requireConfirmation:true}));let rounds=0,executions=0;
 const {base,request}=await service(t,store,async url=>{if(url.includes('tools.example')){executions++;return Response.json({ok:true});}return rounds++?completion({content:'Not executed'}):call();});
 const response=await fetch(base+'/api/chat',{method:'POST',headers:{Authorization:'Bearer test-token','Content-Type':'application/json'},body:JSON.stringify({sessionId:'approval',message:'Run helper'})});
 const reader=response.body.getReader();let stream='',approvalId;
 while(!approvalId){const {value,done}=await reader.read();assert.equal(done,false);stream+=new TextDecoder().decode(value);for(const line of stream.split('\n'))if(line.startsWith('data: ')){try{approvalId=JSON.parse(line.slice(6)).tools?.find(x=>x.approvalId)?.approvalId||approvalId;}catch{}}}
 assert.equal(executions,0);
 assert.equal((await request('tool-approvals/'+approvalId,{allow:false})).status,200);
 assert.equal((await request('tool-approvals/'+approvalId,{allow:true})).status,404);
 while(true){const {value,done}=await reader.read();if(done)break;stream+=new TextDecoder().decode(value);}
 assert.equal(executions,0);const session=store.getSession('approval');assert.equal(session.messages.at(-1).status,'done');assert.equal(session.messages.at(-1).tools[0].approvalId,undefined);
 assert.match(stream,/等待确认/);assert.match(session.apiMessages.find(x=>x.role==='tool').content,/error/);
});

test('abort clears pending approvals and marks the tool as stopped',async t=>{
 const store=fixture(t);store.saveTool(tool({requireConfirmation:true}));let executions=0;
 const {base,request}=await service(t,store,async url=>{if(url.includes('tools.example'))executions++;return call();});
 const response=await fetch(base+'/api/chat',{method:'POST',headers:{Authorization:'Bearer test-token','Content-Type':'application/json'},body:JSON.stringify({sessionId:'cancel-approval',message:'Run helper'})});
 const reader=response.body.getReader();let buffer='',approvalId;
 while(!approvalId){const {value,done}=await reader.read();assert.equal(done,false);buffer+=new TextDecoder().decode(value);for(const line of buffer.split('\n'))if(line.startsWith('data: ')){try{approvalId=JSON.parse(line.slice(6)).tools?.find(x=>x.approvalId)?.approvalId||approvalId;}catch{}}}
 await request('cancel/cancel-approval',{});while(!(await reader.read()).done){}
 assert.equal((await request('tool-approvals/'+approvalId,{allow:true})).status,404);assert.equal(executions,0);
 const event=store.getSession('cancel-approval').messages.at(-1).tools[0];assert.equal(event.approvalId,undefined);assert.equal(event.state,'已停止');
});
