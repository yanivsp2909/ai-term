import { expect, it } from 'vitest';
import packageInfo from '../package.json' with { type: 'json' };
import { renderHomepage } from '../src/client/tui/layout.js';
import { plainText } from '../src/client/tui/grid.js';
import { createTheme } from '../src/client/tui/theme.js';

// Bugs the live suite (npm run live) found in the real app, each pinned here so npm test keeps them fixed.

it('live suite: the homepage shows the version you run, not the v0.1.8 it was drawn with', () => {
  const text = plainText(renderHomepage({ cols: 120, rows: 40, sessions: [], selectedId: null, input: '', note: '', previewVisible: true, cwd: '/tmp', now: 0 }, createTheme('graphite')));
  expect(text).toContain(`v${packageInfo.version}`);
  expect(text).not.toContain('v0.1.8');
});
