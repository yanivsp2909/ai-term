import { defineConfig } from 'vitest/config';
import { POSIX_ONLY_TESTS } from './tests/posix-only.js';

export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], setupFiles: ['tests/setup-git.ts'], exclude: process.platform === 'win32' ? ['**/node_modules/**', ...POSIX_ONLY_TESTS] : ['**/node_modules/**'] },
});
