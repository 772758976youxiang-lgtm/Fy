'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const T=require('../ui/tool-config');
const sharedFile=path.join(__dirname,'../ui/tool-authoring.js');
const backendFile=path.join(__dirname,'../tool-authoring.js');
const A=fs.existsSync(sharedFile)?require(sharedFile):{};
const B=fs.existsSync(backendFile)?require(backendFile):{};
const {Store}=require('../storage');
const {createService}=require('../server');

function draft(kind='http'){const tool=T.createTemplate(kind);tool.name='draft_tool';tool.config.url='https://tool.example.test/run';tool.config.model='image-model';return tool;}
function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'luma-authoring-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const store=new Store(directory);store.saveSettings({apiKey:'fake-main-private-key',searchKey:'fake-search-private-key',baseURL:'https://model.example.test/v1',model:'saved-model',customModel:'chosen-custom-model',effort:'max',systemPrompt:'DO NOT COPY CHAT PROMPT'});return store;}
function completion(tool=draft(),options={}){const content=typeof tool==='string'?tool:JSON.stringify(tool);return new Response('data: '+JSON.stringify({choices:[{delta:{content},finish_reason:options.finish||'stop'}]})+'\n\n'+(options.truncated?'':'data: [DONE]\n\n'),{headers:{'Content-Type':'text/event-stream'}});}
function jsonCompletion(tool=draft()){return Response.json({choices:[{message:{content:JSON.stringify(tool)},finish_reason:'stop'}]});}
async function service(t,store,fetchImpl){const s=createService({store,fetchImpl,token:'local-test-token'});await new Promise(r=>s.server.listen(0,'127.0.0.1',r));t.after(()=>s.close());const base='http://127.0.0.1:'+s.server.address().port;const request=async(input,auth=true)=>{const response=await fetch(base+'/api/custom-tools/generate',{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer local-test-token'}:{})},body:JSON.stringify(input)});return {status:response.status,data:await response.json()};};return {s,base,request};}

test('authoring exposes shared sanitization, validation and local apply helpers',()=>{
 for(const name of ['sanitizeInput','validateSuggestion','applySuggestion'])assert.equal(typeof A[name],'function',name);
 assert.equal(typeof B.generateToolDraft,'function');
});

test('generated LLM base URLs become complete chat endpoints in the preview',()=>{
 const input=draft('llm');input.config.url='https://api.deepseek.com/';
 const result=A.validateSuggestion(input);
 assert.equal(result.tool.config.url,'https://api.deepseek.com/chat/completions');
 assert.equal(input.config.url,'https://api.deepseek.com/');
 assert.equal(A.validateSuggestion({kind:'llm'}).tool.config.url,'');
});

test('sanitization strips metadata and credentials from every draft text location', {skip:!A.sanitizeInput},()=>{
 const tool=draft();Object.assign(tool,{id:'local-id',apiKey:'fake-draft-key',hasApiKey:true,rememberKey:true,removeKey:false});
 tool.config.headers={'Authorization':'Bearer fake-header-key','Content-Type':'application/json'};tool.config.env={TOKEN:'fake-env-key'};
 tool.config.body={api_key:'fake-body-key',nested:{password:'fake-password'},prompt:'fake-draft-key fake-header-key fake-env-key'};
 tool.description='fake-main-key fake-draft-key fake-body-key';
 tool.config.url='https://username:fake-url-password@tool.example.test/run?api_key=fake-query-key&format=json';
 const safe=A.sanitizeInput({prompt:'Use fake-draft-key, fake-main-key. Authorization: Bearer pasted-token-value\nX-API-Key: pasted-other-value',tool},{secrets:['fake-main-key']});
 const text=JSON.stringify(safe);assert.doesNotMatch(text,/fake-(main|draft|header|env|body|password|url-password|query)-key|fake-password|pasted-token-value|pasted-other-value|username|fake-url-password/);
 for(const name of ['id','apiKey','hasApiKey','rememberKey','removeKey','enabled'])assert.equal(Object.hasOwn(safe.tool,name),false,name);
 assert.doesNotMatch(text,/application\/json/);assert.match(safe.tool.config.url,/format=json/);
 assert.equal(tool.apiKey,'fake-draft-key');
});

test('draft validation supplies defaults while leaving absent required provider values blank', {skip:!A.validateSuggestion},()=>{
 for(const kind of ['http','llm','judge','image','video','cli','mcp']){
  const result=A.validateSuggestion({kind,name:'',config:{poll:{enabled:false}}});
  assert.equal(result.tool.name,'');assert.ok(result.missingFields.includes('name'));
  assert.ok(result.missingFields.includes(kind==='cli'?'config.executable':'config.url'));
  if(kind==='llm'||kind==='judge')assert.ok(result.missingFields.includes('config.model'));
  if(kind==='mcp')assert.ok(result.missingFields.includes('config.mcpTool'));
  assert.equal(result.tool.config.url,'');assert.equal(result.tool.config.model,'');assert.ok(result.tool.config.poll.intervalMs);
  assert.doesNotMatch(JSON.stringify(result),/authoring-validator|example\.invalid/);
 }
 const poll=A.validateSuggestion({kind:'video',name:'video_tool',config:{poll:{enabled:true}}});
 assert.ok(poll.missingFields.includes('config.poll.url'));assert.equal(poll.tool.config.poll.url,'');
});

test('validation rejects invalid nonempty fields, structures and unsafe templates', {skip:!A.validateSuggestion},()=>{
 const inputs=[{...draft(),name:'bad name'},{...draft(),kind:'unknown'},{...draft(),config:{url:'file:///tmp'}},{...draft(),config:{url:'https://tool.test',unexpected:true}},{...draft(),parameters:[{name:'model',type:'string'}]},{...draft(),parameters:[{name:'count',type:'integer',default:'two'}]},JSON.parse('{"name":"x","config":{"body":{"__proto__":{"polluted":true}}}}'),{...draft(),config:{url:'https://tool.test',body:{x:'{{config.apiKey}}'}}},{...draft(),config:{url:'https://tool.test',body:{x:'{{args.unknown}}'}}}];
 for(const input of inputs)assert.throws(()=>A.validateSuggestion(input));
 assert.equal({}.polluted,undefined);
});

test('candidate drops generated credentials and save-only metadata', {skip:!A.validateSuggestion},()=>{
 const tool=draft();Object.assign(tool,{id:'injected-id',apiKey:'generated-key',rememberKey:true,enabled:false,hasApiKey:true,removeKey:true});
 tool.config.headers={Authorization:'Bearer generated-header-secret','Content-Type':'application/json'};tool.config.env={API_TOKEN:'generated-env-secret'};tool.config.body={api_key:'generated-body-secret',prompt:'{{args.prompt}}'};
 const result=A.validateSuggestion(tool).tool;
 assert.doesNotMatch(JSON.stringify(result),/generated-(key|header-secret|env-secret|body-secret)|injected-id/);
 for(const key of ['id','apiKey','rememberKey','enabled','hasApiKey','removeKey'])assert.equal(Object.hasOwn(result,key),false);
 assert.equal(result.config.headers['Content-Type'],'application/json');
});

test('local apply preserves identity, flags, confirmation and existing credential paths', {skip:!A.applySuggestion},()=>{
 const current=draft();Object.assign(current,{id:'existing-id',apiKey:'local-key',hasApiKey:true,rememberKey:true,removeKey:false,enabled:false,requireConfirmation:true});
 current.config.headers={Authorization:'Bearer local-header','X-Mode':'private-mode'};current.config.env={TOKEN:'local-env'};
 current.config.body={secret:'local-body',nested:{access_token:'nested-secret'}};current.config.url='https://tool.example.test/run?token=local-query';
 const candidate={name:'new_name',kind:'http',requireConfirmation:false,config:{url:'https://tool.example.test/new',body:{input:'{{args.prompt}}'},poll:{enabled:false}}};
 const result=A.applySuggestion(current,candidate);
 for(const key of ['id','apiKey','hasApiKey','rememberKey','removeKey','enabled'])assert.equal(result[key],current[key]);
 assert.equal(result.requireConfirmation,true);assert.deepEqual(result.config.headers,current.config.headers);assert.deepEqual(result.config.env,current.config.env);
 assert.equal(result.config.body.secret,'local-body');assert.equal(result.config.body.nested.access_token,'nested-secret');assert.equal(result.config.body.input,'{{args.prompt}}');
 assert.match(result.config.url,/token=local-query/);assert.ok(result.config.poll.intervalMs);assert.equal(result.name,'new_name');assert.equal(current.name,'draft_tool');
});

test('generation uses only saved main model settings with no tool calls or state writes', {skip:!B.generateToolDraft},async t=>{
 const store=fixture(t);store.saveTool({...draft(),apiKey:'saved-tool-secret'});const before=fs.readdirSync(store.directory).map(name=>[name,fs.readFileSync(path.join(store.directory,name),'utf8')]);
 let calls=0;
 const result=await B.generateToolDraft({store,input:{prompt:'Make an image tool',tool:draft()},fetchImpl:async(url,init)=>{
  calls++;assert.equal(url,'https://model.example.test/v1/chat/completions');assert.equal(new Headers(init.headers).get('Authorization'),'Bearer fake-main-private-key');
  const payload=JSON.parse(init.body);assert.equal(payload.model,'chosen-custom-model');assert.equal(payload.reasoning_effort,'max');assert.equal(payload.thinking.type,'enabled');assert.equal(payload.tools,undefined);assert.equal(payload.tool_choice,undefined);assert.equal(payload.messages.length,2);assert.equal(payload.messages[0].role,'system');assert.equal(payload.messages[1].role,'user');assert.doesNotMatch(init.body,/DO NOT COPY CHAT PROMPT|fake-main-private-key|saved-tool-secret/);assert.equal(init.redirect,'error');return completion();
 }});
 assert.equal(calls,1);assert.equal(result.model,'chosen-custom-model');assert.equal(result.tool.name,'draft_tool');assert.deepEqual(result.missingFields,[]);
 assert.deepEqual(fs.readdirSync(store.directory).map(name=>[name,fs.readFileSync(path.join(store.directory,name),'utf8')]),before);
});

test('generation rejects invalid input and missing main credentials before network', {skip:!B.generateToolDraft},async t=>{
 const store=fixture(t);let calls=0;const fetchImpl=async()=>{calls++;return completion();};
 for(const input of [{prompt:''},{prompt:' '},{prompt:'x'.repeat(24001)},{prompt:4},{prompt:'ok',tool:{description:'x'.repeat(131073)}},{prompt:'ok',tool:[]},{prompt:'ok',model:'override'},{prompt:'ok',apiKey:'override'},{prompt:'ok',tool:JSON.parse('{"__proto__":{}}')}])await assert.rejects(B.generateToolDraft({store,input,fetchImpl}));
 store.saveSettings({apiKey:''});await assert.rejects(B.generateToolDraft({store,input:{prompt:'ok'},fetchImpl}),/API Key/);assert.equal(calls,0);
});

test('generation supports JSON and exact JSON fences but rejects malformed or tool-call responses', {skip:!B.generateToolDraft},async t=>{
 const store=fixture(t),run=response=>B.generateToolDraft({store,input:{prompt:'Create tool'},fetchImpl:async()=>response});
 assert.equal((await run(jsonCompletion())).tool.name,'draft_tool');
 assert.equal((await run(completion('```json\n'+JSON.stringify(draft())+'\n```'))).tool.name,'draft_tool');
 for(const response of [completion('Here is the JSON: '+JSON.stringify(draft())),completion('{broken'),completion('[]'),completion(JSON.stringify(draft()),{finish:'length'}),completion('{}',{finish:'tool_calls'}),Response.json({choices:[{message:{tool_calls:[{function:{name:'x'}}]},finish_reason:'tool_calls'}]}),new Response('data: '+JSON.stringify({choices:[{delta:{content:'{}'}}]})+'\n\n')])await assert.rejects(run(response));
});

test('request, successful response and errors redact saved and draft secrets', {skip:!B.generateToolDraft},async t=>{
 const store=fixture(t);store.saveTool({...draft(),apiKey:'saved-tool-private'});const tool={...draft(),apiKey:'draft-private'};tool.config.headers={Authorization:'header-private'};tool.config.body={password:'body-private'};
 const secrets=['fake-main-private-key','fake-search-private-key','saved-tool-private','draft-private','header-private','body-private'];
 const result=await B.generateToolDraft({store,input:{prompt:secrets.join(' '),tool},fetchImpl:async(url,init)=>{for(const secret of secrets)assert.ok(!init.body.includes(secret),secret);const output=draft();output.description=secrets.join(' ');return completion(output);}});
 for(const secret of secrets)assert.ok(!JSON.stringify(result).includes(secret),secret);
 await assert.rejects(B.generateToolDraft({store,input:{prompt:'Make it',tool},fetchImpl:async()=>{throw new Error(secrets.join(' '));}}),error=>secrets.every(secret=>!error.message.includes(secret)));
});

test('response byte limits cancel readers and candidate limits reject oversized JSON', {skip:!B.generateToolDraft},async t=>{
 const store=fixture(t);let canceled=false;
 const stream=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('x'.repeat(1048577)));},cancel(){canceled=true;}});
 await assert.rejects(B.generateToolDraft({store,input:{prompt:'Create'},fetchImpl:async()=>new Response(stream)}),/过大|limit|large/i);assert.equal(canceled,true);
 await assert.rejects(B.generateToolDraft({store,input:{prompt:'Create'},fetchImpl:async()=>completion(JSON.stringify({...draft(),description:'x'.repeat(131073)}))}),/过大|limit|large/i);
});

