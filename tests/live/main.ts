import { access } from 'node:fs/promises';
import { redact, runChecks, type Check } from './runner.js';
import { ENTRY, endWorld } from './world.js';
import { setUpTier1, TIER1, type Tier1 } from './tier1.js';

// npm run live: the real built ai, driven in a real PTY the way you'd use it, in a throwaway world (see world.ts).
// Tier 1 needs nothing of yours. Tier 2 (--with-logins) uses your own Claude Code, Codex, API key and gh logins, and only
// runs when you ask for it. --only <id,id> and --from <id> run a part of tier 1 (for working on the suite); --keep keeps a
// failed run's world for a look.
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name), value = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const out = (line: string) => process.stdout.write(`${line}\n`);
function pick<C>(checks: readonly Check<C>[]): Check<C>[] {
  const only = value('--only')?.split(','), from = value('--from');
  if (only) return checks.filter(check => only.includes(check.id));
  const start = from ? checks.findIndex(check => check.id === from) : 0;
  if (start < 0) throw new Error(`no check has the id ${from ?? ''}; ids: ${checks.map(check => check.id).join(' ')}`);
  return checks.slice(start);
}
async function tier1(): Promise<boolean> {
  const context: Tier1 = await setUpTier1();
  let ok = false;
  try {
    // --only and --from still run the first check (starting ai) so the rest has a homepage to work on.
    const chosen = pick(TIER1), first = TIER1[0], checks = first && chosen[0] !== first ? [first, ...chosen] : chosen;
    const report = await runChecks(`Tier 1 · ${checks.length} checks · world ${context.world.root}`, checks, context, out);
    ok = report.failed === null;
    out(ok ? `Tier 1 passed: ${report.passed} checks in ${report.seconds} s` : `Tier 1 stopped at "${report.failed}" after ${report.passed} passed (${report.seconds} s)`);
  } finally {
    await context.ai.close(); await context.stub.close();
    if (flag('--keep') && !ok) out(`kept for a look: ${context.world.root} (ai daemon stop with AI_TERM_HOME=${context.world.aiHome}, then remove it)`);
    else for (const note of await endWorld(context.world)) out(`note: ${note}`);
  }
  return ok;
}
async function main(): Promise<void> {
  try { await access(ENTRY); } catch { out('dist/cli/index.js is missing: npm run build first (npm run live builds it)'); process.exitCode = 1; return; }
  if (!await tier1()) { process.exitCode = 1; return; }
  if (!flag('--with-logins')) { out('Tier 2 (your own logins) not run: npm run live -- --with-logins'); return; }
  const { tier2 } = await import('./tier2.js');
  if (!await tier2(out, args)) process.exitCode = 1;
}
main().catch((error: unknown) => { out(redact(`✗ the live suite itself failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)); process.exitCode = 1; });
