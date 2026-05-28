# Claude Browser Bridge

You have access to a **live Chrome browser** via MCP tools. You can see pages, click buttons, fill forms, navigate, and read anything the user can see — all through the `browser` MCP server.

## Quick Start

If the browser tools are not responding, the user needs to:
1. Start the bridge: `node bridge/dist/index.mjs`
2. Load the Chrome extension from `extension/` in `chrome://extensions` (Developer mode)
3. Open the side panel via the extension icon

## Core Workflow: Snapshot → Act → Snapshot

**Always get a page snapshot before interacting with elements.** Interactive elements have `ref` tokens (like `e0`, `e5`, `e12`) that you use to click, type, hover, or drag.

```
1. page_snapshot → see the page, find element refs
2. click/type/hover/drag → act on a ref
3. page_snapshot → verify what changed
```

Ref tokens are stable within a page but change on navigation. Always re-snapshot after navigating.

## 18 MCP Tools Reference

### Seeing the Page

| Tool | Use when |
|------|----------|
| `page_snapshot` | **First step for any interaction.** Returns accessibility tree with element refs. |
| `page_screenshot` | Need visual confirmation or to show the user what the page looks like. Saves PNG to `~/Downloads/`. |
| `page_url` | Need the current URL and page title. |
| `select_text` | Extract specific text via CSS selector (e.g., `"h1"`, `".price"`, `"#status"`). |
| `console_logs` | Debug JS errors, warnings, API logs. Filter by `level` or `since` timestamp. |
| `network_requests` | Inspect HTTP requests. Filter by `filter` (URL substring) or `since` timestamp. |
| `cookies` | Read all cookies including httpOnly — useful for auth debugging. |

### Interacting with Elements

| Tool | Use when |
|------|----------|
| `click` | Click a button, link, checkbox, etc. Requires a `ref` from `page_snapshot`. |
| `type` | Type text into an input/textarea. Focuses the element first. Requires `ref` + `text`. |
| `hover` | Open hover menus, tooltips, or trigger CSS `:hover` states. Requires `ref`. |
| `drag` | Drag-and-drop from one element to another. Requires `fromRef` + `toRef`. |
| `press_key` | Press keyboard keys: `"Enter"`, `"Escape"`, `"Tab"`, `"ArrowDown"`, `"Control+a"`, etc. |

### Navigation

| Tool | Use when |
|------|----------|
| `navigate` | Go to a URL. Triggers full page load — re-snapshot after. |
| `scroll` | Scroll `up` or `down`. Optional `amount` in pixels (default 500). |

### Advanced

| Tool | Use when |
|------|----------|
| `evaluate_js` | Run arbitrary JavaScript in the page context. Returns result (truncated at 50KB). |
| `list_tabs` | See all open tabs with id, title, url. |
| `switch_tab` | Switch to a different tab by its numeric id. |
| `new_tab` | Open a new tab with a URL. |
| `close_tab` | Close a tab by its numeric id. |

## Slash Commands

The project has 15 slash commands in `.claude/commands/` that wrap the tools with a consistent pattern. Use them for common tasks:

- `/look` — Show what's on the current page
- `/click <element>` — Click an element by description or ref
- `/type <element> <text>` — Type into an input field
- `/goto <url>` — Navigate to a URL
- `/scroll up|down` — Scroll the page
- `/key <key>` — Press a keyboard key
- `/select <css-selector>` — Extract text via CSS
- `/screenshot` — Capture and display a screenshot
- `/debug` — Diagnose page errors and failed requests
- `/eval <js>` — Run JavaScript on the page
- `/cookies` — Show page cookies
- `/tabs` — List and manage tabs
- `/hover <element>` — Hover over an element
- `/drag <from> <to>` — Drag between elements
- `/url` — Show current URL

## Interaction Patterns

### Fill and submit a form
```
page_snapshot → type (ref for input, text) → type (next input, text) → click (submit ref) → page_snapshot
```

### Multi-tab workflow
```
list_tabs → switch_tab (target tabId) → page_snapshot → interact...
```

### Debug a broken page
```
console_logs (level: "error") → network_requests (filter: "api") → page_screenshot
```

### Extract structured data
```
page_snapshot (to understand DOM) → select_text (CSS selector) or evaluate_js (custom query)
```

## Build & Development

```bash
pnpm install          # Install dependencies
pnpm build            # Build bridge + extension
pnpm dev              # Watch mode for bridge
```

## Project Structure

```
bridge/src/
  index.ts          # Entry point: PTY + WebSocket server (port 7862)
  mcp-client.ts     # MCP server (stdio) — registers all 18 tools
  pty.ts            # Spawns claude CLI via node-pty
  websocket.ts      # Binary frame protocol: 0x00=terminal, 0x01=control

extension/src/
  background.ts     # Service worker — all tool execution via CDP (chrome.debugger)
  sidepanel.ts      # xterm.js terminal UI in Chrome side panel
```

## Technical Notes

- Wire protocol uses binary WebSocket frames: `0x00` = terminal data, `0x01` = JSON control message
- Element refs (e0, e1, ...) come from the accessibility tree snapshot and map to screen coordinates via CDP
- All interactions use real mouse/keyboard events via CDP `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`
- Console and network buffers hold last 200 entries per tab, returned as last 50 by default
- Tool calls have a 30-second timeout
- Default bridge port: 7862 (override with `--port` flag or `CLAUDE_BROWSER_PORT` env var)
