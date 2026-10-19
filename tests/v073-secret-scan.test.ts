import { expect, it } from 'vitest';
import { scanPatch, shannonEntropy } from '../src/shared/secret-scan.js';

// v0.7.3 secret scan (D55, on): before a merge or a PR, the lines the agent's branch adds are scanned with the redaction
// patterns plus an entropy check. A hit names the file and line; the value itself is never shown.
const patch = (file: string, lines: string[], start = 1) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +${start},${lines.length} @@\n${lines.map(l => `+${l}`).join('\n')}\n`;

it('finds provider keys, tokens and secret assignments with their file and line, never the value', () => {
  const key = 'sk-ant-api03-' + 'Q'.repeat(40), hits = scanPatch(patch('src/config.ts', ['const a = 1;', `const key = "${key}";`, 'export DB_PASSWORD=hunter2-long', 'ok'], 10) + patch('.env.example', ['AWS=AKIA' + 'IOSFODNN7EXAMPLE']));
  expect(hits.map(h => [h.file, h.line, h.kind])).toEqual([['src/config.ts', 11, 'secret assignment'], ['src/config.ts', 12, 'secret assignment'], ['.env.example', 1, 'AWS access key']]);
  expect(JSON.stringify(hits)).not.toContain('QQQQ'); expect(JSON.stringify(hits)).not.toContain('hunter2'); expect(JSON.stringify(hits)).not.toContain('AKIA');
  expect(hits[0]?.length).toBeGreaterThan(40);
});

it('flags a high-entropy value assigned in code, but not hashes, lockfile integrity or ordinary words', () => {
  const random = 'aZ3kP9qL2mX7vB4nR8tY1wE6uI0oS5dF';
  expect(shannonEntropy(random)).toBeGreaterThan(4);
  expect(scanPatch(patch('src/a.ts', [`const token_value = "${random}";`, `client: "${random}"`])).map(h => h.kind)).toEqual(['high-entropy string', 'high-entropy string']);
  const clean = [
    'commit 3f2a9c1d4e5b6a7c8d9e0f1a2b3c4d5e6f7a8b9c', 'const sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";',
    'const message = "The quick brown fox jumps over the lazy dog";', 'import { aVeryLongButOrdinaryIdentifierName } from "./x";', 'password: string;',
  ];
  expect(scanPatch(patch('src/b.ts', clean))).toEqual([]);
  expect(scanPatch(patch('package-lock.json', [`"integrity": "sha512-${random}${random}=="`]))).toEqual([]);
});

it('only added lines count; removed lines and context are not scanned', () => {
  const text = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,1 @@\n-OLD_TOKEN=abcdef123456\n keep\n';
  expect(scanPatch(text)).toEqual([]);
});

// ---- Part E review findings ----
it('HIGH (both reviews): an added line starting with ++ is content, not a header; hunk counts decide', () => {
  const token = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  const text = `diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -0,0 +1,3 @@\n+x="${token}"\n+++ y="${token}"\n+++ b/evil\n`;
  expect(scanPatch(text).map(h => [h.file, h.line])).toEqual([['x.txt', 1], ['x.txt', 2]]);
});

it('HIGH (TS review): paths with spaces or quoted names keep their real name, no tab', () => {
  const token = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  const spaced = `diff --git a/my dir/a b.txt b/my dir/a b.txt\n--- a/my dir/a b.txt\t\n+++ b/my dir/a b.txt\t\n@@ -0,0 +1 @@\n+t="${token}"\n`;
  const quoted = `diff --git "a/\\303\\251 \\"q\\".txt" "b/\\303\\251 \\"q\\".txt"\n--- /dev/null\n+++ "b/\\303\\251 \\"q\\".txt"\n@@ -0,0 +1 @@\n+t="${token}"\n`;
  expect(scanPatch(spaced)[0]?.file).toBe('my dir/a b.txt');
  expect(scanPatch(quoted)[0]?.file).toBe('é "q".txt');
});

it('MEDIUM (TS review): paths, long identifiers and fixtures are not "high-entropy"; a real token still is', () => {
  const add = (file: string, line: string) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +1 @@\n+${line}\n`;
  expect(scanPatch(add('src/a.ts', 'const p = "/Users/foo/someVeryLongDirectoryName2/another-Dir_Name3";'))).toEqual([]);
  expect(scanPatch(add('src/a.ts', 'const name = "renderHomepageLayoutWithPreview2Columns";'))).toEqual([]);
  expect(scanPatch(add('tests/fixtures/data.json', '"blob": "aZ3kP9qL2mX7vB4nR8tY1wE6uI0oS5dF"'))).toEqual([]);
  expect(scanPatch(add('src/a.ts', 'client: "aZ3kP9qL2mX7vB4nR8tY1wE6uI0oS5dF"')).map(h => h.kind)).toEqual(['high-entropy string']);
});

it('LOW (fix review): a key pasted into a lockfile is still found by its pattern (only the entropy check skips lockfiles)', () => {
  const text = 'diff --git a/x/yarn.lock b/x/yarn.lock\n--- a/x/yarn.lock\n+++ b/x/yarn.lock\n@@ -0,0 +1 @@\n+aws AKIA' + 'IOSFODNN7EXAMPLE\n';
  expect(scanPatch(text).map(h => h.kind)).toEqual(['AWS access key']);
});
