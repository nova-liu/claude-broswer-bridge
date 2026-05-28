# Claude Browser Bridge

Run Claude Code directly in the browser, with the ability to read and control the current page.

## Architecture

The project consists of two packages that communicate over WebSocket.

```
┌──────────────────────────────────────────────────────────┐
│                      Your Mac                            │
│                                                          │
│  ┌─────────────┐                   ┌──────────────────┐ │
│  │   bridge    │   ws://:7862      │    extension     │ │
│  │  (Node.js)  │◄────────────────►│  (Chrome ext.)   │ │
│  │             │                   │                  │ │
│  │  ┌───────┐  │  0x00 terminal    │  ┌────────────┐  │ │
│  │  │  PTY  │──┼──────────────────►│  │ sidepanel  │  │ │
│  │  │(claude│  │◄──────────────────┼──│ (xterm.js) │  │ │
│  │  │ CLI)  │  │  0x01 control     │  └─────┬──────┘  │ │
│  │  └───────┘  │                   │        │         │ │
│  │       ▲     │                   │  ┌─────▼──────┐  │ │
│  │  ┌────┴───┐ │  /mcp endpoint    │  │ background │  │ │
│  │  │MCP     │◄┼───────────────────┼──│ (router)   │  │ │
│  │  │client  │ │  tool_call /      │  └─────┬──────┘  │ │
│  │  │(stdio) │ │  tool_response    │        │         │ │
│  │  └────────┘ │                   │  ┌─────▼──────┐  │ │
│  └─────────────┘                   │  │  content   │  │ │
│                                    │  │  script    │  │ │
│                                    │  │ (DOM ops)  │  │ │
│                                    │  └────────────┘  │ │
│                                    └──────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

### bridge — Local server process

Spawns `claude` CLI inside a pseudo-terminal via node-pty, and starts a WebSocket server on `localhost:7862`. It serves three roles:

1. **Terminal proxy**: Forwards PTY output to the extension's side panel as WebSocket frames (prefixed `0x00`) for xterm.js rendering, and pipes side-panel keystrokes back into the PTY. Terminal resize events are synchronized on connection.

2. **MCP tool routing**: Exposes a dedicated `/mcp` WebSocket endpoint for the MCP client. When the MCP client sends a `tool_call`, the bridge forwards it to the extension; when the extension returns a `tool_response`, the bridge forwards it back to the MCP client.

3. **MCP client entry point** (`mcp-client.ts`): A standalone stdio process that Claude Code spawns as an MCP server subprocess. It connects to the bridge via the `/mcp` WebSocket endpoint and registers 8 browser tools for Claude Code.

### extension — Chrome extension (Manifest V3)

Three scripts working together:

| Script | Runs in | Role |
|--------|---------|------|
| `sidepanel.ts` | Side panel page | xterm.js terminal renderer + WebSocket client; reads keyboard input, displays Claude Code output |
| `background.ts` | Service Worker | Message router: forwards `tool_call` from the side panel to the active tab's content script |
| `content.ts` | Every web page | DOM operator: page snapshots, element clicks, text input, scrolling, navigation, keystrokes |

### Wire protocol

WebSocket uses binary frames with a single-byte prefix:

```
byte[0] = 0x00 → terminal data (UTF-8 text fed into PTY or xterm)
byte[0] = 0x01 → control message (JSON for routing / tool calls)
```

Control message format:

```
{ type: "tool_call",  id: "mcp_1", tool: "page_snapshot", args: { ... } }
{ type: "tool_response", id: "mcp_1", result: "..." | error: "..." }
{ type: "resize",    cols: 120, rows: 40 }
```

### MCP tools

Eight browser tools exposed to Claude Code via MCP:

| Tool | Parameters | What it does |
|------|-----------|--------------|
| `page_snapshot` | none | Returns all visible text on the page plus numbered interactive elements |
| `page_url` | none | Returns the current page URL and title |
| `select_text` | `selector: string` | Extracts text from elements matching a CSS selector |
| `click_element` | `index: number` | Clicks an element by its `page_snapshot` index |
| `type_text` | `index: number, text: string` | Types into an input field (React-compatible) |
| `scroll` | `direction: up\|down, amount?: number` | Scrolls the page |
| `navigate` | `url: string` | Navigates to a new URL |
| `press_key` | `key: string` | Dispatches a keyboard event |

### Key implementation details

**Page snapshot** (`content.ts`): Uses `document.createTreeWalker` to walk the DOM. Every visible element is checked for interactivity (a/button/input/select/textarea, `role="button"`, `onclick`, `tabIndex >= 0`). Interactive elements are indexed into the `indexedElements` array so subsequent click/type operations reference DOM nodes directly by index rather than re-querying.

**React-compatible input**: `type_text` does not use `el.value = text`. Instead it calls the native setter via `Object.getOwnPropertyDescriptor(prototype, 'value').set`, then manually dispatches `input` and `change` events with `bubbles: true`. This ensures React's synthetic event system picks up the change.

**PATH resolution**: On startup, the bridge runs `/bin/zsh -lc "which claude"` to resolve the full path to the `claude` binary, avoiding node-pty's non-login-shell PATH issues.

**Auto-reconnect**: The side panel WebSocket client auto-reconnects every 2 seconds on disconnect. When the bridge process exits, both the WebSocket server and PTY are shut down.

## Usage

### 1. Build

```bash
pnpm install
pnpm build
```

This builds both the bridge (ESM for Node.js) and the extension (IIFE for Chrome).

### 2. Start the bridge

```bash
node bridge/dist/index.js
```

The bridge launches `claude` CLI and listens on `ws://localhost:7862`. Use an environment variable or CLI flag for a different port:

```bash
node bridge/dist/index.js --port 9000
# or
CLAUDE_BROWSER_PORT=9000 node bridge/dist/index.js
```

### 3. Load the Chrome extension

1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `extension/` directory (not the `dist` subdirectory)

After loading, click the extension icon to open the side panel. The xterm.js terminal will display Claude Code's interface.

### 4. Configure Claude Code's MCP server

Add the following to Claude Code's MCP config (`.claude/settings.json` or VS Code settings):

```json
{
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["/path/to/claude-browser-bridge/bridge/dist/mcp-client.js"]
    }
  }
}
```

If using a non-default port, add the environment variable:

```json
{
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["/path/to/claude-browser-bridge/bridge/dist/mcp-client.js"],
      "env": {
        "CLAUDE_BROWSER_PORT": "9000"
      }
    }
  }
}
```

### 5. Use it

Once configured, Claude Code can control the browser directly with these tools:

- `page_snapshot` — get page structure and interactive element indices
- `click_element` — click buttons, links, etc.
- `type_text` — fill in forms
- `navigate` — go to a new page
- …and all 8 tools

Typical workflow: call `page_snapshot` to get element indices, then `click_element` or `type_text` by index, then `page_snapshot` again to verify the result.

### Notes

- The bridge spawns the `claude` command by default. Make sure `claude` CLI is findable by your zsh login shell via PATH.
- The extension cannot operate on `chrome://` or `chrome-extension://` pages.
- Element indices may become stale after the page mutates (DOM nodes replaced). Re-run `page_snapshot` to refresh the index.
- The content script injects into all URLs (`<all_urls>`). Only use with a trusted bridge process.
