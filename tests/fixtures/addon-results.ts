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
