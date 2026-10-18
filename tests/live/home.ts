import { KEY, LiveFailure, Screen, sleep } from './screen.js';

// The homepage as a person uses it: type a command, read the note line, pick a card. Layout facts it relies on
// (src/client/tui/layout.ts): the preview box's title is the selected agent's title, cards are 3 rows from row 2 of
// the agents panel, and the note sits on the row above the command bar.
const EMPTY_BAR = /│ › What do you want to build\?/;
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The agents panel only: the left box from its title row to its bottom border (E2E review: the command bar below it
// echoes what was typed, so "/shell" there read as a shell card).
export function agentsPanel(text: string): string {
  const rows = text.split('\n'), start = rows.findIndex(row => row.startsWith('╭─ Agents')), panel: string[] = [];
  if (start < 0) return '';
  for (const row of rows.slice(start)) {
    const end = row.indexOf(row.startsWith('╭') ? '╮' : row.startsWith('╰') ? '╯' : '│', 1);
    panel.push(end > 0 ? row.slice(0, end + 1) : row);
    if (row.startsWith('╰')) break;
  }
  return panel.join('\n');
}
// The title the preview box shows: the selected agent's, or "Preview" with none. A Don't ask agent's title follows its
// warning: "╭─! don't ask ·AI Term───".
export function previewTitle(text: string): string | null {
  const top = text.split('\n')[1] ?? '';
  return top.match(/╮\s+╭─ ?(?:! don't ask · ?)?([^─]+?) ?─/)?.[1]?.trim() ?? null;
}

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
  async selected(): Promise<string | null> { return previewTitle(await this.screen.text()); }
  // Moves the selection with ↓ (then ↑) until the preview names this title; each key waits for the title to change, so a
  // slow redraw is never read as the next card.
  async select(title: string): Promise<void> {
    for (const key of [KEY.down, KEY.up]) for (let i = 0; i < 12; i++) {
      const before = await this.selected();
      if (before === title) return;
      this.screen.write(key);
      const deadline = Date.now() + 1500;
      while (await this.selected() === before && Date.now() < deadline) await sleep(40);
      if (await this.selected() === before) break;
    }
    if (await this.selected() === title) return;
    throw new LiveFailure(`couldn't select the agent "${title}" with ↑↓`, await this.screen.text());
  }
  // ⏎ on the selected card, and only once the homepage is gone: the preview already shows the agent's prompt, so a key
  // sent before the hand-over landed in the command bar (E2E review: a y was lost this way).
  async attach(title: string): Promise<void> {
    await this.select(title); await this.emptyBar();
    this.screen.write(KEY.enter); await this.screen.waitGone(/^ AI Term_/m, 15_000, 'the homepage (⏎ opens the agent)');
    await sleep(150);
  }
  async cards(): Promise<string> { return agentsPanel(await this.screen.text()); }
  // One card's three rows, by its title (the first card with it).
  async card(title: string): Promise<string> {
    const rows = (await this.cards()).split('\n'), at = rows.findIndex(row => new RegExp(`^│.{0,6}[A-Z]{2}  ${escaped(title)} `).test(row));
    return at < 0 ? '' : rows.slice(at, at + 3).join('\n');
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
  // Waits on this agent's own card (E2E review: a "✓ done" on another card passed the wait).
  async waitStatus(title: string, what: RegExp, timeoutMs = 20_000, label?: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (what.test(await this.card(title))) return;
      if (Date.now() > deadline) throw new LiveFailure(`${title}'s card didn't show ${label ?? String(what)} within ${Math.round(timeoutMs / 1000)} s`, await this.screen.text());
      await sleep(100);
    }
  }
}
