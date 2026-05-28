import { defineConfig } from 'tsup';
import { copyFileSync } from 'fs';

export default defineConfig({
  entry: {
    background: 'src/background.ts',
    sidepanel: 'src/sidepanel.ts',
  },
  format: ['iife'],
  target: 'chrome120',
  clean: true,
  splitting: false,
  noExternal: [/@xterm/],
  globalName: 'ext',
  outExtension: () => ({ js: '.js' }),
  onSuccess: async () => {
    copyFileSync(
      'node_modules/@xterm/xterm/css/xterm.css',
      'dist/xterm.css'
    );
  },
});
