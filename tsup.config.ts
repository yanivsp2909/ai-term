import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli/index.ts'],
  outDir: 'dist/cli',
  format: ['esm'],
  target: 'node22',
  clean: true,
  esbuildPlugins: [{ name: 'design-text', setup(build) {
    build.onResolve({ filter: /\.md\?raw$/ }, args => ({ path: resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'design-text' }));
    build.onLoad({ filter: /.*/, namespace: 'design-text' }, async args => ({ contents: await readFile(args.path, 'utf8'), loader: 'text' }));
  } }],
});
