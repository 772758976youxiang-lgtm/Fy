(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.LumaBackend=api;})(typeof globalThis==='object'?globalThis:this,function(){
 'use strict';
 function backendURL(value){let u;try{u=new URL(value);}catch{throw new Error('请输入有效的本地后端地址');}if(u.protocol!=='http:'||!['localhost','127.0.0.1'].includes(u.hostname)||u.username||u.password||u.search||u.hash||!['','/'].includes(u.pathname))throw new Error('后端地址须为 http://127.0.0.1:端口 或 http://localhost:端口');return u.origin;}
 async function readEvents(response,onEvent){
  if(!response.ok){let data;try{data=await response.json();}catch{}throw new Error(data?.error||'后端请求失败（'+response.status+'）');}
  if(!response.headers.get('Content-Type')?.includes('text/event-stream')||!response.body)throw new Error('后端没有返回事件流');
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',doneEvent=false,finalSession=null;
  function dispatch(block){let type='message',data=[];for(const line of block.split('\n')){if(line.startsWith('event:'))type=line.slice(6).trim();else if(line.startsWith('data:'))data.push(line.slice(5).trimStart());}if(!data.length)return;let value;try{value=JSON.parse(data.join('\n'));}catch{throw new Error('后端事件格式无效');}onEvent(type,value);if(type==='done'){doneEvent=true;finalSession=value.session;}}
  try{while(true){const {value,done}=await reader.read();buffer+=decoder.decode(value,{stream:!done});buffer=buffer.replace(/\r\n/g,'\n');let i;while((i=buffer.indexOf('\n\n'))>=0){dispatch(buffer.slice(0,i));buffer=buffer.slice(i+2);}if(buffer.length>8*1024*1024)throw new Error('后端事件过大');if(done)break;}if(buffer.trim())dispatch(buffer);if(!doneEvent)throw new Error('后端连接已中断，可重新生成');return finalSession;}finally{try{await reader.cancel();}catch{}reader.releaseLock();}
 }
 class Client{
  constructor(fetchImpl){this.fetchImpl=fetchImpl||globalThis.fetch.bind(globalThis);this.connected=false;this.settings={};this.baseURL='';this.token='';this.revision=0;}
  async request(route,{method='GET',data,signal}={}){const identity=this.baseURL+'|'+this.token,revision=this.revision;const response=await this.fetchImpl(this.baseURL+'/api/'+route,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+this.token},body:data===undefined?undefined:JSON.stringify(data),signal:signal||AbortSignal.timeout(20000),redirect:'error'});let value;try{value=await response.json();}catch{throw new Error('本地后端响应无效');}if(revision!==this.revision||identity!==this.baseURL+'|'+this.token)throw new Error('后端连接已切换，请重试');if(!response.ok)throw new Error(value.error||'后端请求失败（'+response.status+'）');return value;}
  async connect(baseURL,token,{auto=false}={}){const candidate=new Client(this.fetchImpl);candidate.baseURL=backendURL(baseURL);candidate.token=String(token||'').trim();if(!candidate.token&&auto){const r=await this.fetchImpl(candidate.baseURL+'/api/bootstrap',{signal:AbortSignal.timeout(5000),redirect:'error'});if(!r.ok)throw new Error('自动连接失败，请填写连接码');candidate.token=(await r.json()).token;}if(!candidate.token)throw new Error('请填写启动窗口中的连接码');const settings=await candidate.request('settings'),sessions=await candidate.request('sessions');this.revision++;this.baseURL=candidate.baseURL;this.token=candidate.token;this.settings=settings;this.connected=true;return {settings,chats:sessions.chats};}
  disconnect(){this.revision++;this.connected=false;this.token='';this.settings={};}
  async saveSettings(data){this.settings=await this.request('settings',{method:'POST',data});return this.settings;}
  async forget(){this.settings=await this.request('credentials',{method:'DELETE'});return this.settings;}
  async chat(data,onEvent,signal){const response=await this.fetchImpl(this.baseURL+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+this.token},body:JSON.stringify(data),signal,redirect:'error'});return readEvents(response,onEvent);}
  cancel(id){return this.request('cancel/'+encodeURIComponent(id),{method:'POST'});}
  getSession(id){return this.request('sessions/'+encodeURIComponent(id));}
  importSession(session){return this.request('sessions',{method:'PUT',data:session});}
  rename(id,title){return this.request('sessions/'+encodeURIComponent(id),{method:'PATCH',data:{title}});}
  remove(id){return this.request('sessions/'+encodeURIComponent(id),{method:'DELETE'});}
  clear(){return this.request('sessions',{method:'DELETE'});}
 }
 return {backendURL,readEvents,Client};
});
