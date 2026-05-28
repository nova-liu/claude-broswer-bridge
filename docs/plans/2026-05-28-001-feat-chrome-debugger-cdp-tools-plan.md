---
title: "refactor: Replace content script tools with CDP via chrome.debugger"
created: 2026-05-28
status: active
type: refactor
---

# refactor: Replace Content Script Tools with CDP via chrome.debugger

## Problem Frame

The Claude Browser Bridge exposes 8 MCP tools to Claude Code, all implemented via Chrome extension content script DOM APIs. These tools are limited: `page_snapshot` produces a flat text dump losing all semantic structure, `click_element` uses synthetic `.click()` instead of real mouse events, `type_text` requires React-specific hacks, and critical capabilities (screenshots, JS execution, console logs, network inspection, cookies) are impossible from content scripts due to Chrome's isolation model.

The goal is to **replace the entire content script tool layer with CDP** (Chrome DevTools Protocol) via the `chrome.debugger` extension API. This eliminates content.ts entirely, simplifies the architecture from 3 hops to 2, and delivers both better versions of existing tools AND new capabilities that were previously impossible.

## Scope Boundaries

### In Scope
- Replacing all 8 content script tools with CDP equivalents
- Deleting `content.ts` and removing content script injection from manifest.json
- Adding new CDP-only tools: screenshot, evaluate_js, console_logs, network_requests, cookies, hover, drag
- Multi-tab management tools: list_tabs, switch_tab, new_tab, close_tab
- Upgrading page_snapshot to Chrome's accessibility tree
- Managing debugger attachment lifecycle in background.ts

### Deferred to Follow-Up Work
- Shadow DOM and iframe penetration via a11y tree deep traversal
- Streaming/MutationObserver-based live page watching
- Zero-config auto-discovery via Native Messaging Host
- Workflow composition (multi-step atomic tool chains)
- Annotated screenshot overlays (bounding boxes on elements)

### Outside This Scope
- Adding Playwright or any external browser automation dependency
- Modifying Chrome startup parameters (`--remote-debugging-port`)
- Adding external npm runtime dependencies

## Key Technical Decisions

### 1. All tools run in background.ts via chrome.debugger — no content script

The `chrome.debugger` API is only available to service workers. All tool execution moves to `background.ts`. This eliminates the 3-hop chain (sidepanel → background → content script) and replaces it with a 2-hop chain (sidepanel → background + CDP). Content.ts is deleted entirely.

### 2. Accessibility tree snapshot with stable ref tokens

`page_snapshot` uses CDP `Accessibility.getFullAXTree` to produce a structured tree with ARIA roles, states, and relationships. Each interactive element gets a stable `ref` token derived from its position in the a11y tree. Subsequent tools (`click`, `type`, `hover`) accept these refs instead of fragile numeric indices. This matches what Playwright MCP's `browser_snapshot` provides.

### 3. Real input events via CDP Input domain

Instead of synthetic DOM events (`el.click()`, `new KeyboardEvent()`), all interactions use CDP's `Input.dispatchMouseEvent` and `Input.dispatchKeyEvent`. These are indistinguishable from real user input — they work with all frameworks (React, Vue, Angular) without framework-specific hacks.

### 4. Lazy attach, persistent session

The debugger attaches to a tab on first tool call, then stays attached until the tab closes or the service worker terminates. Multiple CDP domains (Page, Network, Console, Runtime, Accessibility, Input) are enabled on first attach. This keeps the yellow security bar from appearing until actually needed.

### 5. MV3 service worker lifecycle handling

Service workers can be terminated after ~30s of inactivity, dropping the CDP session. Strategy: listen for `chrome.debugger.onDetach`, clean up state, and re-attach on the next tool call. Event-based tools (console_logs, network_requests) buffer events in memory and may lose events during sleep — acceptable since the agent polls on demand.

### 6. DevTools conflict — clear error, no fallback

If DevTools (F12) is open on a tab, `chrome.debugger.attach()` fails. The tool returns a clear error: "Cannot attach debugger — close DevTools on this tab first." There is no content script fallback — the architecture is CDP-only.

### 7. MCP client registers all tools

`bridge/src/mcp-client.ts` registers all ~18 tools. The `callTool()` mechanism is unchanged — the bridge forwards tool_calls to the extension, which handles them entirely in background.ts.

