#!/usr/bin/env node
// Standalone MCP server that connects to an already-running bridge's WebSocket
// Claude Code spawns this as its MCP server process

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const port = parseInt(process.env.CLAUDE_BROWSER_PORT || '7862', 10);
let ws: WebSocket;
let callId = 0;
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function connect(): Promise<void> {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(`ws://localhost:${port}/mcp`);
    ws.on('open', () => resolve());
    ws.on('error', (err) => reject(err));
    ws.on('message', (raw: Buffer) => {
      if (raw[0] !== 0x01) return; // only control frames
      const msg = JSON.parse(raw.subarray(1).toString());
      if (msg.type === 'tool_response') {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error));
          else p.resolve(msg.result);
        }
      }
    });
  });
}

function callTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
  const id = `mcp_${++callId}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Tool ${tool} timed out`));
    }, 30000);

    pending.set(id, {
      resolve: (v) => { clearTimeout(timeout); resolve(v); },
      reject: (e) => { clearTimeout(timeout); reject(e); },
    });

    const payload = Buffer.from('\x01' + JSON.stringify({ type: 'tool_call', id, tool, args }));
    ws.send(payload);
  });
}

async function main() {
  await connect();

  const server = new McpServer({ name: 'claude-browser', version: '0.2.0' });

  // ─── Page Observation ────────────────────────────────────────────

  server.tool('page_snapshot', 'Get page content as a structured accessibility tree with element refs', {}, async () => {
    const result = await callTool('page_snapshot', {});
    return { content: [{ type: 'text', text: result as string }] };
  });

  server.tool('page_url', 'Get current page URL and title', {}, async () => {
    const result = await callTool('page_url', {});
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  server.tool('page_screenshot', 'Capture a screenshot of the current page', {}, async () => {
    const result = await callTool('page_screenshot', {});
    const dataUri = result as string;

    // Strip data URI prefix and decode base64
    const base64 = dataUri.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');

    // Save to ~/Downloads with timestamp
    const downloadsDir = join(homedir(), 'Downloads');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filePath = join(downloadsDir, `screenshot-${ts}.png`);

    await mkdir(downloadsDir, { recursive: true });
    await writeFile(filePath, buffer);

    return { content: [{ type: 'text', text: `Screenshot saved to ${filePath} (${(buffer.length / 1024).toFixed(0)} KB)` }] };
  });

  server.tool('select_text', 'Extract text content matching a CSS selector',
    { selector: z.string() },
    async ({ selector }) => {
      const result = await callTool('select_text', { selector });
      return { content: [{ type: 'text', text: result as string }] };
    });

  // ─── Element Interaction ─────────────────────────────────────────

  server.tool('click', 'Click an element by its ref from page_snapshot',
    { ref: z.string() },
    async ({ ref }) => {
      const result = await callTool('click', { ref });
      return { content: [{ type: 'text', text: result as string }] };
    });

  server.tool('type', 'Type text into an input element by its ref',
    { ref: z.string(), text: z.string() },
    async ({ ref, text }) => {
      const result = await callTool('type', { ref, text });
      return { content: [{ type: 'text', text: result as string }] };
    });

  server.tool('navigate', 'Navigate to a URL',
    { url: z.string() },
    async ({ url }) => {
      const result = await callTool('navigate', { url });
      return { content: [{ type: 'text', text: result as string }] };
    });

  server.tool('scroll', 'Scroll the page up or down',
    { direction: z.enum(['up', 'down']), amount: z.number().optional() },
    async ({ direction, amount }) => {
      const result = await callTool('scroll', { direction, amount: amount ?? 500 });
      return { content: [{ type: 'text', text: result as string }] };
    });

  server.tool('press_key', 'Press a keyboard key',
    { key: z.string() },
    async ({ key }) => {
      const result = await callTool('press_key', { key });
      return { content: [{ type: 'text', text: result as string }] };
    });

  server.tool('hover', 'Hover over an element by its ref (opens hover menus)',
    { ref: z.string() },
    async ({ ref }) => {
      const result = await callTool('hover', { ref });
      return { content: [{ type: 'text', text: result as string }] };
    });

  server.tool('drag', 'Drag from one element to another by ref',
    { fromRef: z.string(), toRef: z.string() },
    async ({ fromRef, toRef }) => {
      const result = await callTool('drag', { fromRef, toRef });
      return { content: [{ type: 'text', text: result as string }] };
    });

  // ─── JavaScript & Diagnostics ────────────────────────────────────

  server.tool('evaluate_js', 'Execute JavaScript in the page context and return the result',
    { expression: z.string() },
    async ({ expression }) => {
      const result = await callTool('evaluate_js', { expression });
      return { content: [{ type: 'text', text: result as string }] };
    });

  server.tool('console_logs', 'Get recent browser console messages (errors, warnings, logs)',
    { since: z.number().optional(), level: z.enum(['error', 'warning', 'info', 'log']).optional() },
    async ({ since, level }) => {
      const result = await callTool('console_logs', { since, level });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    });

  server.tool('network_requests', 'Get recent network requests (URLs, status codes, methods)',
    { since: z.number().optional(), filter: z.string().optional() },
    async ({ since, filter }) => {
      const result = await callTool('network_requests', { since, filter });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    });

  server.tool('cookies', 'Get cookies for the current page (including httpOnly)', {}, async () => {
    const result = await callTool('cookies', {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  });

  // ─── Tab Management ──────────────────────────────────────────────

  server.tool('list_tabs', 'List all open browser tabs with id, title, and URL', {}, async () => {
    const result = await callTool('list_tabs', {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  });

  server.tool('switch_tab', 'Switch to a different browser tab by id',
    { tabId: z.number() },
    async ({ tabId }) => {
      const result = await callTool('switch_tab', { tabId });
      return { content: [{ type: 'text', text: result as string }] };
    });

  server.tool('new_tab', 'Open a new browser tab with the given URL',
    { url: z.string() },
    async ({ url }) => {
      const result = await callTool('new_tab', { url });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    });

  server.tool('close_tab', 'Close a browser tab by id',
    { tabId: z.number() },
    async ({ tabId }) => {
      const result = await callTool('close_tab', { tabId });
      return { content: [{ type: 'text', text: result as string }] };
    });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Failed to start MCP server: ${err.message}\n`);
  process.exit(1);
});
