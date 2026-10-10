# Custom Callable Tools

Approved scope: settings tool manager with generic HTTP templates for LLM, judge,
image, video, HTTP, plus MCP Streamable HTTP and local CLI. Existing on-demand
search, picker, and collapsed process UI must remain intact. No provider credentials
or paid live calls are used in tests. Custom execution requires the local backend.

## Shared Contract

`ui/tool-config.js` is UMD (`LumaToolConfig` / CommonJS). Exports:

- `KINDS`: array of `{value,label}`.
- `createTemplate(kind)`: new editable tool object (no id, no API key).
- `normalizeTool(input)`: validated public config, throws descriptive errors.
- `definition(tool)`: `{name,description,parameters}` with only dynamic arguments.
- `validateArguments(tool,args)`: validates, inserts defaults, rejects unknown keys.
- `renderTemplate(value,{args,config,result})`: recursively substitutes safe dotted
  placeholders, full placeholder preserves type; embedded placeholders scalar only.
- `extractPath(value,path)`: own-property-only dotted path, supports numeric indices.

Tool shape:

```js
{
  id, name, label, description,
  kind: 'llm'|'judge'|'image'|'video'|'http'|'mcp'|'cli',
  enabled: true, requireConfirmation: false, rememberKey: false,
  parameters: [{name,type,description,required,default?,enum?,itemsType?}],
  config: {
    url: '', method: 'POST', model: '', effort: 'none', systemPrompt: '',
    auth: 'bearer', authHeader: 'X-API-Key', headers: {}, body: {},
    resultPath: '', output: 'text'|'json'|'image'|'video', timeoutMs: 60000,
    poll: {enabled:false,url:'',statusPath:'status',successValues:['completed','succeeded'],
      failureValues:['failed','cancelled'],intervalMs:2000,maxAttempts:30,resultPath:''},
    executable:'', argv:[], cwd:'', env:{}, apiKeyEnv:'TOOL_API_KEY', mcpTool:''
  }
}
```

CLI always requires confirmation; MCP defaults to confirmation. Definitions never
contain config or secrets. Tool names unique and exclude builtin names. Parameter
types string/number/integer/boolean/object/array; optional defaults/enums/item types.
Reject reserved config parameter names (url/model/effort/apiKey/systemPrompt/
executable/argv/cwd/env/headers), dangerous prototype keys, invalid URLs, excessive
sizes/counts. API key is a separate save-only `apiKey` field; empty preserves existing;
`removeKey:true` clears. Arbitrary additional call arguments are rejected.

Storage owns `tools.json` and optional `tool-credentials.json`. Methods:
`listTools()` public configs with hasApiKey; `getTools()` and `getTool(id)` internal
copies including apiKey; `saveTool(input)` public result; `removeTool(id)` boolean.
Secrets memory-only unless rememberKey. forgetCredentials also clears custom keys.

`custom-tools.js` exports:
- `executeCustomTool(tool,args,{fetchImpl=fetch,signal,approve})` ->
  `{output:any,artifacts:[{type:'image'|'video',url:string}]}`.
- `discoverMcpTools(tool,{fetchImpl=fetch,signal})` -> upstream tools array.
- `approvalPreview(tool,args)` -> safe `{label,kind,args,executable?,argv?,url?}`.
Executor validates arguments, fails closed when confirmation absent/denied, bounds
timeout/output, honors cancellation, uses fixed destination/config/auth. HTTP
redirects rejected; poll URL only result placeholders, URL-encoded, same origin.
MCP supports initialize, initialized notification, tools/list/call, JSON or SSE,
session/protocol headers and cleanup. CLI uses spawn shell:false/windowsHide:true,
bounded output, fixed executable/argv/cwd, minimal inherited environment. No shell
interpolation or .cmd/.bat execution. No base64 media sent to the main model.

## API And UI Contract

- GET `custom-tools` -> `{tools}`
- POST `custom-tools` input tool (id optional) -> `{tool}`
- DELETE `custom-tools/:id` -> `{ok:true}`
- POST `custom-tools/test` `{tool?,id?,args,confirmed?}` -> executor result;
  without confirmed and confirmation required -> `{requiresConfirmation:true,preview}`.
  A supplied draft id merges only its saved secret, never supplied runtime args.
- POST `custom-tools/discover` `{tool?,id?}` -> `{tools}` for MCP metadata only.
- POST `tool-approvals/:id` `{allow:boolean}` -> `{ok:true}`.

Authenticated backend request client already exists as `.request(route,{method,data,signal})`.
`ui/tool-manager.js` exports `LumaToolManager.create({root,getBackend})`, returning
`open()` and `close()`. Root is tools settings section. Own save/cancel actions in
editor. Public list supports edit/toggle/delete; add opens form with type templates,
fixed config, parameter rows, JSON body/header advanced config, result/poll settings,
test args/result, MCP discovery/import selected schema. Do not reveal stored key.
Disconnected state disables writes and states backend connection required.
Use existing SVG symbols (not a new icon dependency). Form stays within current
settings panel, no nested modal. Responsive, keyboard accessible, input labels,
validation and pending/error feedback. Text should be compact Chinese UI copy.

Root integrates manager with openSettings/closeSettings and tool SSE. CLI/MCP
approval event is folded process data, automatically expanded while waiting, with
allow/deny buttons and escaped safe preview. Each one-use approval token is tied to
active session and abort/timeout. Chat uses per-turn snapshot of tool configuration.
Custom names/labels/artifacts remain in process, never separate chat messages.

## Work Units

1. Shared schema + storage + tests: tool-config.js, storage.js.
2. Executor + tests: custom-tools.js. Independent protocol contract above.
3. Settings UI + browser tests: tool-manager.js/css, index.html only.
4. Root integration + tests: server.js, agent.js, app.js, conversation.css.
5. Spec review then code quality/security review; full tests, screenshots, ZIP sync,
   documentation and preview server.

## Verification

Run Node test suite with bundled Playwright runtime. Test schema rejection/defaults,
secret persistence/redaction, actual mock HTTP/MCP/CLI execution and approval denial,
polling/cancellation, authenticated CRUD and chat dispatch, browser settings CRUD and
responsive form. Preserve previous search/picker/conversation tests. Use only local
mock upstreams. Compare packaged UI files byte-for-byte. MCP reference:
https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle
https://modelcontextprotocol.io/specification/2025-06-18/server/tools

## Verification Record

Implemented all five work units. Backend spec review passed; subsequent backend
and UI reviews found issues that were corrected and independently re-reviewed.
Remembered credentials are bound to the normalized configuration hash and failed
writes roll back; unsupported MCP schema imports fail without changing the draft;
type changes preserve edited configuration; new approvals scroll into view once;
expanded tool results remain open through subsequent streaming updates.

Final local verification: 59 tests passed, zero failures/skips; syntax checks for
23 JavaScript files; Chrome ZIP contains 22 byte-matching UI files. Browser checks
cover desktop and 320px mobile. Preview http://127.0.0.1:43823 serves authenticated
custom-tool endpoints and the new assets. Tests use fake credentials/local mocks;
no real provider or paid execution was performed. MCP is Streamable HTTP only,
basic schema import only, and generated media currently requires HTTP(S) URLs.