test('cancellation interrupts a stalled upstream reader and releases it', {skip:!B.generateToolDraft},async t=>{
 const store=fixture(t),ctl=new AbortController();let canceled=false,started;
 const ready=new Promise(resolve=>{started=resolve;});
 const pending=B.generateToolDraft({store,input:{prompt:'Create'},signal:ctl.signal,fetchImpl:async()=>{started();return new Response(new ReadableStream({cancel(){canceled=true;}}));}});
 await ready;ctl.abort(new Error('stop now'));await assert.rejects(pending,/取消|停止|stop|abort/i);assert.equal(canceled,true);
});

test('generation route requires authentication and never saves a candidate',async t=>{
 const store=fixture(t);let calls=0;const {request}=await service(t,store,async()=>{calls++;return completion();});
 assert.equal((await request({prompt:'Create'},false)).status,401);assert.equal(calls,0);
 const result=await request({prompt:'Create'});assert.equal(result.status,200);assert.equal(result.data.tool.name,'draft_tool');assert.equal(calls,1);assert.equal(store.listTools().length,0);assert.equal(store.listSessions().length,0);
});

test('route tracks generation for credential deletion and cancels on shutdown',async t=>{
 const store=fixture(t);let begin,aborted=false;const started=new Promise(resolve=>{begin=resolve;});
 const {s,base,request}=await service(t,store,async(url,init)=>{begin();return await new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>{aborted=true;reject(init.signal.reason);},{once:true}));});
 const pending=request({prompt:'Create'});await Promise.race([started,new Promise((resolve,reject)=>setTimeout(()=>reject(new Error('generation was not started')),1000))]);
 const deletion=await fetch(base+'/api/credentials',{method:'DELETE',headers:{Authorization:'Bearer local-test-token'}});assert.equal(deletion.status,409);
 await s.close();await pending;assert.equal(aborted,true);
});

