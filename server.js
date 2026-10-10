'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Store,validId}=require('./storage');
const {runAgent,toolRegistry,redact,redactValue}=require('./agent');
const {C,S,uiDirectory}=require('./shared');
const T=require('./ui/tool-config');
const {executeCustomTool,discoverMcpTools,approvalPreview}=require('./custom-tools');
const {generateToolDraft}=require('./tool-authoring');
function json(res,status,data){if(res.destroyed)return;res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
async function body(req){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>8*1024*1024){const e=new Error('请求内容过大');e.status=413;throw e;}chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{const e=new Error('请求须为有效 JSON');e.status=400;throw e;}}
function safeEqual(a,b){if(typeof a!=='string')return false;const first=Buffer.from(a),second=Buffer.from(b);return first.length===second.length&&crypto.timingSafeEqual(first,second);}
async function readJSON(response,max=2*1024*1024){if(!response.body)return {};let n=0,parts=[];const reader=response.body.getReader();try{while(true){const {value,done}=await reader.read();if(done)break;n+=value.byteLength;if(n>max)throw new Error('接口响应过大');parts.push(Buffer.from(value));}return JSON.parse(Buffer.concat(parts).toString('utf8'));}finally{try{await reader.cancel();}catch{}reader.releaseLock();}}
function createService({store=new Store(path.join(__dirname,'data')),fetchImpl=fetch,token=crypto.randomBytes(32).toString('hex')}={}){
 const active=new Map(),approvals=new Map(),operations=new Set();let server;
 const privateConfig=()=>({...store.snapshot(),customTools:store.getTools()});
 function draftTool(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('工具请求格式无效');
  const id=input.tool?.id||input.id,saved=id?store.getTool(id):null;
  if(id&&!saved)throw new Error('工具不存在');
  if(!input.tool){if(!saved)throw new Error('请选择工具');return saved;}
  const draft=T.normalizeTool(input.tool),key=input.tool.apiKey;
  if(key!==undefined&&(typeof key!=='string'||key.length>8192||/[\r\n]/.test(key)))throw new Error('API Key 格式无效');
  return {...draft,apiKey:input.tool.removeKey?'':key?.trim()||saved?.apiKey||''};
 }
 function requestApproval(sessionId,preview,{signal,onPending}){
  return new Promise((resolve,reject)=>{
   signal?.throwIfAborted();const id=crypto.randomUUID();
   const finish=(allow,error)=>{const entry=approvals.get(id);if(!entry)return;approvals.delete(id);clearTimeout(entry.timeout);signal?.removeEventListener('abort',abort);error?reject(error):resolve(allow);};
   const abort=()=>finish(false,signal.reason||new Error('已停止'));
   const timeout=setTimeout(()=>finish(false,new Error('工具确认已超时')),120000);
   approvals.set(id,{sessionId,finish,timeout});signal?.addEventListener('abort',abort,{once:true});
   try{onPending(id);}catch(error){finish(false,error);}
  });
 }
 server=http.createServer(async(req,res)=>{
  const port=server.address()?.port,host=req.headers.host;
  if(!['127.0.0.1:'+port,'localhost:'+port].includes(host)){json(res,403,{error:'无效的本地主机地址'});return;}
  const origin=req.headers.origin,sameOrigins=['http://127.0.0.1:'+port,'http://localhost:'+port];
  const isLocal=!origin||sameOrigins.includes(origin),external=origin==='null'||/^chrome-extension:\/\/[a-p]{32}$/.test(origin||'');
  if(origin&&!isLocal&&!external){json(res,403,{error:'不允许此网页来源'});return;}
  if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Methods','GET, POST, PUT, PATCH, DELETE, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');}
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
  let url;try{url=new URL(req.url,'http://'+host);}catch{json(res,400,{error:'请求地址无效'});return;}
  try{
   if(url.pathname==='/api/health'&&req.method==='GET'){json(res,200,{ok:true,version:'2.0.0',searchProvider:'deepseek-official'});return;}
   if(url.pathname==='/api/bootstrap'&&req.method==='GET'){if(!isLocal||req.headers['sec-fetch-site']==='cross-site'){json(res,403,{error:'请使用设置中的本地连接码'});return;}json(res,200,{token,version:'2.0.0'});return;}
   if(url.pathname.startsWith('/api/')){
    if(!safeEqual(req.headers.authorization,'Bearer '+token)){json(res,401,{error:'本地连接码无效'});return;}
    if(url.pathname==='/api/settings'){
     if(req.method==='GET'){json(res,200,store.publicSettings());return;}
     if(req.method==='POST'){json(res,200,store.saveSettings(await body(req)));return;}
    }
    if(url.pathname==='/api/credentials'&&req.method==='DELETE'){if(active.size||operations.size){json(res,409,{error:'请先停止正在执行的请求'});return;}json(res,200,store.forgetCredentials());return;}
    if(url.pathname==='/api/models'&&['GET','POST'].includes(req.method)){
     const cfg=store.snapshot(),draft=req.method==='POST'?await body(req):{};const key=typeof draft.apiKey==='string'&&draft.apiKey.trim()?draft.apiKey.trim():cfg.apiKey;const base=typeof draft.baseURL==='string'?draft.baseURL:cfg.baseURL;if(!key){json(res,401,{error:'请配置 DeepSeek API Key'});return;}
     try{const upstream=await fetchImpl(C.endpoint(base).replace(/\/chat\/completions$/,'/models'),{headers:{Authorization:'Bearer '+key},redirect:'error',signal:AbortSignal.timeout(20000)});const data=await readJSON(upstream);if(!upstream.ok)throw new Error(data.error?.message||'模型连接失败（'+upstream.status+'）');if(!Array.isArray(data.data))throw new Error('接口没有返回模型列表');json(res,200,{data:JSON.parse(redact(JSON.stringify(data.data),{...cfg,apiKey:key}))});}catch(e){json(res,400,{error:redact(e.message,{...cfg,apiKey:key})});}return;
    }
    if(url.pathname==='/api/search'&&req.method==='POST'){const input=await body(req),cfg=store.snapshot();const sources=await S.search(input.query,{baseURL:cfg.searchURL,model:cfg.searchModel,apiKey:cfg.searchKey||cfg.apiKey,fetchImpl},AbortSignal.timeout(60000));json(res,200,{sources,provider:'deepseek-official'});return;}
    if(url.pathname==='/api/tools'&&req.method==='GET'){json(res,200,{tools:toolRegistry(privateConfig(),fetchImpl,()=>{}).definitions()});return;}
    if(url.pathname==='/api/custom-tools/generate'&&req.method==='POST'){
     const input=await body(req),ctl=new AbortController();
     const disconnect=()=>{if(!res.writableEnded)ctl.abort(new Error('配置生成已取消'));};
     operations.add(ctl);res.on('close',disconnect);
     try{json(res,200,await generateToolDraft({store,input,fetchImpl,signal:ctl.signal}));}
     catch(e){json(res,e.status||400,{error:e.message});}
     finally{operations.delete(ctl);res.removeListener('close',disconnect);}return;
    }
    if(url.pathname==='/api/custom-tools'){
     if(req.method==='GET'){json(res,200,{tools:store.listTools()});return;}
     if(req.method==='POST'){json(res,200,{tool:store.saveTool(await body(req))});return;}
    }
    if(['/api/custom-tools/test','/api/custom-tools/discover'].includes(url.pathname)&&req.method==='POST'){
     const input=await body(req),ctl=new AbortController();let draft;
     operations.add(ctl);res.on('close',()=>{if(!res.writableEnded)ctl.abort();});
     try{
      draft=draftTool(input);const cfg={...privateConfig(),customTools:[...store.getTools(),draft]};
      if(url.pathname.endsWith('/discover')){if(draft.kind!=='mcp')throw new Error('仅 MCP 工具支持发现');json(res,200,redactValue({tools:await discoverMcpTools(draft,{fetchImpl,signal:ctl.signal})},cfg));}
      else{
       const args=T.validateArguments(draft,input.args||{});
       if((draft.kind==='cli'||draft.requireConfirmation)&&input.confirmed!==true){json(res,200,redactValue({requiresConfirmation:true,preview:approvalPreview(draft,args)},cfg));}
       else json(res,200,redactValue(await executeCustomTool(draft,args,{fetchImpl,signal:ctl.signal,approve:async()=>input.confirmed===true}),cfg));
      }
     }catch(e){json(res,400,{error:redact(e.message,{...privateConfig(),customTools:[...store.getTools(),draft||{apiKey:typeof input.tool?.apiKey==='string'?input.tool.apiKey:''}]})});}
     finally{operations.delete(ctl);}return;
    }
    const duplicateMatch=/^\/api\/custom-tools\/([\w-]+)\/duplicate$/.exec(url.pathname);
    if(duplicateMatch&&req.method==='POST'){const tool=store.duplicateTool(duplicateMatch[1]);json(res,tool?200:404,tool?{tool}:{error:'工具不存在'});return;}
    const customMatch=/^\/api\/custom-tools\/([\w-]+)$/.exec(url.pathname);
    if(customMatch&&req.method==='DELETE'){const removed=store.removeTool(customMatch[1]);json(res,removed?200:404,removed?{ok:true}:{error:'工具不存在'});return;}
    const approvalMatch=/^\/api\/tool-approvals\/([\w-]+)$/.exec(url.pathname);
    if(approvalMatch&&req.method==='POST'){
     const input=await body(req);if(typeof input.allow!=='boolean')throw new Error('请选择允许或拒绝');
     const pending=approvals.get(approvalMatch[1]);
     if(!pending||!active.has(pending.sessionId)){json(res,404,{error:'确认请求已失效'});return;}
     pending.finish(input.allow);json(res,200,{ok:true});return;
    }
    if(url.pathname==='/api/export'&&req.method==='GET'){json(res,200,{app:'Luma',version:2,exportedAt:new Date().toISOString(),chats:store.listSessions()});return;}
    if(url.pathname==='/api/sessions'){
     if(req.method==='GET'){json(res,200,{chats:store.listSessions()});return;}
     if(req.method==='PUT'){const session=await body(req);validId(session.id);if(active.has(session.id)){json(res,409,{error:'此会话正在生成'});return;}json(res,200,{session:store.putSession(session)});return;}
     if(req.method==='DELETE'){if(active.size){json(res,409,{error:'请先停止正在生成的回答'});return;}store.clearSessions();json(res,200,{ok:true});return;}
    }
    const sessionMatch=/^\/api\/sessions\/([\w-]+)$/.exec(url.pathname);
    if(sessionMatch){const id=sessionMatch[1];if(req.method==='GET'){const session=store.getSession(id);json(res,session?200:404,session?{session}:{error:'会话不存在'});return;}if(active.has(id)){json(res,409,{error:'此会话正在生成'});return;}if(req.method==='PATCH'){json(res,200,{session:store.renameSession(id,(await body(req)).title)});return;}if(req.method==='DELETE'){store.deleteSession(id);json(res,200,{ok:true});return;}}
    const cancel=/^\/api\/cancel\/([\w-]+)$/.exec(url.pathname);if(cancel&&req.method==='POST'){active.get(cancel[1])?.abort();json(res,200,{ok:true});return;}
    if(url.pathname==='/api/chat'&&req.method==='POST'){
     const input=await body(req);validId(input.sessionId);if(active.has(input.sessionId)){json(res,409,{error:'此会话已有正在生成的回答'});return;}if(!store.publicSettings().hasApiKey){json(res,401,{error:'请配置 DeepSeek API Key'});return;}
     const ctl=new AbortController(),timeout=setTimeout(()=>ctl.abort(new Error('请求超时')),600000);active.set(input.sessionId,ctl);
     res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','X-Accel-Buffering':'no'});res.flushHeaders();res.on('close',()=>{if(!res.writableEnded)ctl.abort();});const heartbeat=setInterval(()=>{if(!res.destroyed)res.write(': keepalive\n\n');},15000);
     const emit=(type,data)=>{if(!res.destroyed)res.write('event: '+type+'\ndata: '+JSON.stringify(data)+'\n\n');};
     try{await runAgent({store,request:input,fetchImpl,emit,signal:ctl.signal,requestApproval:(preview,options)=>requestApproval(input.sessionId,preview,options)});}catch(e){emit('error',{message:redact(e.message,privateConfig()),status:'error'});emit('done',{session:store.getSession(input.sessionId)});}finally{clearTimeout(timeout);clearInterval(heartbeat);active.delete(input.sessionId);for(const pending of approvals.values())if(pending.sessionId===input.sessionId)pending.finish(false);if(!res.destroyed)res.end();}return;
    }
    json(res,404,{error:'接口不存在'});return;
   }
   if(!['GET','HEAD'].includes(req.method)){json(res,405,{error:'不支持此方法'});return;}
   if(url.pathname==='/download/chrome'){const archive=fs.existsSync(path.join(__dirname,'Luma-Chrome.zip'))?path.join(__dirname,'Luma-Chrome.zip'):path.resolve(__dirname,'../../outputs/Luma-Chrome.zip');if(!fs.existsSync(archive)){json(res,404,{error:'安装包尚未生成'});return;}res.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':'attachment; filename="Luma-Chrome.zip"'});if(req.method==='HEAD')res.end();else fs.createReadStream(archive).pipe(res);return;}
   let relative;try{relative=decodeURIComponent(url.pathname).replace(/^\//,'')||'index.html';}catch{json(res,404,{error:'文件不存在'});return;}
   const target=path.resolve(uiDirectory,relative);if(!target.startsWith(uiDirectory+path.sep)||!fs.existsSync(target)||!fs.statSync(target).isFile()){json(res,404,{error:'文件不存在'});return;}
   const ext=path.extname(target),types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.txt':'text/plain; charset=utf-8','.json':'application/json'};if(!types[ext]){json(res,404,{error:'文件不存在'});return;}
   res.setHeader('Content-Security-Policy',"script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");res.writeHead(200,{'Content-Type':types[ext],'Cache-Control':'no-cache'});if(req.method==='HEAD')res.end();else fs.createReadStream(target).pipe(res);
  }catch(e){if(res.headersSent){if(!res.destroyed)res.end();}else json(res,e.status||400,{error:redact(e.message,privateConfig())});}
 });
 server.requestTimeout=30000;server.headersTimeout=10000;
 async function close(){for(const ctl of [...active.values(),...operations])ctl.abort();for(const pending of approvals.values())pending.finish(false);server.closeIdleConnections();await new Promise(r=>server.close(r));}
 return {server,store,token,active,close};
}
if(require.main===module){
 const port=Number(process.env.LUMA_PORT||43821);if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('LUMA_PORT 无效');
 const service=createService();service.server.on('error',e=>{console.error(e.code==='EADDRINUSE'?'端口 '+port+' 已占用，请使用现有服务或更换 LUMA_PORT。':e.message);process.exitCode=1;});
 service.server.listen(port,'127.0.0.1',()=>{console.log('Luma: http://127.0.0.1:'+port);console.log('连接码: '+service.token);console.log('Ctrl+C 停止服务。');});
 process.on('SIGINT',()=>service.close().then(()=>process.exit(0)));process.on('SIGTERM',()=>service.close().then(()=>process.exit(0)));
}
module.exports={createService};
