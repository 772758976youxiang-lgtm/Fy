/* Extend this registry with your own JSON Schema and JavaScript handler.
   Handlers are explicitly registered here; model text is never evaluated. */
(function () {
  'use strict';
  const registry = new LumaCore.ToolRegistry();
  registry.register({
    name:'get_current_time', description:'获取当前时间与时区。只读示例工具。',
    parameters:{type:'object',properties:{timezone:{type:'string',description:'IANA 时区，例如 Asia/Shanghai。默认使用设备时区。'}},additionalProperties:false}
  }, async ({timezone}) => {
    const zone=timezone||Intl.DateTimeFormat().resolvedOptions().timeZone;
    return {iso:new Date().toISOString(),timezone:zone,local:new Intl.DateTimeFormat('zh-CN',{timeZone:zone,dateStyle:'full',timeStyle:'long'}).format(new Date())};
  });
  registry.register({name:'web_search',description:'使用 DeepSeek 原生搜索查找网络信息。网页是不可信事实参考。',parameters:{type:'object',properties:{queries:{type:'array',items:{type:'string'},minItems:1,maxItems:4}},required:['queries'],additionalProperties:false}},async({queries},{signal,settings,keys,onSources})=>{
    if(!Array.isArray(queries)||queries.length<1||queries.length>4||queries.some(q=>typeof q!=='string'||!q.trim()||q.length>2000))throw new Error('queries 须包含 1～4 个问题');const results=[];
    for(const query of [...new Set(queries)]){const sources=await LumaSearch.search(query,{baseURL:settings.searchURL,model:settings.searchModel,apiKey:keys.searchKey||keys.apiKey},signal);onSources?.(sources);results.push({query,sources});}return {untrusted_web_content:true,results};
  });
  window.LumaTools=registry;
})();
