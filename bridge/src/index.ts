import { spawnPty } from './pty.js';
import { createWebSocketServer } from './websocket.js';

// Parse args
const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const portArg = portIdx >= 0 ? args[portIdx + 1] : undefined;
const port = parseInt(portArg || process.env.CLAUDE_BROWSER_PORT || '7862', 10);

console.log(`\n  Claude Browser Bridge v0.1.0\n`);
console.log(`  WebSocket:  ws://localhost:${port}`);
console.log('');

const ptyProcess = spawnPty();
const wss = createWebSocketServer(port, ptyProcess);

console.log('  Waiting for Chrome extension to connect...\n');
console.log('  Add this MCP server to your Claude Code settings:');
console.log(`  {`);
console.log(`    "mcpServers": {`);
console.log(`      "browser": {`);
console.log(`        "command": "node",`);
console.log(`        "args": ["${process.cwd()}/bridge/dist/mcp-client.js"]`);
console.log(`      }`);
console.log(`    }`);
console.log(`  }\n`);

ptyProcess.onExit(({ exitCode }) => {
  console.log(`Claude process exited (code ${exitCode}). Shutting down.`);
  wss.close();
  process.exit(exitCode);
});

process.on('SIGINT', () => {
  ptyProcess.kill();
  wss.close();
  process.exit(0);
});
