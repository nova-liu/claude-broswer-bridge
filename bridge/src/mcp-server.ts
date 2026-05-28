import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebSocketServer } from 'ws';
import { sendToolCall } from './websocket.js';
import { z } from 'zod';

export function createMcpServer(wss: WebSocketServer): McpServer {
  const server = new McpServer({
    name: 'claude-browser-bridge',
    version: '0.1.0',
  });

  let callId = 0;

  function nextId(): string {
    return `tool_${++callId}`;
  }

  // Page reading tools
  server.tool('page_snapshot', 'Get structured content of the current page with indexed interactive elements', {}, async () => {
    const result = await sendToolCall(wss, nextId(), 'page_snapshot', {});
    return { content: [{ type: 'text', text: result as string }] };
  });

  server.tool('page_url', 'Get current page URL and title', {}, async () => {
    const result = await sendToolCall(wss, nextId(), 'page_url', {});
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  server.tool('select_text', 'Get text content of a CSS selector',
    { selector: z.string().describe('CSS selector to query') },
    async ({ selector }) => {
      const result = await sendToolCall(wss, nextId(), 'select_text', { selector });
      return { content: [{ type: 'text', text: result as string }] };
    }
  );

  // Page action tools
  server.tool('click_element', 'Click an interactive element by its index from page_snapshot',
    { index: z.number().describe('Element index from page_snapshot') },
    async ({ index }) => {
      const result = await sendToolCall(wss, nextId(), 'click_element', { index });
      return { content: [{ type: 'text', text: result as string }] };
    }
  );

  server.tool('type_text', 'Type text into an input element',
    {
      index: z.number().describe('Element index from page_snapshot'),
      text: z.string().describe('Text to type'),
    },
    async ({ index, text }) => {
      const result = await sendToolCall(wss, nextId(), 'type_text', { index, text });
      return { content: [{ type: 'text', text: result as string }] };
    }
  );

  server.tool('scroll', 'Scroll the page',
    {
      direction: z.enum(['up', 'down']).describe('Scroll direction'),
      amount: z.number().optional().describe('Pixels to scroll (default 500)'),
    },
    async ({ direction, amount }) => {
      const result = await sendToolCall(wss, nextId(), 'scroll', { direction, amount: amount ?? 500 });
      return { content: [{ type: 'text', text: result as string }] };
    }
  );

  server.tool('navigate', 'Navigate to a URL',
    { url: z.string().describe('URL to navigate to') },
    async ({ url }) => {
      const result = await sendToolCall(wss, nextId(), 'navigate', { url });
      return { content: [{ type: 'text', text: result as string }] };
    }
  );

  server.tool('press_key', 'Press a keyboard key',
    { key: z.string().describe('Key to press (Enter, Tab, Escape, etc.)') },
    async ({ key }) => {
      const result = await sendToolCall(wss, nextId(), 'press_key', { key });
      return { content: [{ type: 'text', text: result as string }] };
    }
  );

  return server;
}

export async function startMcpServer(wss: WebSocketServer) {
  const server = createMcpServer(wss);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