test('missing model references survive repeated validation without invented values',()=>{
 for(const kind of ['image','video','http']){
  const result=A.validateSuggestion({kind,name:'model_tool',config:{body:{model:'{{config.model}}'}}});
  assert.ok(result.missingFields.includes('config.model'));assert.equal(result.tool.config.model,'');
  assert.deepEqual(A.validateSuggestion(result.tool),result);
 }
});

test('credential placeholders are preserved and primitive credential body values are removed',()=>{
 const input=draft();input.parameters.push({name:'access_token',type:'string'});
 input.config.body={access_token:'{{args.access_token}}',client_secret:12345,options:{password:false},message:'token={{args.access_token}}'};
 const result=A.validateSuggestion(input).tool;
 assert.equal(result.config.body.access_token,'{{args.access_token}}');assert.equal(result.config.body.message,'token={{args.access_token}}');
 assert.equal(result.config.body.client_secret,'');assert.equal(result.config.body.options.password,'');
});

test('malformed nested configs, invalid templates and oversized multibyte drafts fail validation',()=>{
 for(const config of [[],false,{poll:[]},{poll:null},{body:{x:'{{args.prompt.}}'}},{body:{x:'{{config.model.extra}}'}}])assert.throws(()=>A.validateSuggestion({...draft(),config}));
 assert.throws(()=>A.sanitizeInput({prompt:'Create',tool:{description:'汉'.repeat(50000)}}));
});

