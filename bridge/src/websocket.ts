import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { IPty } from 'node-pty';

// Frame protocol:
// 0x00 + data = terminal data (binary)
// 0x01 + JSON = control message (resize, tool_call, tool_response)

export const FRAME_TERMINAL = 0x00;
export const FRAME_CONTROL = 0x01;

export interface ControlMessage {
  type: 'resize' | 'tool_call' | 'tool_response';
  [key: string]: unknown;
}

// Track extension connection (the one that renders terminal + executes DOM tools)
let extensionClient: WebSocket | null = null;

export function createWebSocketServer(port: number, ptyProcess: IPty): WebSocketServer {
  const wss = new WebSocketServer({ port });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = req.url || '/';

    if (url === '/mcp') {
      // MCP client connection — only sends tool_calls, receives tool_responses
      console.log('  MCP client connected');
      ws.on('message', (raw: Buffer) => {
        if (raw[0] !== FRAME_CONTROL) return;
        const msg: ControlMessage = JSON.parse(raw.subarray(1).toString());
        if (msg.type === 'tool_call') {
          // Forward to extension
          if (extensionClient?.readyState === WebSocket.OPEN) {
            extensionClient.send(raw);
          } else {
            // Send error back
            const errResp = Buffer.from('\x01' + JSON.stringify({
              type: 'tool_response', id: msg.id, error: 'No extension connected'
            }));
            ws.send(errResp);
          }
        }
      });
      ws.on('close', () => console.log('  MCP client disconnected'));
      return;
    }

    // Default: extension/terminal connection
    extensionClient = ws;
    console.log('  Extension connected');

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
        ptyProcess.write(data.toString());
      } else if (frameType === FRAME_CONTROL) {
        const msg: ControlMessage = JSON.parse(data.toString());
        handleControlMessage(msg, ptyProcess, wss);
      }
    });

    ws.on('close', () => {
      console.log('  Extension disconnected');
      extensionClient = null;
      dataHandler.dispose();
      exitHandler.dispose();
    });
  });

  return wss;
}

function handleControlMessage(msg: ControlMessage, ptyProcess: IPty, wss: WebSocketServer) {
  switch (msg.type) {
    case 'resize':
      ptyProcess.resize(msg.cols as number, msg.rows as number);
      break;
    case 'tool_response':
      // Forward tool response to MCP client(s)
      const respPayload = Buffer.from('\x01' + JSON.stringify(msg));
      for (const client of wss.clients) {
        if (client !== extensionClient && client.readyState === WebSocket.OPEN) {
          client.send(respPayload);
        }
      }
      break;
  }
}
