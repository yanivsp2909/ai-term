import { AB_NO_SANDBOX, type AbView, type AddonResult, type Finding, type FindingsKind } from '../../shared/addon-results.js';
import type { TestResult } from '../../shared/test-run.js';
import { testCommandText } from '../../shared/test-run.js';
import { testsText } from './agent-card.js';

// The lines of a batch-1 and batch-2 add-on result (v1.1). Pure: the panel owns the keys and passes what is selected or revealed.
// Every status keeps its glyph and a word (never color alone).
export interface ResultView { selected: number; picked: ReadonlySet<number>; tests: TestResult | null; ab: AbView | null; applied: string | null; quiz: 'hidden' | 'offered' | 'declined' | { question: number; answer: boolean }; commits?: boolean }
type Batch = Exclude<AddonResult, { kind: 'plan' | 'prompt' | 'explain' }>;
const SEVERITY: Record<Finding['severity'], string> = { critical: '✗ CRITICAL', high: '✗ HIGH', medium: '● MEDIUM', low: '· LOW' };
const testsLine = (tests: TestResult | null): string => `tests (AI Term's sandbox): ${tests ? testsText(tests).text : 'not run yet · they run when the agent finishes, if the project has a /test-cmd'}`;
// A short window of a long list around the selected row, so ↑↓ stays in view.
function windowed<T>(items: readonly T[], selected: number, row: (item: T, index: number) => string, size = 6): string[] {
  const start = Math.max(0, Math.min(selected - 2, items.length - size));
  return [...start > 0 ? [`  ↑ ${start} more`] : [], ...items.slice(start, start + size).map((item, i) => row(item, start + i)), ...start + size < items.length ? [`  ↓ ${items.length - start - size} more`] : []];
}
function findingLines(kind: FindingsKind, r: { summary: string; findings: Finding[]; dropped: number }, view: ResultView): string[] {
  const chosen = r.findings[view.selected];
  return [r.summary, ...r.dropped ? [`${r.dropped} finding${r.dropped === 1 ? '' : 's'} dropped: the reproduction reached outside this repository`] : [], '',
    ...r.findings.length ? windowed(r.findings, view.selected, (f, i) => `${i === view.selected ? '›' : ' '} ${SEVERITY[f.severity]} ${f.file}:${f.line} ${f.title}`) : ['✓ no findings'],
    ...chosen ? ['', `${chosen.file}:${chosen.line}${chosen.reviewer ? ` · ${chosen.reviewer} reviewer` : ''}`, ...chosen.detail.split('\n'), ...chosen.fix ? [`Fix: ${chosen.fix}`] : [], ...chosen.reproduction ? ['Reproduction (this repository only):', ...chosen.reproduction.split('\n')] : []] : [],
    '', findingKeys(kind, r.findings, chosen, view)];
}
function findingKeys(kind: FindingsKind, findings: readonly Finding[], chosen: Finding | undefined, view: ResultView): string {
  const fixable = findings.filter(f => f.fix).length;
  if (kind === 'types' && chosen) return view.applied ?? '↑↓ finding · f fixes this one in a worktree (Ask) · Esc closes';
  if (kind === 'opensource' && fixable) return view.applied ?? `↑↓ finding · f fixes the ${fixable} a file change can fix, in a worktree (Ask) · Esc closes`;
  if (kind === 'pr-review') return `${findings.length ? '↑↓ finding · ' : ''}c copies the review · nothing is posted to GitHub · Esc closes`;
  return findings.length ? '↑↓ finding · Esc closes' : 'Esc closes';
}
const made = (summary: string, files: readonly string[], extra: string[], tests: TestResult | null | undefined, hint: string) =>
  [summary, `Changed: ${files.join(', ') || 'nothing'}`, ...extra, ...tests !== undefined ? [testsLine(tests)] : [], `Work is in the agent's worktree · d shows its diff on the homepage · ${hint}Esc closes`];
