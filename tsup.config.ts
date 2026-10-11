import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli/index.ts'],
  outDir: 'dist/cli',
  format: ['esm'],
  target: 'node22',
  clean: true,
  define: { __AI_TERM_DESIGN__: JSON.stringify(readFileSync(new URL('./docs/design.md', import.meta.url), 'utf8')) },
});