test('generated nonsecret headers remain useful while pasted document secrets cannot be echoed',async t=>{
 const store=fixture(t),tool=draft();tool.config.headers={'Content-Type':'application/json'};
 const prompt='Use Authorization: Bearer pasted-only-token\nX-API-Key: pasted-only-api\nURL https://docuser:docpass@tool.example.test/run?token=query-only-value\n{"client_secret":"json-only-value"}';
 const secrets=['pasted-only-token','pasted-only-api','docuser','docpass','query-only-value','json-only-value'];
 const result=await B.generateToolDraft({store,input:{prompt},fetchImpl:async(url,init)=>{for(const secret of secrets)assert.ok(!init.body.includes(secret));tool.description=secrets.join(' ');return jsonCompletion(tool);}});
 assert.equal(result.tool.config.headers['Content-Type'],'application/json');for(const secret of secrets)assert.ok(!JSON.stringify(result).includes(secret));
 await assert.rejects(B.generateToolDraft({store,input:{prompt},fetchImpl:async()=>Response.json({error:{message:secrets.join(' ')}},{status:400})}),error=>secrets.every(secret=>!error.message.includes(secret)));
});

test('disconnecting the HTTP client aborts the generation request',async t=>{
 const store=fixture(t);let started,aborted;const ready=new Promise(resolve=>{started=resolve;}),stopped=new Promise(resolve=>{aborted=resolve;});
 const {base}=await service(t,store,async(url,init)=>{started();return await new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>{aborted();reject(init.signal.reason);},{once:true}));});
 const ctl=new AbortController();const pending=fetch(base+'/api/custom-tools/generate',{method:'POST',headers:{Authorization:'Bearer local-test-token','Content-Type':'application/json'},body:JSON.stringify({prompt:'Create'}),signal:ctl.signal});
 await ready;ctl.abort();await assert.rejects(pending);await stopped;
});

