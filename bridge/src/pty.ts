import * as pty from 'node-pty';
import { IPty } from 'node-pty';
import { execSync } from 'child_process';

export interface PtyOptions {
  command?: string;
  args?: string[];
  cols?: number;
  rows?: number;
}

function findCommand(cmd: string): string {
  try {
    // Use login shell to resolve PATH properly
    return execSync(`/bin/zsh -lc "which ${cmd}"`, { encoding: 'utf8' }).trim();
  } catch {
    return cmd; // fallback to bare name
  }
}

export function spawnPty(options: PtyOptions = {}): IPty {
  const {
    command = 'claude',
    args = [],
    cols = 120,
    rows = 40,
  } = options;

  const resolvedCommand = findCommand(command);
  console.log(`  Spawning: ${resolvedCommand} ${args.join(' ')}`);

  const ptyProcess = pty.spawn(resolvedCommand, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
  });

  return ptyProcess;
}
