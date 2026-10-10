(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory(require('./tool-config'));
  else root.LumaToolAuthoring=factory(root.LumaToolConfig);
})(typeof globalThis!=='undefined'?globalThis:this,function(T){
  'use strict';
  const MAX_DRAFT=128*1024,REDACTED='[REDACTED]';
  const BLOCKED=new Set(['__proto__','constructor','prototype']);
  const FIELDS=new Set(['name','label','description','kind','requireConfirmation','parameters','config']);
  const LOCAL=new Set(['id','apiKey','hasApiKey','rememberKey','removeKey','enabled']);
  const SECRET=/^(?:api[_-]?key|access[_-]?key|secret[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|authorization|proxy-authorization|cookie|set-cookie|client[_-]?secret|credential|credentials|x-api-key|x-auth-token)$/i;
  const secretName=name=>SECRET.test(name)||/(?:^|[_-])(?:token|secret|password|api[_-]?key)(?:$|[_-])/i.test(name);
  const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
  const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
  const copy=value=>JSON.parse(JSON.stringify(value));
  function credentialArgs(argv){
    if(!Array.isArray(argv))return [];
    const result=[];
    argv.forEach((arg,index)=>{
      if(typeof arg!=='string')return;
      const match=/^(--[A-Za-z_][A-Za-z0-9_-]*)(?:=(.*))?$/.exec(arg);
      if(!match||!secretName(match[1].slice(2)))return;
      const inline=match[2]!==undefined,value=inline?match[2]:argv[index+1];
      if(typeof value==='string'&&!value.startsWith('--')&&!/^\{\{[^{}]+\}\}$/.test(value))result.push({flag:match[1],index:inline?index:index+1,value,inline});
    });
    return result;
  }
  function invalid(message){const error=new Error(message);error.status=400;throw error;}
  function checkJSON(value,limit=MAX_DRAFT){
    let nodes=0;const active=new Set();
    function visit(item,depth){
      if(++nodes>10000||depth>20)invalid('工具草稿嵌套或数量过大');
      if(item===null||typeof item==='string'||typeof item==='boolean'||(typeof item==='number'&&Number.isFinite(item)))return;
      if((!Array.isArray(item)&&!plain(item))||active.has(item))invalid('工具草稿须为 JSON 对象');
      active.add(item);
      for(const key of Object.keys(item)){if(BLOCKED.has(key.toLowerCase()))invalid('工具草稿包含不安全的字段');visit(item[key],depth+1);}
      active.delete(item);
    }
    visit(value,0);
    if(new TextEncoder().encode(JSON.stringify(value)).byteLength>limit)invalid('工具草稿内容过大');
    return value;
  }
  function collectSecrets(value,allMaps=true){
    const found=new Set(),seen=new Set();
    function add(item){if(typeof item==='number'||typeof item==='boolean')item=String(item);if(typeof item==='string'&&item&&item!==REDACTED&&!/^\{\{[^{}]+\}\}$/.test(item)){found.add(item);const token=item.replace(/^(?:Bearer|Basic)\s+/i,'');if(token!==item&&token)found.add(token);}}
    function textSecrets(text){
      for(const match of text.matchAll(/\b(?:Bearer|Basic)\s+([A-Za-z0-9._~+/=-]+)/gi))add(match[1]);
      for(const match of text.matchAll(/\bsk-[A-Za-z0-9_-]{8,}/g))add(match[0]);
      for(const match of text.matchAll(/["']?\b([A-Za-z_][A-Za-z0-9_-]{0,99})["']?\s*[:=]\s*(?:["']([^"'\r\n]*)["']|([^\s,;&\r\n{}\[\]]+))/g)){
        const token=match[2]??match[3];if(secretName(match[1])&&token&&!/^\{\{|^(?:Bearer|Basic|string|number|integer|boolean|object|array|null|true|false|none|optional|required)$|^<[^>]+>$/i.test(token))add(token);
      }
      for(const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)){
        try{const url=new URL(match[0]);add(decodeURIComponent(url.username));add(decodeURIComponent(url.password));for(const [name,entry] of url.searchParams)if(secretName(name))add(entry);}catch{}
      }
    }
    function walk(item,depth=0,sensitive=false){
      if(sensitive)add(item);
      if(typeof item==='string'){textSecrets(item);return;}
      if(depth>20||!item||typeof item!=='object'||seen.has(item))return;
      seen.add(item);
      for(const [key,child] of Object.entries(item)){
        if(secretName(key))add(child);
        if((key==='headers'||key==='env')&&plain(child))for(const [name,entry] of Object.entries(child))if(allMaps||secretName(name)||name.toLowerCase()===value.config?.authHeader?.toLowerCase())add(entry);
        if(key==='parameters'&&Array.isArray(child))for(const parameter of child)if(plain(parameter)&&secretName(parameter.name))for(const field of ['default','enum'])if(own(parameter,field))walk(parameter[field],depth+2,true);
        if(key==='argv')for(const entry of credentialArgs(child))add(entry.value);
        walk(child,depth+1,sensitive||secretName(key));
      }
    }
    walk(value);return [...found];
  }
  function redactText(value,secrets=[]){
    let text=String(value??'');
    for(const secret of [...new Set(secrets.filter(x=>typeof x==='string'&&x&&x!==REDACTED))].sort((a,b)=>b.length-a.length)){
      text=text.split(secret).join(REDACTED);
      const encoded=encodeURIComponent(secret);if(encoded!==secret)text=text.split(encoded).join(REDACTED);
    }
    text=text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,'$1 '+REDACTED)
      .replace(/\bsk-[A-Za-z0-9_-]{8,}/g,REDACTED)
      .replace(/(["']?\b([A-Za-z_][A-Za-z0-9_-]{0,99})["']?\s*[:=]\s*)(["'][^"'\r\n]*["']|[^\s,;&\r\n{}\[\]]+)/g,(match,prefix,name,token)=>!secretName(name)||/^["']?\{\{/.test(token)?match:prefix+REDACTED)
      .replace(/https?:\/\/[^\s<>"']+/gi,raw=>{
        try{const url=new URL(raw);url.username='';url.password='';for(const name of [...url.searchParams.keys()])if(secretName(name))url.searchParams.set(name,REDACTED);return url.href.replace(/%7B/gi,'{').replace(/%7D/gi,'}');}catch{return raw;}
      });
    return text;
  }
  function clean(value,secrets,hideMaps=false,key='',sensitive=false){
    sensitive=sensitive||secretName(key);
    if(sensitive&&(value===null||typeof value!=='object')&&!(typeof value==='string'&&/^\{\{\s*(?:args|config)\.[A-Za-z0-9_.-]+\s*\}\}$/.test(value)))return '';
    if(typeof value==='string')return redactText(value,secrets);
    if(Array.isArray(value)){
      const result=value.map(item=>clean(item,secrets,hideMaps,key==='parameters'?'parameter':'',sensitive));
      if(key==='argv')for(const entry of credentialArgs(value))result[entry.index]=entry.inline?entry.flag+'=':'';
      return result;
    }
    if(plain(value)){
      const result={};
      for(const [name,entry] of Object.entries(value)){
        if(name.toLowerCase()==='apikey')continue;
        if(key==='parameter'&&secretName(value.name)&&['default','enum'].includes(name))continue;
        const safeName=redactText(name,secrets);
        if(BLOCKED.has(safeName.toLowerCase()))invalid('工具草稿包含不安全的字段');
        result[safeName]=hideMaps&&(key==='headers'||key==='env')?REDACTED:clean(entry,secrets,hideMaps,name,sensitive);
      }
      return result;
    }
    return value;
  }
  function allowedTool(input){
    if(!plain(input))invalid('工具草稿格式无效');
    const result={};
    for(const [key,value] of Object.entries(input)){
      if(LOCAL.has(key))continue;
      if(!FIELDS.has(key))invalid('工具草稿包含未知字段');
      result[key]=value;
    }
    if(result.config!==undefined){
      if(!plain(result.config))invalid('固定配置格式无效');
      if(result.config.poll!==undefined&&!plain(result.config.poll))invalid('轮询配置格式无效');
      const allowed=T.createTemplate('http').config;
      for(const key of Object.keys(result.config))if(!own(allowed,key)&&key!=='apiKey')invalid('固定配置包含未知字段');
    }
    if(Array.isArray(result.parameters))result.parameters=result.parameters.map(parameter=>{
      if(!plain(parameter))invalid('参数格式无效');
      const result={};for(const [key,value] of Object.entries(parameter)){if(!['name','type','description','required','itemsType','enum','default'].includes(key))invalid('参数包含未知字段');result[key]=value;}return result;
    });
    return result;
  }
  function validateTemplates(tool){
    const names=new Set(tool.parameters.map(parameter=>parameter.name));
    function walk(value){
      if(Array.isArray(value)){value.forEach(walk);return;}
      if(plain(value)){Object.values(value).forEach(walk);return;}
      if(typeof value!=='string')return;
      const remaining=value.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g,(_,path)=>{
        const parts=path.split('.');if(parts.length<2||parts.some(part=>!part||BLOCKED.has(part.toLowerCase())))invalid('模板变量无效');
        if(parts[0]==='args'&&names.has(parts[1]))return '';
        if(parts[0]==='config'&&parts.length===2&&['model','effort','systemPrompt','mcpTool','output'].includes(parts[1]))return '';
        invalid('模板引用了未声明或不允许的变量');
      });
      if(/\{\{|\}\}/.test(remaining))invalid('模板表达式无效');
    }
    walk(tool.config.body);walk(tool.config.argv);
  }
  function validateSuggestion(input,{secrets=[]}={}){
    checkJSON(input);const hidden=[...secrets,...collectSecrets(input,false)];
    const source=clean(allowedTool(input),hidden),kind=source.kind||'http',template=T.createTemplate(kind);
    const config={...template.config,...source.config,poll:{...template.config.poll,...source.config?.poll}};
    const candidate={...template,...source,config},missingFields=[];
    function fill(object,key,path,value,required=true){
      if(object[key]===undefined||(typeof object[key]==='string'&&!object[key].trim())){
        if(required)missingFields.push(path);object[key]=value;
      }
    }
    fill(candidate,'name','name','authoring_validator_name');
    let origin='https://authoring-validator.invalid';
    try{if(config.url)origin=new URL(config.url).origin;else if(config.poll.url)origin=new URL(config.poll.url.replace(/\{\{[^{}]+\}\}/g,'result')).origin;}catch{}
    if(kind!=='cli')fill(config,'url','config.url',origin+'/');
    if(kind==='llm'||kind==='judge'||/\{\{\s*config\.model\s*\}\}/.test(JSON.stringify([config.body,config.argv])))fill(config,'model','config.model','authoring-validator-model');
    if(kind==='cli')fill(config,'executable','config.executable','authoring-validator-executable');
    if(kind==='mcp')fill(config,'mcpTool','config.mcpTool','authoring-validator-tool');
    if(config.poll.enabled)fill(config.poll,'url','config.poll.url',origin+'/');
    let normalized;
    try{normalized=T.normalizeTool(candidate);}catch(error){invalid(redactText(error.message,hidden));}
    for(const path of missingFields){const parts=path.split('.');let object=normalized;while(parts.length>1)object=object[parts.shift()];object[parts[0]]='';}
    if(missingFields.includes('name')&&normalized.label==='authoring_validator_name')normalized.label='';
    normalized.config.url=T.resolveRequestURL(normalized);
    for(const key of LOCAL)delete normalized[key];
    validateTemplates(normalized);checkJSON(normalized);return {tool:normalized,missingFields};
  }
  function sanitizeInput(input,{secrets=[]}={}){
    if(!plain(input)||Object.keys(input).some(key=>!['prompt','tool'].includes(key)))invalid('生成请求包含未知字段');
    if(typeof input.prompt!=='string'||!input.prompt.trim()||input.prompt.length>24000||input.prompt.includes('\0'))invalid('创作需求须为 1 至 24000 个字符');
    const source=input.tool===undefined?T.createTemplate('http'):input.tool;
    checkJSON(source);const hidden=[...secrets,...collectSecrets(source),...collectSecrets(input.prompt)];
    const tool=clean(allowedTool(source),hidden,true);
    // Validate the redacted draft before it becomes model context.
    return {prompt:redactText(input.prompt,hidden),tool:validateSuggestion(tool).tool};
  }
  function restoreBody(target,current,secrets){
    if(!plain(current)&&!Array.isArray(current))return target;
    const result=Array.isArray(current)?(Array.isArray(target)?copy(target):[]):(plain(target)?copy(target):{});
    for(const [key,value] of Object.entries(current)){
      if(secretName(key)||(typeof value==='string'&&secrets.some(secret=>secret&&value.includes(secret))))result[key]=copy(value);
      else if(plain(value)||Array.isArray(value)){
        const restored=restoreBody(result[key],value,secrets);
        if(JSON.stringify(restored)!==(Array.isArray(restored)?'[]':'{}'))result[key]=restored;
      }
    }
    return result;
  }
  function restoreURL(candidate,current){
    if(typeof current!=='string'||!current)return candidate;
    try{
      const before=new URL(current),keys=[...before.searchParams.keys()].filter(secretName);
      if(!keys.length)return candidate;
      const after=new URL(candidate);
      if(after.origin!==before.origin)return current;
      for(const key of keys){after.searchParams.delete(key);for(const value of before.searchParams.getAll(key))after.searchParams.append(key,value);}
      return after.href.replace(/%7B/gi,'{').replace(/%7D/gi,'}');
    }catch{return candidate;}
  }
  function applySuggestion(current,generated){
    checkJSON(current);checkJSON(generated);const secrets=collectSecrets(current),result=validateSuggestion(clean(generated,secrets)).tool;
    for(const key of LOCAL)if(own(current,key))result[key]=copy(current[key]);
    result.requireConfirmation=current.requireConfirmation===true||result.requireConfirmation||result.kind==='cli';
    for(const key of ['headers','env']){
      const values={};for(const [name,value] of Object.entries(result.config[key]))if(value&&!value.includes(REDACTED))values[name]=value;
      result.config[key]={...values,...copy(current.config?.[key]||{})};
    }
    result.config.body=restoreBody(result.config.body,current.config?.body,secrets);
    for(const previous of credentialArgs(current.config?.argv)){
      const argv=result.config.argv,index=argv.findIndex(arg=>arg===previous.flag||arg.startsWith(previous.flag+'='));
      if(index<0)argv.push(previous.flag,previous.value);
      else if(argv[index].includes('='))argv[index]=previous.flag+'='+previous.value;
      else if(index+1<argv.length&&!argv[index+1].startsWith('--'))argv[index+1]=previous.value;
      else argv.splice(index+1,0,previous.value);
    }
    for(const parameter of result.parameters){
      const previous=current.parameters?.find(value=>value.name===parameter.name&&secretName(value.name));
      if(previous){
        for(const field of ['default','enum'])if(own(previous,field))parameter[field]=copy(previous[field]);
        if(own(previous,'default')||own(previous,'enum')){parameter.type=previous.type;if(previous.itemsType)parameter.itemsType=previous.itemsType;else delete parameter.itemsType;}
      }
    }
    result.config.url=restoreURL(result.config.url,current.config?.url);
    result.config.poll.url=restoreURL(result.config.poll.url,current.config?.poll?.url);
    checkJSON(result);return result;
  }
  return {sanitizeInput,validateSuggestion,applySuggestion,collectSecrets,redactText};
});