test('documentation type annotations and credential placeholders do not corrupt the config schema',()=>{
 const result=A.sanitizeInput({prompt:'api_key: string\nclient_secret: null\nAuthorization: Bearer <YOUR_API_KEY>\nUse an HTTP tool',tool:draft()});
 assert.equal(result.tool.parameters[0].type,'string');assert.equal(result.tool.config.effort,'none');
});

test('nested credential objects and custom auth headers are not disclosed in descriptions',()=>{
 const input=draft();input.config.authHeader='X-Custom-Auth';input.config.headers={'X-Custom-Auth':'custom-auth-value'};
 input.config.body={credentials:{username:'credential-user',pass:'credential-pass'}};input.description='custom-auth-value credential-user credential-pass';
 const result=A.sanitizeInput({prompt:input.description,tool:input});
 assert.doesNotMatch(JSON.stringify(result),/custom-auth-value|credential-user|credential-pass/);
});

test('generation enforces its 120 second total deadline',async t=>{
 const store=fixture(t);t.mock.timers.enable({apis:['setTimeout']});let started,canceled=false;
 const ready=new Promise(resolve=>{started=resolve;});
 const pending=B.generateToolDraft({store,input:{prompt:'Create'},fetchImpl:async()=>{started();return new Response(new ReadableStream({cancel(){canceled=true;}}));}});
 await ready;await Promise.resolve();t.mock.timers.tick(120000);
 await assert.rejects(pending,/超时/);assert.equal(canceled,true);
});

