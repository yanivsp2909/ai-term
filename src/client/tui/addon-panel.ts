import type { Frame } from './grid.js';
import type { Theme } from './theme.js';
import { TextPanel } from './text-panel.js';
import type { AddonAsk } from '../../shared/addons.js';
import { AB_NO_SANDBOX, type AbView, type AddonResult } from '../../shared/addon-results.js';
import type { TaskUsage } from '../../shared/protocol.js';
import type { TestResult } from '../../shared/test-run.js';
import { batchLines, copyText, teachEnd, type ResultView } from './addon-views.js';
import { testCommandText } from '../../shared/test-run.js';
interface Actions { start(unsandboxed?: boolean): void; build(): void; approve(): void; step(index: number): void; copy(text: string): void; choose(kind: 'engine' | 'model'): void; apply?(items: number[]): void; ab?(unsandboxed: boolean): void; commit?(): void; polish?(text: string): void }
export class AddonPanel {
  private panel: TextPanel; private ask?: AddonAsk; private result?: AddonResult;
  private chunk = 0; private selected = 0; private approved = false; private busy = false;
  private usage: TaskUsage | null = null; private tests: TestResult | null = null; private ab: AbView | null = null;
  private picked = new Set<number>(); private applied: string | null = null; private problem: string | null = null; private quiz: ResultView['quiz'] = 'hidden';
  lines: string[] = [];
  constructor(changed: () => void, private close: () => void, private actions: Actions) { this.panel = new TextPanel('Add-on', changed, close); this.wait('Preparing the estimate…'); }
  private show(lines: string[]): void { this.lines = lines; this.panel.set(lines.map(text => ({ text, tone: 'ink-2' as const }))); }
  wait(message = 'Running in Ask mode · close this popup to inspect or attach the agent.'): void { this.busy = true; this.show([message, 'Esc closes']); }
  // A refused action on a shown result: say why above the result and keep it usable (review: busy stayed on).
  fail(message: string): void { if (!this.result) { this.wait(message); return; } this.problem = message; this.busy = false; this.refresh(); }
  setAsk(ask: AddonAsk): void { this.ask = ask; this.busy = false; this.result = undefined; this.show(ask.bisect ? this.bisectAsk(ask, ask.bisect) : ask.free ? [`/${ask.name} · ${ask.summary}`, 'no model · no tokens', ...ask.facts ?? []] : [
    `/${ask.name} · ${ask.summary}`, ...ask.cost === 'high' ? [this.expensive(ask)] : [], ...ask.facts ?? [], `${ask.target?.engine ?? 'no engine'} · ${ask.target?.model ?? 'CLI default'} · ${ask.authLabel ?? (ask.subscription ? 'subscription' : 'API key')} · Ask`,
    `folder: ${ask.cwd}`, ...ask.subject ? [ask.subject] : [], `${ask.readOnly ? 'read-only' : 'can edit'} · worktree ${ask.worktree ? 'yes' : 'no'}`,
    `brain: ${ask.brain} · ${ask.brainNeed}`, ...(ask.brainNeed !== 'none' && ask.brain !== 'fresh' ? ['b builds the free local /brain first: folders, entry points and import ranks save repeated exploration.'] : []),
    `uses: ${ask.files.join(', ') || 'prompt only'}`, ...this.estimate(ask),
    'e engine/key · m model · y starts · Enter does nothing · Esc cancels',
  ]); }
  // D49 for a costly add-on: the worst case first, in dollars, before anything else.
  private expensive(ask: AddonAsk): string { return ask.subscription ? '● expensive: a long read that uses a lot of your subscription limits' : ask.priceUsd ? `● expensive: up to $${ask.priceUsd.high.toFixed(2)} at this model's price` : '● expensive · price unknown: set this model’s price before starting'; }
  private bisectAsk(ask: AddonAsk, b: NonNullable<AddonAsk['bisect']>): string[] {
    return [`/${ask.name} · ${ask.summary}`, 'no model · no tokens · $0', `folder: ${ask.cwd}`, `test: ${testCommandText(b.command)}`, `good: ${b.goodLabel} (${b.good.slice(0, 7)}) · bad: HEAD (${b.bad.slice(0, 7)}) · ${b.commits} commit${b.commits === 1 ? '' : 's'}, about ${Math.max(1, Math.ceil(Math.log2(b.commits + 1)))} steps`,
      'runs in a temporary copy that shares your repository’s objects; your checkout is never checked out, reset or bisected',
      'the copy has only committed files: no installed dependencies or build output, and the sandbox has no network to fetch them',
      b.sandbox ? '✓ test sandbox: writes only in the copy, no network, no home folder' : '● no sandbox here: the test command would run with your rights',
      b.sandbox ? 'y starts · Enter does nothing · Esc cancels' : 'Y (capital) starts without a sandbox · Enter does nothing · Esc cancels'];
  }
  private estimate(ask: AddonAsk): string[] { return [`estimated tokens: ${ask.inputTokens.low}–${ask.inputTokens.high} in · ${ask.outputTokens.low}–${ask.outputTokens.high} out (1–${ask.cost === 'high' ? 16 : 8} inspection rounds; not a cap)`, ask.subscription ? 'price: $0 API charge · uses subscription limits' : ask.priceUsd ? `estimated price: $${ask.priceUsd.low.toFixed(4)}–$${ask.priceUsd.high.toFixed(4)}` : 'price unknown · set this model’s price before starting']; }
  setResult(result: AddonResult): void { this.result = result; this.busy = false; this.chunk = 0; this.panel.resetScroll(); this.refresh(); }
  setApproved(): void { this.problem = null; this.approved = true; this.busy = false; this.refresh(); }
  setApplied(note: string): void { this.problem = null; this.applied = note; this.busy = false; this.refresh(); }
  setUsage(usage: TaskUsage | null): void { this.usage = usage; this.refresh(); }
  setTests(tests: TestResult | null): void { this.tests = tests; this.refresh(); }
  setAb(ab: AbView | null): void { this.problem = null; this.ab = ab; this.busy = false; this.refresh(); }
  private refresh(): void {
    const r = this.result; if (!r) return;
    const problem = this.problem ? [`✗ ${this.problem}`] : [];
    const actual = r.kind === 'bisect' ? 'no model · no tokens' : this.usage ? `actual: ${this.usage.tokens} tokens · ${this.usage.unknownPrice ? 'price unknown' : this.usage.costUsd === null ? 'subscription limits' : `$${this.usage.costUsd.toFixed(4)}`}` : 'actual: not reported by the engine';
    if (r.kind === 'plan') {
      const start = Math.max(0, Math.min(this.selected - 1, r.steps.length - 3));
      this.show([...problem, r.title, this.approved ? '✓ plan saved · ↑↓ step · s starts this step in Ask mode in a worktree · Esc closes' : 'a approves and saves the plan · nothing starts · Esc closes', actual,
        ...(this.ask ? [`${this.ask.target?.engine ?? 'no engine'} · ${this.ask.target?.model ?? 'CLI default'} · ${this.ask.cwd}`, ...this.estimate(this.ask)] : []),
        ...r.steps.slice(start, start + 3).map((s, i) => `${start + i === this.selected ? '›' : ' '} ${start + i + 1}. ${s.title}`), `Selected step ${this.selected + 1}/${r.steps.length}:`, ...(r.steps[this.selected]?.prompt.split('\n') ?? [])]);
    }
    else if (r.kind === 'prompt') this.show([...problem, actual, ...r.issues.map(s => `• ${s}`), ...r.diff.split('\n'), 'c copies the improved diff · Esc closes']);
    else if (r.kind === 'explain' || r.kind === 'teach') {
      if (this.chunk < r.chunks.length) this.show([...problem, actual, ...(this.chunk === 0 ? [r.why, ...r.diagram, ''] : []), ...r.chunks[this.chunk] ?? [], `Space next · ${this.chunk + 1}/${r.chunks.length} · Esc closes`]);
      else this.show(r.kind === 'teach' ? [actual, ...teachEnd(r, this.quiz)] : [actual, 'Recap · Esc closes', ...r.recap]);
    }
    // AI Term's own facts (what it read before the model ran) stay above the result.
    else this.show([...problem, ...r.kind === 'standup' ? [] : [actual], ...this.ask?.facts ?? [], ...batchLines(r, { selected: this.selected, picked: this.picked, tests: this.tests, ab: this.ab, applied: this.applied, quiz: this.quiz, commits: this.ask?.commits === true })]);
  }
  private move(key: 'up' | 'down', count: number): void { this.selected = Math.max(0, Math.min(count - 1, this.selected + (key === 'up' ? -1 : 1))); this.panel.resetScroll(); this.refresh(); }
  key(key: string): void {
    if (key === 'escape') { this.close(); return; } if (this.busy || key === 'enter') return;
    if (!this.result && this.ask) {
      // Without a sandbox /bisect takes a capital Y, like /dev: one easy key shouldn't run code with your rights.
      if (this.ask.bisect) { if (key === (this.ask.bisect.sandbox ? 'y' : 'Y')) { this.wait('Bisecting in a temporary copy · no model, no tokens'); this.actions.start(!this.ask.bisect.sandbox); } return; }
      if (key === 'y' && (this.ask.subscription || this.ask.priceUsd)) { this.wait(); this.actions.start(); }
      else if (key === 'b' && this.ask.brainNeed !== 'none' && this.ask.brain !== 'fresh') { this.wait('Building the free local brain…'); this.actions.build(); }
      else if (key === 'e' || key === 'm') { this.wait('Updating the estimate…'); this.actions.choose(key === 'e' ? 'engine' : 'model'); }
      return;
    }
    const r = this.result;
    if (r?.kind === 'plan') {
      if (key === 'up' || key === 'down') this.move(key, r.steps.length);
      else if (key === 'a' && !this.approved) { this.busy = true; this.actions.approve(); }
      else if (key === 's' && this.approved) this.actions.step(this.selected);
      else this.panel.key(key);
    } else if (r?.kind === 'prompt' && key === 'c') this.actions.copy(r.diff);
    else if ((r?.kind === 'explain' || r?.kind === 'teach') && this.chunk < r.chunks.length && key === 'space') { this.chunk++; this.panel.resetScroll(); this.refresh(); }
    else if (r?.kind === 'teach' && this.chunk >= r.chunks.length) this.quizKey(key, r.quiz.length);
    else if (r?.kind === 'refactor' && (key === 'up' || key === 'down')) this.move(key, r.items.length);
    else if (r?.kind === 'refactor' && key === 'space') { if (!this.picked.delete(this.selected)) this.picked.add(this.selected); this.refresh(); }
    else if (r?.kind === 'refactor' && key === 'r' && this.picked.size && !this.applied) { this.busy = true; this.actions.apply?.([...this.picked].sort((a, b) => a - b)); }
    else if ((r?.kind === 'types' || r?.kind === 'failures' || r?.kind === 'review-deep' || r?.kind === 'security') && (key === 'up' || key === 'down') && r.findings.length) this.move(key, r.findings.length);
    else if (r?.kind === 'types' && key === 'f' && r.findings[this.selected] && !this.applied) { this.busy = true; this.actions.apply?.([this.selected]); }
    else if ((r?.kind === 'pr-review' || r?.kind === 'context' || r?.kind === 'opensource') && (key === 'up' || key === 'down') && r.findings.length) this.move(key, r.findings.length);
    else if (r?.kind === 'opensource' && key === 'f' && !this.applied && r.findings.some(f => f.fix)) { this.busy = true; this.actions.apply?.(r.findings.flatMap((f, i) => f.fix ? [i] : [])); }
    else if (r && key === 'c' && copyText(r) !== null) this.actions.copy(copyText(r) ?? '');
    // y commits only a message written for an agent's worktree; the daemon checks again.
    else if (r?.kind === 'commit' && key === 'y' && this.ask?.commits && !this.applied) { this.busy = true; this.actions.commit?.(); }
    else if (r?.kind === 'changelog' && key === 'w' && !this.applied) { this.busy = true; this.actions.apply?.([0]); }
    else if (r?.kind === 'standup' && key === 'm') this.actions.polish?.(r.lines.join('\n'));
    else if (r?.kind === 'perf' && key === 'a' && this.ab?.state !== 'running' && this.ab?.state !== 'done' && !(this.ab?.state === 'failed' && this.ab.reason === AB_NO_SANDBOX)) { this.busy = true; this.actions.ab?.(false); }
    // Y only once AI Term said there is no sandbox for this A/B.
    else if (r?.kind === 'perf' && key === 'Y' && this.ab?.state === 'failed' && this.ab.reason === AB_NO_SANDBOX) { this.busy = true; this.actions.ab?.(true); }
    else this.panel.key(key);
  }
  // The quiz is offered at the end and never starts by itself: y starts it, n skips it, Space reveals then moves on.
  private quizKey(key: string, count: number): void {
    const q = this.quiz;
    if ((q === 'hidden' || q === 'offered') && key === 'y') this.quiz = { question: 0, answer: false };
    else if ((q === 'hidden' || q === 'offered') && key === 'n') this.quiz = 'declined';
    else if (typeof q === 'object' && key === 'space' && q.question < count) this.quiz = q.answer ? { question: q.question + 1, answer: false } : { question: q.question, answer: true };
    else { this.panel.key(key); return; }
    this.panel.resetScroll(); this.refresh();
  }
  draw(frame: Frame, theme: Theme): Frame { return this.panel.draw(frame, theme); }
}
