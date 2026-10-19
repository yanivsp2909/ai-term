import { describe, expect, it } from 'vitest';
import { renderHomepage, type HomepageView } from '../src/client/tui/layout.js';
import { createTheme } from '../src/client/tui/theme.js';
import { plainText } from '../src/client/tui/grid.js';

// B35: on a fresh AI Term folder at 120 columns the bottom line read
// "CLI default · claude c ·  · own login · sub · CLI default · ask · worktree on ↑↓ agents …": the engine cut mid-word,
// the folder an empty field, the key hints kept. Fields are now shown whole or not at all, in a fixed priority.
const HINTS = '↑↓ agents  ⏎ open  p preview  / commands';
const theme = createTheme('graphite');
const fresh = (cols: number, patch: Partial<HomepageView> = {}): HomepageView => ({ cols, rows: 40, sessions: [], selectedId: null, input: '', note: '', previewVisible: true, cwd: '~/projects/demo', engine: 'claude-code', model: null, authLabel: 'own login · sub', effort: null, permission: 'ask', worktrees: 'on', now: Date.parse('2026-10-19T10:00:00Z'), ...patch });
const bottom = (view: HomepageView): string => plainText(renderHomepage(view, theme)).split('\n')[view.rows - 1] ?? '';
const FIELDS = ['CLI default', 'claude code', 'own login · sub', 'ask', 'worktree on', '~/projects/demo'];
// The fields a line shows, in order; a field cut short or left empty is a field that isn't one of these.
const shown = (line: string): string[] => line.replace(HINTS, '').trim().replace('own login · sub', 'own login\u0000sub').split(' · ').map(field => field.replace('\u0000', ' · ')).filter(Boolean);

describe('B35 the homepage bottom line', () => {
  it('at 120 columns shows the engine, auth, model, mode and worktree whole, then the key hints; the folder is left out', () => {
    expect(bottom(fresh(120))).toBe(` ${'CLI default · claude code · own login · sub · ask · worktree on'.padEnd(120 - HINTS.length - 2)}${HINTS} `);
  });
  it('at 100 columns drops the key hints before any field, and the folder fits whole', () => {
    expect(bottom(fresh(100)).trimEnd()).toBe(' CLI default · claude code · own login · sub · ask · worktree on · ~/projects/demo');
  });
  it('at 80 columns drops the key hints and the folder', () => {
    expect(bottom(fresh(80)).trimEnd()).toBe(' CLI default · claude code · own login · sub · ask · worktree on');
  });
  it('never cuts a field or leaves one empty, and drops by priority: engine, auth, model, mode, then the rest', () => {
    // Highest first; the key hints sit right of the fields, two columns apart.
    const priority = ['claude code', 'own login · sub', 'CLI default', 'ask', 'worktree on', HINTS, '~/projects/demo'];
    const cost = (items: readonly string[]): number => { const fields = items.filter(item => item !== HINTS); return fields.join(' · ').length + (items.includes(HINTS) ? HINTS.length + 2 : 0); };
    for (let cols = 10; cols <= 200; cols++) {
      const line = bottom(fresh(cols)), fields = shown(line), present = [...fields, ...line.includes(HINTS) ? [HINTS] : []];
      expect(line, `${cols} columns`).not.toMatch(/·\s+·|·\s*$|^\s*·/);
      for (const field of fields) expect(FIELDS, `${cols} columns: "${field}"`).toContain(field);
      expect(cost(present), `${cols} columns`).toBeLessThanOrEqual(cols - 2);
      // A field is missing only when it wouldn't fit even with everything of lower priority gone.
      priority.forEach((item, rank) => {
        if (present.includes(item)) return;
        expect(cost([...priority.slice(0, rank).filter(higher => present.includes(higher)), item]), `${cols} columns: "${item}" left out`).toBeGreaterThan(cols - 2);
      });
    }
  });
  it('says CLI default once: an unset effort is left out (the CLI picks it), a picked one is labelled', () => {
    expect(bottom(fresh(200)).match(/CLI default/g)).toHaveLength(1);
    expect(bottom(fresh(200, { effort: 'high' }))).toContain('own login · sub · effort high · ask · worktree on');
  });
  it("draws Don't ask in status-error wherever it lands", () => {
    const view = fresh(120, { permission: 'dontAsk' }), row = renderHomepage(view, theme)[view.rows - 1] ?? [], text = row.map(cell => cell.char).join('');
    const at = text.indexOf("! don't ask");
    expect(at).toBeGreaterThan(0);
    expect(row.slice(at, at + "! don't ask".length).every(cell => cell.fg === theme.colors['status-error'])).toBe(true);
    expect(row[at - 2]?.fg).toBe(theme.colors['ink-3']);
  });
  it('a keyed agent reads model · engine · key, its auth right after the engine', () => {
    expect(bottom(fresh(120, { engine: 'ai-term', model: 'claude-sonnet-4-5', authLabel: 'key ····abcd' }))).toContain('claude-sonnet-4-5 · ai term · key ····abcd · ask · worktree on');
  });
  it('a shell keeps its folder', () => {
    expect(bottom(fresh(120, { engine: undefined, cwd: '/tmp' })).trimEnd()).toBe(` ${'shell · /tmp'.padEnd(120 - HINTS.length - 2)}${HINTS}`);
  });
});