test('credential parameter defaults and enums are withheld and restored only to matching local parameters',async t=>{
 const tool=draft();tool.parameters=[{name:'access_token',type:'string',default:'parameter-private-default',enum:['parameter-private-default','parameter-private-option']}];tool.config.body={access_token:'{{args.access_token}}'};tool.description='parameter-private-default parameter-private-option';
 const safe=A.sanitizeInput({prompt:tool.description,tool});assert.doesNotMatch(JSON.stringify(safe),/parameter-private-(default|option)/);assert.equal(Object.hasOwn(safe.tool.parameters[0],'default'),false);assert.equal(Object.hasOwn(safe.tool.parameters[0],'enum'),false);
 const generated=A.validateSuggestion(tool).tool;assert.equal(Object.hasOwn(generated.parameters[0],'default'),false);assert.equal(Object.hasOwn(generated.parameters[0],'enum'),false);
 const applied=A.applySuggestion(tool,generated);assert.equal(applied.parameters[0].default,'parameter-private-default');assert.deepEqual(applied.parameters[0].enum,tool.parameters[0].enum);
 const store=fixture(t);const response=await B.generateToolDraft({store,input:{prompt:'Create',tool},fetchImpl:async()=>completion({...draft(),description:tool.description})});assert.doesNotMatch(JSON.stringify(response),/parameter-private-(default|option)/);
});

test('all recognized credential field names in pasted text are redacted from requests and errors',async t=>{
 const prompt='token = pasted-token-value; secret = pasted-secret-value; passwd = pasted-password-value; access_key = pasted-access-value; secret_key = pasted-key-value; X-Token: pasted-header-value';
 const values=['pasted-token-value','pasted-secret-value','pasted-password-value','pasted-access-value','pasted-key-value','pasted-header-value'];
 const safe=A.sanitizeInput({prompt});for(const value of values)assert.ok(!JSON.stringify(safe).includes(value),value);
 const store=fixture(t);await assert.rejects(B.generateToolDraft({store,input:{prompt},fetchImpl:async(url,init)=>{for(const value of values)assert.ok(!init.body.includes(value));throw new Error(values.join(' '));}}),error=>values.every(value=>!error.message.includes(value)));
});

test('known credentials copied to neutral body fields remain local on apply',()=>{
 const current={...draft(),apiKey:'known-current-private-key'};current.config.body={credentialData:{value:'known-current-private-key'},prompt:'{{args.prompt}}'};
 const result=A.applySuggestion(current,{...draft(),config:{url:'https://tool.example.test/new',body:{input:'{{args.prompt}}'}}});
 assert.equal(result.config.body.credentialData.value,'known-current-private-key');assert.equal(result.config.body.input,'{{args.prompt}}');
});

test('recognized CLI credential flag values stay local and restore by flag',async t=>{
 const current=draft('cli');current.config.executable='node';current.config.argv=['--token','cli-token-private','--password=cli-password-private','{{args.prompt}}'];current.description='cli-token-private cli-password-private';
 const safe=A.sanitizeInput({prompt:current.description,tool:current});assert.doesNotMatch(JSON.stringify(safe),/cli-(token|password)-private/);
 const generated=A.validateSuggestion({...current,config:{...current.config,argv:['{{args.prompt}}','--password=model-password','--token','model-token']}}).tool;
 assert.doesNotMatch(JSON.stringify(generated),/model-password|model-token/);
 const applied=A.applySuggestion(current,generated);assert.deepEqual(applied.config.argv,['{{args.prompt}}','--password=cli-password-private','--token','cli-token-private']);
 const store=fixture(t);await assert.rejects(B.generateToolDraft({store,input:{prompt:'Create',tool:current},fetchImpl:async()=>{throw new Error(current.description);}}),error=>!error.message.includes('cli-token-private')&&!error.message.includes('cli-password-private'));
});

test('headings and nested JSON documentation cannot hide credential assignments from scanning',async t=>{
 const prompt='Request: {"token":"nested-private-token","body":{"api_key":"nested-private-key"}}\nExamples: [{"password":"nested-private-password"}]';
 const secrets=['nested-private-token','nested-private-key','nested-private-password'];
 const safe=A.sanitizeInput({prompt});for(const secret of secrets)assert.ok(!safe.prompt.includes(secret),secret);
 const store=fixture(t);await assert.rejects(B.generateToolDraft({store,input:{prompt},fetchImpl:async(url,init)=>{for(const secret of secrets)assert.ok(!init.body.includes(secret));throw new Error(secrets.join(' '));}}),error=>secrets.every(secret=>!error.message.includes(secret)));
});
