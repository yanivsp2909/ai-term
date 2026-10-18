import { access } from 'node:fs/promises';
import { Cleanup } from './cleanup.js';
import { pickChecks, redact, redactingOut, runChecks } from './runner.js';
import { ENTRY } from './world.js';
import { setUpTier1, TIER1 } from './tier1.js';
import { tier2, tier2Options } from './tier2.js';

// npm run live: the real built ai, driven in a real PTY the way you'd use it, in a throwaway world (see world.ts).
// Tier 1 needs nothing of yours. Tier 2 (--with-logins) uses your own Claude Code, Codex, API key and gh logins, and only
// runs when you ask for it. --only <id,id> and --from <id> run a part of tier 1 (for working on the suite); --keep keeps a
// failed run's world for a look. Every flag is checked before anything starts.
const FLAGS = new Set(['--with-logins', '--keep', '--only', '--from', '--github', '--issue', '--pr', '--key-model']);
const args = process.argv.slice(2);
const out = redactingOut(line => process.stdout.write(`${line}\n`));

async function main(): Promise<void> {
  const unknown = args.filter(arg => arg.startsWith('--') && !FLAGS.has(arg));
  if (unknown.length) throw new Error(`unknown flag ${unknown.join(', ')}; flags: ${[...FLAGS].join(' ')}`);
  const checks = pickChecks(TIER1, args), withLogins = args.includes('--with-logins'), options = withLogins ? tier2Options(args) : null;
  // Tier 2 hands the screen to you for your key and for prompts it doesn't know: never unattended (security review).
  if (withLogins && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error('tier 2 needs you at a terminal (it hands the screen to you); run it in Terminal, not piped or in the background');
  try { await access(ENTRY); } catch { throw new Error('dist/cli/index.js is missing: npm run build first (npm run live builds it)'); }
  const cleanup = new Cleanup();
  cleanup.onSignals(out);
  let ok: boolean;
  try {
    const keep = { world: false }, context = await setUpTier1(cleanup, () => keep.world);
    const report = await runChecks(`Tier 1 · ${checks.length} checks · world ${context.world.root}`, checks, context, out);
    // The stub answers every request it gets; one it couldn't is a failure even when the screens looked right.
    const stubFailed = report.failed === null && context.stub.errors.length > 0;
    if (stubFailed) out(`✗ the stub Ollama couldn't answer: ${context.stub.errors.slice(0, 3).join(' | ')}`);
    ok = report.failed === null && !stubFailed;
    out(ok ? `Tier 1 passed: ${report.passed} checks in ${report.seconds} s` : report.failed ? `Tier 1 stopped at "${report.failed}" after ${report.passed} passed (${report.seconds} s)` : 'Tier 1 failed: the stub Ollama had errors');
    if (!ok && args.includes('--keep')) { keep.world = true; out(`kept for a look: ${context.world.root} (stop its daemon: AI_TERM_HOME=${context.world.aiHome} node ${ENTRY} daemon stop; then remove the folder)`); }
  } finally { for (const note of await cleanup.run()) out(`note: ${note}`); }
  if (!ok) { process.exitCode = 1; return; }
  if (!options) { out('Tier 2 (your own logins) not run: npm run live -- --with-logins'); return; }
  try { if (!await tier2(out, options, cleanup)) process.exitCode = 1; }
  finally { for (const note of await cleanup.run()) out(`note: ${note}`); }
}
main().catch((error: unknown) => { process.stdout.write(`${redact(`✗ the live suite stopped: ${error instanceof Error ? error.message : String(error)}`)}\n`); process.exitCode = 1; });
