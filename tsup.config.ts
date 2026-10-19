import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli/index.ts'],
  outDir: 'dist/cli',
  format: ['esm'],
  target: 'node22',
  clean: true,
});
