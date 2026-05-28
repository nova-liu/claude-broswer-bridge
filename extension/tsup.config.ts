import { defineConfig } from 'tsup';
import { copyFileSync } from 'fs';

export default defineConfig({
  entry: ['src/background.ts', 'src/content.ts', 'src/sidepanel.ts'],
  format: ['esm'],
  target: 'chrome120',
  clean: true,
  splitting: false,
  onSuccess: async () => {
    // Copy xterm.css to dist for sidepanel
    copyFileSync(
      'node_modules/@xterm/xterm/css/xterm.css',
      'dist/xterm.css'
    );
  },
});
