import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'spikes/**', 'app/out/**', 'test-results/**', 'playwright-report/**'] },
  eslint.configs.recommended,
  // Plain Node build scripts (.mjs) run outside TypeScript.
  { files: ['scripts/**/*.mjs'], languageOptions: { globals: { process: 'readonly' } } },
  ...tseslint.configs.recommended,
  {
    rules: {
      'no-restricted-imports': ['error', {
        paths: ['node:child_process', 'child_process'].map((name) => ({
          name,
          importNames: ['exec', 'execSync'],
          message: 'Use spawn or execFile with an argument array.',
        })),
      }],
      'no-restricted-properties': ['error',
        { property: 'exec', message: 'Use spawn or execFile with an argument array.' },
        { property: 'execSync', message: 'Use spawn or execFile with an argument array.' },
      ],
    },
  },
);
