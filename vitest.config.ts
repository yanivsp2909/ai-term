import { defineConfig } from 'vitest/config';
import { POSIX_ONLY_TESTS } from './tests/posix-only.js';

// B31: a test's deadlines only catch hangs; they never measure speed. With every worker busy, a real process (a tsx CLI,
// a PTY shell, a daemon) can take seconds to start, so the default 1 s poll and 5 s test budgets failed working code.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'], exclude: process.platform === 'win32' ? ['**/node_modules/**', ...POSIX_ONLY_TESTS] : ['**/node_modules/**'],
    testTimeout: 30_000, expect: { poll: { timeout: 10_000 } },
  },
});
