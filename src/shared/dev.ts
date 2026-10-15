import { isTestCommand } from './test-run.js';
// v0.9.2 dev servers per worktree: what /dev shows before you start one, and what the card shows while it runs.
// runs: the script a package manager's `run <name>` would start (from package.json), shown where nothing sandboxes it.
export interface DevPlan { title: string; command: string[]; cwd: string; port: number; sandbox: boolean; why?: string; runs?: string; fingerprint: string; running: boolean; tail: string[] }
export type DevState = { state: 'running'; port: number } | { state: 'exited'; port: number; code: number | null };
// eslint-disable-next-line no-control-regex -- refusing controls is the point.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const isPort = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 1024 && Number(value) <= 65535;
const text = (value: unknown, max: number): value is string => typeof value === 'string' && [...value].length <= max && !CONTROL.test(value);
export function validateDevPlan(value: unknown): DevPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid dev plan');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !['title', 'command', 'cwd', 'port', 'sandbox', 'why', 'runs', 'fingerprint', 'running', 'tail'].includes(key)) || !text(v.title, 60) || !isTestCommand(v.command) || !text(v.cwd, 4096) || !isPort(v.port)
    || typeof v.sandbox !== 'boolean' || v.why !== undefined && !text(v.why, 160) || v.runs !== undefined && !text(v.runs, 200) || typeof v.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(v.fingerprint) || typeof v.running !== 'boolean'
    || !Array.isArray(v.tail) || v.tail.length > 20 || !v.tail.every(line => text(line, 200))) throw new Error('Invalid dev plan');
  return { title: v.title, command: [...v.command], cwd: v.cwd, port: v.port, sandbox: v.sandbox, ...v.why !== undefined ? { why: v.why } : {}, ...v.runs !== undefined ? { runs: v.runs } : {}, fingerprint: v.fingerprint, running: v.running, tail: [...v.tail] as string[] };
}
export function isDevState(value: unknown): value is DevState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.state === 'running') return Object.keys(v).length === 2 && isPort(v.port);
  return v.state === 'exited' && Object.keys(v).length === 3 && isPort(v.port) && (v.code === null || Number.isSafeInteger(v.code));
}
type Tone = 'ink' | 'ink-2' | 'ink-3' | 'status-error' | 'status-done';
// The /dev popup: what runs, where, on which port, in which sandbox; a running one's last lines. Without a sandbox it takes
// a capital Y (review: one easy key shouldn't run agent code with your rights).
export function devLines(plan: DevPlan): { text: string; tone: Tone }[] {
  const command = plan.command.map(word => /[\s"'\\]/.test(word) ? JSON.stringify(word) : word).join(' ');
  return [
    { text: `Dev server for ${plan.title}`, tone: 'ink' },
    { text: `$ ${command}`, tone: 'ink-2' },
    ...plan.runs ? [{ text: `runs: ${plan.runs}`, tone: 'ink-2' as const }] : [],
    { text: `in ${plan.cwd} · http://127.0.0.1:${plan.port} · PORT=${plan.port}`, tone: 'ink-3' },
    plan.sandbox ? { text: 'sandbox: listens on 127.0.0.1 only · writes only in this worktree and a temp folder · no internet', tone: 'ink-3' }
      : { text: `${plan.why ?? 'no sandbox'} · it runs with your user's rights`, tone: 'status-error' },
    ...plan.running ? [{ text: `▶ running · http://127.0.0.1:${plan.port}`, tone: 'status-done' as const }, ...plan.tail.map(line => ({ text: `  ${line}`, tone: 'ink-3' as const }))] : [],
    { text: plan.running ? 'x stops it · Esc closes' : plan.sandbox ? 'y starts it · n or Esc starts nothing' : 'Y (capital) runs it without a sandbox · n or Esc starts nothing', tone: 'ink-3' },
  ];
}
