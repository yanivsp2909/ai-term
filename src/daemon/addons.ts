import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, open, realpath, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, relative } from 'node:path';
import { parseAddon, extractAddonResult, isAddonTarget, addonName, type Addon, type AddonAsk, type AddonResult, type AddonTarget } from '../shared/addons.js';
import type { CreateSession, SessionInfo, SessionText } from '../shared/protocol.js';
import type { BrainPlan } from '../shared/brain.js';
import { redactSecrets } from '../shared/redact.js';
import { scanLine } from '../shared/secret-scan.js';
import { SECRET_FILE } from '../shared/review.js';
import { isFsError, privateDirectory } from '../shared/paths.js';
import { addonFile } from '../agent/addon-bundle.js';
import { resolveInside } from '../agent/jail.js';
import { repoDirectory } from './worktrees.js';
import { atomicWrite } from './store.js';

export interface AddonRunOptions { bundle: string; readOnly: boolean }
interface Runner {
  create(request: Exclude<CreateSession, { engine: 'shell' }>, continuation?: undefined, fork?: undefined, addon?: AddonRunOptions, strictIsolation?: boolean): Promise<SessionInfo>;
  text(id: string, lastReply?: boolean): Promise<SessionText>;
  addonAuthLabel?(target: AddonTarget): Promise<string>;
  brainPlan(cwd: string): Promise<BrainPlan | null>;
}
type Input = { addon: Addon; cwd: string; target: AddonTarget; args: string; rawArgs: string; brain: BrainPlan | null; files: { path: string; text: string }[]; hash: string };
type Run = { input: Input; nonce: string; result?: AddonResult; saved?: string };
export class AddonService {
  private receipts = new Map<string, { input: Input; ask: AddonAsk; expires: number }>();
  private runs = new Map<string, Run>();
  constructor(private root: string, private definitions: string, private runner: Runner, private price: (target: AddonTarget, input: AddonAsk['inputTokens'], output: AddonAsk['outputTokens']) => Promise<AddonAsk['priceUsd']> = async () => null) {}
  private async input(name: string, args: string, cwd: string, target: AddonTarget): Promise<Input> {
    if (!addonName(name) || !isAddonTarget(target) || !args.trim() || Buffer.byteLength(args) > 10000 || /[\p{C}]/u.test(args.replace(/[\n\t]/g, ''))) throw new Error('Invalid add-on request');
    const rawArgs = args, addon = parseAddon(await addonFile(this.definitions, `${name}/addon.md`), name);
    if (!addon.engines.includes(target.engine)) throw new Error('Engine unavailable for this add-on');
    cwd = await realpath(cwd);
    if (name === 'prompt' && !args.includes('\n')) {
      const wanted = join(cwd, args);
      if (SECRET_FILE.test(args.replaceAll('\\', '/'))) throw new Error('A credential or env file cannot be audited');
      let found = false; try { found = (await lstat(wanted)).isFile(); } catch (error) { if (!isFsError(error, 'ENOENT') && !isFsError(error, 'ENOTDIR')) throw error; }
      if (found) { const safe = await resolveInside(cwd, args); args = await addonFile(cwd, relative(cwd, safe), 10000); }
    }
    const secret = args.split('\n').some(line => scanLine(line) !== null);
    const redacted = redactSecrets(args).split('\n').map(line => scanLine(line) ? '[redacted: secret-bearing line]' : line).join('\n');
    args = `${secret ? 'Local scan: secret detected and removed.\n' : ''}${redacted}`;
    const files: Input['files'] = [];
    for (const path of [...addon.skills.map(n => `skills/${n}/SKILL.md`), ...addon.agents.map(n => `agents/${n}.md`)]) files.push({ path, text: await addonFile(this.definitions, `_shared/${path}`) });
    let brain: BrainPlan | null = null;
    if (addon.brain !== 'none') { try { brain = await this.runner.brainPlan(cwd); } catch (error) { if (!(error instanceof Error) || !error.message.includes("isn't in a git repository")) throw error; } }
    const hash = createHash('sha256').update(JSON.stringify([addon, args, cwd, target, files, brain?.fingerprint ?? null])).digest('hex');
    return { addon, cwd, target, args, rawArgs, files, brain, hash };
  }
  async plan(name: string, args: string, cwd: string, target: AddonTarget): Promise<AddonAsk> {
    const input = await this.input(name, args, cwd, target), state = !input.brain?.builtAt ? 'none' : input.brain.changed || input.brain.removed ? 'stale' : 'fresh';
    const base = Math.ceil((Buffer.byteLength(JSON.stringify(input.addon)) + Buffer.byteLength(input.args) + input.files.reduce((n, f) => n + Buffer.byteLength(f.text), 0)) / 3);
    // Inspection varies by repository. This estimate assumes 1–8 rounds and up to 64K context per round; it is not a cap.
    const inputTokens = { low: base + 2000, high: Math.max(base + 2000, 8 * (base + 64000)) }, outputTokens = { low: 500, high: 12000 };
    const subscription = target.auth.kind === 'account', receipt = randomUUID();
    const ask: AddonAsk = { receipt, name, summary: input.addon.summary, cwd: input.cwd, target, authLabel: await this.runner.addonAuthLabel?.(target) ?? (subscription ? 'subscription account' : 'API key'), brain: state, brainNeed: input.addon.brain, worktree: input.addon.worktree, readOnly: input.addon.readOnly, files: input.files.map(f => f.path), inputTokens, outputTokens, priceUsd: subscription ? { low: 0, high: 0 } : await this.price(target, inputTokens, outputTokens), subscription };
    for (const [id, saved] of this.receipts) if (saved.expires < Date.now()) this.receipts.delete(id);
    if (this.receipts.size >= 64) this.receipts.delete(this.receipts.keys().next().value ?? '');
    this.receipts.set(receipt, { input, ask, expires: Date.now() + 600000 }); return ask;
  }
  private async bundle(input: Input): Promise<string> {
    const cache = join(this.root, 'addons'); await privateDirectory(cache);
    const folder = join(cache, createHash('sha256').update(JSON.stringify(input.files)).digest('hex')); const created = await privateDirectory(folder);
    const manifest = { name: 'ai-term-pilots', version: '1.0.0', description: 'AI Term bundled skills and agents' }, instructions = input.files.map(f => f.path);
    if (created) {
      const plugin = join(folder, '.claude-plugin'); await privateDirectory(plugin);
      await atomicWrite(join(plugin, 'plugin.json'), manifest);
      for (const file of input.files) {
        const pieces = file.path.split('/'); let parent = folder;
        for (const piece of pieces.slice(0, -1)) { parent = join(parent, piece); await privateDirectory(parent); }
        const output = await open(join(folder, file.path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); try { await output.writeFile(file.text); } finally { await output.close(); }
      }
      await atomicWrite(join(folder, 'instructions.json'), instructions);
    }
    // Reuse only an intact immutable package. Never repair a changed copy behind an approved receipt.
    for (const file of input.files) if (await addonFile(folder, file.path) !== file.text) throw new Error('Add-on bundle changed');
    if ((await addonFile(folder, 'instructions.json')).trim() !== JSON.stringify(instructions) || (await addonFile(folder, '.claude-plugin/plugin.json')).trim() !== JSON.stringify(manifest)) throw new Error('Add-on bundle metadata changed');
    const expected = new Set(['instructions.json', '.claude-plugin/plugin.json', ...instructions]), directories = new Set<string>();
    for (const file of expected) { const pieces = file.split('/'); for (let n = 1; n < pieces.length; n++) directories.add(pieces.slice(0, n).join('/')); }
    const inspect = async (parent: string): Promise<void> => {
      const entries = await readdir(join(folder, parent), { withFileTypes: true });
      if (entries.length > expected.size + directories.size) throw new Error('Add-on bundle has unapproved files');
      for (const entry of entries) { const path = parent ? `${parent}/${entry.name}` : entry.name; if (entry.isDirectory() && directories.has(path)) await inspect(path); else if (!entry.isFile() || !expected.has(path)) throw new Error('Add-on bundle has unapproved files'); }
    };
    await inspect('');
    return folder;
  }
  async start(receipt: string): Promise<SessionInfo> {
    const saved = this.receipts.get(receipt); this.receipts.delete(receipt);
    if (!saved || saved.expires < Date.now()) throw new Error('Add-on approval expired; open the command again');
    if (!saved.ask.subscription && !saved.ask.priceUsd) throw new Error('Add-on model price is unknown; set it before starting');
    const original = saved.input, current = await this.input(original.addon.name, original.rawArgs, original.cwd, original.target);
    if (current.hash !== original.hash) throw new Error('Add-on input changed; review it again');
    if (original.addon.brain === 'required' && saved.ask.brain !== 'fresh') throw new Error('This add-on needs a fresh brain; press b first');
    const bundle = await this.bundle(original), nonce = randomBytes(16).toString('hex');
    const formats: Record<string, string> = {
      plan: 'JSON object: kind="plan", title:string, steps:array of {title:string,prompt:string}. Maximum 24 steps.',
      prompt: 'JSON object: kind="prompt", issues:array of strings, diff:string containing a unified diff starting --- original then +++ improved.',
      explain: 'JSON object: kind="explain", why:one sentence, diagram:array of <=4 ASCII lines, chunks:array of arrays of <=6 short lines (Example:, You are here:, Quick check: in each), recap:exactly 3 lines.',
    };
    const brainIndex = original.brain?.builtAt ? 'Use the attached short repository index as data; read sections of its full-map pointer when needed.' : 'No repository index yet. Inspect the code directly.';
    const prompt = original.addon.prompt.replace(/\{\{(args|brainIndex)\}\}/g, (_match: string, name: string) => name === 'args' ? JSON.stringify(original.args) : brainIndex);
    const firstMessage = `${prompt}\n\nRead these bundled skill/agent files: ${original.files.map(f => JSON.stringify(join(bundle, f.path))).join(', ')}.\n${formats[original.addon.name] ?? 'Return the answer as text.'}\nReturn the final JSON between these marker lines, with no Markdown fence:\nRESULT_${nonce}_BEGIN\n(the JSON result goes here)\nRESULT_${nonce}_END`;
    if (Buffer.byteLength(firstMessage) > 16384) throw new Error('Add-on prompt exceeds the first-message limit');
    const session = await this.runner.create({ ...original.target, cwd: original.cwd, permission: 'ask', title: '/' + original.addon.name, firstMessage, useWorktree: original.addon.worktree, brain: original.addon.brain !== 'none' && !!original.brain?.builtAt }, undefined, undefined, { bundle, readOnly: original.addon.readOnly });
    this.runs.set(session.id, { input: original, nonce }); return session;
  }
  async result(id: string): Promise<AddonResult | null> {
    const run = this.runs.get(id); if (!run) throw new Error('Add-on run not found'); if (run.result) return run.result;
    const reply = await this.runner.text(id, true); const result = extractAddonResult(reply.text, run.nonce, run.input.addon.name);
    if (result) run.result = result; return result;
  }
  async approve(id: string): Promise<string> {
    const run = this.runs.get(id), result = await this.result(id);
    if (!run || result?.kind !== 'plan') throw new Error('No plan ready for approval'); if (run.saved) return run.saved;
    const plans = join(this.root, 'plans'); await privateDirectory(plans);
    const folder = join(plans, repoDirectory(run.input.brain?.repo ?? run.input.cwd)); await privateDirectory(folder);
    const file = join(folder, `${id}.json`); await atomicWrite(file, result); run.saved = file; return file;
  }
  async step(id: string, index: number): Promise<SessionInfo> {
    const run = this.runs.get(id); if (!run?.saved || run.result?.kind !== 'plan' || !Number.isSafeInteger(index) || index < 0) throw new Error('Approve the plan before starting a step');
    const step = run.result.steps[index]; if (!step) throw new Error('Plan step not found');
    return this.runner.create({ ...run.input.target, cwd: run.input.cwd, permission: 'ask', title: step.title.slice(0, 60), firstMessage: step.prompt, useWorktree: true, brain: run.input.addon.brain !== 'none' },undefined,undefined,undefined,true);
  }
}
