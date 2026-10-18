import { LiveFailure } from './screen.js';

// One check: what it does, what a person would look at to see it worked, and the steps. Checks run in order and share
// one world (a later check uses agents an earlier one started), so the first failure stops the run.
// id: one word, for --only and --from.
export interface Check<C> { id: string; name: string; look: string; run(context: C): Promise<void> }
// Secrets never reach the output, not even the suite's fake ones: anything shaped like a key (OpenAI and Anthropic sk-,
// GitHub, xAI, Google, Groq, Bedrock, bearer tokens; security review) and the fake values the suite plants (LIVESECRET…)
// are cut from every line it prints.
const SHAPES = [/\b(?:gh[pousr])_[A-Za-z0-9]{8,}/g, /\bgithub_pat_[A-Za-z0-9_]{8,}/g, /\bxai-[A-Za-z0-9_-]{8,}/g, /\bAIza[0-9A-Za-z_-]{10,}/g, /\bgsk_[A-Za-z0-9]{8,}/g, /\bABSK[A-Za-z0-9+/=]{8,}/g, /\bBearer\s+[A-Za-z0-9._~+/=-]+/g, /LIVESECRET\S*/g];
export const redact = (text: string): string => SHAPES.reduce((cut, shape) => cut.replace(shape, '[redacted]'), text.replace(/sk-[A-Za-z0-9_-]{3,}/g, 'sk-[redacted]'));
// Every line the suite prints goes through this (review: lines a check didn't wrap went out as they were).
export const redactingOut = (write: (line: string) => void) => (line: string): void => write(redact(line));
const indent = (text: string) => text.split('\n').map(line => `    ${line}`).join('\n');
// The checks a run's flags pick: --only <id,id> (in suite order) or --from <id>, the first check (it starts ai) always
// first. An unknown id or a flag without its value is refused (review: a typo ran nothing and passed).
export function pickChecks<C>(checks: readonly Check<C>[], args: readonly string[]): Check<C>[] {
  const value = (name: string): string | undefined => {
    const i = args.indexOf(name); if (i < 0) return undefined;
    const given = args[i + 1];
    if (!given || given.startsWith('--')) throw new Error(`${name} needs a check id; ids: ${checks.map(c => c.id).join(' ')}`);
    return given;
  };
  const only = value('--only')?.split(','), from = value('--from'), unknown = [...only ?? [], ...from ? [from] : []].filter(id => !checks.some(c => c.id === id));
  if (unknown.length) throw new Error(`no check has the id ${unknown.join(', ')}; ids: ${checks.map(c => c.id).join(' ')}`);
  const chosen = only ? checks.filter(c => only.includes(c.id)) : checks.slice(from ? checks.findIndex(c => c.id === from) : 0), first = checks[0];
  return first && chosen[0] !== first ? [first, ...chosen] : chosen;
}
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
