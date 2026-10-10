'use strict';
const fs=require('node:fs'),path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const {C,S}=require('./shared');
const ToolConfig=require('./ui/tool-config');
const DEFAULTS={baseURL:'https://api.deepseek.com',model:'deepseek-flash',customModel:'',effort:'high',systemPrompt:'你是澄蓝 Luma，一位清晰、耐心、诚实的助手。优先使用中文回答。把复杂问题解释得简单，必要时使用 Markdown。对不确定的事实明确说明。',searchURL:S.DEFAULTS.baseURL,searchModel:S.DEFAULTS.model,searchEnabled:false,toolsEnabled:false,remember:false};
const clone=x=>structuredClone(x);
const toolConfigHash=tool=>createHash('sha256').update(JSON.stringify(ToolConfig.normalizeTool(tool))).digest('hex');
function invalid(message){const e=new Error(message);e.status=400;throw e;}
function validId(id){if(typeof id!=='string'||!/^[\w-]{1,80}$/.test(id))invalid('无效的会话 ID');return id;}
function configPatch(input){
 if(!input||typeof input!=='object'||Array.isArray(input))invalid('设置格式错误');const result={};
 for(const [key,max] of Object.entries({baseURL:2000,model:120,customModel:120,effort:10,systemPrompt:24000,searchURL:2000,searchModel:120}))if(Object.hasOwn(input,key)){if(typeof input[key]!=='string'||input[key].length>max)invalid('设置字段无效：'+key);result[key]=input[key];}
 for(const key of ['remember','searchEnabled','toolsEnabled'])if(Object.hasOwn(input,key)){if(typeof input[key]!=='boolean')invalid('设置字段须为布尔值：'+key);result[key]=input[key];}
 if(result.baseURL!==undefined)C.endpoint(result.baseURL);
 if(result.searchURL!==undefined)S.searchEndpoint(result.searchURL);
 if(result.effort!==undefined&&!['none','low','high','max'].includes(result.effort))invalid('无效的思考强度');
 for(const key of ['model','searchModel'])if(result[key]!==undefined&&!result[key].trim())invalid('模型 ID 不能为空');
 return result;
}
class Store{
 constructor(directory){this.directory=path.resolve(directory);fs.mkdirSync(this.directory,{recursive:true,mode:0o700});this.settings={...DEFAULTS,...configPatch(this.read('settings.json',{}))};this.keys=this.settings.remember?this.read('credentials.json',{}):{};this.sessions=this.read('sessions.json',[]);if(!Array.isArray(this.sessions))throw new Error('会话文件格式错误');this.sessions=this.sessions.map(s=>this.validateSession(s));for(const s of this.sessions)for(const m of s.messages)if(m.status==='streaming'){m.status='stopped';m.error='上次回答已中断，可重新生成。';}this.loadTools();}
 read(name,fallback){const file=path.join(this.directory,name);if(!fs.existsSync(file))return fallback;try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw new Error('本地数据文件损坏：'+name+'。请保留备份后修复。');}}
 atomic(name,value){const file=path.join(this.directory,name),tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value),{encoding:'utf8',mode:0o600});fs.renameSync(tmp,file);}
 snapshot(){return {...clone(this.settings),apiKey:this.keys.apiKey||'',searchKey:this.keys.searchKey||''};}
 publicSettings(){return {...clone(this.settings),hasApiKey:!!this.keys.apiKey,hasSearchKey:!!this.keys.searchKey};}
 saveSettings(input){const settings={...this.settings,...configPatch(input)},keys={...this.keys};for(const key of ['apiKey','searchKey'])if(Object.hasOwn(input,key)){if(typeof input[key]!=='string'||input[key].length>8192)invalid('无效的密钥');keys[key]=input[key].trim();}this.atomic('settings.json',settings);if(settings.remember)this.atomic('credentials.json',keys);else{const file=path.join(this.directory,'credentials.json');if(fs.existsSync(file))fs.unlinkSync(file);}this.settings=settings;this.keys=keys;return this.publicSettings();}
 forgetCredentials(){
  const settings={...this.settings,remember:false},tools=this.tools.map(tool=>({...tool,rememberKey:false}));
  this.persistBatch([['tools.json',tools],['tool-credentials.json',null],['settings.json',settings],['credentials.json',null]]);
  this.keys={};this.settings=settings;this.toolKeys=Object.create(null);this.tools=tools;return this.publicSettings();
 }
 loadTools(){
  const source=this.read('tools.json',[]),names=new Set(),ids=new Set();
  try{
   if(!Array.isArray(source)||source.length>64)throw new Error('invalid tools');
   this.tools=source.map(input=>{const tool=ToolConfig.normalizeTool(input);if(!tool.id||ids.has(tool.id)||names.has(tool.name.toLowerCase())||(tool.kind==='mcp'&&!tool.config.mcpTool.trim()))throw new Error('invalid tool');ids.add(tool.id);names.add(tool.name.toLowerCase());return tool;});
  }catch{throw new Error('本地数据文件损坏：tools.json。请保留备份后修复。');}
  const storedKeys=this.read('tool-credentials.json',{});
  if(!storedKeys||typeof storedKeys!=='object'||Array.isArray(storedKeys)||Object.keys(storedKeys).length>64||Object.entries(storedKeys).some(([id,record])=>!/^[A-Za-z0-9_-]{1,80}$/.test(id)||['__proto__','constructor','prototype'].includes(id.toLowerCase())||!record||typeof record!=='object'||Array.isArray(record)||Object.keys(record).some(key=>!['apiKey','configHash'].includes(key))||typeof record.apiKey!=='string'||record.apiKey.length>8192||/[\r\n\0]/.test(record.apiKey)||typeof record.configHash!=='string'||!/^[a-f0-9]{64}$/.test(record.configHash)))throw new Error('本地数据文件损坏：tool-credentials.json。请保留备份后修复。');
  this.toolKeys=Object.create(null);
  // Independent atomic files may come from different writes after a crash.
  for(const tool of this.tools)if(tool.rememberKey&&Object.hasOwn(storedKeys,tool.id)&&storedKeys[tool.id].configHash===toolConfigHash(tool))this.toolKeys[tool.id]=storedKeys[tool.id].apiKey;
 }
 persistTools(tools,keys){
  const remembered=Object.create(null);
  for(const tool of tools)if(tool.rememberKey&&keys[tool.id])remembered[tool.id]={apiKey:keys[tool.id],configHash:toolConfigHash(tool)};
  this.persistBatch([['tools.json',tools],['tool-credentials.json',Object.keys(remembered).length?remembered:null]]);
 }
 persistBatch(entries){
  const before=entries.map(([name])=>{const file=path.join(this.directory,name),raw=fs.existsSync(file)?fs.readFileSync(file,'utf8'):null;return {name,file,raw,value:raw===null?null:JSON.parse(raw)};});
  const write=(name,value)=>{if(value!==null)this.atomic(name,value);else{const file=path.join(this.directory,name);if(fs.existsSync(file))fs.unlinkSync(file);}};
  try{for(const [name,value] of entries)write(name,value);}
  catch(error){
   for(const previous of before){
    try{const current=fs.existsSync(previous.file)?fs.readFileSync(previous.file,'utf8'):null;if(current!==previous.raw)write(previous.name,previous.value);}
    catch{error.rollbackFailed=true;}
   }
   throw error;
  }
 }
 publicTool(tool){return {...clone(tool),hasApiKey:!!this.toolKeys[tool.id]};}
 listTools(){return this.tools.map(tool=>this.publicTool(tool));}
 getTools(){return this.tools.map(tool=>({...clone(tool),apiKey:this.toolKeys[tool.id]||''}));}
 getTool(id){validId(id);const tool=this.tools.find(item=>item.id===id);return tool?{...clone(tool),apiKey:this.toolKeys[id]||''}:null;}
 saveTool(input){
  const tool=ToolConfig.normalizeTool(input);if(!tool.id)tool.id=randomUUID();
  if(tool.kind==='mcp'&&!tool.config.mcpTool.trim())invalid('请选择 MCP 工具');
  if(this.tools.some(item=>item.id!==tool.id&&item.name.toLowerCase()===tool.name.toLowerCase()))invalid('工具名称已存在');
  if(input.removeKey!==undefined&&typeof input.removeKey!=='boolean')invalid('removeKey 须为布尔值');
  if(input.apiKey!==undefined&&(typeof input.apiKey!=='string'||input.apiKey.length>8192||/[\r\n\0]/.test(input.apiKey)))invalid('无效的工具密钥');
  const tools=clone(this.tools),keys=Object.assign(Object.create(null),this.toolKeys),index=tools.findIndex(item=>item.id===tool.id);
  if(index<0){if(tools.length>=64)invalid('工具数量达到 64，请先清理');tools.push(tool);}else tools[index]=tool;
  if(input.removeKey)delete keys[tool.id];else if(typeof input.apiKey==='string'&&input.apiKey.trim())keys[tool.id]=input.apiKey.trim();
  this.persistTools(tools,keys);this.tools=tools;this.toolKeys=keys;return this.publicTool(tool);
 }
 duplicateTool(id){
  const source=this.getTool(id);if(!source)return null;
  let index=1,name,label;
  do{
   const suffix='_copy'+(index===1?'':'_'+index),labelSuffix=index===1?'（副本）':'（副本 '+index+'）';
   name=source.name.slice(0,64-suffix.length)+suffix;
   label=source.label.slice(0,120-labelSuffix.length).replace(/[\uD800-\uDBFF]$/,'')+labelSuffix;
   index++;
  }while(this.tools.some(tool=>tool.name.toLowerCase()===name.toLowerCase()||tool.label===label));
  delete source.id;
  return this.saveTool({...source,name,label,enabled:false});
 }
 removeTool(id){
  validId(id);if(!this.tools.some(tool=>tool.id===id))return false;
  const tools=this.tools.filter(tool=>tool.id!==id),keys=Object.assign(Object.create(null),this.toolKeys);delete keys[id];
  this.persistTools(tools,keys);this.tools=tools;this.toolKeys=keys;return true;
 }
 validateSession(input){
  if(!input||typeof input!=='object')invalid('会话格式错误');validId(input.id);if(typeof input.title!=='string'||input.title.length>200)invalid('会话标题无效');if(!Array.isArray(input.messages)||input.messages.length>500||!Array.isArray(input.apiMessages)||input.apiMessages.length>1000)invalid('会话消息数量无效');
  const messages=clone(input.messages);for(const m of messages){validId(m.id);if(!['user','assistant'].includes(m.role)||typeof m.content!=='string'||m.content.length>2000000)invalid('会话内容格式错误');if(m.reasoning!==undefined&&(typeof m.reasoning!=='string'||m.reasoning.length>2000000))invalid('思考内容格式错误');}
  for(const m of input.apiMessages)if(!['user','assistant','tool'].includes(m.role)||!(typeof m.content==='string'||m.content===null))invalid('API 历史格式错误');
  return {id:input.id,title:input.title,messages,apiMessages:clone(input.apiMessages),createdAt:Number(input.createdAt)||Date.now(),updatedAt:Number(input.updatedAt)||Date.now()};
 }
 listSessions(){return clone(this.sessions).sort((a,b)=>b.updatedAt-a.updatedAt);}
 getSession(id){validId(id);const s=this.sessions.find(x=>x.id===id);return s?clone(s):null;}
 putSession(input){const s=this.validateSession(input);const index=this.sessions.findIndex(x=>x.id===s.id);if(index<0){if(this.sessions.length>=200)invalid('会话数量达到 200，请先导出并清理');this.sessions.unshift(s);}else this.sessions[index]=s;this.atomic('sessions.json',this.sessions);return clone(s);}
 renameSession(id,title){const s=this.getSession(id);if(!s){const e=new Error('会话不存在');e.status=404;throw e;}if(typeof title!=='string'||!title.trim()||title.length>60)invalid('标题长度须为 1～60 字');s.title=title.trim();s.updatedAt=Date.now();return this.putSession(s);}
 deleteSession(id){validId(id);this.sessions=this.sessions.filter(s=>s.id!==id);this.atomic('sessions.json',this.sessions);}
 clearSessions(){this.sessions=[];this.atomic('sessions.json',[]);}
}
module.exports={Store,DEFAULTS,configPatch,validId};
