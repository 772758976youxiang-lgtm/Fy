# Reply Choices Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement these steps in this session.

**Goal:** Send complete action choices with one click, keeping choices visible only for the current round and hiding their content from historical replies.

**Architecture:** Extract only explicit, trailing action-choice lists from visible assistant text. Render buttons for the latest completed reply; leave the stored model context unchanged. Retire choices immediately on send or leaving the conversation, including across reloads. Reuse the existing guarded send path for browser and backend modes.

**Tech Stack:** Vanilla JavaScript, existing Markdown renderer, Node test runner, Playwright.

## Tasks

- [x] Add `tests/reply-choices.test.js`: screenshot-style Chinese lists, standardized action headings, fenced examples, ordinary lists, malformed lists, preserved story body and footer.
- [x] Run `node --test tests/reply-choices.test.js`, expecting missing `extractReplyChoices` failures.
- [x] Add `extractReplyChoices(text)` to `ui/core.js`, returning `{content, heading, options, footer}` or `null`. Require a clear action cue and 2-6 complete list items. Do not infer actions from arbitrary lists, quotes, code or process notes. Add a concise payload policy for consistent future action lists.
- [x] Add `tests/reply-choices-browser.test.js` with isolated stores and fake streams for direct/backend modes. Check full-text sending, duplicate-click suppression, immediate disappearance, free-text sending, new-chat/history/reload behavior, failed/stopped replies, copy/export and desktop/mobile layout.
- [x] Run the browser test before implementing UI behavior; expect no choice buttons.
- [x] Update `ui/app.js`: render escaped full-text buttons with the existing arrow symbol, validate current message ID and choice index, call `send(text)`, retire choices before async work, hide historical option sections without deleting raw conversation data.
- [x] Add restrained responsive button styles to `ui/conversation.css`; use keyboard focus, wrapping and fixed icon sizing.
- [x] Run focused tests and the complete `node --test tests/*.test.js` suite with the bundled Playwright NODE_PATH. Inspect desktop/mobile screenshots. All 120 tests passed, none skipped.
- [x] Obtain focused code review, address findings, update both usage guides, and refresh matching UI files in `Luma-Chrome.zip` with byte-for-byte checks. Retirement now prunes only obsolete final-reply keys instead of evicting live history; all 24 extension entries match UI sources.
- [x] Verify the isolated preview, inspect Git diff and credential exclusions. Preview assets match disk; the scan passed for all 57 tracked files, with credentials and conversation storage excluded.

**Release:** Commit and publish only this feature, its tests, guides and refreshed extension package to the user-designated repository. The existing primary backend is left running; restart it to load the new action-formatting policy.
