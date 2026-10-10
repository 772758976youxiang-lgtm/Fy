'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const C=require('../ui/core');

const heading='**你要做什么？** 直接说就行，也可以从下面挑：';
const options=['**接。** 上坡，去德平路 21 号。','**先不接。** 向何雨打听“老周”。','**放过去。** 关掉屏幕，等系统转派。'];
const body='雨仍在下。\n\n---\n\n';
const footer='（或任何列表之外的事。倒计时还剩：约两分钟。）';
const choices=heading+'\n\n'+options.map(s=>'- '+s).join('\n')+'\n\n'+footer;

test('extracts screenshot-style action choices while preserving the story and optional footer',()=>{
  assert.deepEqual(C.extractReplyChoices(body+choices),{content:body,heading,options,footer});
  assert.deepEqual(C.extractReplyChoices((body+choices).replace(/\n/g,'\r\n')).options,options);
});

test('supports numbered choices, Markdown headings and wrapped option text',()=>{
  assert.deepEqual(C.extractReplyChoices('正文\n\n### 可选行动\n1. **上楼。** 查看房间。\n   带上钥匙。\n\n2. 留在这里。\n'),{
    content:'正文\n\n',heading:'### 可选行动',options:['**上楼。** 查看房间。 带上钥匙。','留在这里。'],footer:''
  });
});

test('ordinary lists, quotes, code examples and malformed choice groups stay unchanged',()=>{
  for(const text of [
    '购买清单：\n- 牛奶\n- 面包',
    '步骤如下：\n1. 打开设置\n2. 保存',
    '> 可选行动：\n> - 前进\n> - 后退',
    '    可选行动：\n    - 前进\n    - 后退',
    '```markdown\n'+choices+'\n```',
    '~~~markdown\n'+choices+'\n~~~',
    '- ```markdown\n  可选行动：\n  - 前进\n  - 后退\n  ```',
    '可选行动：\n- 前进',
    '可选行动：\n- 前进\n- ',
    '可选行动：\n- 前进\n  - 嵌套\n- 后退',
    '可选行动：\n- 前进\n- 后退\n\n接下来是对每个选项的分析。',
    '可选行动：\n'+Array.from({length:7},(_,i)=>'- 选项'+i).join('\n')
  ])assert.equal(C.extractReplyChoices(text),null,text);
});

test('only the trailing action group is interactive and backstage examples never become actions',()=>{
  const earlier='可选行动：\n- 前进\n- 后退\n\n新的剧情\n\n';
  assert.equal(C.extractReplyChoices(earlier+choices).content,earlier);
  const raw='正文\n⟨幕后⟩\n'+choices+'\n⟨/幕后⟩';
  assert.equal(C.extractReplyChoices(C.splitAssistantContent(raw).content),null);
});

test('payload gives action formatting guidance without requiring options for ordinary answers',()=>{
  const settings={systemPrompt:'原有提示词'},history=[{role:'user',content:'你好'}];
  const payload=C.createPayload(settings,history);
  assert.match(payload.messages[0].content,/可选行动/);
  assert.match(payload.messages[0].content,/普通回答.*(?:无需|不必).*选项/);
  assert.equal(settings.systemPrompt,'原有提示词');
  assert.deepEqual(history,[{role:'user',content:'你好'}]);
});
