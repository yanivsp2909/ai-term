import headless from '@xterm/headless';
import unicode11 from '@xterm/addon-unicode11';
// @xterm/headless ships only Unicode 6 widths, where most emoji (🧪, 🧠) are 1 cell; the agents draw
// them 2 wide, so every cell after one shifts. The daemon mirror, the preview mirror and the text the
// homepage draws itself all count with this one Unicode 11 table, so the three agree cell for cell.
export function useUnicode11(terminal: headless.Terminal): void {
  terminal.loadAddon(new unicode11.Unicode11Addon());
  terminal.unicode.activeVersion = '11';
}
// Capture the addon's table through a real headless terminal. Installing browser xterm makes
// the addon's full browser Terminal types available, so a partial stand-in no longer typechecks.
const provider = ((): headless.IUnicodeVersionProvider => {
  let captured: headless.IUnicodeVersionProvider | undefined;
  const terminal = new headless.Terminal({ allowProposedApi: true });
  // unicode is a fresh facade on each access; replacing a method on one facade is lost.
  const unicode = terminal.unicode;
  Object.defineProperty(terminal, 'unicode', { value: { ...unicode, register: (version: headless.IUnicodeVersionProvider) => { captured = version; } } });
  terminal.loadAddon(new unicode11.Unicode11Addon());
  terminal.dispose();
  if (!captured) throw new Error('Unicode 11 width table did not register');
  return captured;
})();
export interface TextCell { text: string; width: number }
// Split text the way xterm prints it: a zero-width code point (combining mark, VS16, ZWJ) joins the
// cell before it unless that cell is itself zero-width; everything else starts a new cell.
export function textCells(text: string): TextCell[] {
  const cells: TextCell[] = [];
  for (const char of text) {
    const width = provider.wcwidth(char.codePointAt(0) ?? 0), last = cells.at(-1);
    if (width === 0 && last && last.width > 0) cells[cells.length - 1] = { text: last.text + char, width: last.width };
    else cells.push({ text: char, width });
  }
  return cells;
}
export function textWidth(text: string): number { return textCells(text).reduce((sum, cell) => sum + cell.width, 0); }
