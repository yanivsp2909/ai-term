import { isTestCommand } from './test-run.js';
// v0.9.2 dev servers per worktree: what /dev shows before you start one, and what the card shows while it runs.
export interface DevPlan { title: string; command: string[]; cwd: string; port: number; sandbox: boolean; why?: string; fingerprint: string; running: boolean; tail: string[] }
export type DevState = { state: 'running'; port: number } | { state: 'exited'; port: number; code: number | null };
// eslint-disable-next-line no-control-regex -- refusing controls is the point.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const isPort = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 1024 && Number(value) <= 65535;
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !CONTROL.test(value);
export function validateDevPlan(value: unknown): DevPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid dev plan');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !['title', 'command', 'cwd', 'port', 'sandbox', 'why', 'fingerprint', 'running', 'tail'].includes(key)) || !text(v.title, 60) || !isTestCommand(v.command) || !text(v.cwd, 4096) || !isPort(v.port)
    || typeof v.sandbox !== 'boolean' || v.why !== undefined && !text(v.why, 160) || typeof v.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(v.fingerprint) || typeof v.running !== 'boolean'
    || !Array.isArray(v.tail) || v.tail.length > 20 || !v.tail.every(line => text(line, 200))) throw new Error('Invalid dev plan');
  return { title: v.title, command: [...v.command], cwd: v.cwd, port: v.port, sandbox: v.sandbox, ...v.why !== undefined ? { why: v.why } : {}, fingerprint: v.fingerprint, running: v.running, tail: [...v.tail] as string[] };
}
export function isDevState(value: unknown): value is DevState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.state === 'running') return Object.keys(v).length === 2 && isPort(v.port);
  return v.state === 'exited' && Object.keys(v).length === 3 && isPort(v.port) && (v.code === null || Number.isSafeInteger(v.code));
}
