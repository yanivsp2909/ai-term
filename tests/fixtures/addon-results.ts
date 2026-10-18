// v1.1 batch 1: one valid result per model add-on, as a stub engine returns it between the nonce markers.
const explained = { why: 'The parser now rejects empty input.', diagram: ['input -> parse -> error'], chunks: [['One idea: empty input is refused.', 'Example: src/a.ts: if (!text) throw new Error("empty")', 'You are here: src/a.ts.', 'Quick check: what does "" do now?']], recap: ['Empty input throws.', 'The caller sees the error.', 'Tests cover it.'] };
export const finding = { file: 'src/a.ts', line: 3, severity: 'high', title: 'Error is swallowed', detail: 'catch {} hides a failed write; the user sees success.' };
export const fixtures: Record<string, Record<string, unknown>> = {
  teach: { kind: 'teach', ...explained, quiz: [{ question: 'You pass "" now; what happens?', answer: 'It throws "empty".' }] },
  fix: { kind: 'fix', reproduced: true, rootCause: 'parse() reads past the end on empty input', test: 'tests/a.test.ts › rejects empty input', fix: 'Return early on empty input.', files: ['src/a.ts', 'tests/a.test.ts'] },
  cover: { kind: 'cover', tests: [{ file: 'tests/a.test.ts', name: 'rejects empty input', behavior: 'empty input throws "empty"', wouldFailIf: 'the empty check were removed' }], gaps: ['retry after a timeout'] },
  refactor: { kind: 'refactor', items: [{ title: 'Split parse()', why: 'It is 90 lines with three jobs.', files: ['src/a.ts'], risk: 'low' }, { title: 'Remove dead export', why: 'Nothing imports old().', files: ['src/b.ts'], risk: 'medium' }] },
  perf: { kind: 'perf', measured: 'node bench/a.js: median 120 ms over 5 runs', change: 'Cached the regex; now 40 ms', benchmark: ['node', 'bench/a.js'], files: ['bench/a.js'] },
  types: { kind: 'types', summary: 'One loose type', findings: [{ ...finding, title: 'status is a string', fix: "Use 'ok' | 'failed'." }] },
  failures: { kind: 'failures', summary: 'One hidden failure', findings: [finding] },
  'review-deep': { kind: 'review-deep', summary: 'One issue', findings: [{ ...finding, reviewer: 'security' }] },
  security: { kind: 'security', summary: 'One local finding', findings: [{ ...finding, title: 'Path escapes the folder', reproduction: 'node -e "require(\'./src/a\').read(\'../x\')" reads outside the folder' }] },
};

// v1.1 batch 2: repository and GitHub add-ons.
export const batch2: Record<string, Record<string, unknown>> = {
  issue: { kind: 'issue', summary: 'Empty titles are refused now, with a test.', files: ['src/a.ts', 'tests/a.test.ts'] },
  'pr-review': { kind: 'pr-review', summary: 'One real issue', findings: [{ file: 'src/a.ts', line: 3, severity: 'high', title: 'Null is not handled', detail: 'parse(null) throws; the PR says it returns [].' }] },
  deps: { kind: 'deps', summary: 'Two upgrades, one skipped', files: ['package.json', 'package-lock.json'], upgraded: ['left-pad 1.0.0 → 1.3.0 (security)'], skipped: ['react 18 → 19: breaking JSX change, needs you'] },
  commit: { kind: 'commit', subject: 'fix(parser): refuse empty input', body: 'Empty input read past the end of the buffer.' },
  changelog: { kind: 'changelog', section: '## [Unreleased]\n### Fixed\n- Empty input no longer crashes the parser.' },
  docs: { kind: 'docs', summary: 'README commands match package.json', files: ['README.md'] },
  handover: { kind: 'handover', summary: 'PROGRESS.md written', files: ['PROGRESS.md'] },
  adr: { kind: 'adr', summary: 'Decision D61 proposed', files: ['docs/architecture.md'] },
  context: { kind: 'context', summary: 'Two rules contradict', findings: [{ file: 'AGENTS.md', line: 12, severity: 'medium', title: 'Contradicts CLAUDE.md:4', detail: 'One says always commit, the other never.', fix: 'Keep the never-commit rule.' }] },
  opensource: { kind: 'opensource', summary: 'Not ready: a secret in history', findings: [{ file: 'config.js', line: 2, severity: 'critical', title: 'API key in history', detail: 'Committed in abc1234; rotate it.' }, { file: 'README.md', line: 1, severity: 'low', title: 'Personal path', detail: '/Users/someone appears in an example.', fix: 'Use ~/project instead.' }] },
  'standup-polish': { kind: 'standup-polish', text: 'Done: fixer fixed the parser.\nDoing: nothing.\nBlockers: none.' },
};

// v1.1 batch 3: making things.
export const batch3: Record<string, Record<string, unknown>> = {
  deck: { kind: 'deck', summary: 'Eight slides from the README and docs', files: ['out/deck/ai-term.html'], todo: ['TODO: paying users (no number in the repo)', 'TODO: team bios'] },
  slides: { kind: 'slides', summary: 'A 12-slide walkthrough of the add-on core', files: ['out/slides/addons.html'], todo: [] },
  diagram: { kind: 'diagram', summary: 'Client, daemon and agents as Mermaid', files: ['docs/diagrams/processes.mmd'], rendered: false },
  design: { kind: 'design', summary: 'Two settings mockups', files: ['out/design/settings-a.html', 'out/design/settings-b.html'] },
  polish: { kind: 'polish', summary: 'Focus rings and spacing fixed', files: ['src/ui/button.css'] },
  a11y: { kind: 'a11y', summary: 'One real problem', findings: [{ file: 'src/ui/button.tsx', line: 4, severity: 'high', title: 'Icon button has no name', detail: '4.1.2: screen readers announce "button".', fix: 'Add aria-label="Close".' }] },
  e2e: { kind: 'e2e', summary: 'Sign-in and save flows', files: ['e2e/signin.spec.ts'] },
  animate: { kind: 'animate', verdict: 'animate', why: 'A dialog opens a few times a day: a standard animation fits.', summary: 'Dialog fades and scales in from 0.96', files: ['src/ui/dialog.css'] },
  video: { kind: 'video', summary: 'A 20-second terminal demo of /plan', files: ['out/video/plan.tape'], rendered: false, missing: ['vhs (brew install vhs)'] },
  research: { kind: 'research', summary: 'Three sources agree; one disagrees on limits', files: ['docs/research/pty-limits.md'], sources: ['https://nodejs.org/api/child_process.html', 'https://man7.org/linux/man-pages/man7/pty.7.html'] },
  study: { kind: 'study', why: 'Worktrees let agents work without touching your checkout.', chunks: [['A worktree is a second folder on its own branch.', 'Example: ~/.ai-term/worktrees/<repo>/<agent>.', 'Check: two agents edit a.ts; why do they not collide?']], recap: ['Worktrees isolate agents.', 'Each has its own branch.', 'Merging brings work back.'] },
};
