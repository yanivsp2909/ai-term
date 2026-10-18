import { LiveFailure } from './screen.js';

// One check: what it does, what a person would look at to see it worked, and the steps. Checks run in order and share
// one world (a later check uses agents an earlier one started), so the first failure stops the run.
// id: one word, for --only and --from.
export interface Check<C> { id: string; name: string; look: string; run(context: C): Promise<void> }
// Secrets never reach the output, not even the suite's fake ones: anything shaped like a key, and the fake values the
// suite plants (LIVESECRET...), are cut from every line it prints.
export const redact = (text: string): string => text.replace(/sk-[A-Za-z0-9_-]{3,}/g, 'sk-[redacted]').replace(/LIVESECRET\S*/g, '[redacted]');
const indent = (text: string) => text.split('\n').map(line => `    ${line}`).join('\n');
export interface RunReport { passed: number; failed: string | null; seconds: number }

export async function runChecks<C>(title: string, checks: readonly Check<C>[], context: C, out: (line: string) => void): Promise<RunReport> {
  const started = Date.now();
  out(title);
  let passed = 0;
  for (const [index, check] of checks.entries()) {
    const began = Date.now();
    try { await check.run(context); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error), screen = error instanceof LiveFailure ? error.screen : '';
      out(redact(`✗ ${index + 1}/${checks.length} ${check.name}: ${message}`));
      out(redact(`  look at: ${check.look}`));
      if (screen.trim()) out(redact(`  the screen then:\n${indent(screen.replace(/\n+$/, ''))}`));
      return { passed, failed: check.name, seconds: Math.round((Date.now() - started) / 1000) };
    }
    passed++;
    out(redact(`✓ ${index + 1}/${checks.length} ${check.name} · ${((Date.now() - began) / 1000).toFixed(1)} s`));
  }
  return { passed, failed: null, seconds: Math.round((Date.now() - started) / 1000) };
}
