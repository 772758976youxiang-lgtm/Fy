# AI Tool Authoring Implementation Plan

> **For agentic workers:** Use subagent-driven-development for the bounded backend task and integrate the UI in this session. Verify spec compliance, then request independent review. No Git repository is present; do not create commits or worktrees.

**Goal:** Generate a complete editable custom-tool draft from natural language or pasted API documentation, with explicit preview and apply.

**Architecture:** A header action opens an inline authoring section above the tool editor. An authenticated, stateless backend route calls the currently configured chat model without tools/search. Shared validation and secret filtering protect both request and candidate. Applying changes only the form; save and trial remain separate user actions.

**Tech Stack:** Existing vanilla JS, Node built-ins, shared UMD helpers, node:test and Playwright/Chrome.

## Approved Design

User selected complete tool configuration generation. Include name, kind, description,
fixed provider settings, dynamic parameter rows, body/result/poll templates. Reuse
saved main model, key and effort. No additional provider integration, conversation
history, automatic fetching of pasted links, tool execution or automatic saving.
Keep the existing key locally; never include it in model context. Missing URL/model/
executable/MCP selection must stay empty and be highlighted, never filled with invented
provider values. Preview complete JSON with a compact identity/parameter summary.

## Task 1: Shared Privacy, Draft Validation And Backend

Files: new `ui/tool-authoring.js`, new `tool-authoring.js`, `server.js`,
new `tests/tool-authoring.test.js`.

- [x] Write failing tests for authenticated generation, model reuse, empty/missing main key,
  input secrecy, unknown/malformed output, missing config values, no storage/execution,
  cancellation, bounded output and upstream errors.
- [x] Implement shared UMD `LumaToolAuthoring` exports:
  `sanitizeInput({prompt,tool},{secrets=[]}={})` -> safe `{prompt,tool}`;
  `validateSuggestion(tool)` -> `{tool,missingFields}`;
  `applySuggestion(current,generated)` -> local editable draft with current identity,
  API key/key flags and protected credential fields preserved, new config otherwise.
  Use JSON parsing, allowlisted shape, bounded depth/length, no eval. Strip unknown
  save-only fields and credentials. Do not expose current headers/env values to AI.
  Normalize with `LumaToolConfig.normalizeTool`, temporarily supply validator-only
  sentinels for blank required destination/model/executable/name, then restore blanks
  and return missingFields. Invalid nonempty values still fail validation. CLI always
  requires confirmation, existing confirmation true cannot be weakened by suggestion.
- [x] Implement `generateToolDraft({store,input,fetchImpl=fetch,signal})` ->
  `{tool,missingFields,model}`. Validate prompt 1..24000 characters, optional partial
  tool <=128 KiB, main key required. Endpoint/main key must come only from store.
  Build structured system instructions with full tool schema, supported kinds,
  templating, fixed config rules, and unknown-field policy. User docs remain user data.
  Reuse current model/effort through core payload, no tools. Accept complete JSON or
  one JSON fence only. Bound upstream response <=1 MiB, candidate <=128 KiB, total
  timeout 120s, abort on client disconnect. No streamed unvalidated draft to UI.
  Return sanitized errors; do not log or persist prompts, docs or candidates.
- [x] Route `POST /api/custom-tools/generate` behind existing token/origin checks;
  add controller to operations so shutdown/credential forgetting accounts for it.
- [x] Run focused tests, inspect behavior against approved design, report limitations.

## Task 2: Header Action, Preview And Apply

Files: new `ui/tool-authoring-panel.js`, `ui/tool-manager.js`,
`ui/tool-manager.css`, `ui/index.html`, `ui/app.js`,
new `tests/tool-authoring-browser.test.js`.

- [x] Write browser failing tests using the actual backend with stub completion only:
  header position, fields unchanged before Apply, key retained, no saved tool until
  Save, retry/errors, cancellation and settings close preventing stale apply.
- [x] Add `#tool-authoring-button` with existing sparkle icon next to close control,
  visible only on tool settings. Disabled without backend or while other tool request
  is pending. Manager public `author()` enters editor if needed, then opens panel.
- [x] Panel module `LumaToolAuthoringPanel.create({root,getBackend,getDraft,onApply})`
  returns `open(),close()`. Compact inline section, textarea `创作需求与接口文档`,
  Generate/Stop, candidate preview, missing-field list, explicit Apply/Discard.
  Keep current form untouched until Apply; during generation disable editor mutations,
  keep close/cancel usable. Store prompt/candidate only for this editing session.
- [x] Manager uses collect(false), adds isolated panel outside the editor form,
  restores original API key and metadata on apply, replaces editor with resulting draft,
  highlights missing fields and reports applied-unsaved state. Cancel/close/type changes
  reset/abort authoring. No phantom confirmation from earlier trial survives apply.
- [x] Responsive header/panel at desktop and 320px, escape all model text, maintain
  keyboard focus, respect existing modal focus handling.
- [x] Run browser tests and visually inspect screenshots.

## Task 3: Review And Delivery

- [x] Independent spec/quality review of request secrecy, response validation, stale
  async lifecycle, key preservation and no implicit save/execution. Fix findings and
  add regression tests.
- [x] Run `node --test tests/*.test.js` with bundled Playwright NODE_PATH; syntax-check
  JS; update both README copies; rebuild Chrome ZIP and compare every entry hash.
- [x] Restart only our preview service or use an unused port, verify route/assets and
  provide preview URL. Do not touch user's primary service or data.

## Verification Commands

```powershell
$env:NODE_PATH='C:\Users\PC\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
node --test tests/tool-authoring.test.js tests/tool-authoring-browser.test.js
node --test tests/*.test.js
```

All upstream calls in tests use local mocks and fake keys. Real paid model behavior
cannot be verified without user-provided credentials.

## Verification Results

- Full regression: 91 passed, 0 failed, 0 skipped.
- Authoring coverage: 27 backend/shared tests and 5 browser workflows.
- Syntax checks: 28 JavaScript files passed.
- Chrome archive: all 24 entries matched UI source hashes.
- Desktop and 320px screenshots inspected; no overflow or header overlap.
- Independent UI and backend reviews completed; concrete findings fixed with regressions.
- Updated preview: http://127.0.0.1:43823. Primary service/data left untouched.
- No paid provider calls performed; generation tests use fake upstream responses.
