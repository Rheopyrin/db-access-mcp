import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    cli: 'src/bin/cli.ts',
    watchdog: 'src/bin/watchdog.ts',
  },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  splitting: false,
  sourcemap: false,
  banner: { js: '#!/usr/bin/env node' },
});
