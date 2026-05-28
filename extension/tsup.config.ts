import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/background.ts', 'src/content.ts', 'src/sidepanel.ts'],
  format: ['esm'],
  target: 'chrome120',
  clean: true,
  splitting: false,
});
