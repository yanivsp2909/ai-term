import { KEY, LiveFailure, Screen, sleep } from './screen.js';

// The homepage as a person uses it: type a command, read the note line, pick a card. Layout facts it relies on
// (src/client/tui/layout.ts): the preview box's title is the selected agent's title, cards are 3 rows from row 2 of
// the agents panel, and the note sits on the row above the command bar.
const EMPTY_BAR = /│ › What do you want to build\?/;
export class Home {
  constructor(readonly screen: Screen) {}
  // The command bar emptied first (Ctrl+U, then Esc if a pasted token stays), so nothing typed before joins the line.
  async command(line: string, enter = true): Promise<void> { await this.emptyBar(); await this.screen.type(line, enter); }
  async emptyBar(): Promise<void> {
    for (const key of [KEY.ctrlU, KEY.esc, KEY.esc]) {
      this.screen.write(key);
      try { await this.screen.waitFor(EMPTY_BAR, 1500); return; } catch (error) { if (!(error instanceof LiveFailure)) throw error; }
      await sleep(100);
    }
    await this.screen.waitFor(EMPTY_BAR, 1500, 'an empty command bar ("What do you want to build?")');
  }
  // Esc until a popup with this title is gone (an Esc that lands while the popup is busy does nothing).
  async close(title: string): Promise<void> {
    const box = `╭─ ${title} `;
    for (let i = 0; i < 4; i++) {
      if (!(await this.screen.text()).includes(box)) return;
      this.screen.write(KEY.esc);
      try { await this.screen.waitGone(box, 1500); return; } catch (error) { if (!(error instanceof LiveFailure)) throw error; }
    }
    await this.screen.waitGone(box, 1500, `the ${title} popup`);
  }
  async home(): Promise<string> { return this.screen.waitFor(/^ AI Term_/m, 15_000, 'the homepage (AI Term_ at the top)'); }
  // The title the preview box shows: the selected agent's, or "Preview" with none.
  async selected(): Promise<string | null> {
    const top = (await this.screen.text()).split('\n')[1] ?? '';
    // A Don't ask agent's title follows its warning: "╭─! don't ask ·AI Term───".
    const match = top.match(/╮\s+╭─ ?(?:! don't ask · ?)?([^─]+?) ?─/);
    return match?.[1]?.trim() ?? null;
  }
  // Moves the selection with ↓ (then ↑) until the preview names this title.
  async select(title: string): Promise<void> {
    for (const key of [KEY.down, KEY.up]) for (let i = 0; i < 12; i++) {
      if (await this.selected() === title) return;
      this.screen.write(key); await sleep(120);
    }
    if (await this.selected() === title) return;
    throw new LiveFailure(`couldn't select the agent "${title}" with ↑↓`, await this.screen.text());
  }
  // The agents panel's rows (the left box), each trimmed.
  async cards(): Promise<string> {
    const lines = (await this.screen.text()).split('\n');
    return lines.map(line => /^[│╭╰]/.test(line) ? line.slice(0, line.indexOf('│', 1) > 0 ? line.indexOf('│', 1) + 1 : line.length) : '').join('\n');
  }
  async waitCard(what: string | RegExp, timeoutMs = 20_000, label?: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const cards = await this.cards();
      if (typeof what === 'string' ? cards.includes(what) : what.test(cards)) return;
      if (Date.now() > deadline) throw new LiveFailure(`no agent card showed ${label ?? JSON.stringify(String(what))} within ${Math.round(timeoutMs / 1000)} s`, await this.screen.text());
      await sleep(100);
    }
  }
}
