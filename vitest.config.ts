import { defineConfig } from 'vitest/config';
import { POSIX_ONLY_TESTS } from './tests/posix-only.js';

export default defineConfig({
  // testTimeout (B34): many tests wait up to 10 s for a spawned process or the daemon under load; the default 5 s test limit
  // cut those waits short on a busy machine.
  test: { include: ['tests/**/*.test.ts'], testTimeout: 20_000, globalSetup: ['tests/global-setup.ts'], setupFiles: ['tests/setup-git.ts'], exclude: process.platform === 'win32' ? ['**/node_modules/**', ...POSIX_ONLY_TESTS] : ['**/node_modules/**'] },
});