## Architecture

```
Before:
  MCP → Bridge → Extension(sidepanel → background → content script)  — 3 hops
  8 tools, text-only snapshots, synthetic events, no diagnostics

After:
  MCP → Bridge → Extension(background + chrome.debugger)              — 2 hops
  ~18 tools, a11y tree snapshots, real input events, full diagnostics
```

## Implementation Units

### U1. Add CDP infrastructure and remove content script

**Goal:** Establish the CDP session manager in background.ts, remove content.ts and its manifest injection, update permissions.

**Requirements:** Foundation for all tools. Eliminates the content script layer.

**Dependencies:** None

**Files:**
- `extension/manifest.json` — add `"debugger"`, `"tabs"` permissions; remove `content_scripts` section
- `extension/src/background.ts` — add CDP manager (attach/detach/sendCommand), tool dispatcher
- `extension/src/content.ts` — delete this file
- `extension/tsup.config.ts` — remove `content` entry point

**Approach:**
- Add a CDP manager module in background.ts:
  - `ensureAttached(tabId)` — attach if not already, enable domains: Page, Runtime, Network, Console, Accessibility, Input
  - `sendCdp(tabId, method, params)` — Promise wrapper around `chrome.debugger.sendCommand`
  - `onDetach` listener — clean up session state per tab
- Rewrite the `onMessage` listener in background.ts:
  - Remove content script forwarding logic
  - All tool calls handled directly in background.ts via CDP
  - Get active tab via `chrome.tabs.query({ active: true, currentWindow: true })`
- Delete `extension/src/content.ts`
- Remove `content_scripts` block and `<all_urls>` from manifest.json
- Add `"debugger"` and `"tabs"` to permissions array

**Patterns to follow:**
- Existing message routing pattern in `background.ts`

**Test scenarios:**
- Happy path: extension loads without content script, receives tool_call via sidepanel, routes to CDP handler
- Happy path: CDP attach succeeds, sendCommand returns valid result
- Edge case: tab has DevTools open — attach fails, clear error returned
- Edge case: tab is `chrome://` URL — restricted page error
- Error path: attach fails unexpectedly — error propagated in tool_response
- Regression: sidepanel terminal still works (WebSocket connection unaffected)

**Verification:** Extension loads, sidepanel connects, a tool_call is received and routed through CDP. No content script injection occurs.

---

### U2. Implement core interaction tools via CDP Input domain

**Goal:** Replace click, type, scroll, press_key, navigate with CDP real-input equivalents.

**Requirements:** All existing interaction tools work via CDP with real events.

**Dependencies:** U1

**Files:**
- `extension/src/background.ts` — implement click, type, scroll, press_key, navigate handlers
- `bridge/src/mcp-client.ts` — update tool registrations (same names, new implementation)

**Approach:**
- `click({ ref })` — resolve a11y ref to element coordinates via `Accessibility.getFullAXTree` + `DOM.resolveNode`, then `Input.dispatchMouseEvent` (mousePressed + mouseReleased)
- `type({ ref, text })` — focus element via click, then `Input.insertText({ text })` — works with React/Vue/Angular without hacks
- `scroll({ direction, amount })` — `Input.dispatchMouseEvent` with `mouseWheel` type
- `press_key({ key })` — `Input.dispatchKeyEvent` (keyDown + keyUp)
- `navigate({ url })` — `Page.navigate({ url })`, wait for `Page.loadEventFired` or timeout

**Test scenarios:**
- Happy path: click a button on a test page, verify action fires
- Happy path: type into an input field, verify value changes (including React-controlled inputs)
- Happy path: navigate to a URL, verify page loads
- Happy path: scroll down, verify scroll position changes
- Happy path: press Enter key, verify keydown/keyup events fire
- Edge case: click on a ref that no longer exists (DOM changed) — clear error
- Edge case: type into a readonly field — error or no-op

**Verification:** On a test page with a form: click the submit button, type in an input, press Enter, navigate to another page. All succeed with real events.

---

### U3. Implement page_snapshot via accessibility tree

**Goal:** Replace the flat text DOM walker with Chrome's structured accessibility tree.

