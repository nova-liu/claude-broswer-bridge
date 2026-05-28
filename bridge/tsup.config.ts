import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/mcp-client.ts'],
  format: ['esm'],
  target: 'node22',
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
});
