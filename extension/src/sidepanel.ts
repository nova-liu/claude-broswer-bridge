import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

const FRAME_TERMINAL = 0x00;
const FRAME_CONTROL = 0x01;

const term = new Terminal({
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  fontSize: 13,
  theme: {
    background: '#1e1e1e',
    foreground: '#d4d4d4',
  },
  cursorBlink: true,
});

const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById('terminal')!);
fitAddon.fit();

const statusEl = document.getElementById('status')!;
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

async function getPort(): Promise<number> {
  const result = await chrome.storage.local.get('port');
  return result.port || 7862;
}

async function connect() {
  const port = await getPort();
  ws = new WebSocket(`ws://localhost:${port}`);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    statusEl.textContent = 'Connected';
    statusEl.className = 'connected';
    // Send initial size
    sendControl({ type: 'resize', cols: term.cols, rows: term.rows });
  };

  ws.onmessage = (event) => {
    const data = new Uint8Array(event.data as ArrayBuffer);
    const frameType = data[0];
    const payload = data.subarray(1);

    if (frameType === FRAME_TERMINAL) {
      term.write(payload);
    } else if (frameType === FRAME_CONTROL) {
      const msg = JSON.parse(new TextDecoder().decode(payload));
      // Tool calls from bridge → forward to background script
      if (msg.type === 'tool_call') {
        chrome.runtime.sendMessage(msg);
      }
    }
  };

  ws.onclose = () => {
    statusEl.textContent = 'Disconnected';
    statusEl.className = 'disconnected';
    scheduleReconnect();
  };

  ws.onerror = () => {
    ws?.close();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 2000);
}

function sendControl(msg: Record<string, unknown>) {
  if (ws?.readyState === WebSocket.OPEN) {
    const json = JSON.stringify(msg);
    const encoder = new TextEncoder();
    const jsonBytes = encoder.encode(json);
    const frame = new Uint8Array(1 + jsonBytes.length);
    frame[0] = FRAME_CONTROL;
    frame.set(jsonBytes, 1);
    ws.send(frame);
  }
}

// Keyboard input → bridge
term.onData((data) => {
  if (ws?.readyState === WebSocket.OPEN) {
    const encoder = new TextEncoder();
    const dataBytes = encoder.encode(data);
    const frame = new Uint8Array(1 + dataBytes.length);
    frame[0] = FRAME_TERMINAL;
    frame.set(dataBytes, 1);
    ws.send(frame);
  }
});

// Resize handling
const resizeObserver = new ResizeObserver(() => {
  fitAddon.fit();
  sendControl({ type: 'resize', cols: term.cols, rows: term.rows });
});
resizeObserver.observe(document.getElementById('terminal')!);

// Listen for tool responses from background script
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'tool_response') {
    sendControl(msg);
  }
});

connect();
