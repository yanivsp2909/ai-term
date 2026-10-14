import { defineConfig } from 'electron-vite';
import { resolve } from 'node:path';
const root = resolve('app');
// Dev watches the built local files as well: no remote page, eval or HMR exception to CSP.
export default defineConfig({
  main: { envDir: false, build: { outDir: 'app/out/main', rollupOptions: { input: resolve(root, 'main/index.ts') } } },
  preload: { envDir: false, build: { outDir: 'app/out/preload', externalizeDeps: false, rollupOptions: { input: resolve(root, 'preload/index.ts'), output: { format: 'cjs', entryFileNames: 'index.cjs' } } } },
  renderer: { root: resolve(root, 'renderer'), envDir: false, base: './', build: { outDir: resolve(root, 'out/renderer'), rollupOptions: { input: resolve(root, 'renderer/index.html') } } },
});