**Requirements:** Structured semantic snapshot with ARIA roles, states, stable ref tokens.

**Dependencies:** U1

**Files:**
- `extension/src/background.ts` — implement `page_snapshot` handler using `Accessibility.getFullAXTree`

**Approach:**
- Call `Accessibility.getFullAXTree` to get the full a11y tree
- Walk the tree, format as indented text with role, name, and state:
  ```
  heading "Welcome to Example" [level=1]
  navigation
    link "Home" [ref=e12]
    link "About" [ref=e13]
  main
    button "Sign In" [ref=e20] [enabled]
    textbox "Email" [ref=e21] [focused]
    textbox "Password" [ref=e22]
  ```
- Each interactive element gets a `ref` token (e.g., `e20`) derived from its AXNodeId
- Interactive elements: button, link, textbox, checkbox, radio, combobox, menuitem, tab, switch, etc.
- Truncate output at ~100KB to match existing behavior
- Build a ref-to-node mapping for subsequent click/type/hover calls

**Test scenarios:**
- Happy path: snapshot a page with headings, links, buttons, inputs — tree shows correct roles and names
- Happy path: snapshot a page with ARIA labels — labels appear in the tree
- Edge case: page with no semantic HTML (all divs) — implicit roles still detected
- Edge case: page is mostly empty — returns minimal tree
- Edge case: page exceeds 100KB — truncated with marker

**Verification:** Snapshot a GitHub issue page. Tree shows `heading "Issue title"`, `button "Submit comment"`, `textbox` with correct nesting and ref tokens.

---

### U4. Implement screenshot tool

**Goal:** Expose `page_screenshot` MCP tool via CDP.

**Requirements:** Agent can see the page visually.

**Dependencies:** U1

**Files:**
- `extension/src/background.ts` — implement handler using `Page.captureScreenshot`
- `bridge/src/mcp-client.ts` — add tool registration

**Approach:**
- `Page.captureScreenshot({ format: 'png' })` returns base64 data
- Return as MCP text content with base64 image data

**Test scenarios:**
- Happy path: capture screenshot of a visible page, verify valid PNG
- Edge case: blank page — returns valid minimal image
- Error path: debugger not attached — clear error

**Verification:** Screenshot tool returns a base64 string that decodes to the current page.

---

### U5. Implement evaluate_js tool

**Goal:** Expose `evaluate_js` MCP tool via CDP `Runtime.evaluate`.

**Requirements:** Universal escape hatch for arbitrary JS execution.

**Dependencies:** U1

**Files:**
- `extension/src/background.ts` — implement handler using `Runtime.evaluate`
- `bridge/src/mcp-client.ts` — add tool registration

**Approach:**
- `Runtime.evaluate({ expression, returnByValue: true })` in page's main world
- Return result value or error message
- Truncate large results (e.g., full DOM HTML) to prevent overflow

**Test scenarios:**
- Happy path: `document.title` returns page title
- Happy path: `document.cookie` returns cookies
- Edge case: expression throws — return error message
- Edge case: large return value — truncated

**Verification:** `evaluate_js({ expression: "1 + 1" })` returns `2`.

---

### U6. Implement diagnostic tools (console_logs, network_requests)

**Goal:** Expose console and network monitoring tools via CDP event domains.

**Requirements:** Agent can observe errors and network activity.

**Dependencies:** U1

**Files:**
- `extension/src/background.ts` — implement Console/Network event listeners, ring buffers, query tools
- `bridge/src/mcp-client.ts` — add tool registrations

**Approach:**
- On attach: `Console.enable()`, `Network.enable()`
- Buffer events in per-tab ring buffers (last 200 entries)
- `console_logs({ since?, level? })` — return buffered messages, filtered by level/timestamp
- `network_requests({ filter?, since? })` — return buffered requests, filtered by URL pattern
- Clear buffers on detach

**Test scenarios:**
- Happy path: `console.error("test")` appears in console_logs
- Happy path: fetch request appears in network_requests with URL, status, method
- Edge case: no events — empty array
- Edge case: buffer full — oldest dropped

**Verification:** Trigger console error and fetch on a page, both appear in respective tools.

---

### U7. Implement cookies tool

**Goal:** Expose `cookies` MCP tool via CDP `Network.getCookies`.

