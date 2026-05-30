---
date: 2026-05-29
topic: open-ideation
focus: (surprise-me mode — no user-specified subject)
mode: repo-grounded
---

# Ideation: Claude Browser Bridge — Surprise-Me Run

## Grounding Context

**Project shape:**
- TypeScript monorepo: `bridge/` (Node.js, 4 files) + `extension/` (Chrome Manifest V3, 2 files)
- `background.ts` monolithic (621 lines) — CDP session manager, event buffers, all 18 tool implementations, message router
- Binary WebSocket framing (0x00=terminal, 0x01=control)
- Accessibility tree as page model via `Accessibility.getFullAXTree`
- 16 slash commands as thin prompt wrappers
- No tests, no CI, no linter, stale README

**Notable patterns:**
- CDP-only architecture (recent refactor removed content script)
- Accessibility tree snapshots with ref-token system (e0, e1, ...)
- PTY-based terminal in side panel via xterm.js
- Lazy debugger attach with persistent sessions

**Key pain points:**
1. `press_key` broken for non-ASCII keys (charCodeAt(0) mapping)
2. Accessibility tree bloat — 30-80K chars per snapshot, 100K hard truncation
3. Ephemeral refs — full re-snapshot required on any DOM mutation
4. No error recovery for stale CDP sessions
5. Single extension client hardcoded as global
6. Service worker 30-second death with no state persistence
7. Three-step manual startup (start bridge, load extension, open side panel)
8. README stale (references removed content.ts, 8 tools when there are 18)

