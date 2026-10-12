import { EventEmitter } from 'node:events';
import type { CpuInfo } from 'node:os';
import type { SessionStats } from '../shared/protocol.js';
export interface ProcRow { pid: number; ppid: number; rssKb: number; cpu: number }
export interface NetCounter { rx: number; tx: number }
export interface SamplerDeps { run(file: string, args: string[]): Promise<string>; cpus(): CpuInfo[]; totalmem(): number; now(): number; sessions(): { sessionId: string; pid: number }[]; log: { info(message: string): void; error(message: string): void } }
export const SAMPLE_COMMANDS = { ps: { file: '', args: [] as string[] }, vmStat: { file: '', args: [] as string[] }, netstat: { file: '', args: [] as string[] } };
const todo = (): never => { throw new Error('not implemented'); };
export function parsePs(_text: string): ProcRow[] { return todo(); }
export function parseVmStat(_text: string): number | null { return todo(); }
export function parseNetstat(_text: string): Map<string, NetCounter> | null { return todo(); }
export function netRates(_a: Map<string, NetCounter>, _b: Map<string, NetCounter>, _s: number): NetCounter | null { return todo(); }
export function cpuPercent(_a: CpuInfo[], _b: CpuInfo[]): number | null { return todo(); }
export function sessionUsage(_rows: ProcRow[], _roots: { sessionId: string; pid: number }[], _cpus: number): SessionStats[] { return todo(); }
export class SystemSampler extends EventEmitter { constructor(_deps: SamplerDeps) { super(); } setSubscribers(_count: number): void { todo(); } running(): boolean { return todo(); } }