**Requirements:** Agent can read cookies including httpOnly.

**Dependencies:** U1

**Files:**
- `extension/src/background.ts` — implement handler
- `bridge/src/mcp-client.ts` — add tool registration

**Approach:**
- `Network.getCookies({ urls: [currentUrl] })` returns cookies for the page
- Return as JSON array with name, value, domain, path, httpOnly, secure

**Test scenarios:**
- Happy path: page with cookies, returns them correctly
- Edge case: no cookies — empty array
- Edge case: httpOnly cookies — included (CDP has access)

**Verification:** Set a cookie, call cookies tool, verify it appears.

---

### U8. Implement multi-tab tools

**Goal:** Expose `list_tabs`, `switch_tab`, `new_tab`, `close_tab` via `chrome.tabs` API.

**Requirements:** Agent can manage multiple tabs.

**Dependencies:** U1

**Files:**
- `extension/src/background.ts` — implement tab management handlers
- `bridge/src/mcp-client.ts` — add 4 tool registrations

**Approach:**
- `list_tabs()` — `chrome.tabs.query({})` returns id, title, url, active status for all tabs
- `switch_tab({ tabId })` — `chrome.tabs.update(tabId, { active: true })`
- `new_tab({ url })` — `chrome.tabs.create({ url })`, return new tab id
- `close_tab({ tabId })` — `chrome.tabs.remove(tabId)`
- All other tools default to the active tab but can accept an optional `tabId` parameter

**Test scenarios:**
- Happy path: list tabs shows open tabs
- Happy path: switch_tab changes active tab
- Happy path: new_tab opens URL, close_tab closes it
- Edge case: close the active tab — Chrome handles tab focus
- Error path: invalid tabId — clear error

**Verification:** Open 2 tabs, list both, switch between them, close one.

---

### U9. Implement hover and drag tools

**Goal:** Expose `hover` and `drag` tools via CDP Input domain.

**Requirements:** Agent can open hover menus and perform drag-and-drop.

**Dependencies:** U3 (needs a11y ref resolution for coordinates)

**Files:**
- `extension/src/background.ts` — implement using `Input.dispatchMouseEvent`
- `bridge/src/mcp-client.ts` — add tool registrations

**Approach:**
- `hover({ ref })` — resolve ref to element bounding rect center, dispatch `mouseMoved` event
- `drag({ fromRef, toRef })` — resolve both refs, dispatch `mousePressed` → `mouseMoved` → `mouseReleased`
- Element coordinates obtained by resolving a11y ref to DOM node, then `DOM.getBoxModel`

**Test scenarios:**
- Happy path: hover opens a CSS :hover dropdown menu
- Happy path: drag moves an element from position A to B
- Edge case: ref not found — clear error
- Edge case: element moves during drag — release at last position

**Verification:** Hover menu appears. Drag sortable list reorders.

---

### U10. Update and add slash commands for all tools

**Goal:** Ensure every MCP tool has a corresponding `.claude/commands/` slash command so users can invoke capabilities naturally (e.g., `/screenshot`, `/debug`, `/tabs`).

**Requirements:** All new tools are accessible via slash commands. Existing commands updated for new tool names.

**Dependencies:** U2-U9 (all tools must exist before commands reference them)

**Files:**
- `.claude/commands/look.md` — update (already exists, may need tool name adjustment)
- `.claude/commands/click.md` — update
- `.claude/commands/type.md` — update
- `.claude/commands/goto.md` — update
- `.claude/commands/scroll.md` — update
- `.claude/commands/key.md` — update
- `.claude/commands/select.md` — update
- `.claude/commands/url.md` — update
- `.claude/commands/screenshot.md` — new
- `.claude/commands/debug.md` — new (console_logs + network_requests)
- `.claude/commands/eval.md` — new (evaluate_js)
- `.claude/commands/cookies.md` — new
- `.claude/commands/tabs.md` — new (list_tabs + switch_tab + new_tab + close_tab)
- `.claude/commands/hover.md` — new
- `.claude/commands/drag.md` — new

