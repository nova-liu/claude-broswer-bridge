import * as pty from 'node-pty';
import { IPty } from 'node-pty';

export interface PtyOptions {
  command?: string;
  args?: string[];
  cols?: number;
  rows?: number;
}

export function spawnPty(options: PtyOptions = {}): IPty {
  const {
    command = 'claude',
    args = [],
    cols = 120,
    rows = 40,
  } = options;

  const shell = command;
  const ptyProcess = pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
  });

  return ptyProcess;
}
