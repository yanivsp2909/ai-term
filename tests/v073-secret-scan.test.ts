import { expect, it } from 'vitest';
import { scanPatch, shannonEntropy } from '../src/shared/secret-scan.js';

// v0.7.3 secret scan (D55, on): before a merge or a PR, the lines the agent's branch adds are scanned with the redaction
// patterns plus an entropy check. A hit names the file and line; the value itself is never shown.
const patch = (file: string, lines: string[], start = 1) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +${start},${lines.length} @@\n${lines.map(l => `+${l}`).join('\n')}\n`;

it('finds provider keys, tokens and secret assignments with their file and line, never the value', () => {
  const key = 'sk-ant-api03-' + 'Q'.repeat(40), hits = scanPatch(patch('src/config.ts', ['const a = 1;', `const key = "${key}";`, 'export DB_PASSWORD=hunter2-long', 'ok'], 10) + patch('.env.example', ['AWS=AKIAIOSFODNN7EXAMPLE']));
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
