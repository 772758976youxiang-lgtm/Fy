# Duplicate Tool Implementation Plan

> Execution: inline in the current workspace with test-driven development. This workspace has no Git repository, so no commits or worktrees are created.

**Goal:** Add the confirmed one-click duplication flow to the custom tool list.

**Architecture:** The authenticated backend duplicates a saved tool and its private credential through the existing Store persistence path. The browser sends only the source ID and receives public configuration, then opens the saved copy in the existing editor.

**Tech Stack:** Node.js, node:test, vanilla JavaScript, existing SVG icon sprite, Playwright with Chrome.

## Confirmed Design

- Add a copy icon beside edit, with an accessible label and tooltip.
- Clicking creates a saved, disabled copy and immediately opens its editor.
- Keep all fixed configuration, dynamic parameters, confirmation settings and remember-key preference.
- Generate a fresh ID, a unique name ending in `_copy` or `_copy_N`, and a label ending in `（副本）` or `（副本 N）`. Truncate the base to respect the existing limits.
- Duplicate credentials only inside the backend, with independent persistence bindings. Do not return the API key or execute the tool.
- Editing, removing or cancelling edits to the copy never changes the source. Cancelling leaves the already-created copy in the list.
- Use existing busy/error handling to prevent repeat clicks and ignore late responses after settings close.

## Task 1: Storage and API

- [x] Add failing tests to `tests/tool-storage.test.js` for independent copies, all supported kinds, temporary/remembered/absent keys, naming collisions and limits, missing sources, capacity and write rollback.
- [x] Add an authenticated route test to `tests/custom-tools-integration.test.js`; assert no upstream calls and no secret in responses.
- [x] Run `node --test tests/tool-storage.test.js tests/custom-tools-integration.test.js`; confirmed six failures for missing duplication support.
- [x] Implement `Store.duplicateTool(id)` in `storage.js`: read the source using `getTool`, return null if absent, remove the old ID, choose unused names, force `enabled: false`, and call `saveTool` with the existing private key.
- [x] Implement authenticated `POST /api/custom-tools/:id/duplicate` in `server.js`; respond with `{tool}` or a 404 error.
- [x] Rerun focused tests: 22 passed.

## Task 2: List Interaction

- [x] Add real-service Playwright coverage in `tests/custom-tools-browser.test.js` for the copy button, saved disabled copy, editable configuration, key placeholder, cancel/save independence, repeat-click blocking, failure recovery, late responses and offline state.
- [x] Run the new browser test and confirm failure because the copy button is missing.
- [x] In `ui/tool-manager.js`, render `button('duplicate', '复制 ' + label, 'copy', 'icon-button')` next to edit.
- [x] Handle duplication through `run`: POST the ID-only route, append the returned public tool, call `edit(response.tool)`, and announce that the disabled copy is saved.
- [x] Verify desktop and 320px layout bounds and screenshots. Existing CSS fits without changes.

## Task 3: Delivery

- [x] Update both existing user guides with the copy behavior.
- [x] Run `node --test tests/*.test.js` with the bundled Playwright NODE_PATH: 103 passed, zero failed or skipped. All six changed JavaScript files passed syntax checks.
- [x] Review credential lifecycle, error paths and screenshots; independent review found no actionable issues.
- [x] Refresh the UI-only Chrome archive; all 24 entry hashes match local UI files.
- [x] Refresh the isolated preview at http://127.0.0.1:43823 without stopping the user's primary backend or touching their stored tools. Verified the new route and asset without creating a tool. The primary backend needs a restart to load the new route.