**Approach:**
- Each command is a short instruction file (1-3 sentences) that tells Claude which MCP tools to use and how
- Pattern: "Use the [tool] MCP tool to [action]. [Then do X]. Confirm [result]."
- New commands follow the same concise style as existing ones
- `debug.md` combines console_logs and network_requests into a single diagnostic command
- `tabs.md` covers listing, switching, creating, and closing tabs
- Update existing commands if tool names changed (e.g., `click_element` → `click`)

**Command list:**

| Command | Description | Tools used |
|---|---|---|
| `/look` | See current page | page_snapshot |
| `/click <element>` | Click an element | page_snapshot + click |
| `/type <element> <text>` | Type into a field | page_snapshot + type |
| `/goto <url>` | Navigate to URL | navigate + page_snapshot |
| `/scroll <up/down>` | Scroll the page | scroll + page_snapshot |
| `/key <key>` | Press a keyboard key | press_key + page_snapshot |
| `/select <selector>` | Extract text by CSS selector | select_text |
| `/url` | Get current page URL | page_url |
| `/screenshot` | Capture page screenshot | page_screenshot |
| `/debug` | Show console errors and network failures | console_logs + network_requests |
| `/eval <expression>` | Run JavaScript on the page | evaluate_js |
| `/cookies` | Show page cookies | cookies |
| `/tabs` | List and manage tabs | list_tabs, switch_tab, new_tab, close_tab |
| `/hover <element>` | Hover over an element | page_snapshot + hover |
| `/drag <from> <to>` | Drag from one element to another | page_snapshot + drag |

**Verification:** Type `/screenshot` in Claude Code, verify screenshot is captured. Type `/tabs`, verify tab list appears. Type `/debug`, verify console/network info appears.

---

## MCP Tool Summary

After implementation, the extension exposes these tools via MCP:

| Tool | Source | New/Upgraded |
|---|---|---|
| `page_snapshot` | Accessibility.getFullAXTree | **Upgraded** (was DOM walker) |
| `click` | Input.dispatchMouseEvent | **Upgraded** (was el.click()) |
| `type` | Input.insertText | **Upgraded** (was native setter hack) |
| `navigate` | Page.navigate | **Upgraded** (was window.location) |
| `scroll` | Input.dispatchMouseEvent (wheel) | **Upgraded** (was window.scrollBy) |
| `press_key` | Input.dispatchKeyEvent | **Upgraded** (was KeyboardEvent) |
| `page_url` | Runtime.evaluate | Equivalent |
| `select_text` | Runtime.evaluate | Equivalent |
| `page_screenshot` | Page.captureScreenshot | **New** |
| `evaluate_js` | Runtime.evaluate | **New** |
| `console_logs` | Console domain events | **New** |
| `network_requests` | Network domain events | **New** |
| `cookies` | Network.getCookies | **New** |
| `hover` | Input.dispatchMouseEvent | **New** |
| `drag` | Input.dispatchMouseEvent | **New** |
| `list_tabs` | chrome.tabs.query | **New** |
| `switch_tab` | chrome.tabs.update | **New** |
| `new_tab` | chrome.tabs.create | **New** |
| `close_tab` | chrome.tabs.remove | **New** |

## System-Wide Impact

- **Deleted files:** `extension/src/content.ts` — no longer needed
- **Manifest changes:** Remove `content_scripts` block, add `"debugger"` and `"tabs"` permissions
- **Yellow security bar:** Appears when CDP is first used on a tab ("An extension is debugging this browser") — Chrome requirement, cannot be suppressed
- **Service worker lifecycle:** CDP sessions drop on ~30s inactivity. Re-attach on next tool call. Event buffers lost during sleep.
- **DevTools conflict:** If F12 is open, CDP tools fail with clear error. No fallback (content script is gone).
- **MCP tool count:** 8 → ~19 tools. All better quality than the originals.
- **No new runtime dependencies:** All via Chrome's built-in `chrome.debugger` API
- **Bridge minimal change:** Only `mcp-client.ts` needs new `server.tool()` entries. WebSocket protocol and PTY untouched.

## Assumptions

- The yellow "extension is debugging" bar is acceptable (Chrome security requirement, cannot be suppressed)
- The user does not commonly keep DevTools open on tabs they want Claude to control
- MCP tool responses can include base64 image data for screenshots
- 30-second service worker sleep window is acceptable — agent polls on demand
- Removing the content script fallback is acceptable — CDP-only architecture is simpler and more capable