**Past learnings:** CDP refactor (PR #1, commit 216aba6) documented extensive institutional knowledge including deferred features (shadow DOM, streaming, native messaging, workflow composition, annotated screenshots).

**External context:**
- browser-use (96k stars), Playwright MCP (33k), mcp-chrome (11.7k)
- Market validates Chrome extension + MCP model; token cost is hidden battle
- Multi-agent orchestration trending; anti-detection emerging as sub-category
- File upload/download absent from all browser automation MCP tools

## Topic Axes

Decomposition skipped — surprise-me mode

## Ranked Ideas

### 1. Fix Broken Keyboard Input

**Description:** The `press_key` implementation at `background.ts:391-398` uses `key.charCodeAt(0)` for `windowsVirtualKeyCode`, which is wrong for every non-letter key. "Enter" sends keyCode 69 (char code of 'E'), not 13. "Tab" sends 84 ('T'), not 9. Modifier combos like `Control+a` produce NaN. The fix: build a proper key-to-CDP-params lookup table covering special keys, arrow keys, and modifier combinations.

**Basis:** `direct:` `background.ts:392` — `key.charCodeAt(0)` applied unconditionally. The CLAUDE.md and tool docs both promise support for Enter, Escape, Tab, ArrowDown, Control+a, none of which work correctly.

**Rationale:** Keyboard input is fundamental to form interaction — Enter to submit, Escape to dismiss, Tab to navigate, Control+a to select. Every form-filling workflow depends on these. The tool is documented as working but is silently broken for its primary use case.

**Downsides:** Low risk. A lookup table is a well-understood problem (Playwright and Puppeteer both ship one). May need to handle platform differences (Mac vs Windows modifier keys).

**Confidence:** 95%
**Complexity:** Low (1-2 days)
**Status:** Unexplored

### 2. Token-Optimized Snapshot Granularity

**Description:** Add `detail` and `subtree` parameters to `page_snapshot`. Three detail levels: `minimal` (interactive elements + refs only, ~2K tokens), `standard` (current behavior), `full` (all nodes). The `subtree` parameter accepts a CSS selector to snapshot only a page region. This lets the agent control token spend per step — "click Submit" needs minimal, "what's on this page" needs full.

**Basis:** `direct:` `pageSnapshot()` at `background.ts:225` hard-truncates at 100K chars with no prioritization. Line 232-239 skips `generic`/`none` roles but keeps everything else. A typical "snapshot -> act -> snapshot" cycle on a news site burns ~100K tokens. Multiple independent frames converged on this as the #1 cost driver.

**Rationale:** Token cost scales linearly with snapshot size and call frequency. In a 10-step workflow, using minimal for 8 intermediate steps and standard for 2 bookends cuts token cost ~80%. At scale, this is the difference between viable and prohibitively expensive. It also extends context window capacity for longer workflows.

**Downsides:** `minimal` mode may miss context the agent needs (e.g., nearby text that disambiguates a button). Requires the agent to know when to request which level — adds decision overhead. `subtree` selector needs the agent to already know the page structure.

**Confidence:** 90%
**Complexity:** Medium (3-5 days)
**Status:** Unexplored

### 3. Persistent Element Identity with Ref-Cache

**Description:** The current ref system is fully ephemeral — every `page_snapshot` rebuilds the entire ref map from scratch, and any DOM mutation invalidates all refs. Three changes: (a) cache the accessibility tree per tab with mutation-aware staleness detection, returning cached results when the page hasn't changed; (b) after snapshot, inject `data-claude-ref` attributes into the DOM so refs persist across interactions within a page load; (c) when `resolveRef` detects staleness, fall back to re-querying the DOM attribute rather than forcing a full re-snapshot.

**Basis:** `direct:` `refMaps` at `background.ts:287` rebuilt from scratch on every snapshot. `resolveRef()` at line 290 throws "run page_snapshot again" with no recovery. Multiple frames converged — this is the single largest source of redundant tool calls. Every click costs 2 snapshots (~200K tokens of tree output).

**Rationale:** A 10-step form fill currently requires 10+ snapshot calls. With persistent refs, it drops to 1-2. Combined with snapshot granularity (#2), multi-step interactions become 4x cheaper in tool calls and tokens.

**Downsides:** DOM attribute injection modifies the page (though invisibly). Stale cache detection heuristics (URL change, mutation count, elapsed time) may miss edge cases. Shadow DOM elements can't receive `data-` attributes. Service worker death still invalidates the in-memory cache.

**Confidence:** 85%
**Complexity:** Medium-High (5-8 days)
**Status:** Unexplored

### 4. Cross-Frame Element Resolution for Shadow DOM and Iframes

**Description:** Extend `resolveRef` to search across shadow DOM boundaries and into iframe contexts. Currently, `DOM.resolveNode` with `backendDOMNodeId` cannot cross frame boundaries — buttons inside `<shadow-root>` or `<iframe>` are unreachable even when the accessibility tree exposes them. The fix: fetch the frame tree via `Page.getResourceTree`, attach to each frame's execution context, and route ref resolution to the correct target.

**Basis:** `external:` browser-use (96K stars) and Playwright both invest heavily in shadow DOM/iframe penetration because modern web apps (React, Lit, Angular, Salesforce) use these encapsulation boundaries extensively. The current `Accessibility.getFullAXTree` partially exposes shadow DOM content, but `resolveRef` at `background.ts:290` uses `DOM.resolveNode` which cannot cross frame boundaries.

**Rationale:** This is a capability gate — without it, all 18 tools fail on enterprise SaaS apps, React component libraries with shadow DOM, and pages with authenticated iframes. Fixing this makes every existing tool work on the modern web. Every workflow recorded, test built, and automation written works on production sites instead of simplified demos.

**Downsides:** High complexity. Frame management adds significant state tracking. Cross-origin iframes have security restrictions that may block CDP access entirely. Performance overhead of maintaining multiple CDP sessions per page.

**Confidence:** 80%
**Complexity:** High (8-12 days)
**Status:** Unexplored

### 5. Typed Tool Registry + CDP Descriptor Layer

**Description:** Define each tool as a typed descriptor object (name, Zod input schema, handler function, metadata). A single registration step generates both the MCP `server.tool()` calls and the `handleToolCall` dispatch. This eliminates the current pattern of maintaining parallel definitions in `mcp-client.ts` and `background.ts`. As a second phase, build a CDP-to-MCP mapping layer where a descriptor (CDP domain, method, parameter schema, result transformer) auto-generates the tool, making any CDP method a one-line addition.

**Basis:** `reasoned:` Currently adding a tool requires editing 3 files (background.ts handler + switch case, mcp-client.ts schema + wiring, CLAUDE.md docs). Any drift between them is a silent runtime error. With CDP exposing hundreds of methods (DOM, Storage, Input, Performance, Emulation), the marginal cost of each new capability drops from 30 lines of hand-maintained code to one descriptor object. The compounding path: registry enables testing, testing enables confident refactoring, refactoring enables rapid feature development.

**Rationale:** This is the foundational refactor that makes every other idea cheaper. It makes testing possible (each tool is an isolated unit). It makes adding CDP-backed tools trivial. It makes slash commands derivable from tool metadata. Every future feature ships faster because the tool infrastructure no longer requires hand-wiring.

**Downsides:** Requires a refactor of both `mcp-client.ts` and `background.ts` — risky if done without tests (which don't exist yet). The CDP descriptor layer adds abstraction that may obscure custom tool behavior. Some tools (like `page_snapshot`) have complex logic that doesn't fit a simple descriptor pattern.

**Confidence:** 85%
**Complexity:** Medium (4-6 days for registry; 3-5 additional days for CDP descriptors)
**Status:** Unexplored

### 6. Zero-Config Self-Bootstrapping Bridge

**Description:** Eliminate the three-step manual setup (start bridge, load extension, open side panel). Ship a single `npx claude-browser-bridge` command that: downloads and launches a bundled Chromium instance, connects via CDP directly (no extension needed), registers as the MCP server automatically, and discovers the running Claude process. The Chrome extension becomes an optional "live view" feature, not a required component.

**Final product form (recommended hybrid mode):**
- Auto-detect existing Chrome → connect via CDP → fallback to bundled Chromium
- MCP auto-registration to Claude Code config
- Extension downgraded to optional UI (visual action log, live page viewer)
- Session persistence via `chrome.storage.session` + auto-reconnect
- Architecture: Claude CLI ←stdio→ MCP Server ←CDP WebSocket→ Chrome (direct)
- Differentiator vs Playwright MCP (bundled only) and mcp-chrome (existing Chrome only): both modes

**Basis:** `external:` Playwright CLI (10.8k stars) proves "one command, working browser automation" is the winning adoption pattern. mcp-chrome (11.7k stars) derives adoption partly from easier setup. The current 3-step setup is documented in CLAUDE.md Quick Start as the primary failure mode.

**Rationale:** The current setup requires developer knowledge of Chrome extension loading, `chrome://extensions`, and MCP configuration. Zero-config turns the tool from a developer experiment into something any Claude Code user can run. This is the difference between 100 users and 10,000 users.

**Downsides:** Bundling Chromium adds ~150MB to install size. Talking CDP directly (no extension) means losing the side panel terminal UI. The extension's `chrome.debugger` API may behave differently from raw CDP over DevTools Protocol. Auto-discovery of the Claude process is platform-dependent.

**Confidence:** 85%
**Complexity:** Medium (5-7 days)
**Status:** Unexplored

### 7. Action Recorder -> Replayable Workflow Definitions

**Description:** Extend the existing event buffer architecture to record every tool invocation (tool name, args, result, timestamp) into a structured YAML/JSON session file. Tap into `handleToolCall` at `background.ts:589` to emit a structured record before execution. These artifacts become shareable, replayable workflow definitions — "how to sign up for service X" or "regression test for checkout flow" — that survive beyond the conversation.

**Basis:** `reasoned:` The bridge already captures the full chain: snapshots produce ref maps, actions resolve refs to coordinates, results flow back. Every tool call has a known schema. Tapping into `handleToolCall` to serialize before execution costs nearly nothing. The pattern is validated by Playwright's `codegen` and Chrome DevTools Recorder.

**Rationale:** Every Claude browser session today is disposable knowledge. A recorder transforms sessions into durable assets that can be shared, chained, version-controlled, and replayed. This creates a flywheel: humans record scripts, AI agents can read and modify those scripts, AI agents record their own successful sequences. It also enables visual regression testing — replay a recorded workflow and diff screenshots at each step.

**Downsides:** Ref-based recordings are fragile — DOM changes break refs, so replay requires either stable selectors or a re-snapshot step. Recording adds overhead to every tool call (though minimal). YAML format choice is arbitrary; JSONL or a custom format might be better for streaming.

**Confidence:** 80%
**Complexity:** Medium (4-6 days for basic recording; 3-5 additional days for replay engine)
**Status:** Unexplored

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | Tool errors are opaque | Better as part of tool registry refactor; standalone too incremental |
| 2 | Unified page_state tool | Too vague — "combine all representations" is not actionable as one tool |
| 3 | Yellow bar as trust model | Not grounded in current codebase pain; better suited for brainstorm |
| 4 | Extraction mode | Low novelty vs existing `select_text` + `evaluate_js` |
| 5 | Side panel visual inspector | Scope overrun — redesigns entire UI rather than improving current identity |
| 6 | Kuleshov context validation | Creative analogy but too abstract for implementation |
| 7 | Improv state transitions | Stretched analogy; absorbed by tool registry error handling |
| 8 | Debate flow sheet tracking | Abstract; practical equivalent covered by snapshot granularity |
| 9 | Playwright core (browser-agnostic) | Subject-replacement — abandons Chrome extension identity |
| 10 | Event-stream architecture | Very high complexity for speculative value |
| 11 | Vision-first page understanding | Shifts project's core identity from structured to visual |
| 12 | Tab-graph orchestration | Nice-to-have; current `list_tabs` + `switch_tab` works |
