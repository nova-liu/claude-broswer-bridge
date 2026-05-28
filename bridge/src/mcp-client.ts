#!/usr/bin/env node
// Standalone MCP server that connects to an already-running bridge's WebSocket
// Claude Code spawns this as its MCP server process

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebSocket } from 'ws';
import { z } from 'zod';

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

  const server = new McpServer({ name: 'claude-browser', version: '0.1.0' });

  server.tool('page_snapshot', 'Get current page content with indexed interactive elements', {}, async () => {
    const result = await callTool('page_snapshot', {});
    return { content: [{ type: 'text', text: result as string }] };
  });

  server.tool('page_url', 'Get current page URL and title', {}, async () => {
    const result = await callTool('page_url', {});
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  server.tool('select_text', 'Get text content of a CSS selector',
    { selector: z.string() },
    async ({ selector }) => {
      const result = await callTool('select_text', { selector });
      return { content: [{ type: 'text', text: result as string }] };
    });

  server.tool('click_element', 'Click element by index from page_snapshot',
    { index: z.number() },
    async ({ index }) => {
      const result = await callTool('click_element', { index });
      return { content: [{ type: 'text', text: result as string }] };
    });

  server.tool('type_text', 'Type text into an input element',
    { index: z.number(), text: z.string() },
    async ({ index, text }) => {
      const result = await callTool('type_text', { index, text });
      return { content: [{ type: 'text', text: result as string }] };
    });

  server.tool('scroll', 'Scroll the page',
    { direction: z.enum(['up', 'down']), amount: z.number().optional() },
    async ({ direction, amount }) => {
      const result = await callTool('scroll', { direction, amount: amount ?? 500 });
      return { content: [{ type: 'text', text: result as string }] };
    });

  server.tool('navigate', 'Navigate to a URL',
    { url: z.string() },
    async ({ url }) => {
      const result = await callTool('navigate', { url });
      return { content: [{ type: 'text', text: result as string }] };
    });

  server.tool('press_key', 'Press a keyboard key',
    { key: z.string() },
    async ({ key }) => {
      const result = await callTool('press_key', { key });
      return { content: [{ type: 'text', text: result as string }] };
    });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Failed to start MCP server: ${err.message}\n`);
  process.exit(1);
});
