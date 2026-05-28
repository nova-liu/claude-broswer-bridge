import { WebSocketServer, WebSocket } from 'ws';
import { IPty } from 'node-pty';

// Frame protocol:
// 0x00 + data = terminal data (binary)
// 0x01 + JSON = control message (resize, tool call, tool response)

export const FRAME_TERMINAL = 0x00;
export const FRAME_CONTROL = 0x01;

export interface ControlMessage {
  type: 'resize' | 'tool_call' | 'tool_response';
  [key: string]: unknown;
}

export function createWebSocketServer(port: number, ptyProcess: IPty): WebSocketServer {
  const wss = new WebSocketServer({ port });

  wss.on('connection', (ws: WebSocket) => {
    console.log('Extension connected');

    // Forward PTY output to WebSocket as terminal frames
    const dataHandler = ptyProcess.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        const payload = Buffer.alloc(1 + Buffer.byteLength(data));
        payload[0] = FRAME_TERMINAL;
        payload.write(data, 1);
        ws.send(payload);
      }
    });

    const exitHandler = ptyProcess.onExit(({ exitCode }) => {
      console.log(`PTY exited with code ${exitCode}`);
      ws.close(1000, 'PTY exited');
    });

    ws.on('message', (raw: Buffer) => {
      const frameType = raw[0];
      const data = raw.subarray(1);

      if (frameType === FRAME_TERMINAL) {
        // Keyboard input from extension → PTY
        ptyProcess.write(data.toString());
      } else if (frameType === FRAME_CONTROL) {
        const msg: ControlMessage = JSON.parse(data.toString());
        handleControlMessage(msg, ptyProcess, ws);
      }
    });

    ws.on('close', () => {
      console.log('Extension disconnected');
      dataHandler.dispose();
      exitHandler.dispose();
    });
  });

  return wss;
}

function handleControlMessage(msg: ControlMessage, ptyProcess: IPty, ws: WebSocket) {
  switch (msg.type) {
    case 'resize':
      ptyProcess.resize(msg.cols as number, msg.rows as number);
      break;
    case 'tool_response':
      // MCP tool response from extension — handled by mcp-server via event
      toolResponseHandlers.get(msg.id as string)?.(msg);
      toolResponseHandlers.delete(msg.id as string);
      break;
  }
}

// Tool call/response coordination
type ResponseHandler = (msg: ControlMessage) => void;
const toolResponseHandlers = new Map<string, ResponseHandler>();

export function sendToolCall(wss: WebSocketServer, id: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      toolResponseHandlers.delete(id);
      reject(new Error(`Tool call ${tool} timed out after 30s`));
    }, 30000);

    toolResponseHandlers.set(id, (msg) => {
      clearTimeout(timeout);
      if (msg.error) reject(new Error(msg.error as string));
      else resolve(msg.result);
    });

    // Send to first connected client
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        const payload = Buffer.from(
          '\x01' + JSON.stringify({ type: 'tool_call', id, tool, args })
        );
        client.send(payload);
        return;
      }
    }
    clearTimeout(timeout);
    toolResponseHandlers.delete(id);
    reject(new Error('No extension connected'));
  });
}
