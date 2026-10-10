'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const C=require('../ui/core');

test('explicit backstage blocks are separated without parsing or inventing tool events',()=>{
 const raw='正文。\n\n⟨幕后⟩\nscene_build → {"hidden":["未公开信息"]}\n<script>alert(1)</script>\n⟨/幕后⟩\n\n继续正文。';
 const parts=C.splitAssistantContent(raw);
 assert.equal(parts.content,'正文。\n\n\n继续正文。');
 assert.deepEqual(parts.notes,['scene_build → {"hidden":["未公开信息"]}\n<script>alert(1)</script>']);
 assert.ok(raw.includes('⟨幕后⟩'));
 assert.equal(parts.tools,undefined);
});

test('multiple blocks and unfinished blocks preserve their note text and answer order',()=>{
 assert.deepEqual(C.splitAssistantContent('开头\n⟨幕后⟩\nfirst\n⟨/幕后⟩\n中间\n⟨幕后⟩\nsecond'),
  {content:'开头\n中间\n',notes:['first','second']});
 assert.deepEqual(C.splitAssistantContent('⟨幕后⟩\n\n⟨/幕后⟩\n正文'),{content:'正文',notes:[]});
 assert.deepEqual(C.splitAssistantContent('⟨幕后⟩\nraw state'),{content:'',notes:['raw state']});
});

test('streaming chunk boundaries never expose backstage text or partial standalone markers',()=>{
 for(const newline of ['\n','\r\n']){
  const raw=['正文','⟨幕后⟩','secret state','⟨/幕后⟩','后续'].join(newline);
  for(let end=0;end<=raw.length;end++){
   const parts=C.splitAssistantContent(raw.slice(0,end),{streaming:true});
   assert.doesNotMatch(parts.content,/secret|state|[⟨⟩]|幕后/,String(end));
   for(const note of parts.notes)assert.doesNotMatch(note,/⟨\/幕|⟨\/|⟨$/,'Partial closing marker at '+end);
  }
 }
 assert.equal(C.splitAssistantContent('正文\n⟨幕').content,'正文\n⟨幕','Completed non-marker text is preserved');
 assert.equal(C.splitAssistantContent('正文\n⟨幕',{streaming:true}).content,'正文\n');
});

test('inline, quoted, indented and code-fenced marker examples remain visible',()=>{
 const examples=[
  '普通文字中提到 ⟨幕后⟩，不是区块。',
  '`⟨幕后⟩` 和 `⟨/幕后⟩`',
  '> ⟨幕后⟩\n> 示例\n> ⟨/幕后⟩',
  '    ⟨幕后⟩\n    indented example\n    ⟨/幕后⟩',
  '```text\n⟨幕后⟩\nexample\n⟨/幕后⟩\n```',
  '~~~~\n```\n⟨幕后⟩\nexample\n⟨/幕后⟩\n```\n~~~~',
  '````text\n```\n⟨幕后⟩\nexample\n⟨/幕后⟩\n```\n````',
  '- ```text\n  ⟨幕后⟩\n  example\n  ⟨/幕后⟩\n  ```',
  '1. ~~~text\n   ⟨幕后⟩\n   example\n   ⟨/幕后⟩\n   ~~~',
  '```text\n⟨幕',
  '普通 <div>HTML</div> 与 <think>文字</think>',
  '⟨/幕后⟩\nUnmatched closing marker',
  '第一行\r\n第二行\r\n'
 ];
 for(const raw of examples)for(const streaming of [false,true]){
  assert.deepEqual(C.splitAssistantContent(raw,{streaming}),{content:raw,notes:[]},raw);
 }
});

test('code within a backstage block cannot prematurely close it or affect following answer fences',()=>{
 const raw='开头\n⟨幕后⟩\n```text\n⟨/幕后⟩\n```\n{"literal":"⟨/幕后⟩"}\n⟨/幕后⟩\n后续\n```\n⟨幕后⟩\n```';
 assert.deepEqual(C.splitAssistantContent(raw),{content:'开头\n后续\n```\n⟨幕后⟩\n```',notes:['```text\n⟨/幕后⟩\n```\n{"literal":"⟨/幕后⟩"}']});
 assert.deepEqual(C.splitAssistantContent('正文\r\n  ⟨幕后⟩ \r\nstate\r\n  ⟨/幕后⟩\r\n后续'),{content:'正文\r\n后续',notes:['state']});
});

test('list fence indentation closes before a following real backstage block',()=>{
 for(const prefix of ['10. ','  - ','100. ']){
  const indent=' '.repeat(prefix.length);
  const example=prefix+'```text\n'+indent+'example\n'+indent+'```\n\n';
  const raw=example+'⟨幕后⟩\nsecret-state\n⟨/幕后⟩\nanswer';
  assert.deepEqual(C.splitAssistantContent(raw),{content:example+'answer',notes:['secret-state']});
 }
});

test('chat payload keeps user instructions and raw history while defining truthful tool and note presentation',()=>{
 const messages=[{role:'assistant',content:'⟨幕后⟩\nstate\n⟨/幕后⟩'}];
 const before=structuredClone(messages);
 const payload=C.createPayload({systemPrompt:'用户配置的角色规则',effort:'high'},messages);
 assert.match(payload.messages[0].content,/用户配置的角色规则/);
 assert.match(payload.messages[0].content,/真实.*工具调用/);
 assert.match(payload.messages[0].content,/不要.*伪造/);
 assert.match(payload.messages[0].content,/⟨幕后⟩.*独立.*行/);
 assert.deepEqual(payload.messages.slice(1),messages);
 assert.deepEqual(messages,before);
 assert.equal(payload.tools,undefined);
});