// What c copies, for the results that have something to copy.
export function copyText(r: AddonResult): string | null {
  switch (r.kind) {
    case 'commit': return r.body.trim() ? `${r.subject}\n\n${r.body.trim()}` : r.subject;
    case 'changelog': return r.section;
    case 'standup': return r.lines.join('\n');
    case 'standup-polish': return r.text;
    case 'pr-review': return [r.summary, ...r.findings.map(f => `${f.severity.toUpperCase()} ${f.file}:${f.line} ${f.title}\n  ${f.detail.replace(/\n/g, '\n  ')}`)].join('\n');
    default: return null;
  }
}
export function batchLines(r: Batch, view: ResultView): string[] {
  switch (r.kind) {
    case 'teach': return [];
    case 'fix': return r.reproduced
      ? [`Root cause: ${r.rootCause}`, `Failing test first: ${r.test}`, `Fix: ${r.fix}`, `Changed: ${r.files.join(', ') || 'nothing'}`, testsLine(view.tests), 'Work is in the agent\'s worktree · d shows its diff on the homepage · Esc closes']
      : ['■ stopped: no test reproduced the bug, so there is no fix to keep', `Best lead: ${r.rootCause}`, `Tried: ${r.reason}`, "The agent was told to change nothing · d on the agent's card shows whether anything changed in its worktree · Esc closes"];
    case 'cover': return [`${r.tests.length} test${r.tests.length === 1 ? '' : 's'} written for untested behavior:`, ...r.tests.flatMap(t => [`• ${t.file} › ${t.name}`, `  checks: ${t.behavior}`, `  fails if: ${t.wouldFailIf}`]),
      ...r.gaps.length ? ['Still untested:', ...r.gaps.map(g => `  ${g}`)] : [], testsLine(view.tests), 'Esc closes'];
    case 'refactor': {
      const chosen = r.items[view.selected];
      return [`${r.items.length} tech-debt item${r.items.length === 1 ? '' : 's'}, highest priority first · ${view.picked.size} picked`, '',
        ...windowed(r.items, view.selected, (item, i) => `${i === view.selected ? '›' : ' '} [${view.picked.has(i) ? 'x' : ' '}] ${item.title} · ${item.risk} risk`),
        ...chosen ? ['', chosen.why, `files: ${chosen.files.join(', ') || 'not named'}`] : [], '',
        view.applied ?? `↑↓ item · Space picks it · r refactors ${view.picked.size ? `the ${view.picked.size} picked` : 'the picked items'} in a worktree (Ask), tests kept green · Esc closes`];
    }
    case 'perf': {
      const ab = view.ab, change = ab?.state === 'done' && ab.beforeMs > 0 ? Math.round((ab.afterMs - ab.beforeMs) / ab.beforeMs * 100) : null;
      return [`Measured first: ${r.measured}`, `Changed: ${r.change}`, `Benchmark: ${testCommandText(r.benchmark)}${r.files.length ? ` (new: ${r.files.join(', ')})` : ''}`, '',
        ...!ab ? ['a runs the A/B: the benchmark on the code before and after, back to back on this Mac, in the test sandbox', 'the before copy has only committed files: no installed dependencies or build output'] : ab.state === 'running' ? ['◐ A/B running · before and after, alternating'] : ab.state === 'failed' ? [`✗ A/B stopped: ${ab.reason}`, ...ab.reason === AB_NO_SANDBOX ? [] : ['a runs it again']]
          : [`✓ A/B · ${ab.rounds} runs each, alternating, ${ab.sandbox ? 'sandboxed' : 'without a sandbox'}`, `  before: ${ab.beforeMs} ms median`, `  after:  ${ab.afterMs} ms median${change === null ? '' : ` · ${change > 0 ? '+' : ''}${change}%`}`],
        'Esc closes'];
    }
    case 'types': case 'failures': case 'review-deep': case 'security': case 'pr-review': case 'context': case 'opensource': return findingLines(r.kind, r, view);
    case 'issue': return made(r.summary, r.files, [], view.tests, "/pr <agent> opens a pull request when you're ready · ");
    case 'docs': case 'handover': case 'adr': return made(r.summary, r.files, [], undefined, '');
    case 'deps': return made(r.summary, r.files, [...r.upgraded.length ? ['Upgraded:', ...r.upgraded.map(u => `  ${u}`)] : [], ...r.skipped.length ? ['Skipped:', ...r.skipped.map(u => `  ${u}`)] : []], view.tests, '');
    case 'commit': return [r.subject, ...r.body ? ['', ...r.body.split('\n')] : [], '', view.applied ?? (view.commits ? "c copies it · y commits it in the agent's worktree, with your name · Esc closes" : 'c copies it · AI Term never commits in your checkout · Esc closes')];
    case 'changelog': return [...r.section.split('\n'), '', view.applied ?? 'c copies it · w writes it into CHANGELOG.md in a worktree (Ask) · Esc closes'];
    case 'standup': return ['no model · no tokens · from AI Term\'s own records', ...r.lines, '', 'c copies it · m polishes it with a model (asks first) · Esc closes'];
    case 'standup-polish': return [...r.text.split('\n'), '', 'c copies it · Esc closes'];
    case 'bisect': return [`First bad commit: ${r.commit.slice(0, 12)} ${r.subject}`, `${r.author} · ${r.date} · ${r.steps} step${r.steps === 1 ? '' : 's'} tested`, 'git bisect reset ran and the temporary copy was removed; your checkout was never touched.', '', ...r.diff];
  }
}
// /teach after its last chunk: the recap, then the quiz only if asked for.
export function teachEnd(r: Extract<AddonResult, { kind: 'teach' }>, quiz: ResultView['quiz']): string[] {
  if (quiz === 'hidden' || quiz === 'offered') return ['Recap', ...r.recap, '', `Quiz? ${r.quiz.length} short scenario question${r.quiz.length === 1 ? '' : 's'} on this diff · y starts · n skips · Esc closes`];
  if (quiz === 'declined') return ['Recap', ...r.recap, '', 'No quiz · Esc closes'];
  const item = r.quiz[quiz.question];
  if (!item) return ['✓ Quiz done', ...r.recap, 'Esc closes'];
  return [`Quiz ${quiz.question + 1}/${r.quiz.length}`, item.question, ...quiz.answer ? [`Answer: ${item.answer}`, `Space ${quiz.question + 1 < r.quiz.length ? 'next question' : 'finishes'} · Esc closes`] : ['Space shows the answer · Esc closes']];
}
