# Backstage Content Implementation Plan

**Goal:** Keep explicit model-generated backstage blocks out of the visible answer and distinguish them from real tool events.

**Architecture:** Add a pure display-time splitter to `ui/core.js`. Render its answer in the existing answer container and its notes, escaped as plain text, inside the existing folded process container. Keep stored message content and API history unchanged. No live model calls or user-data writes.

**Tech Stack:** Existing vanilla JavaScript UI, node:test, Playwright/Chrome.

## Approved Behavior

- Recognize standalone-line `⟨幕后⟩` / `⟨/幕后⟩` blocks, including multiple blocks and missing closing markers.
- Do not treat quoted text, inline mentions, indented examples or fenced code as protocol markers.
- While streaming, withhold trailing partial protocol markers so internal notes never flash in the answer.
- Render notes in the existing collapsed process area under `幕后附注 · 模型生成`, separate from actual tool event rows. Keep scroll and expansion state during streaming.
- Copy-answer and Markdown answer export use the visible answer. Full JSON backups and model history retain all original data.
- Add a short application protocol to chat payloads: use actual advertised tools for calls; don't present invented logs as completed calls; required backstage notes use standalone markers. Do not alter the user's saved prompt.

## Task 1: Splitter and Protocol

- [x] Add `tests/message-content.test.js` for extraction, multiple/unclosed blocks, all streaming prefixes, code/inline protection, literal JSON and content preservation.
- [x] Add a payload-policy assertion preserving the original prompt/messages.
- [x] Run `node --test tests/message-content.test.js` and confirm missing-support failures.
- [x] Implement/export `splitAssistantContent(text, {streaming})` returning `{content, notes}` from a line-based state machine with code-fence tracking; add the payload protocol.
- [x] Rerun the focused unit tests: seven passed, including CRLF prefix and list indentation regressions found during review.

## Task 2: Rendering and Copy/Export

- [x] Add browser tests to `tests/conversation-layout.test.js` for existing stored records, collapsed notes, actual tool event counts, HTML escaping, streaming boundaries, copy/export and mobile bounds.
- [x] Confirm the test fails before editing the rendering.
- [x] Use the splitter in `assistantInner`, the copy-answer handler and Markdown export in `ui/app.js`. User messages remain literal; raw stored content stays intact.
- [x] Add restrained note text styles to `ui/conversation.css`, reusing the existing process heading treatment.
- [x] Verify desktop/mobile screenshots and browser behavior without external services.

## Task 3: Verification and Delivery

- [x] Update both existing guides, run the full test suite: 111 passed, zero failed/skipped. JavaScript syntax checks passed.
- [x] Review parser boundaries, preservation of original data and separation from real tool calls. All reproduced review findings were fixed and rechecked.
- [x] Update changed UI archive entries and verify every entry against local files.
- [x] Refresh only the isolated preview at http://127.0.0.1:43823. Existing pages receive the rendering fix after refresh, without a backend restart; the new chat protocol on the original backend requires restart.

## Publication

The user additionally requested publishing to `git@github.com:772758976youxiang-lgtm/Fy.git`, including configuration but excluding API keys. The repository was empty. The workspace now uses Git with `data/settings.json` and `data/tools.json` included; credential files, chat history, temporary files and environment files are ignored. Local credentials are not modified. Staged content is checked against known private key values and common credential patterns before publishing.
