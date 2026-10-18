import { repoDirectory } from './worktrees.js';
import { McpService } from './mcp/service.js';
import { ExtensionService } from './extensions.js';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { stripVTControlCharacters } from 'node:util';
import { writeClaudeSettings,claudeStatusLine } from './claude-settings.js';
import { agentTranscript,removeSessionFiles } from './session-files.js';
import {parseAgentStatus} from './agent-status.js';
import { AGENT_PROVIDERS, engineTitle, keyEngine, deploymentWire } from '../shared/models.js';
import { catalogIds, catalogModels } from '../shared/model-catalog.js';
import { DEFAULT_AGENT_CAPS, type AgentFacts } from '../shared/agent-facts.js';
import { closestCatalogModel, findPrice, findLimits, deploymentAlias, estimateCost, type PriceSnapshot } from './usage-prices.js';
import { cheapestWriter, handoffPlan, summarizeWithKey, type Summarize } from './handoff.js';
import { cleanNote, HANDOFF_OUTPUT_TOKENS, handoffInstructions, handoffMessage, handoffPrompt, type HandoffPlan, type HandoffSummary, type HandoffWriter } from '../shared/handoff.js';
import { engineLabel } from '../shared/models.js';
import priceData from '../../data/usage-prices.json' with {type:'json'};
const PRICES=priceData as PriceSnapshot;
const AGENT_SECRETS_TTL_MS=60_000;
// Created new (never over a link or an old file), 0600, inside the agent's private session folder.
function writeAgentSecrets(file:string,secrets:Record<string,string>):void{
    try{unlinkSync(file);}catch(error){if(!isFsError(error,'ENOENT'))throw error;}
    const fd=openSync(file,fsConstants.O_WRONLY|fsConstants.O_CREAT|fsConstants.O_EXCL|fsConstants.O_NOFOLLOW,0o600);
    try{writeSync(fd,JSON.stringify(secrets));}finally{closeSync(fd);}
}
import {parseClaudeStatus} from './claude-status.js';
import {parseCodexStatus,codexTitle,isCodexApproval,type CodexRun} from './codex-status.js';
import {initialStatus,reduceStatus,type StatusState} from './status-reducer.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { isFsError, type Paths } from '../shared/paths.js';
import { MAX_FIND_PER_AGENT, MAX_FIND_RESULTS, type SessionInfo, type SessionEvent, type TerminalModes, type CreateSession, type ClaudeStatusEvent, type WorktreeRecord, type WorktreeView, type FindMatch, type KeyView, type Settings, type TaskUsage, type UsageRecord, type CliEngine } from '../shared/protocol.js';
import { isUUID, isTitle, isSize, validCwd, validateSession, validateWorktreeRecord, isSendText, isFindQuery } from '../shared/validate.js';
import { SettingsStore } from './settings.js';
import { GitError, isWorktreeTop, repoCommonDir, repoTopLevel, runGit } from './git.js';
import { worktreeDiff, worktreeStat } from './diff.js';
import type { AgentDiff } from '../shared/diff.js';
import { fitExport, redactExportMeta, transcriptFor } from './session-export.js';
import { applyUndo, CheckpointError, dropCheckpoints, listCheckpoints, snapshot, undoPlan, type CheckpointContext } from './checkpoints.js';
import type { UndoPlan } from '../shared/checkpoints.js';
import { merge, MergeError, mergePlan, openPr, prPlan, type MergeTarget, type UserGit } from './merge.js';
import { isYourPrice, MAX_PRICES, overridesFor, priceCount, PRICED_BY_YOU } from '../shared/prices.js';
import { runTests, testSetup, TestRunError, projectRepo } from './test-run.js';
import { currentAgentSandbox, dontAskNote } from './agent-sandbox.js';
import { windowsRecipe, windowsShell } from './win-launch.js';
import { pathInside } from '../shared/path-inside.js';
import { limitCaps, overLimit, stopDelayMs, type QueueLimit } from '../shared/queue.js';
const QUEUE_CHECK_MS = 15_000, QUEUE_REPORT_MS = 3 * 60_000;
import { BRAIN_BATCH_CHARS, BRAIN_MAX_DECISIONS, BRAIN_OUTPUT_PER_FILE, BRAIN_SUMMARY_FILE_CHARS, brainMention, brainPrompt, parseSummaries, type BrainPlan, type BrainResult } from '../shared/brain.js';
import { BrainError, brainFolderSafe, brainPaths, readBrain, readRepoFile, removeBrain, scanRepo, writeBrain, writeBrainIndex } from './brain.js';
import { allocateFreePort, devEnv, DevServers, scriptOf } from './dev-servers.js';
import type { DevPlan, DevState } from '../shared/dev.js';
const DEV_OFF = 'Dev servers are off; turn them on in /settings (y)', DEV_NO_TREE = 'A dev server runs in an agent\'s worktree; this agent has none', DEV_NO_CMD = "Set the project's dev command with /dev-cmd first";
const DEV_NO_PORT = 'No free dev port left (4100–4199); stop a dev server first', DEV_SETUP = "The dev server setup couldn't be read", DEV_CHANGED = 'The dev server setup changed since it was shown; run /dev again', DEV_RUNNING = 'A dev server already runs for this agent; /dev shows it';
const DEV_PORT_TAKEN = "Another agent's dev server just took that port; run /dev again";
export const DEV_ERRORS: readonly string[] = [DEV_OFF, DEV_NO_TREE, DEV_NO_CMD, DEV_NO_PORT, DEV_CHANGED, DEV_RUNNING, DEV_SETUP, DEV_PORT_TAKEN, "The dev server couldn't start", 'AI Term is stopping; start it again after'];
import { prepareSandbox, sandboxReady, SandboxPathError, type PreparedSandbox } from './test-sandbox.js';
import { MAX_TEST_CHANGED, type ProjectTestCommand, type TestPlan } from '../shared/test-run.js';
import { FORK_PREVIEW_CHARS, forkTitle, type ForkPlan, type ForkTarget } from '../shared/fork.js';
import { ownLoginLabel } from '../shared/models.js';
import { keyAuthLabel } from '../shared/providers.js';
import { AutoReviewLedger, ReviewError, reviewModelView, reviewWriters } from './review.js';
import { countFindings, diffForReview, REVIEW_OUTPUT_TOKENS, reviewPrompt, reviewText, type ReviewPlan, type ReviewResult } from '../shared/review.js';
import { estimateTokens } from '../agent/limits.js';
import { createHash } from 'node:crypto';
import type { MergePlan, PrPlan } from '../shared/merge.js';
import { EXPORT_TEXT_CHARS, type SessionExport } from '../shared/session-export.js';
import { redactSecrets } from '../shared/redact.js';
import { prepareWorktree, serialize } from './worktrees.js';
import { checkWorktree, deleteWorktree, unrecordedFolders, WorktreeError } from './worktree-removal.js';
import { atomicWrite, keepCopy, moveAside, readState, StateLoadError } from './store.js';
import { Logger } from './log.js';
import { PtyHost, type SpawnRecipe } from './pty-host.js';
import { Mirror, type MirrorSignal } from './mirror.js';
import { electronNodeNeeded } from '../shared/runtime-paths.js';
import { buildShellEnv, buildSpawnEnv, buildArgs, buildUsageEnv, buildUsageArgs,buildStatusEnv,buildStatusArgs,buildAgentArgs,buildAgentEnv,buildTestEnv,splitAgentSecrets } from './env.js';
import { KeyStore, KeyError, type FoundryBinding } from './keys.js';
import { CLI_KEY_PROVIDERS, isBoundProvider, isLocalEndpoint, testedModels } from '../shared/providers.js';
import { checkEngine } from './engines.js';
import { UsageService } from './usage-service.js';
import { ReplyBudget } from './reply-budget.js';
import { BudgetLedger } from './budget-ledger.js';
import { prepareProfile } from './accounts.js';
import { parseLimit } from './limit-detect.js';
import { OWN_ACCOUNT } from '../shared/accounts.js';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { link, lstat, open, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { closeSync, constants, constants as fsConstants, existsSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join, relative, sep, resolve } from 'node:path';
import { MAX_RECORD_COST_USD, validatePriceOverrides } from '../shared/validate.js';
import { OutputClock } from './output-clock.js';
// Fixed reasons /retry, /send and /find may return; the server passes only these through to the client.
export const AGENT_COMMAND_ERRORS = ['Retry needs a finished agent','Retry already starting','Worktree in use by a running agent','Its worktree is gone','Its folder is gone',
    'Agent has exited','Agent is open in a session','Agent is asking for permission','Agent is asking a question','Agent has not reported its status yet',
    'Agent does not accept pasted lines','Agent is printing too fast to check','Agent is running a tool','Text pasted but not sent; go inside','Agent is busy with another send','Invalid send request','Invalid find request','Worktree is busy'] as const;
interface Live {
    // v0.9.1: a queued agent's limit and how to tell the queue it was stopped at it.
    queueLimit?: QueueLimit; queueStop?: (note: string) => void; queueStopping?: boolean;
    approvedSetup?: string;
    checkpointFailed?: boolean; // gate: the last turn's checkpoint failed, so /undo says so instead of "no checkpoint" // v0.7.4: the test setup you ran with /test; later turns with the same setup run without asking
    firstMessage?: string; // v0.7.4 /fork: what it was started with (memory only: a prompt is never written to disk here)
    diffStatSeq?: number; // v0.7.1: which diff-stat count is the latest (a stale one never lands)
    info: SessionInfo;
    host?: PtyHost;
    mirror: Mirror;
    output: Promise<void>;
    mirrorFailed?:boolean;
    statusState?:StatusState;
    lastReply?:string;
    limitTimer?:ReturnType<typeof setTimeout>;
    codexRun?:CodexRun;
    pasting?:boolean;
    outputClock?:OutputClock;
    queuedBytes:number;
    paused:boolean;
    attached:boolean;
    // v0.9.3 performance pass: an attached session's output goes to its client before the mirror's write (xterm calls
    // back from a timer, ~1.2 ms of typing echo). Only while nothing is queued for the client and no attach is pending,
    // so the order of bytes never changes and a new owner's snapshot holds everything it isn't sent.
    attaching?:number; pendingEmits?:number;
    clientPaused:boolean;
    // A hook or run-state signal has arrived (not just a context report): the agent is past its startup dialogs.
    reported?:boolean;
    // AI Term's agent: the deployments its /model may switch to (bound to the key and tested).
    agentModels?:string[];
}
// Any account profile folder means accounts were made, so the default account matters (v0.6.4).
async function profilesExist(root:string):Promise<boolean>{try{await lstat(join(root,'profiles'));return true;}catch(error){if(isFsError(error,'ENOENT'))return false;throw error;}}
const TASK_UPDATE_MS=1000;
// v0.6.4: limit checks wait for output to settle, and read only the visible screen (up to 60 rows), never the scrollback.
const LIMIT_CHECK_MS=1000,LIMIT_ROWS=60;
// v0.6.3: a new engine has this long to start; a keyed summary this long to answer; an agent this long to write its note.
export const HANDOFF_NOT_STARTED="The new agent didn't start; the old one keeps running";
export const HANDOFF_NOT_STOPPED="The new agent didn't start and couldn't be stopped; stop it with s";
export const HANDOFF_NOT_STARTED_PAID="The new agent didn't start; the old one keeps running · the note's tokens were spent";
// Every handoff refusal is one of these fixed texts, so the socket can return it as written.
export class ForkError extends Error {}
export const FORK_ERRORS=['Only an AI agent can be forked',"The fork's worktree couldn't be made (the start commit may be gone); nothing started","Fork needs the agent's first message; it started without one, or before the background service restarted",'Fork needs an agent with a worktree, so the two can be compared','Pick two different agents to compare','These agents are in different repositories'] as const;
export const HANDOFF_ERRORS=[HANDOFF_NOT_STOPPED,'Handoff is off · /settings g turns it on (it spends tokens)','Only an AI agent can hand off','Handoff already running','Agent has exited','Agent is asking for permission','Agent is asking a question','Agent is running a tool','The handoff note came back empty','The handoff summary request failed','Agent exited before writing its handoff note',"The agent didn't write its handoff note in time; it keeps running",'The handoff would pass your daily budget','The handoff would pass your weekly budget','The handoff would pass your monthly budget','Budget check unavailable; try again',HANDOFF_NOT_STARTED,HANDOFF_NOT_STARTED_PAID,"Agent hasn't started yet",'The summary writer changed; run /handoff again','Agent exited before the handoff finished','Agent is still working · hand off when it is done',"Agent hit its limit and can't write the note · add an API key for the summary",'Agent is being handed off'];
const HANDOFF_SUMMARY_MS=120_000,HANDOFF_REPLY_MS=300_000;
function sameWriter(approved:HandoffWriter,writer:import('./handoff.js').KeyedWriter|null):boolean{return approved.kind==='agent'?writer===null:writer!==null&&approved.provider===writer.key.provider&&approved.model===writer.model&&approved.last4===writer.key.last4;}
export class SessionManager extends EventEmitter {
    // /send: how long Enter waits behind the paste (static so a test can widen the window it races).
    static sendEnterDelayMs = 50;
    // v0.6.3: how long a handed-off agent has to start (a test shortens it).
    static handoffStartMs = 30_000;
    // B26: the sandbox auto-test runs under (a test points it at a missing file to see the no-sandbox path).
    // null: the system's own (sandbox-exec on macOS, bwrap on Linux).
    static sandboxExec: string | null = null;
    // v1.1 o and s on a made file; tests replace the opener and the Downloads folder.
    static fileOpener: ((path: string) => Promise<void>) | null = null;
    static downloads: string | null = null;
    private secretTimers=new Map<string,ReturnType<typeof setTimeout>>();
    // v0.9.2: dev servers, and each worktree's port (kept while the daemon runs).
    private readonly dev=new DevServers({error:(text:string)=>this.log.error(text)});
    private readonly devPorts=new Map<string,number>();
    private readonly devStarting=new Set<string>();
    private sessions = new Map<string, Live>();
    private size = { cols: 85, rows: 30 };
    private saving: Promise<void> = Promise.resolve();
    private closing = false;
    private shutDown = false;
    private warnings = new Map<string, string>();
    // B24's one homepage note, sent after each sessions.list for this daemon's lifetime.
    notice: string | null = null;
    private resuming=new Set<string>();
    private retrying=new Set<string>();
    private sending=new Set<string>();
    // Worktrees AI Term created, by path. A record outlives its agent and goes only when its worktree is deleted.
    private worktreeRecords=new Map<string,WorktreeRecord>();
    private busyWorktrees=new Set<string>();
    readonly mcp:McpService;
    readonly addons:AddonService;
    // B25 (v0.6.1): every AI Term agent's in-flight worst cases, checked against the budgets before any request is sent.
    private readonly ledger?:BudgetLedger;
    private readonly taskTimers=new Map<string,ReturnType<typeof setTimeout>>();
    // v0.6.3: how handoff summaries are written (tests swap the model call), and sources being handed off right now.
    private handoffWriter:{prices:PriceSnapshot;summarize:Summarize}={prices:PRICES,summarize:summarizeWithKey};
    private readonly handingOff=new Set<string>();
    // Bookings of exited agents' held requests still writing; shutdown waits for them before closing the ledger.
    private readonly releases=new Set<Promise<void>>();
    // For tests: the worst case the last keyed handoff summary held.
    lastHandoffWorst=0;
    private taskDirty=false;
    private onLogFailure = () => this.warning('log', 'Log could not be saved; agents keep running.');
    private onLogRecovery = () => this.clearWarning('log');
    constructor(private readonly paths: Paths, private readonly log: Logger, private readonly recipe?: SpawnRecipe, private readonly childUmask?: number, private readonly writeState = atomicWrite, private readonly keys = new KeyStore(paths.root), private readonly usage?:UsageService,private readonly cliEntry=fileURLToPath(new URL('../cli/index.js',import.meta.url))) {
        super();this.mcp=new McpService(new SettingsStore(paths.root),keys,log);
        this.addons=new AddonService(paths.root,resolve(dirname(cliEntry),'..','..','addons'),this,async(target,input,output)=>{
            if(target.auth.kind!=='key'||!target.model)return null;
            const settings=await new SettingsStore(paths.root).get(),key=await keys.view(target.auth.keyId),price=findPrice(this.handoffWriter.prices,key.provider,target.model,overridesFor(settings,key.provider),deploymentAlias(settings,target.model));
            if(!price)return null;
            return {low:estimateCost(price,input.low,output.low)??0,high:estimateCost(price,input.high,output.high)??0};
        },text=>log.error(text));
        if(usage){this.ledger=new BudgetLedger({file:join(paths.root,'budget-reservations.json'),book:reservation=>usage.book(reservation),log,warn:(key,text)=>{if(text)this.warning(`budget-${key}`,text);else this.clearWarning(`budget-${key}`);},busy:id=>{const live=this.sessions.get(id);return !!live&&(live.info.status==='waiting'||(live.statusState?.toolsInFlight??0)>0);}});usage.on('record',(record:UsageRecord)=>this.addTask(record.sessionId,record.inputTokens+record.outputTokens,record.costUsd));usage.on('task',(id:string,tokens:number)=>this.addTask(id,tokens,undefined));}usage?.on('claude-status',(id:string,raw:unknown,seq:number)=>this.ingressStatus(id,parseClaudeStatus(raw,seq,new Date().toISOString())));usage?.on('codex-status',(id:string,raw:unknown,seq:number)=>this.ingressStatus(id,parseCodexStatus(raw,seq,new Date().toISOString())));usage?.on('ai-term-status',(id:string,raw:unknown,seq:number)=>this.ingressAgentStatus(id,parseAgentStatus(raw,seq,new Date().toISOString())));usage?.setAgentQuery((id,body)=>this.agentQuery(id,body));keys.on('warning',()=>this.keyMetadataWarning());usage?.on('settingsWarning',(on:boolean)=>{if(on)this.warning('usage-settings','Settings could not be read; usage uses last good prices.');else this.clearWarning('usage-settings');});usage?.on('warning',(on:boolean)=>{if(on)this.warning('usage','Usage could not be saved; agents keep running.');else this.clearWarning('usage');}); log.on('writeFailed', this.onLogFailure); log.on('writeRecovered', this.onLogRecovery);
    }
    keyMetadataWarning():void{this.warning('key-metadata','Invalid key metadata entry skipped; other keys remain usable.');}
    warningText(): string | null { return this.warnings.size ? [...this.warnings.values()].join(' ') : null; }
    private warning(source: string, text: string): void {
        if (this.warnings.get(source) === text) return;
        this.warnings.set(source, text); this.event({ kind: 'daemon.warning', text: this.warningText() ?? '' });
    }
    private clearWarning(source: string): void {
        if (!this.warnings.delete(source)) return;
        const text = this.warningText(); this.event(text ? { kind: 'daemon.warning', text } : { kind: 'daemon.warningCleared' });
    }
    async load(): Promise<void> {
        await this.loadSessions();
        await this.ledger?.load();
    }
    private async loadSessions(): Promise<void> {
        let loaded: { sessions: SessionInfo[]; worktrees: Map<string, WorktreeRecord>; rejected?: number };
        try {
            loaded = await this.readSaved();
            // An invalid worktree record is skipped, and the next save would erase it: keep the file as it was first.
            if (loaded.rejected) {
                this.log.error(`Worktree records skipped: ${loaded.rejected}; keeping a copy of the agent list`);
                try { this.notice = `couldn't read part of your agent list; saved it as ${await keepCopy(this.paths.state)}`; }
                catch { this.log.error('Agent list copy failed; skipped worktree records will not be saved'); }
            }
        }
        catch (error) {
            // B24: an agent list that can't be loaded is never overwritten. It is moved aside and the daemon starts empty.
            // Only the fixed stage is logged: the raw error and the file can carry prompts, titles and paths.
            const stage = error instanceof StateLoadError ? error.stage : 'migrate';
            this.log.error(`Agent list could not be loaded (${stage}); moving it aside and starting empty`);
            let aside: Awaited<ReturnType<typeof moveAside>>;
            try { aside = await moveAside(this.paths.state); }
            catch {
                this.log.error('Agent list could not be moved aside; left untouched and not overwritten');
                throw new Error('Agent list unreadable and not moved aside');
            }
            if (!aside.private) this.log.error('Moved-aside agent list could not be made private');
            loaded = { sessions: [], worktrees: new Map() };
            this.notice = `couldn't read your agent list; saved it as ${aside.path}`;
        }
        for (const info of loaded.sessions)
            this.sessions.set(info.id, { info, mirror: new Mirror(this.size.cols, this.size.rows, () => { }), queuedBytes:0, attached:false,clientPaused:false, paused:false, output: Promise.resolve() });
        for (const [path, record] of loaded.worktrees) this.worktreeRecords.set(path, record);
        await this.persist();
    }
    // Each stage throws StateLoadError with its fixed name and nothing else.
    private async readSaved(): Promise<{ sessions: SessionInfo[]; worktrees: Map<string, WorktreeRecord>; rejected: number }> {
        let state: unknown;
        try { state = await readState(this.paths.state); }
        catch (error) { throw new StateLoadError(error instanceof SyntaxError ? 'parse' : 'read'); }
        let saved: { sessions: SessionInfo[]; worktrees: unknown[] };
        try { saved = this.validateState(state); }
        catch { throw new StateLoadError('validate'); }
        try { return this.migrateState(saved); }
        catch { throw new StateLoadError('migrate'); }
    }
    private validateState(state: unknown): { sessions: SessionInfo[]; worktrees: unknown[] } {
        if (!state || typeof state !== 'object' || !('sessions' in state) || !Array.isArray(state.sessions) || 'worktrees' in state && !Array.isArray(state.worktrees))
            throw new Error('Invalid daemon state');
        const sessions: SessionInfo[] = [];
        for (const raw of state.sessions as unknown[]) {
            if (!raw || typeof raw !== 'object')
                throw new Error('Invalid session record');
            const r = raw as Record<string, unknown>;
            if (!isUUID(r.id) || !isTitle(r.title) || !['shell','claude-code','codex','ai-term'].includes(String(r.engine)) || typeof r.cwd !== 'string' || typeof r.createdAt !== 'string')
                throw new Error('Invalid session record');
            const saved = validateSession(r);
            sessions.push({ id: saved.id, title: saved.title, engine: saved.engine, model: saved.model, auth: saved.auth, cwd: saved.cwd, permission: saved.permission, status: saved.status, statusDetail: saved.statusDetail, statusSince: saved.statusSince, exitCode: saved.exitCode, createdAt: saved.createdAt, lastOutputAt: saved.lastOutputAt, ctxPercent: saved.ctxPercent,lastActivity:saved.lastActivity??null, ...(saved.authMethod ? {authMethod:saved.authMethod} : {}), ...(saved.effort!==undefined?{effort:saved.effort}:{}), ...(saved.conversationId?{conversationId:saved.conversationId}:{}), ...(saved.worktree?{worktree:saved.worktree,branch:saved.branch}:{}), ...(saved.worktreeNote?{worktreeNote:saved.worktreeNote}:{}), ...(saved.login?{login:true as const}:{}), ...(saved.taskUsage?{taskUsage:saved.taskUsage}:{}),...(saved.handoffTo?{handoffTo:saved.handoffTo}:{}),...(saved.diffStat?{diffStat:saved.diffStat}:{}) });
        }
        return { sessions, worktrees: 'worktrees' in state && Array.isArray(state.worktrees) ? state.worktrees as unknown[] : [] };
    }
    private migrateState(saved: { sessions: SessionInfo[]; worktrees: unknown[] }): { sessions: SessionInfo[]; worktrees: Map<string, WorktreeRecord>; rejected: number } {
        const now = new Date().toISOString(), worktrees = new Map<string, WorktreeRecord>();
        let rejected = 0;
        const sessions = saved.sessions.map(info => ['exited','error'].includes(info.status) ? info : { ...info, status: 'exited' as const, statusDetail: 'background service restarted', statusSince: now, exitCode: null });
        for (const entry of saved.worktrees) {
            try { const record = validateWorktreeRecord(entry); worktrees.set(record.path, record); }
            catch { rejected++; this.log.error('Invalid worktree record skipped; that worktree is kept'); }
        }
        // v0.3.1 kept worktree metadata only on session records; those become records without repo or base.
        for (const info of sessions)
            if (info.worktree && info.branch && !worktrees.has(info.worktree)) worktrees.set(info.worktree, { path: info.worktree, branch: info.branch, createdAt: info.createdAt });
        return { sessions, worktrees, rejected };
    }
    list(): SessionInfo[] { return [...this.sessions.values()].map(s => ({ ...s.info })); }
    get(id: string): SessionInfo { const live = this.sessions.get(id); if (!live)
        throw new Error('Session not found'); return { ...live.info }; }
    previewDimensions(): {
        cols: number;
        rows: number;
    } { return { ...this.size }; }
    // Live PTY children only; the This Mac sampler sums each one's process tree.
    sessionRoots(): { sessionId: string; pid: number }[] { return [...this.sessions.values()].flatMap(s => s.host && !['exited', 'error'].includes(s.info.status) ? [{ sessionId: s.info.id, pid: s.host.pty.pid }] : []); }
    activeCount(): number { return this.list().filter(s => !['exited','error'].includes(s.status)).length; }
    private event(event: SessionEvent): void { this.emit('event', event); }
    private persist(): Promise<void> {
        // After shutdown's last write nothing else may land: a PTY can still deliver data or its exit late.
        if (this.shutDown) return this.saving;
        const data = { sessions: [...this.sessions.values()].map(s => ({ ...s.info, dev: undefined, pid: s.host?.pty.pid ?? null, recipe: { engine: s.info.engine, model: s.info.model, auth: s.info.auth.kind==='key'?{kind:'key',keyId:s.info.auth.keyId}:{ kind: 'account' }, cwd: s.info.cwd, permission: s.info.permission, ...(s.info.effort!==undefined?{effort:s.info.effort}:{}), ...(s.info.conversationId?{conversationId:s.info.conversationId}:{}) } })), worktrees: [...this.worktreeRecords.values()] };
        this.saving = this.saving.then(async () => {
            try { await this.writeState(this.paths.state, data); }
            catch {
                this.warning('state', 'Session state could not be saved; agents keep running.');
                this.log.error('State write failed; will retry on the next change');
                return;
            }
            this.clearWarning('state');
        });
        return this.saving;
    }
    async resume(id:string):Promise<SessionInfo>{
        const saved=this.get(id);
        if(!['exited','error'].includes(saved.status))throw new Error('Resume needs a finished agent');
        if(saved.engine==='shell')throw new Error('A shell has no AI conversation to resume');
        if(saved.engine==='ai-term')throw new Error("AI Term agent can't resume yet; /retry starts it fresh");
        if(saved.engine==='claude-code'&&!saved.conversationId)throw new Error('This older Claude agent has no conversation ID');
        if(saved.conversationId&&this.list().some(s=>s.conversationId===saved.conversationId&&!['exited','error'].includes(s.status)))throw new Error('Conversation already running');
        const identity=saved.conversationId??saved.id;if(this.resuming.has(identity))throw new Error('Conversation already starting');
        // A finished agent restarts on the account it ran on, not on whatever is the default now.
            const auth=saved.auth.kind==='key'?{kind:'key' as const,keyId:saved.auth.keyId}:{kind:'account' as const,profile:saved.auth.profile??OWN_ACCOUNT};
        // A resume and a delete of one worktree exclude each other until the other has finished.
        if(saved.worktree&&this.busyWorktrees.has(saved.worktree))throw new Error('Worktree is busy');
        this.resuming.add(identity);if(saved.worktree)this.busyWorktrees.add(saved.worktree);
        try{return await this.create({engine:saved.engine,model:saved.model,effort:saved.effort??null,auth,cwd:saved.cwd,permission:saved.permission,title:saved.title},{resume:true,...(saved.conversationId?{conversationId:saved.conversationId}:{}), ...(saved.worktree?{worktree:saved.worktree,branch:saved.branch}:{})});}finally{this.resuming.delete(identity);if(saved.worktree)this.busyWorktrees.delete(saved.worktree);}
    }
    // /retry: the same engine, model, auth, effort, mode and folder (its worktree too, if it still exists), started fresh:
    // no conversation is resumed and no first message is resent, because AI Term never keeps one. The new agent replaces
    // the old record; the worktree record is untouched.
    async retry(id:string):Promise<SessionInfo>{
        const saved=this.get(id);
        if(!['exited','error'].includes(saved.status))throw new Error('Retry needs a finished agent');
        if(this.retrying.has(id))throw new Error('Retry already starting');
        if(saved.worktree&&this.busyWorktrees.has(saved.worktree))throw new Error('Worktree is busy');
        // Both flags are taken before the first await, so a second retry or a delete arriving meanwhile is refused.
        this.retrying.add(id);if(saved.worktree)this.busyWorktrees.add(saved.worktree);
        let next:SessionInfo;
        try{
            if(saved.worktree){
                if(this.list().some(s=>s.worktree===saved.worktree&&!['exited','error'].includes(s.status)))throw new Error('Worktree in use by a running agent');
                if(!this.worktreeRecords.has(saved.worktree)||!(await validCwd(saved.cwd)))throw new Error('Its worktree is gone');
            }else if(!(await validCwd(saved.cwd)))throw new Error('Its folder is gone');
            // A finished agent restarts on the account it ran on, not on whatever is the default now.
            const auth=saved.auth.kind==='key'?{kind:'key' as const,keyId:saved.auth.keyId}:{kind:'account' as const,profile:saved.auth.profile??OWN_ACCOUNT};
            // A login session retries as the same login; an empty continuation keeps an agent that ran in place there.
            next=await this.create(saved.engine==='shell'?{cwd:saved.cwd,title:saved.title}:saved.login?{engine:saved.engine,model:null,auth:{kind:'account',profile:saved.auth.kind==='account'?saved.auth.profile??OWN_ACCOUNT:OWN_ACCOUNT},cwd:saved.cwd,permission:'ask',login:true,title:saved.title}:{engine:saved.engine,model:saved.model,effort:saved.effort??null,auth,cwd:saved.cwd,permission:saved.permission,title:saved.title},saved.worktree?{worktree:saved.worktree,branch:saved.branch}:{});
        }finally{this.retrying.delete(id);if(saved.worktree)this.busyWorktrees.delete(saved.worktree);}
        try{await this.remove(id);}catch{this.log.error('Retried agent: old record could not be removed');}
        return next;
    }
    async create(request: CreateSession | { cwd: string; title?: string }, continuation?:{resume?:boolean;conversationId?:string;worktree?:string;branch?:string}, fork?:{startCommit:string}, addon?:AddonRunOptions, strictIsolation=false): Promise<SessionInfo> {
        const cwdValid=await validCwd(request.cwd);
        if (this.closing || !cwdValid || (request.title !== undefined && !isTitle(request.title)))
            throw new Error('Invalid session request');
        const agent = 'engine' in request && request.engine !== 'shell' ? await this.route(request) : null;
        if(addon&&(!agent||agent.permission!=='ask'||agent.login))throw new Error('Invalid add-on arguments');
        // v0.8.1: AI Term's agent runs in Don't ask only where its bash is sandboxed; elsewhere the start is refused with why.
        if (agent?.engine === 'ai-term' && agent.permission === 'dontAsk') { const note = dontAskNote(await currentAgentSandbox()); if (note) throw new Error(note); }
        // Read once per start: AI Term's agent takes the theme, and worktrees decide isolation below. Unreadable settings
        // keep the defaults (ask, worktrees on, keys on AI Term's agent).
        let settings: Settings | null = null;
        let settingsFailed = false;
        if (agent) { try { settings = await new SettingsStore(this.paths.root).get(); } catch { settingsFailed = true; this.log.error('Settings unreadable; new agents keep their worktrees'); } }
        // v0.6.4 (D53): an account agent runs on the profile it names, else the engine's default account, else your normal
        // login (`own`). A profile must exist for that engine; its folder is made private before the CLI sees it.
        let profile:string|undefined,profilePath:string|undefined;
        if(agent&&agent.engine!=='ai-term'&&agent.auth.kind==='account'){
            // Without settings the default account is unknown: guessing your normal login could bill the wrong account.
            if(settingsFailed&&agent.auth.profile!==OWN_ACCOUNT&&await profilesExist(this.paths.root))throw new Error("Settings unreadable; can't tell which account to use");
            const choice=agent.auth.profile??settings?.defaultAccounts?.[agent.engine];
            if(choice&&choice!==OWN_ACCOUNT){
                if(!(settings?.accounts??[]).some(a=>a.name===choice&&a.engine===agent.engine))throw new Error('Account not found for this engine');
                profile=choice;profilePath=await prepareProfile(this.paths.root,agent.engine,choice,homedir());
            }
        }
        // B30: only an explicit setting/choice loads the small index; logins and resumes never receive it.
        const preferences = agent && !agent.login && !continuation?.resume ? await this.brainPreferences(request.cwd,settings??{theme:'graphite'}) : { agents: false, trusted: false };
        const brain=agent&&!agent.login&&!continuation?.resume&&(agent.brain??agent.brainMention??preferences.agents)?await this.brainFor(request.cwd,preferences.trusted):null;
        const conversationId=agent?.engine==='claude-code'&&!agent.login?(continuation?.conversationId??randomUUID()):undefined;
        // Status is not billing: subscription and key sessions both report it. Login sessions only sign in.
        const withStatus=Boolean(agent&&!agent.login&&this.usage);
        const codexStatus=withStatus&&agent?.engine==='codex'?{node:process.execPath,entry:this.cliEntry,...(this.cliEntry.endsWith('.ts')?{loader:createRequire(import.meta.url).resolve('tsx')}:{})}:undefined;
        const mentioned=brain&&agent?.engine==='codex'?{firstMessage:brainMention(brain.file,agent.firstMessage??'')}:{};
        const argvRequest=agent?{...agent,...mentioned,...(conversationId?{conversationId}:{}),...(continuation?.resume?{resume:true}:{}),...(codexStatus?{codexStatus}:{}),...(brain&&agent.engine==='claude-code'?{brainFile:brain.file}:{}),...(addon?{addon}:{})}:null;
        let recipe: SpawnRecipe;
        let authMethod: SessionInfo['authMethod'];
        let agentKey: {view:KeyView;models:string[]}|undefined;
        if (agent?.engine === 'ai-term') {
            // AI Term's agent is this program: no engine check or login. Only a key it supports, and a tested deployment.
            if(agent.auth.kind!=='key')throw new KeyError('AI Term agent needs an API key');
            const key=await this.keys.view(agent.auth.keyId);
            if(!AGENT_PROVIDERS.includes(key.provider))throw new KeyError("AI Term agent can't use this key yet");
            // Foundry: deployments whose test found a wire (Responses or Chat Completions, D30). Anthropic and OpenAI: the
            // catalog's chat models, plus a valid model id typed in /model.
            // v0.6.5 providers: the key's own models whose tiny test request (Ollama: its listing) succeeded.
            const catalog=key.provider==='anthropic'||key.provider==='openai'?key.provider:null;
            const models=key.provider==='foundry'?(key.deployments??[]).filter(model=>deploymentWire(key.lastTest?.find(r=>r.model===model))!==null):catalog?[...new Set([...catalogModels(catalog),...(agent.model?[agent.model]:[])])]:testedModels(key);
            if(!agent.model||!models.includes(agent.model))throw new KeyError(key.provider==='foundry'?'Foundry deployment must pass its test first':catalog?'Pick a model for AI Term agent':'Model must pass its test first; test the key in /settings (t)');
            agentKey={view:key,models};authMethod='api-key';
            recipe={executable:process.execPath,args:[],env:{}};
        } else if (agent) {
            const engine=agent.engine;
            const status = await checkEngine(engine,process.env,undefined,profilePath);
            if (!status.installed || !status.path) throw new Error(`${agent.engine === 'codex' ? 'codex' : 'claude'} not found in PATH`);
            if(addon&&engine==='claude-code')await checkAddonCli(status.path,addon.readOnly);
            if(addon?.mcp)await checkReverseCli(engine,status.path);
            if (agent.auth.kind==='account' && !agent.login && status.loggedIn !== true) throw new Error(status.loggedIn === false ? 'Engine is not logged in' : 'Engine login status unavailable');
            if(addon&&agent.auth.kind==='account'&&status.authMethod!=='subscription')throw new Error('Add-on CLI runs require a confirmed subscription login');
            authMethod = status.authMethod;
            if(agent.auth.kind==='key'){
                const key=await this.keys.view(agent.auth.keyId);
                // Routing already sends every other provider to AI Term's agent; this is the second guard (v0.6.5).
                if(!CLI_KEY_PROVIDERS.includes(key.provider)||engine==='claude-code'&&key.provider!=='anthropic'||engine==='codex'&&key.provider==='anthropic')throw new KeyError('Key provider does not match engine');
                if(key.provider==='foundry'&&(!agent.model||!key.deployments?.includes(agent.model)||!key.lastTest?.some(r=>r.model===agent.model&&r.status==='ready')))throw new KeyError('Foundry deployment must pass its test first');
                authMethod='api-key';
                recipe={executable:status.path,args:buildArgs({...agent,...argvRequest,engine,...(key.provider==='foundry'?{foundryEndpoint:key.endpoint}:{}),...(key.provider==='openai'?{openaiKey:true}:{})}),env:{}};
            }else recipe = { executable: status.path, args: agent.login ? (engine==='codex'?['--no-daemon','-c','check_for_update_on_startup=false','login']:['auth','login']) : buildArgs({...agent,...argvRequest,engine}), env: buildSpawnEnv(engine, {kind:'account'}, process.env, {keepElectronNode:electronNodeNeeded(process.execPath,process.versions.electron),...(profilePath?{profileDir:profilePath}:{})}) };
            // Windows (v0.8.2): an npm .cmd launcher becomes node + its script, the arguments still an array (win-launch.ts).
            recipe = { ...recipe, ...await windowsRecipe({ executable: recipe.executable, args: recipe.args }, process.env.PATH ?? '') };
        } else recipe = this.recipe ? {executable:this.recipe.executable,args:[...this.recipe.args],env:{...this.recipe.env}} : process.platform==='win32' ? { executable: windowsShell(process.env, existsSync), args: [], env: buildShellEnv(process.env) } : { executable: process.env.SHELL || '/bin/zsh', args: ['-l'], env: buildShellEnv(process.env) };
        const keyView=agent?.auth.kind==='key'?await this.keys.view(agent.auth.keyId):null;
        const now = new Date().toISOString();
        const info: SessionInfo = { id: randomUUID(), title: request.title ?? (agent ? engineTitle(agent.engine) : 'shell'), engine: agent?.engine ?? 'shell', model: agent ? agent.model : 'shell', ...(agent&&!agent.login?{effort:agent.effort??null}:{}), ...(agent?.login?{login:true as const}:{}), ...(conversationId?{conversationId}:{}), auth: keyView?{kind:'key',keyId:keyView.id,provider:keyView.provider,keyLabel:keyView.label,last4:keyView.last4}:{ kind: 'account',...(profile?{profile}:{}) }, cwd: request.cwd, permission: agent?.permission ?? 'ask', ...(authMethod ? {authMethod} : {}), status: 'starting', statusDetail: 'starting', statusSince: now, exitCode: null, createdAt: now, lastOutputAt: null, ctxPercent: null,lastActivity:null };
        if(brain)info.brain={builtAt:brain.builtAt};
        if(continuation?.worktree){info.worktree=continuation.worktree;info.branch=continuation.branch;}
        else if(agent&&!agent.login&&!continuation){
            const forkWorktree=fork!==undefined;
            // Isolation is the default: settings that can't be read keep it on rather than quietly turning it off.
            // v0.6.2: a preset's own worktree choice wins for this one agent.
            const isolate='useWorktree' in request&&request.useWorktree!==undefined?request.useWorktree:settings?.worktrees!=='off';
            if(isolate){
                try {
                    const {repo,baseBranch,baseCommit,...start}=await prepareWorktree(this.paths.root,request.cwd,info.title,text=>this.log.error(text),fork?.startCommit);Object.assign(info,start);
                    if(start.worktree&&start.branch&&repo)this.worktreeRecords.set(start.worktree,{path:start.worktree,branch:start.branch,repo,...(baseBranch?{baseBranch}:{}),...(baseCommit?{baseCommit}:{}),createdAt:now});
                } catch { info.worktreeNote='worktree off: git check failed'; }
            }
            // Not a repo and no commits are the user's situation; anything else lost isolation by failing, so it's an error.
            if(info.worktreeNote)(['worktree off: not a git repo','worktree off: repo has no commits'].includes(info.worktreeNote)?this.log.info:this.log.error).call(this.log,info.worktreeNote);
            // v0.7.4: a fork runs in its own worktree or not at all (never in your checkout).
            if(forkWorktree&&!info.worktree)throw new ForkError("The fork's worktree couldn't be made (the start commit may be gone); nothing started");
        }
        if((strictIsolation||addon&&!addon.readOnly)&&!info.worktree)throw new Error('Add-on worktree could not be made; nothing started');
        const statusTelemetry=withStatus&&agent?this.usage?.registerStatus(info.id,agent.engine):undefined;
        // Usage counts API-key sessions (D27). Cost per task (v0.6.1, D55, on by default) also asks a subscription or
        // unknown-auth CLI for its usage, but only for its own token total: never Usage, a budget or a price.
        const counted=agent&&!agent.login&&this.usage?(authMethod==='api-key'?'usage':agent.engine!=='ai-term'&&(settings?.taskCost!==false||addon||strictIsolation)?'task':null):null;
        const telemetry=counted&&agent&&this.usage?this.usage.register({sessionId:info.id,engine:agent.engine,provider:keyView?.provider??(agent.engine==='claude-code'?'anthropic':'openai'),model:agent.model,...(counted==='task'?{taskOnly:true}:{})}):undefined;
        const cliEngine=agent&&agent.engine!=='ai-term'?agent.engine:null;
        // AI Term's agent gets its usage credential through buildAgentEnv at spawn; the CLIs through their own settings here.
        if(telemetry&&cliEngine){const extra=buildUsageArgs(cliEngine,telemetry),delimiter=recipe.args.indexOf('--');if(delimiter>=0)recipe.args.splice(delimiter,0,...extra);else recipe.args.push(...extra);Object.assign(recipe.env,buildUsageEnv(cliEngine,telemetry));}
        const replies = new ReplyBudget();
        let dropping = false;
        const reply = (data: string) => {
            if (replies.take(Buffer.byteLength(data))) { dropping = false; live.host?.write(data); return; }
            if (!dropping) this.log.error(`Dropped terminal query replies over budget for session ${info.id}`);
            dropping = true;
        };
        const live: Live = { info,...(statusTelemetry?{statusState:initialStatus(now)}:{}), mirror: new Mirror(this.size.cols, this.size.rows, reply, agent?.engine==='codex'?signal=>this.codexSignal(live,signal):undefined), queuedBytes:0, attached:false,clientPaused:false, paused:false, output: Promise.resolve() };
        // Fresh lastOutputAt for the homepage's quiet timer; never persisted, and silent once the session ended.
        live.outputClock=new OutputClock(()=>{if(!['exited','error'].includes(info.status))this.event({kind:'session.updated',session:{...info}});});
        if(agent?.firstMessage!==undefined)live.firstMessage=agent.firstMessage;
        this.sessions.set(info.id, live);
        // v1.0.7 /reverse on AI Term's agent: its own MCP list (REA alone), there before the agent first asks for it, and
        // gone again if the start fails (review).
        if(addon?.mcp&&agent?.engine==='ai-term')this.mcp.session(info.id,addon.mcp);
        try {
            if(statusTelemetry&&agent?.engine==='codex'){
                Object.assign(recipe.env,buildStatusEnv(statusTelemetry));
                if(!recipe.args.some(arg=>arg.startsWith('notify=')))this.log.error('Codex notify left off: node or ai path has characters outside the safe set; done and last reply need it');
            }
            if(statusTelemetry&&agent?.engine==='claude-code'){
                const settings=await writeClaudeSettings(this.paths.root,info.id,statusTelemetry.port,process.execPath,this.cliEntry);
                if(!claudeStatusLine(process.execPath,this.cliEntry))this.log.error('Claude status line left off: node or ai path has characters outside the safe set; context % needs it');
                const extra=buildStatusArgs(settings),delimiter=recipe.args.indexOf('--');if(delimiter>=0)recipe.args.splice(delimiter,0,...extra);else recipe.args.push(...extra);
                Object.assign(recipe.env,buildStatusEnv(statusTelemetry));
            }
            const transcript=agent?.engine==='ai-term'?await agentTranscript(this.paths.root,info.id):null;
            // The repository a worktree shares its .git with: its hooks and config are kept out of the agent's bash (fix review).
            let gitCommon:string|undefined;
            const gitRepo=agent?.engine==='ai-term'&&info.worktree?this.worktreeRecords.get(info.worktree)?.repo:undefined;
            if(gitRepo)try{gitCommon=await repoCommonDir(gitRepo);}catch{this.log.error('Agent sandbox: the repository\'s git folder is unknown; its hooks are not protected');}
            if(agent?.engine==='ai-term'&&agent.auth.kind==='key'){const spawnAgent=(secret:string|null,binding:FoundryBinding|null)=>{
                // B12: only the Keychain's bound endpoint and deployments decide where the key goes and which models it may run
                // (Foundry, Bedrock). Fixed-host providers' hosts are in the agent's code; Ollama's endpoint is local only.
                const provider=agentKey?.view.provider,bound=provider!==undefined&&isBoundProvider(provider),model=agent.model,models=(agentKey?.models??[]).filter(id=>!bound||binding?.deployments.includes(id));
                if(bound&&!binding||!model||!models.includes(model)||!transcript||!agentKey)throw new KeyError(provider==='bedrock'?'Bedrock key details changed outside AI Term; add the key again':'Foundry key details changed outside AI Term; add the key again');
                const endpoint=bound&&binding?binding.endpoint:provider==='ollama'&&isLocalEndpoint(agentKey.view.endpoint)?agentKey.view.endpoint:null;
                live.agentModels=models;
                const command={node:process.execPath,entry:this.cliEntry,...(this.cliEntry.endsWith('.ts')?{loader:createRequire(import.meta.url).resolve('tsx')}:{})};
                const built=buildAgentArgs({command,provider:agentKey.view.provider,model,models,permission:agent.permission,theme:settings?.theme??'graphite',transcript,lsp:settings?.lspDiagnostics===true,...(brain?{brainFile:brain.file}:{}),...(addon?{addon}:{}),...(agent.firstMessage!==undefined?{firstMessage:agent.firstMessage}:{})});
                const file=join(dirname(transcript),'agent-secrets.json'),split=splitAgentSecrets(buildAgentEnv(process.env,{secret,endpoint,...(statusTelemetry?{status:statusTelemetry}:{}),...(telemetry?{usage:telemetry}:{}),entry:this.cliEntry}),file,this.paths.root);
                writeAgentSecrets(file,split.secrets);
                // An agent that never started leaves no secret behind for long; a restart's newer file keeps its own timer.
                clearTimeout(this.secretTimers.get(file));
                this.secretTimers.set(file,setTimeout(()=>{this.secretTimers.delete(file);try{unlinkSync(file);}catch(error){if(!isFsError(error,'ENOENT'))this.log.error('Agent secrets file could not be removed');}},AGENT_SECRETS_TTL_MS).unref());
                recipe={executable:built.executable,args:built.args,env:{...split.env,...(gitCommon?{AITERM_GIT_COMMON:gitCommon}:{})}};
                try{live.host=new PtyHost(recipe,info.cwd,this.size.cols,this.size.rows,this.childUmask);}finally{recipe.env={};}
            };
                // Ollama has no key: nothing is read from the Keychain for it.
                if(agentKey?.view.provider==='ollama')spawnAgent(null,null);else await this.keys.withSecret(agent.auth.keyId,spawnAgent);
            }
            else if(agent&&cliEngine&&agent.auth.kind==='key') await this.keys.withSecret(agent.auth.keyId,(secret,binding)=>{
                // B12: argv was built from settings.json's copy; the secret goes only to the endpoint bound to it in the Keychain.
                if(keyView?.provider==='foundry'&&(!binding||!recipe.args.includes(`model_providers.aiterm_foundry.base_url="${binding.endpoint}"`)||!agent.model||!binding.deployments.includes(agent.model)))throw new KeyError('Foundry key details changed outside AI Term; add the key again');
                recipe.env=buildSpawnEnv(cliEngine,{kind:'key',secret,...(keyView?.provider==='openai'?{provider:'openai' as const}:{})},process.env,{keepElectronNode:electronNodeNeeded(process.execPath,process.versions.electron)});
                if(telemetry)Object.assign(recipe.env,buildUsageEnv(cliEngine,telemetry));
                if(statusTelemetry)Object.assign(recipe.env,buildStatusEnv(statusTelemetry));
                try{live.host=new PtyHost(recipe,info.cwd,this.size.cols,this.size.rows,this.childUmask);}finally{recipe.env={};}
            });
            else live.host = new PtyHost(recipe, info.cwd, this.size.cols, this.size.rows, this.childUmask);
            const host=live.host;if(!host)throw new Error('Spawn did not return a PTY');
            host.pty.onData(data => {
                if(live.mirrorFailed)return;
                const bytes=Buffer.byteLength(data);live.queuedBytes+=bytes;
                this.updatePause(live);
                const direct=live.attached&&!live.attaching&&!live.pendingEmits,chunk=Buffer.from(data);
                if(direct)this.emit('ownerOutput',info.id,chunk);else live.pendingEmits=(live.pendingEmits??0)+1;
                live.output = live.output.then(async () => {
                    if(live.mirrorFailed)return;
                    await live.mirror.write(data);
                    this.scheduleLimitCheck(live);
                    info.lastOutputAt = new Date().toISOString();
                    if (info.status === 'starting'&&(!live.statusState||live.statusState.status==='starting')) {
                        // PTY output is not an ingress event: preserve its sequence while making the same startup transition in both records.
                        if(live.statusState)live.statusState={...live.statusState,status:'running',statusDetail:'running',statusSince:info.lastOutputAt};
                        info.status = 'running';
                        info.statusDetail = 'running';
                        info.statusSince = info.lastOutputAt;
                        await this.persist();
                        this.event({ kind: 'session.updated', session: { ...info } });
                        live.outputClock?.sent();
                    } else live.outputClock?.output();
                    this.emit('output', info.id, chunk, direct);
                }).catch(async () => {
                    if(live.mirrorFailed)return;
                    live.mirrorFailed=true;this.usage?.revoke(info.id);live.outputClock?.dispose();
                    info.status='error';info.statusDetail='terminal mirror failed';info.exitCode=null;info.statusSince=new Date().toISOString();
                    this.log.error('Session terminal mirror failed');
                    await this.persist();this.event({kind:'session.updated',session:{...info}});
                    // Stop the failed child without waiting on live.output, which is this very task.
                    try{await host.stop();}catch{this.log.error('Failed to stop session after terminal mirror failure');}
                }).finally(()=>{
                    // Only once its emit is done (review: the first chunk waits on a state save first, and the next one
                    // must not go ahead of it on the direct path), and on every way out, failures included.
                    if(!direct)live.pendingEmits=(live.pendingEmits??1)-1;
                    live.queuedBytes-=bytes;
                    this.updatePause(live);
                });
            });
            host.pty.onExit(event => {
                this.usage?.revoke(info.id);this.trackRelease(info.id);if(live.limitTimer){clearTimeout(live.limitTimer);live.limitTimer=undefined;}live.outputClock?.dispose();void this.mcp.stop(info.id).then(()=>this.mcp.endSession(info.id),()=>{this.mcp.endSession(info.id);this.log.error('MCP session stop failed');});
                // Set terminal precedence synchronously: queued hook bodies must not win a process-exit race.
                if(live.statusState)live.statusState=reduceStatus(live.statusState,{seq:live.statusState.seq+1,at:new Date().toISOString(),kind:'exit',status:'exited',detail:'exited',exitCode:event.exitCode});
                live.output = live.output.then(async () => {
                    if(live.mirrorFailed)return;
                    // node-pty reports exitCode 0 for a killed child; only the signal tells a crash apart.
                    const crashed = Boolean(event.signal) && !live.host?.stopRequested;
                    info.exitCode = crashed ? null : event.exitCode;
                    info.status = event.exitCode === 0 && !crashed ? 'exited' : 'error';
                    info.statusDetail = crashed ? `signal ${event.signal}` : `exit ${event.exitCode}`;
                    info.statusSince = new Date().toISOString();
                    if(live.statusState)live.statusState={...live.statusState,status:info.status,statusDetail:info.statusDetail,statusSince:info.statusSince,exitCode:info.exitCode};
                    await this.persist();
                    this.event({ kind: 'session.updated', session: { ...info } });
                }).catch(error => { this.log.error('Exit record failed'); this.emit('fatal', error); });
            });
        }
        catch (error) {
            this.usage?.revoke(info.id);this.mcp.endSession(info.id);
            if(error instanceof KeyError){this.sessions.delete(info.id);live.outputClock?.dispose();live.mirror.dispose();throw error;}
            info.status = 'error';
            info.statusDetail = 'spawn failed';
            // Spawn errors can include argv or child output, so keep diagnostics fixed for every session.
            this.log.error('PTY spawn failed for session');
        }
        await this.persist();
        this.event({ kind: 'session.updated', session: { ...info } });
        return { ...info };
    }
    // D47: a key whose provider AI Term's agent supports starts that agent, unless the fallback setting says the CLI.
    // Account logins always start the official CLIs. The homepage shows the same choice (models.ts keyEngine).
    private async route<T extends Exclude<CreateSession,{engine:'shell'}>>(request:T):Promise<T>{
        if(request.auth.kind!=='key'||request.login||request.engine==='ai-term')return request;
        let keysRunOn:Settings['keysRunOn'];
        try{keysRunOn=(await new SettingsStore(this.paths.root).get()).keysRunOn;}catch{this.log.error('Settings unreadable; keys run on AI Term agent');}
        // keyEngine applies the fallback, except for a provider no CLI can run (v0.6.5), which always starts AI Term's agent.
        const key=await this.keys.view(request.auth.keyId);
        if(keyEngine(key.provider,keysRunOn)!=='ai-term')return request;
        // AI Term's agent takes no effort level in v0.4.1, and has no Claude-only modes.
        return {...request,engine:'ai-term',effort:null,permission:request.permission==='dontAsk'?'dontAsk':'ask'};
    }
    // POST /v1/agent/ai-term (§12.5): what the agent needs before a model request. Only a live AI Term agent asking about a
    // model it may use (bound to its key and tested) gets an answer; anything else gets none (the receiver answers 204).
    private async agentQuery(id:string,raw:unknown):Promise<unknown> {
        const live=this.sessions.get(id);
        if(!live||live.info.engine!=='ai-term'||live.info.auth.kind!=='key'||['exited','error'].includes(live.info.status))return null;
        if(raw&&typeof raw==='object'&&!Array.isArray(raw)&&'kind'in raw&&typeof raw.kind==='string'&&raw.kind.startsWith('mcp.'))return this.mcp.query(id,raw);
        if(raw&&typeof raw==='object'&&!Array.isArray(raw)&&'kind'in raw&&typeof raw.kind==='string'&&raw.kind.startsWith('budget.'))return this.budgetQuery(id,raw as Record<string,unknown>);
        if(raw&&typeof raw==='object'&&!Array.isArray(raw)&&'kind'in raw&&typeof raw.kind==='string'&&raw.kind.startsWith('price.'))return this.priceQuery(id,raw as Record<string,unknown>);
        if(raw&&typeof raw==='object'&&!Array.isArray(raw)&&'kind' in raw)return new ExtensionService(new SettingsStore(this.paths.root)).query(raw as Record<string,unknown>);
        return this.agentFacts(id,raw);
    }
    // v0.9.1 queue: AI Term's agent takes the item's turns and $ as its caps (agentFacts); a CLI on a key stops at its $
    // (addTask); a CLI on your subscription stops at its time.
    setQueueLimit(id:string,limit:QueueLimit,onStop:(note:string)=>void):void{
        const live=this.sessions.get(id);if(!live)return;
        live.queueLimit=limit;live.queueStop=onStop;
        // Checked against the wall clock every 15 s: a long timer doesn't run while a Mac sleeps, so it would stop late (review).
        const gone=()=>this.sessions.get(id)!==live||['exited','error'].includes(live.info.status);
        if(limit.until){const until=limit.until,deadline=Date.now()+stopDelayMs(until,new Date());const check=setInterval(()=>{if(gone()){clearInterval(check);return;}if(Date.now()<deadline)return;clearInterval(check);
            void this.stop(id).then(()=>onStop(`stopped at its stop time (${until})`),()=>{this.log.error('Queued agent could not be stopped at its stop time');onStop('its stop time came but it could not be stopped');});},QUEUE_CHECK_MS);check.unref();}
        // A CLI on a key whose cost never reports can't be held to its $ budget: stopped when nothing arrived in 3 minutes.
        if(limit.usd!==undefined&&live.info.engine!=='ai-term'){const watch=setTimeout(()=>{if(gone()||live.info.taskUsage||live.queueStopping)return;live.queueStopping=true;
            void this.stop(id).then(()=>onStop("stopped: no cost reports came in 3 minutes, so its $ budget couldn't be held"),()=>{this.log.error('Queued agent could not be stopped without cost reports');onStop('no cost reports came, and it could not be stopped');});},QUEUE_REPORT_MS);watch.unref();}
    }
    // The agents running now, by title (queue: an `after` trigger must name one).
    titles():string[]{return [...this.sessions.values()].filter(live=>!['exited','error'].includes(live.info.status)).map(live=>live.info.title);}
    // The engine a start would really use: a key CLI request runs on AI Term's agent when keys do (queue: Don't ask is
    // checked against that).
    async effectiveEngine(request:Exclude<CreateSession,{engine:'shell'}>):Promise<import('../shared/protocol.js').AgentEngine>{return (await this.route(request)).engine;}
    async agentFacts(id:string,raw:unknown):Promise<AgentFacts|null>{
        const live=this.sessions.get(id);
        if(!live||live.info.engine!=='ai-term'||live.info.auth.kind!=='key'||['exited','error'].includes(live.info.status)||!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length!==1)return null;
        const model=(raw as {model?:unknown}).model;
        if(typeof model!=='string'||!live.agentModels?.includes(model))return null;
        const key=await this.keys.view(live.info.auth.keyId),settings=await new SettingsStore(this.paths.root).get();
        const alias=key.provider==='foundry'?deploymentAlias(settings,model):undefined,overrides=overridesFor(settings,key.provider);
        const price=findPrice(PRICES,key.provider,model,overrides,alias)??null,limits=findLimits(PRICES,key.provider,model,alias),usage=this.usage?.summary();
        // B28: the card says `price: yours` while the price in use is one you typed (a $0 one included).
        const yours=price!==null&&isYourPrice(settings,key.provider,model);
        if(yours!==(live.info.priceYours===true)){if(yours)live.info.priceYours=true;else delete live.info.priceYours;this.event({kind:'session.updated',session:{...live.info}});void this.persist();}
        return {model,wire:key.provider==='foundry'?deploymentWire(key.lastTest?.find(r=>r.model===model)):null,context:limits.context??null,output:limits.output??null,price,
            spent:{day:usage?.today.costUsd??0,week:usage?.week.costUsd??0,month:usage?.month.costUsd??0},budgets:{daily:settings.budgets?.daily??null,weekly:settings.budgets?.weekly??null,monthly:settings.budgets?.monthly??null},
            caps:live.queueLimit?limitCaps(live.queueLimit,settings.agentCaps??DEFAULT_AGENT_CAPS):settings.agentCaps??DEFAULT_AGENT_CAPS,contextWarning:settings.contextWarning!==false,reserved:this.ledger?.reserved()??0};
    }
    // B28, at a price pause: {kind:'price.info', model} → the key's provider and the catalog's closest model (a guess you
    // check); {kind:'price.set', model, price} and {kind:'price.map', model, catalog} → {saved:true}. Only a live AI Term
    // agent, for its own model, and only while that model has no price: an agent never changes a price (you do, in
    // /settings p). Anything else gets no answer (204).
    private async priceQuery(id:string,raw:Record<string,unknown>):Promise<unknown>{
        const live=this.sessions.get(id),keys=Object.keys(raw).sort().join(','),model=raw.model;
        if(!live||live.info.engine!=='ai-term'||live.info.auth.kind!=='key'||['exited','error'].includes(live.info.status)||typeof model!=='string'||!live.agentModels?.includes(model))return null;
        const key=await this.keys.view(live.info.auth.keyId),store=new SettingsStore(this.paths.root);
        const unpriced=(settings:Settings)=>findPrice(PRICES,key.provider,model,overridesFor(settings,key.provider),key.provider==='foundry'?deploymentAlias(settings,model):undefined)===undefined;
        if(raw.kind==='price.info'&&keys==='kind,model')return {provider:key.provider,guess:unpriced(await store.get())?closestCatalogModel(PRICES,key.provider,model):null};
        if(raw.kind==='price.set'&&keys==='kind,model,price'){
            if(!PRICED_BY_YOU.includes(key.provider))return null;
            try{validatePriceOverrides({[model]:raw.price});}catch{return null;}
            const price=raw.price as import('../shared/protocol.js').ModelPrice;let saved=false,full=false;
            await store.update(async settings=>{if(!unpriced(settings))return settings;if(priceCount(settings)>=MAX_PRICES){full=true;return settings;}saved=true;const current=settings.providerPrices??{};return {...settings,providerPrices:{...current,[key.provider]:{...current[key.provider],[model]:{input:price.input,output:price.output,...(price.cacheRead===undefined?{}:{cacheRead:price.cacheRead})}}}};});
            if(saved)this.log.info('A price for an AI Term agent\'s model was set at its pause');
            return saved?{saved:true}:full?{full:true}:null;
        }
        if(raw.kind==='price.map'&&keys==='catalog,kind,model'){
            if(key.provider!=='foundry'||typeof raw.catalog!=='string'||!catalogIds().includes(raw.catalog))return null;
            const catalog=raw.catalog;let saved=false;
            await store.update(async settings=>{if(!unpriced(settings))return settings;saved=true;return {...settings,deploymentModels:{...settings.deploymentModels,[model]:catalog}};});
            return saved?{saved:true}:null;
        }
        return null;
    }
    // B25: {kind:'budget.reserve', model, amountUsd} → a grant or a refusal; {kind:'budget.settle', id, worstCase} → settled.
    // Only a live AI Term agent, for a model it may use; anything else gets no answer (204), so its request isn't sent.
    private async budgetQuery(id:string,raw:Record<string,unknown>):Promise<unknown>{
        const live=this.sessions.get(id),ledger=this.ledger,keys=Object.keys(raw).sort().join(',');
        if(!ledger||!live||live.info.auth.kind!=='key'||['exited','error'].includes(live.info.status))return null;
        if(raw.kind==='budget.settle'){
            if(keys!=='id,kind,worstCase'||!isUUID(raw.id)||typeof raw.worstCase!=='boolean')return null;
            return {settled:await ledger.settle(id,raw.id,raw.worstCase)};
        }
        const amount=raw.amountUsd;
        // id (v0.6 gate): the agent's own, so it can cancel a grant it never got; older agents send none.
        if(raw.kind!=='budget.reserve'||keys!=='amountUsd,kind,model'&&!(keys==='amountUsd,id,kind,model'&&isUUID(raw.id))||typeof raw.model!=='string'||!live.agentModels?.includes(raw.model)||typeof amount!=='number'||!Number.isFinite(amount)||amount<0||amount>MAX_RECORD_COST_USD)return null;
        const key=await this.keys.view(live.info.auth.keyId),settings=await new SettingsStore(this.paths.root).get();
        // Checked again after the reads: an agent that exited meanwhile must not leave a reservation behind.
        if(['exited','error'].includes(live.info.status))return null;
        const usage=this.usage?.summary(),budgets={daily:settings.budgets?.daily??null,weekly:settings.budgets?.weekly??null,monthly:settings.budgets?.monthly??null};
        const answer=ledger.reserve({sessionId:id,provider:key.provider,model:raw.model,amountUsd:amount,...(typeof raw.id==='string'?{id:raw.id}:{})},budgets,{day:usage?.today.costUsd??0,week:usage?.week.costUsd??0,month:usage?.month.costUsd??0});
        // A grant goes out once its hold is on disk: a daemon killed in between must still book it at the next start.
        if('grant' in answer)await ledger.flushed();
        return answer;
    }
    // v0.6.4 (D53): a second after output settles, the agent's visible screen is read for an account limit. It is only
    // shown (card, homepage note); AI Term never switches accounts by itself.
    private scheduleLimitCheck(live:Live):void{
        if(live.limitTimer||!['claude-code','codex'].includes(live.info.engine)||['exited','error'].includes(live.info.status))return;
        live.limitTimer=setTimeout(()=>{live.limitTimer=undefined;this.checkLimit(live);},LIMIT_CHECK_MS);live.limitTimer.unref();
    }
    private checkLimit(live:Live):void{
        if(live.mirrorFailed||this.shutDown||!this.sessions.has(live.info.id))return;
        const found=parseLimit(live.mirror.tail(LIMIT_ROWS)),before=live.info.limit;
        if(found?.resets===before?.resets&&!!found===!!before)return;
        if(found)live.info.limit=found;else delete live.info.limit;
        this.event({kind:'session.updated',session:{...live.info}});void this.persist();
    }
    private trackRelease(id:string):void{
        const release=this.ledger?.releaseSession(id);if(!release)return;
        this.releases.add(release);void release.finally(()=>this.releases.delete(release));
    }
    setHandoffWriter(writer:{prices:PriceSnapshot;summarize:Summarize}):void{this.handoffWriter=writer;}
    async addonAuthLabel(target:import('../shared/addons.js').AddonTarget):Promise<string>{
        if(target.auth.kind==='key'){const key=await this.keys.view(target.auth.keyId);return `${key.provider} · ${key.label} ····${key.last4}`;}
        const settings=await new SettingsStore(this.paths.root).get();return `subscription · ${target.auth.profile??(target.engine!=='ai-term'?settings.defaultAccounts?.[target.engine]:undefined)??'own'}`;
    }
    // v1.1 /teach and /review <agent> deep: the agent's diff as data (redacted, within the first-message room) and the
    // worktree the model reads for context.
    async addonAgent(id:string):Promise<{title:string;cwd:string;diff:string}>{
        if(!isUUID(id))throw new Error('Invalid session UUID');
        const live=this.sessions.get(id);if(!live)throw new Error('Session not found');
        const diff=await this.diff(id);if(!diff.files.length)throw new Error("This agent's diff is empty; nothing to read yet");
        // Measured as the prompt carries it (JSON-escaped): quotes and backslashes double (security review).
        const text=diffForReview(diff),fits=(value:string)=>Buffer.byteLength(JSON.stringify(value))<=ADDON_DIFF_BYTES;
        if(fits(text))return {title:live.info.title,cwd:live.info.worktree??live.info.cwd,diff:text};
        let room=text.length,cut:string;
        do{room=Math.floor(room*0.9);cut=`${cutText(text,room)}\n(the diff is cut here; read the rest in the worktree)`;}while(room>0&&!fits(cut));
        return {title:live.info.title,cwd:live.info.worktree??live.info.cwd,diff:cut};
    }
    // v1.1 batch 2: the data an add-on gets, read by AI Term read-only (gh, package queries, git, instruction files).
    async addonGather(kind:import('../shared/addons.js').AddonInput,cwd:string,args:string):Promise<Gathered>{
        const top=await repoTopLevel(cwd);if(!top)throw new Error("This folder isn't in a git repository");
        switch(kind){
            case 'github-issue': case 'github-pr':
                return githubView(kind==='github-issue'?'issue':'pr',args,{gh:await resolveExecutable('gh',process.env.PATH??''),cwd:top,env:buildGhEnv(process.env)});
            case 'deps':{
                // /deps [path]: that folder's manifests (a package in a monorepo), inside this repository.
                const folder=args.trim()?await resolveInside(top,resolve(cwd,args.trim())):top;
                if(!(await stat(folder)).isDirectory())throw new Error('/deps [path] names a folder in this repository');
                return {...await depsQueries(folder,{path:process.env.PATH??'',env:buildTestEnv(process.env)}),subject:`dependencies of ${relative(top,folder)||'this repository'}`};
            }
            case 'commit':{
                if(!args.trim())return stagedChanges(top);
                // The message is written for the agent's uncommitted work, exactly what y commits (review).
                const id=args.trim(),{live,work}=await this.agentCommitTarget(id),found=await agentWork(work);
                return {data:found.data,subject:`agent: ${live.info.title} (y commits there)`,facts:found.facts,cwd:work.path,commitAgent:id,commitState:found.state};
            }
            case 'git-range': return changelogRange(top,args);
            case 'context':{
                // The skills and agents an agent here would load (D48, read-only): names, sizes and descriptions.
                const catalog=new ExtensionReader(homedir(),top).scan((await new SettingsStore(this.paths.root).get()).extensions),loaded=catalog.items.filter(item=>item.enabled&&item.kind!=='command');
                const total=loaded.reduce((n,item)=>n+item.tokens,0);
                return contextFiles(top,{facts:[`loaded skills and agents: ${loaded.length}, ≈${total.toLocaleString('en-US')} tokens`],data:['Loaded skills and agents (name, tokens, description):',...loaded.slice(0,80).map(item=>`${item.kind} ${item.name} ≈${item.tokens} — ${item.description}`)]});
            }
            case 'opensource': return {...await opensourceScan(top),subject:'release readiness of this repository'};
            default: throw new Error('Nothing to gather for this add-on');
        }
    }
    // v1.1 /commit y: the agent's own work, committed in its own worktree with your global git name; never in your
    // checkout. The worktree must still lead back to the recorded repository, and the work must be what the message
    // was written for (agent-commit.ts).
    private async agentCommitTarget(id:string):Promise<{live:Live;work:import('./agent-commit.js').AgentWork}>{
        if(!isUUID(id))throw new Error('Invalid session UUID');
        const live=this.sessions.get(id);if(!live)throw new Error('Session not found');
        if(this.working(live))throw new Error('The agent is still working; commit when it has finished');
        const {path,base,repo}=await this.diffTarget(live);if(!repo||!live.info.branch)throw new Error("This agent's worktree has no recorded repository or branch");
        return {live,work:{path,base,repo,branch:live.info.branch}};
    }
    async addonCommit(id:string,message:string,state?:string):Promise<string>{
        if(typeof message!=='string'||!message.trim()||Buffer.byteLength(message)>8000||/[\p{C}]/u.test(message.replace(/[\n\t]/g,'')))throw new Error('Invalid commit message');
        if(!state)throw new Error('Run /commit again: the message must be written for the current work');
        const {work}=await this.agentCommitTarget(id);
        // Your identity from your own global config file only: the repository's config is the agent's to influence.
        const identity=async(key:string)=>(await runGit('/',['config','--file',this.userGit.globalConfig,'--get',key]).catch((error:unknown)=>{if(error instanceof GitError)return '';throw error;})).trim();
        const name=await identity('user.name'),email=await identity('user.email');
        if(!name||!email)throw new Error('Set your git user.name and user.email first (git config --global)');
        return commitWork(work,message,state,{name,email});
    }
    // v1.1 /standup: today's agents from AI Term's own records; no model, no tokens.
    async addonStandup():Promise<string[]>{
        const today=new Date().toDateString(),seen=(iso:string|null|undefined)=>!!iso&&new Date(iso).toDateString()===today,lines:string[]=[];
        for(const live of this.sessions.values()){
            const info=live.info;if(info.engine==='shell'||!(seen(info.createdAt)||seen(info.statusSince)||seen(info.lastOutputAt)))continue;
            let commits='no worktree';
            // Only the agent's own commits: after its recorded start, not the history its branch carries.
            const base=info.worktree?this.worktreeRecords.get(info.worktree)?.baseCommit:undefined;
            if(info.worktree&&base&&/^[0-9a-f]{40,64}$/.test(base))try{const n=(await runGit(info.worktree,['log','--since=midnight','--format=%h','--end-of-options',`${base}..HEAD`,'--'])).split('\n').filter(Boolean).length;commits=`${n} commit${n===1?'':'s'} today`;}catch(error){if(!(error instanceof GitError))throw error;commits='commits unreadable';}
            const usage=info.taskUsage?`${info.taskUsage.tokens.toLocaleString('en-US')} tokens · ${info.taskUsage.unknownPrice?'price unknown':info.taskUsage.costUsd===null?'subscription':`$${info.taskUsage.costUsd.toFixed(2)}`}`:'no usage reported';
            lines.push(`${info.title} · ${info.status} · ${commits} · ${usage}`);
        }
        return lines.length?lines:['No agent was active today'];
    }
    // v1.1 o and s: a file an add-on made in its worktree (the service already checked it is under the command's folder).
    // Review: only a viewable type (never one macOS would run), no exec bit, one link only, no link on the way, read
    // through one no-follow descriptor; o opens AI Term's private copy of those bytes (a swap after the check changes
    // nothing), s writes them to Downloads without overwriting. Its refusals are AddonErrors: AI Term's own words, which
    // reach you (live suite: as plain errors the server showed "Session operation failed" instead).
    async addonFile(id:string,file:string,action:'open'|'save'):Promise<string|null>{
        if(!isUUID(id))throw new Error('Invalid session UUID');
        const live=this.sessions.get(id),tree=live?.info.worktree;
        if(!live||!tree||!this.worktreeRecords.has(tree))throw new AddonError('This agent has no worktree');
        if(!viewable(file))throw new AddonError("That's not a file type AI Term opens or saves");
        // A running agent could still swap its folder for a link between the checks below and the open (gate LOW).
        if(['starting','running'].includes(live.info.status))throw new AddonError('Wait until the agent finishes, then press o or s');
        // A link out of the worktree, a file the result names but the agent never wrote, or a link at the file itself:
        // fixed words, never the system's text (Part C review: its ENOENT carried the worktree's path).
        const root=await realpath(tree);
        let full:string;
        try{full=await resolveInside(root,file);}catch(error){if(error instanceof JailError)throw new AddonError('A made file is never opened through a link');throw error;}
        if(full!==join(root,file))throw new AddonError('A made file is never opened through a link');
        let handle:Awaited<ReturnType<typeof open>>;
        try{handle=await open(full,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}
        catch(error){if(isFsError(error,'ENOENT'))throw new AddonError("That file isn't in the agent's folder any more");if(isFsError(error,'ELOOP'))throw new AddonError('A made file is never opened through a link');throw error;}
        let data:Buffer;
        try{
            const info=await handle.stat();
            if(!info.isFile()||info.size>ADDON_FILE_MAX)throw new AddonError('Only a regular file up to 64 MB is opened or saved');
            if(info.mode&0o111)throw new AddonError("That file is executable; AI Term doesn't open or save it");
            if(info.nlink!==1)throw new AddonError('Only a file with one link is opened or saved');
            data=await handle.readFile();
        }finally{await handle.close();}
        const name=basename(file),lower=name.toLowerCase(),html=lower.endsWith('.html')||lower.endsWith('.htm');
        // HTML opens and saves with no script able to run; an SVG opens as an image in such a page (inert-copy.ts).
        if(html)data=Buffer.from(inertHtml(data.toString('utf8')));
        if(action==='open'){
            // A fresh private folder per open; earlier copies go first.
            const opened=join(this.paths.root,'opened');await rm(opened,{recursive:true,force:true});await privateDirectory(opened);
            const folder=join(opened,randomUUID());await privateDirectory(folder);
            const copy=join(folder,name);await writeFile(copy,data,{flag:'wx',mode:0o600});
            let shown=copy;
            if(lower.endsWith('.svg')){shown=join(folder,`${name}.html`);await writeFile(shown,svgPage(name),{flag:'wx',mode:0o600});}
            await(SessionManager.fileOpener??openWithDefaultApp)(shown);return null;
        }
        const folder=SessionManager.downloads??join(homedir(),'Downloads');
        let isFolder=false;try{isFolder=(await stat(folder)).isDirectory();}catch(error){if(!isFsError(error,'ENOENT'))throw error;}
        if(!isFolder)throw new AddonError('No Downloads folder to save into');
        const dot=name.lastIndexOf('.'),stem=dot>0?name.slice(0,dot):name,ext=dot>0?name.slice(dot):'';
        for(let n=1;n<=99;n++){
            const target=join(folder,n===1?name:`${stem} (${n})${ext}`);
            try{await writeFile(target,data,{flag:'wx',mode:0o644});return target;}catch(error){if(!isFsError(error,'EEXIST'))throw error;}
        }
        throw new AddonError('Downloads already has 99 copies of this file');
    }
    // v1.0.7 /reverse: the target (checked), REA (found, never installed) and its sandboxed server, for an engine whose
    // installed CLI takes a per-session MCP list. Errors are one line each and reach the popup.
    async addonReverse(cwd:string,args:string,target:import('../shared/addons.js').AddonTarget):Promise<ReversePlan>{
        if(target.engine!=='ai-term'){const status=await checkEngine(target.engine,process.env);if(!status.installed||!status.path)throw new Error(`${target.engine==='codex'?'codex':'claude'} not found in PATH`);await checkReverseCli(target.engine,status.path);}
        let setting:string|undefined;
        try{const value=(await new SettingsStore(this.paths.root).get()).reversePath;if(typeof value==='string')setting=value;}catch{this.log.error('Settings unreadable; /reverse looks for REA on PATH');}
        const reverseTargetPath=await reverseTarget(cwd,args,this.paths.root),rea=await findRea(setting,process.env.PATH??'',cwd);
        return {target:reverseTargetPath,rea,identity:await reaIdentity(rea),mcp:await reverseServer({rea,target:reverseTargetPath,cwd,root:this.paths.root,env:process.env})};
    }
    // v1.1 /bisect: the plan reads your checkout only; whether a sandbox starts here decides y or a capital Y.
    async addonBisectPlan(cwd:string,args:string):Promise<BisectAsk>{
        const repo=await repoTopLevel(cwd);if(!repo)throw new BisectError("This folder isn't in a git repository; /bisect needs one");
        const box=await this.sandboxFor(repo,repo);
        await box?.dispose().catch(()=>this.log.error('Test sandbox: its temp folder could not be removed'));
        return {...await bisectPlan(repo,args,!!box),sandbox:!!box};
    }
    async addonBisect(cwd:string,plan:BisectAsk,unsandboxed:boolean):Promise<Extract<AddonResult,{kind:'bisect'}>>{
        const repo=await repoTopLevel(cwd);if(!repo)throw new BisectError("This folder isn't in a git repository; /bisect needs one");
        return runBisect({repo,plan,sandbox:(path,readable)=>this.sandboxFor(path,repo,undefined,readable),unsandboxed,env:buildBisectEnv(process.env),log:text=>this.log.error(text)});
    }
    // v1.1 /perf's A/B: the benchmark on a temporary copy at the agent's start (before) and in its worktree (after), each in
    // its own test sandbox; without one it runs only after the capital Y the popup asks for.
    async addonPerfAb(id:string,benchmark:string[],files:string[],unsandboxed:boolean):Promise<AbView>{
        if(!isUUID(id))throw new Error('Invalid session UUID');
        const live=this.sessions.get(id);if(!live)throw new Error('Session not found');
        if(!isTestCommand(benchmark)||files.length>5||files.some(file=>!file.startsWith('bench/')))throw new Error('Only a benchmark command and new files under bench/ can run in the A/B');
        const {path,base,repo}=await this.diffTarget(live),before=await tempClone(repo??path,base),boxes:(PreparedSandbox|null)[]=[];
        try{
            for(const file of files)await copyBenchFile(path,before.path,file);
            const a=await this.sandboxFor(before.path,repo);boxes.push(a);const b=await this.sandboxFor(path,repo);boxes.push(b);
            if((!a||!b)&&!unsandboxed)return {state:'failed',reason:AB_NO_SANDBOX};
            const env=buildTestEnv(process.env),side=(cwd:string,box:PreparedSandbox|null)=>({cwd,run:()=>runTests(benchmark,cwd,{...env,...box?.env},{timeoutMs:AB_RUN_TIMEOUT_MS,log:text=>this.log.error(text),...(box?{sandbox:box}:{})})});
            return await runAb(side(before.path,a),side(path,b),{sandbox:!!a&&!!b});
        }finally{
            for(const box of boxes)await box?.dispose().catch(()=>this.log.error('Test sandbox: its temp folder could not be removed'));
            await before.dispose().catch(()=>this.log.error('A/B: its temporary copy could not be removed'));
        }
    }
    // v0.6.3 (D55, off by default): only an AI agent that isn't waiting on you or running a tool, to a CLI that is installed
    // and logged in. Account logins only: a key never moves between engines.
    private async handoffSource(id:string,engine:CliEngine,account?:string):Promise<{live:Live;settings:Settings;account:string}>{
        const settings=await new SettingsStore(this.paths.root).get();
        if(settings.handoff!==true)throw new Error('Handoff is off · /settings g turns it on (it spends tokens)');
        const live=this.sessions.get(id);if(!live)throw new Error('Session not found');
        if(live.info.engine==='shell'||live.info.login)throw new Error('Only an AI agent can hand off');
        await this.caughtUp(live);
        this.handoffBusy(live);
        // v0.6.4: onto another account of yours (D53); its login is checked in its own folder.
        // The account named, else the engine's default: resolved once, so the login checked is the one that starts.
        const choice=account??settings.defaultAccounts?.[engine]??OWN_ACCOUNT;
        let profilePath:string|undefined;
        if(choice!==OWN_ACCOUNT){
            if(!(settings.accounts??[]).some(a=>a.name===choice&&a.engine===engine))throw new Error('Account not found for this engine');
            profilePath=await prepareProfile(this.paths.root,engine,choice,homedir());
        }
        const target=await checkEngine(engine,process.env,undefined,profilePath);
        if(!target.installed||!target.path)throw new Error(`${engine==='codex'?'codex':'claude'} not found in PATH`);
        if(target.loggedIn!==true)throw new Error(target.loggedIn===false?'Engine is not logged in':'Engine login status unavailable');
        return {live,settings,account:choice};
    }
    // The states a handoff refuses, checked before anything runs and again before the old agent is stopped.
    private handoffBusy(live:Live):void{
        if(!live.host||live.mirrorFailed||['exited','error'].includes(live.info.status))throw new Error('Agent has exited');
        if(live.info.status==='starting')throw new Error("Agent hasn't started yet");
        if(live.info.status==='waiting'&&live.info.statusDetail==='permission'||live.info.engine==='codex'&&live.codexRun==='action')throw new Error('Agent is asking for permission');
        if(live.info.status==='waiting'&&live.info.statusDetail==='question')throw new Error('Agent is asking a question');
        if((live.statusState?.toolsInFlight??0)>0)throw new Error('Agent is running a tool');
    }
    async handoffPlan(id:string,engine:CliEngine,account?:string):Promise<HandoffPlan>{
        const source=await this.handoffSource(id,engine,account),screen=(await this.text(id)).text,writer=cheapestWriter(await this.keys.list(),source.settings,this.handoffWriter.prices);
        // Said before the ask, not after ⏎: a limited agent can't write its own note.
        if(!writer&&source.live.info.limit)throw new Error("Agent hit its limit and can't write the note · add an API key for the summary");
        const plan=handoffPlan(source.live.info.title,engine,screen,writer,source.live.info.authMethod==='subscription');
        return source.account===OWN_ACCOUNT?plan:{...plan,account:source.account};
    }
    // The note is written first, then the new agent starts in the same folder or worktree with it as its first message;
    // the old agent is stopped only once the new one is running. `approved` is the writer the user saw in the ask (D49).
    async handoff(id:string,engine:CliEngine,approved?:HandoffWriter,account?:string):Promise<{session:SessionInfo;summary:HandoffSummary|null;oldKeptRunning:boolean}>{
        // Taken before the first await, so a second request (another client, a double ⏎) is refused rather than run twice.
        if(this.handingOff.has(id))throw new Error('Handoff already running');
        this.handingOff.add(id);
        try{
            const {live,settings,account:target}=await this.handoffSource(id,engine,account);
            const screen=(await this.text(id)).text,writer=cheapestWriter(await this.keys.list(),settings,this.handoffWriter.prices);
            if(approved&&!sameWriter(approved,writer))throw new Error('The summary writer changed; run /handoff again');
            const written=writer?await this.keyedSummary(id,live,engine,screen,writer,settings):{text:await this.agentSummary(live,engine),summary:null};
            if(!cleanNote(written.text))throw new Error('The handoff note came back empty');
            if(['exited','error'].includes(live.info.status))throw new Error('Agent exited before the handoff finished');
            const title=[...`${live.info.title} · ${engineLabel(engine)}`].slice(0,60).join('');
            const continuation=live.info.worktree?{worktree:live.info.worktree,...(live.info.branch?{branch:live.info.branch}:{})}:{};
            const next=await this.create({engine,model:null,auth:{kind:'account',profile:target},cwd:live.info.cwd,permission:'ask',title,firstMessage:handoffMessage(live.info.title,written.text)},continuation);
            for(let waited=0;;waited+=100){
                const status=this.get(next.id).status;
                if(['running','waiting','done'].includes(status))break;
                if(['exited','error'].includes(status)||waited>=SessionManager.handoffStartMs){
                    // Late is not never: a new agent left starting would later work on the same task beside the old one.
                    try{await this.stop(next.id);}catch{this.log.error('Handoff: stopping the new agent that did not start failed');throw new Error(HANDOFF_NOT_STOPPED);}
                    throw new Error(written.summary?HANDOFF_NOT_STARTED_PAID:HANDOFF_NOT_STARTED);
                }
                await new Promise(resolve=>setTimeout(resolve,100));
            }
            // It may have started a tool or asked something while the note was written: then it keeps running, and says so;
            // only an agent that really stopped is marked handed off.
            let oldKeptRunning=false;
            try{this.handoffBusy(live);await this.stop(id);}
            catch{oldKeptRunning=true;this.log.error('Handoff: the old agent kept running');}
            if(!oldKeptRunning){live.info.handoffTo=next.title;this.event({kind:'session.updated',session:{...live.info}});await this.persist();}
            return {session:this.get(next.id),summary:written.summary,oldKeptRunning};
        }finally{this.handingOff.delete(id);}
    }
    // One request to the cheapest keyed model, held against the budgets like an agent's request (B25) and counted in Usage.
    private async keyedSummary(id:string,live:Live,engine:CliEngine,screen:string,writer:import('./handoff.js').KeyedWriter,settings:Settings):Promise<{text:string;summary:HandoffSummary}>{
        const plan=handoffPlan(live.info.title,engine,screen,writer,false),worst=plan.priceUsd?.high??0;
        this.lastHandoffWorst=worst;
        return this.keyedRequest(id,writer,handoffPrompt(engine,screen),{worst,maxOutput:HANDOFF_OUTPUT_TOKENS,what:'handoff'},settings);
    }
    // One request on a saved key for a job (a handoff note, a review): held against the budgets at its worst case first,
    // then settled with the provider's own counts. Only fixed words ever leave; the provider's error text never does.
    private async keyedRequest(id:string,writer:import('./handoff.js').KeyedWriter,prompt:string,job:{worst:number;maxOutput:number;what:'handoff'|'review'|'brain'},settings:Settings):Promise<{text:string;summary:HandoffSummary}>{
        // A review may read an agent that has exited (whose own holds the ledger already closed): it holds under its own id.
        const {worst,what}=job,usage=this.usage?.summary(),label=what==='handoff'?'Handoff summary':what==='brain'?'Brain':'Review',holder=what==='handoff'?id:randomUUID();
        // No ledger, no budget check: a keyed request is never sent unchecked (v0.6 gate).
        if(!this.ledger)throw new Error('Budget check unavailable; try again');
        const held=this.ledger.reserve({sessionId:holder,provider:writer.key.provider,model:writer.model,amountUsd:worst},{daily:settings.budgets?.daily??null,weekly:settings.budgets?.weekly??null,monthly:settings.budgets?.monthly??null},{day:usage?.today.costUsd??0,week:usage?.week.costUsd??0,month:usage?.month.costUsd??0});
        if('refused' in held)throw new Error(held.refused.budget==='unavailable'?'Budget check unavailable; try again':`The ${what} would pass your ${held.refused.budget} budget`);
        const grant=held.grant.id,controller=new AbortController(),timer=setTimeout(()=>controller.abort(),HANDOFF_SUMMARY_MS);
        const settle=(worstCase:boolean):Promise<unknown>=>grant?this.ledger?.settle(holder,grant,worstCase).catch(()=>{this.log.error('Budget reservation could not be booked');})??Promise.resolve():Promise.resolve();
        let result:import('./handoff.js').Summary;
        try{
            result=await this.keys.withSecret(writer.key.id,(secret,binding)=>{
                // B12: a Foundry key goes only to its Keychain-bound endpoint and deployments.
                if(writer.key.provider==='foundry'&&(!binding||!binding.deployments.includes(writer.model)))throw new KeyError('Foundry key details changed outside AI Term; add the key again');
                return this.handoffWriter.summarize(writer,secret,writer.key.provider==='foundry'?binding?.endpoint??null:null,prompt,controller.signal,job.maxOutput);
            });
        }catch(error){
            // A key problem stops before anything is sent: the hold is released, not booked.
            await settle(!(error instanceof KeyError));
            if(error instanceof KeyError)throw error;
            this.log.error(`${label} request failed`);
            // eslint-disable-next-line preserve-caught-error -- provider errors may carry anything the provider sent; only fixed words leave.
            throw new Error(what==='handoff'?'The handoff summary request failed':what==='brain'?'The brain request failed':'The review request failed');
        }finally{clearTimeout(timer);}
        // The agent exited meanwhile: its hold was already booked at the worst case, so the real usage isn't added on top.
        const stillHeld=grant!==null&&this.ledger?.holds(grant)===true;
        if(result.inputTokens===null||result.outputTokens===null||grant!==null&&!stillHeld){await settle(true);return {text:result.text,summary:{inputTokens:result.inputTokens??0,outputTokens:result.outputTokens??0,costUsd:worst}};}
        const costUsd=estimateCost(writer.price,result.inputTokens,result.outputTokens);
        try{await this.usage?.job({ts:new Date().toISOString(),sessionId:id,provider:writer.key.provider,model:writer.model,inputTokens:result.inputTokens,outputTokens:result.outputTokens,costUsd,costSource:'price-table'});await settle(false);}
        catch{this.log.error(`${label} usage could not be recorded; counted at its worst case`);await settle(true);}
        return {text:result.text,summary:{inputTokens:result.inputTokens,outputTokens:result.outputTokens,costUsd}};
    }
    // No key: the agent writes its own note as its next reply (sent like /send), read from its last reply when that turn
    // ends. Only an agent that has finished its turn: a reply still pending would otherwise become the note.
    private async agentSummary(live:Live,engine:CliEngine):Promise<string>{
        // An agent at its account limit can't write anything; only a keyed summary can hand it off.
        if(live.info.limit)throw new Error('Agent hit its limit and can\'t write the note · add an API key for the summary');
        if(live.info.status!=='done')throw new Error('Agent is still working · hand off when it is done');
        const before=live.lastReply;
        await this.sendText(live,`${handoffInstructions(engine)} Reply with the note only.`);
        for(let waited=0;waited<HANDOFF_REPLY_MS;waited+=200){
            if(['exited','error'].includes(live.info.status))throw new Error('Agent exited before writing its handoff note');
            if(live.info.status==='done'&&live.lastReply!==undefined&&live.lastReply!==before)return live.lastReply;
            await new Promise(resolve=>setTimeout(resolve,200));
        }
        throw new Error("The agent didn't write its handoff note in time; it keeps running");
    }
    // Cost per task: one session's own total from its start. cost undefined: a tokens-only (subscription) report.
    private addTask(id:string,tokens:number,cost:number|null|undefined):void{
        const live=this.sessions.get(id);if(!live||!Number.isSafeInteger(tokens)||tokens<0)return;
        const before=live.info.taskUsage,next:TaskUsage={tokens:Math.min(Number.MAX_SAFE_INTEGER,(before?.tokens??0)+tokens),costUsd:cost===undefined?before?.costUsd??null:(before?.costUsd??0)+(cost??0)};
        if(before?.unknownPrice||cost===null)next.unknownPrice=true;
        live.info.taskUsage=next;
        // v0.9.1: a queued CLI on a key stops at its $ budget (or at once when its spend can't be priced).
        const limit=live.queueLimit;
        if(limit&&live.info.engine!=='ai-term'&&!live.queueStopping&&overLimit(limit,next)){
            live.queueStopping=true;const note=next.unknownPrice||next.costUsd===null?"stopped: its spend can't be priced, so its $ budget can't be held":`stopped at its $${(limit.usd??0).toFixed(2)} budget`;
            void this.stop(id).then(()=>live.queueStop?.(note),()=>{this.log.error('Queued agent could not be stopped at its limit');live.queueStop?.('its limit was reached but it could not be stopped');});
        }
        // A CLI can report 120 records a minute: the card and state.json follow at most once a second. While stopping,
        // no timer: shutdown's last write saves it.
        if(this.closing){this.taskDirty=true;return;}
        if(this.taskTimers.has(id))return;
        this.taskTimers.set(id,setTimeout(()=>{this.taskTimers.delete(id);const current=this.sessions.get(id);if(!current)return;this.event({kind:'session.updated',session:{...current.info}});void this.persist();},TASK_UPDATE_MS));
    }
    private ingressAgentStatus(id:string,update:import('./agent-status.js').AgentUpdate|null):void{
        const live=this.sessions.get(id);if(!live||!update)return;
        if(update.model!==undefined){
            // Only a deployment this session may use (bound to its key and tested) can become its model.
            if(!live.agentModels?.includes(update.model)||['exited','error'].includes(live.info.status)||live.info.model===update.model)return;
            live.info.model=update.model;this.event({kind:'session.updated',session:{...live.info}});void this.persist();return;
        }
        if(update.event)this.ingressStatus(id,{event:update.event,...(update.reply!==undefined?{reply:update.reply}:{})});
    }
    private ingressStatus(id:string,update:{event:ClaudeStatusEvent;reply?:string}|null):void{
        const live=this.sessions.get(id);if(!live?.statusState||live.mirrorFailed||['exited','error'].includes(live.statusState.status)||!update)return;
        // A reply stays the newest reply even when its status event lost to a newer one.
        if(update.reply!==undefined)live.lastReply=update.reply;
        if(update.event.kind!=='context')live.reported=true;
        this.applyStatus(live,reduceStatus(live.statusState,update.event));
    }
    private applyStatus(live:Live,next:StatusState):void{
        if(!live.statusState||next===live.statusState)return;
        const previous=live.statusState;live.statusState=next;
        Object.assign(live.info,{status:next.status,statusDetail:next.statusDetail,statusSince:next.statusSince,ctxPercent:next.ctxPercent,lastActivity:next.lastActivity});
        // v0.7.1: a finished turn counts what the worktree changed for the card (`+N −M · ready to review`).
        if(next.status==='done'&&previous.status!=='done'&&live.info.worktree)void this.refreshDiffStat(live);
        // v0.7.2 (D55): a turn that ends (done, or waiting on you) is checkpointed, in the agent's own queue; a finished one
        // then runs the project's tests (v0.7.4), after the checkpoint has read the worktree.
        const turnEnd=previous.status==='running'&&(next.status==='done'||next.status==='waiting')&&live.info.worktree?this.checkpointTurn(live.info.id):null;
        if(turnEnd&&next.status==='done')void turnEnd.then(()=>this.afterTurn(live.info.id));
        // Working again: the last count and test result are stale until the next finished turn; a test run still going stops.
        if(next.status==='running'&&live.info.diffStat){delete live.info.diffStat;live.diffStatSeq=(live.diffStatSeq??0)+1;}
        if(next.status==='running')this.cancelTests(live.info.id,false);
        if(next.status==='running'&&live.info.review&&live.info.review.state!=='running')delete live.info.review;
        this.event({kind:'session.updated',session:{...live.info}});live.outputClock?.sent();
        // Notifications listen here; a listener failure must never stop status from applying.
        try{this.emit('statusChanged',{...live.info},previous,next,live.attached);}catch{this.log.error('Status listener failed');}
        void this.persist();
    }
    // Codex terminal signals and Enter from the attached owner wait behind status requests that arrived earlier. Each applies only
    // when it changes what a card would show, so a repainting title cannot reset statusSince or flood state writes.
    private codexStatus(live:Live,event:{kind:'running'}|{kind:'waiting';reason:'permission'}|{kind:'context';percent:number},when?:(state:StatusState)=>boolean):void{
        this.usage?.enqueueStatus(live.info.id,seq=>{
            const state=live.statusState;if(!state||live.mirrorFailed||['exited','error'].includes(state.status)||when&&!when(state))return;
            if(event.kind!=='context')live.reported=true;
            const next=reduceStatus(state,{...event,seq,at:new Date().toISOString()});
            if(next.status===state.status&&next.statusDetail===state.statusDetail&&next.ctxPercent===state.ctxPercent)return;
            this.applyStatus(live,next);
        });
    }
    private codexSignal(live:Live,signal:MirrorSignal):void{
        // Signals run inside the mirror's parser; a failure here must not mark the terminal mirror failed and stop the agent.
        try{this.readCodexSignal(live,signal);}catch{this.log.error('Codex status signal failed');}
    }
    private readCodexSignal(live:Live,signal:MirrorSignal):void{
        // A bare bell counts only during a turn: with osc9 Codex itself never rings, so a stray bell after done is not an approval.
        if(signal.kind==='bell'){this.codexStatus(live,{kind:'waiting',reason:'permission'},state=>state.status==='running');return;}
        if(signal.kind==='osc9'&&isCodexApproval(signal.text)){this.codexStatus(live,{kind:'waiting',reason:'permission'});return;}
        if(signal.kind!=='title')return;
        const title=codexTitle(signal.title),previous=live.codexRun;live.codexRun=title.run;
        if(title.leftPercent!==null)this.codexStatus(live,{kind:'context',percent:100-title.leftPercent});
        // Only a change into a run state counts: the spinner repaints the same "Working" title after notify already said done.
        // Ready is left to notify, which marks the turn done.
        if(title.run===previous)return;
        if(title.run==='working')this.codexStatus(live,{kind:'running'});
        else if(title.run==='action')this.codexStatus(live,{kind:'waiting',reason:'permission'});
    }
    // D50: /send is the one way homepage text reaches an agent. It is refused whenever the text could answer something the
    // user hasn't seen: a permission prompt or question, an agent someone is typing in, or an AI agent that hasn't reported
    // status yet (it may still be at its folder-trust prompt, which no hook reports).
    private unsendable(live:Live):string|null{
        if(!live.host||live.mirrorFailed||['exited','error'].includes(live.info.status))return 'Agent has exited';
        if(live.attached)return 'Agent is open in a session';
        if(live.info.status==='waiting'&&live.info.statusDetail==='permission')return 'Agent is asking for permission';
        if(live.info.status==='waiting'&&live.info.statusDetail==='question')return 'Agent is asking a question';
        // Codex's approval title stays up for as long as the approval does, and the mirror reads it as it parses; a late
        // turn-complete notify can mark the card done while the approval is still open, so the title has the final say.
        if(live.info.engine==='codex'&&live.codexRun==='action')return 'Agent is asking for permission';
        // The late-hook window: Claude's PermissionRequest can arrive seconds after its prompt is drawn, but never outside a
        // tool call. Codex reports approvals in its own output stream, which caughtUp has already read.
        if((live.info.engine==='claude-code'||live.info.engine==='ai-term')&&(live.statusState?.toolsInFlight??0)>0)return 'Agent is running a tool';
        // A status-line context report can come while a dialog is up; only a hook or run-state signal counts.
        if(live.info.engine!=='shell'&&!live.reported)return 'Agent has not reported its status yet';
        // A paused PTY holds unread output, which may be a prompt the status below hasn't seen.
        if(live.paused)return 'Agent is printing too fast to check';
        return null;
    }
    // Status is only as fresh as what the mirror has parsed: wait for every chunk that arrived before now, then for the
    // status signals those chunks queued. Claude's hooks arrive over HTTP and can still lag (D50).
    private async caughtUp(live:Live):Promise<void>{
        await live.output;
        // Status signals the mirror queued apply in order behind any status request still arriving; a no-op entry
        // resolves once everything before it has.
        await new Promise<void>(resolve=>{if(!this.usage?.enqueueStatus(live.info.id,()=>resolve()))resolve();});
        await new Promise<void>(resolve=>setImmediate(resolve));
    }
    async send(id:string,text:string):Promise<void>{
        if(!isUUID(id)||!isSendText(text))throw new Error('Invalid send request');
        const live=this.sessions.get(id);if(!live)throw new Error('Session not found');
        // While its handoff runs, a /send could become the note or race the stop.
        if(this.handingOff.has(id))throw new Error('Agent is being handed off');
        await this.sendText(live,text);
    }
    private async sendText(live:Live,text:string):Promise<void>{
        const id=live.info.id;
        if(this.sending.has(id))throw new Error('Agent is busy with another send');
        this.sending.add(id);
        try{
            await this.caughtUp(live);
            const refused=this.unsendable(live);if(refused)throw new Error(refused);
            const paste=live.mirror.modes().bracketedPaste;
            // Without bracketed paste every newline would be its own Enter, so only one line may go.
            if(!paste&&text.includes('\n'))throw new Error('Agent does not accept pasted lines');
            live.host?.write(paste?`\x1b[200~${text}\x1b[201~`:text);
            // Enter is its own write a moment later, so the agent has taken the whole paste in before it submits. The
            // checks run again: a prompt that appeared in between must not get this Enter.
            await new Promise(resolve=>setTimeout(resolve,SessionManager.sendEnterDelayMs));
            await this.caughtUp(live);
            if(this.unsendable(live))throw new Error('Text pasted but not sent; go inside');
            // With kitty 'report all keys as escapes' (flag 8) Enter is CSI 13 u, not CR.
            live.host?.write(((live.mirror.modes().kittyFlags?.at(-1)??0)&8)?'\x1b[13u':'\r');
            // Only a finished turn becomes running: a waiting that arrived meanwhile must stay visible.
            if(live.info.engine==='codex')this.codexStatus(live,{kind:'running'},state=>state.status==='done');
        }finally{this.sending.delete(id);}
    }
    // v1.0.8 /remote: the agent's screen as plain text from its mirror (never raw output), after everything that arrived
    // has been parsed, with the fingerprint an answer must send back.
    private remoteWaiting(live:Live):'permission'|'question'|null{
        if(live.info.engine==='codex'&&live.codexRun==='action')return 'permission';
        return live.info.status==='waiting'&&(live.info.statusDetail==='permission'||live.info.statusDetail==='question')?live.info.statusDetail:null;
    }
    async remoteScreen(id:string):Promise<import('../shared/remote.js').RemoteScreen>{
        const live=isUUID(id)?this.sessions.get(id):undefined;if(!live||live.info.engine==='shell')throw new Error('Session not found');
        await this.caughtUp(live);
        const lines=live.mirror.tail(REMOTE_SCREEN_ROWS).split('\n');
        return {lines,fingerprint:screenFingerprint(id,live.info.statusSince,lines),waiting:this.remoteWaiting(live)};
    }
    // Answers a permission prompt with the engine's own key, only while it is the very prompt the phone was shown, and
    // never while you are attached on the Mac (you answer it there).
    async remoteAnswer(id:string,keys:(engine:SessionInfo['engine'])=>string,fingerprint:string):Promise<void>{
        const live=isUUID(id)?this.sessions.get(id):undefined;if(!live||live.info.engine==='shell')throw new Error('Session not found');
        if(this.sending.has(id))throw new Error('Agent is busy with another send');
        this.sending.add(id);
        try{
            await this.caughtUp(live);
            if(!live.host||['exited','error'].includes(live.info.status))throw new Error('Agent has exited');
            const lines=live.mirror.tail(REMOTE_SCREEN_ROWS).split('\n');
            const refused=answerRefusal({attached:live.attached,waiting:this.remoteWaiting(live),current:screenFingerprint(id,live.info.statusSince,lines),given:fingerprint,approvable:approvable(live.info.engine,lines)});
            if(refused)throw new Error(refused);
            live.host.write(keys(live.info.engine));
        }finally{this.sending.delete(id);}
    }
    // Folders a phone may start an agent in: where your agents run and your default folder, if they still exist.
    async remoteFolders():Promise<string[]>{
        let preferred:string|undefined;try{preferred=(await new SettingsStore(this.paths.root).get()).defaultCwd;}catch{this.log.error('Settings unreadable; the phone offers only your agents\' folders');}
        const folders=[...new Set([...(preferred?[preferred]:[]),...this.list().filter(s=>s.engine!=='shell').map(s=>s.cwd)])].slice(0,12);
        return (await Promise.all(folders.map(async folder=>await validCwd(folder)?folder:null))).filter((f):f is string=>f!==null);
    }
    // /find over every agent's mirror; per-agent and total caps keep one search to one small response.
    find(query:string):{matches:FindMatch[];more:boolean}{
        if(!isFindQuery(query))throw new Error('Invalid find request');
        const matches:FindMatch[]=[];let more=false;
        for(const live of this.sessions.values()){
            if(live.mirrorFailed)continue;
            const found=live.mirror.find(query,MAX_FIND_PER_AGENT+1);
            if(found.length>MAX_FIND_PER_AGENT)more=true;
            for(const match of found.slice(0,MAX_FIND_PER_AGENT)){if(matches.length>=MAX_FIND_RESULTS){more=true;break;}matches.push({sessionId:live.info.id,...match});}
        }
        return {matches,more};
    }
    async snapshot(id: string, publish?: (snapshot: string, size:{cols:number;rows:number}) => void): Promise<string> { const live = this.sessions.get(id); if (!live)
        throw new Error('Session not found'); return live.output.then(() => { const snapshot = live.mirror.snapshot(); publish?.(snapshot,{cols:live.mirror.terminal.cols,rows:live.mirror.terminal.rows}); return snapshot; }); }
    async text(id:string,lastReply=false):Promise<import('../shared/protocol.js').SessionText>{
        if(!isUUID(id))throw new Error('Invalid session UUID');const live=this.sessions.get(id);if(!live)throw new Error('Session not found');
        return live.output.then(()=>{
            if(lastReply&&live.info.engine!=='shell'&&live.lastReply!==undefined){
                // eslint-disable-next-line no-control-regex -- Explicit copy strips controls before reaching a clipboard.
                const text=stripVTControlCharacters(live.lastReply).replace(/\r\n?/g,'\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\p{Zl}\p{Zp}]|(?!\u200d)\p{Cf}/gu,'');
                return {sessionId:id,text,truncated:false,source:'last-reply' as const};
            }
            return {sessionId:id,...live.mirror.plainText()};
        });
    }
    // v0.7.2 checkpoints, /undo and /redo. One checkpoint, undo or redo at a time per agent; a failure is logged and the
    // agent goes on (a checkpoint is a convenience, never a reason to stop work).
    private checkpointQueues=new Map<string,Promise<unknown>>();
    private inCheckpointQueue<T>(id:string,work:()=>Promise<T>):Promise<T>{
        const next=(this.checkpointQueues.get(id)??Promise.resolve()).then(work,work);
        const settled=next.then(()=>undefined,()=>undefined);this.checkpointQueues.set(id,settled);
        void settled.then(()=>{if(this.checkpointQueues.get(id)===settled)this.checkpointQueues.delete(id);});
        return next;
    }
    private checkpointSlug(live:Live):string{
        if(!live.info.worktree||!live.info.branch?.startsWith('ai/'))throw new CheckpointError('This agent has no worktree; checkpoints need one');
        return live.info.branch.slice(3);
    }
    // The key that signs AI Term's own checkpoint commits, in ~/.ai-term/checkpoint.key (0600, 32 random bytes). It stops
    // ref forgery by an agent that never reads it (a sandboxed one can't write the repository's refs anyway); a same-user
    // process that reads it can sign refs (D35), and every restore is still confined to that agent's worktree and asked.
    // Read without following a symlink or blocking on a FIFO; made once, atomically (a temp file linked into place);
    // garbled: replaced (older checkpoints then no longer count, which only ever hides them).
    private checkpointKeyFile?:Promise<Buffer>;
    private checkpointKey():Promise<Buffer>{
        const loading=this.checkpointKeyFile??(this.checkpointKeyFile=this.loadCheckpointKey());
        loading.catch(()=>{if(this.checkpointKeyFile===loading)this.checkpointKeyFile=undefined;});
        return loading;
    }
    private async loadCheckpointKey():Promise<Buffer>{
        const path=join(this.paths.root,'checkpoint.key');
        try{
            const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
            try{const info=await file.stat();if(info.isFile()&&info.size<=128){const text=(await file.readFile('utf8')).trim();if(/^[0-9a-f]{64}$/.test(text))return Buffer.from(text,'hex');}}finally{await file.close();}
            this.log.error('Checkpoint key unreadable; replaced');await unlink(path);
        }catch(error){if(!isFsError(error,'ENOENT'))throw error;}
        const key=randomBytes(32),temp=`${path}.${randomBytes(6).toString('hex')}`;
        const file=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
        try{await file.writeFile(key.toString('hex')+'\n');await file.sync();}finally{await file.close();}
        try{await link(temp,path);}catch(error){if(!isFsError(error,'EEXIST'))throw error;await unlink(temp);return this.loadCheckpointKey();}
        await unlink(temp);
        return key;
    }
    // The repository AI Term recorded for this agent's worktree, and the signing key: what every checkpoint step is bound to.
    async checkpointContext(id:string):Promise<CheckpointContext>{
        const live=this.sessions.get(id);if(!live)throw new Error('Session not found');
        this.checkpointSlug(live);
        const repo=live.info.worktree?this.worktreeRecords.get(live.info.worktree)?.repo:undefined;
        if(!repo)throw new CheckpointError('This agent has no worktree; checkpoints need one');
        return {repo,key:await this.checkpointKey(),scope:this.worktreeRecords.get(live.info.worktree??'')?.createdAt??''};
    }
    async checkpointTurn(id:string):Promise<void>{
        const live=this.sessions.get(id);if(!live||!live.info.worktree)return;
        let settings:Settings|null=null;try{settings=await new SettingsStore(this.paths.root).get();}catch{this.log.error('Settings unreadable; checkpoints stay on');}
        if(settings?.checkpoints===false)return;
        await this.inCheckpointQueue(id,async()=>{
            try{const path=live.info.worktree;if(!path)return;await snapshot(path,this.checkpointSlug(live),await this.checkpointContext(id));live.checkpointFailed=false;}
            // The reason goes to the log (an error class and code, never a path); /undo says a checkpoint failed (gate).
            catch(error){live.checkpointFailed=true;this.log.error(`Checkpoint failed; the agent goes on (${error instanceof Error?error.constructor.name:'unknown'}${error instanceof Error&&'code' in error?` ${String(error.code)}`:''})`);}
        });
    }
    // Refused while the agent works or asks you something: checked when asked, and again in the agent's queue right
    // before the restore (a turn may have started while it waited behind a checkpoint).
    private async undoTarget(id:string):Promise<{live:Live;path:string;slug:string;ctx:CheckpointContext}>{
        if(!isUUID(id))throw new Error('Invalid session UUID');
        const live=this.sessions.get(id);if(!live)throw new Error('Session not found');
        let settings:Settings|null=null;try{settings=await new SettingsStore(this.paths.root).get();}catch{this.log.error('Settings unreadable; checkpoints stay on');}
        if(settings?.checkpoints===false)throw new CheckpointError('Checkpoints are off · /settings u turns them on');
        this.undoIdle(live);this.undoNoTests(id);
        const slug=this.checkpointSlug(live),path=live.info.worktree??'',ctx=await this.checkpointContext(id);
        return {live,path,slug,ctx};
    }
    // Gate: test code runs in this worktree while its tests run, and could swap a folder for a link while a restore writes.
    private undoNoTests(id:string):void{if(this.testRuns.has(id))throw new CheckpointError('Tests are running in this worktree; /undo or /redo when they finish');}
    private undoIdle(live:Live):void{
        if(['running','starting'].includes(live.info.status))throw new CheckpointError('Stop or wait for the agent first; it is running');
        if(live.info.status==='waiting')throw new CheckpointError('Stop or wait for the agent first; it is asking');
    }
    async undoPlan(id:string,kind:'undo'|'redo'):Promise<UndoPlan>{
        const {live,path,slug,ctx}=await this.undoTarget(id);
        return this.inCheckpointQueue(id,()=>undoPlan(path,slug,kind,ctx,live.info.title).catch((error:unknown)=>{
            if(error instanceof CheckpointError&&error.message==='No checkpoint to go back to'&&live.checkpointFailed)throw new CheckpointError("No checkpoint to go back to; the last checkpoint failed (AI Term's log says why)");
            throw this.undoError(error);}));
    }
    async undo(id:string,kind:'undo'|'redo',fingerprint:string):Promise<{restored:number}>{
        const {live,path,slug,ctx}=await this.undoTarget(id);
        return this.inCheckpointQueue(id,async()=>{this.undoIdle(live);this.undoNoTests(id);return applyUndo(path,slug,kind,fingerprint,ctx).catch((error:unknown)=>{throw this.undoError(error);});});
    }
    private undoError(error:unknown):Error{
        if(error instanceof CheckpointError)return error;
        this.log.error(`Undo failed: ${error instanceof GitError?error.message:'unexpected error'}`);
        return new CheckpointError('Undo unavailable; git could not read the worktree');
    }
    // v0.7.3 /merge and /pr: your own git (global config, PATH, HOME, ssh agent), never a key. Tests set a temp one.
    private userGit:UserGit={globalConfig:process.env.GIT_CONFIG_GLOBAL??join(homedir(),'.gitconfig'),env:Object.fromEntries(['PATH','HOME','USER','LOGNAME','SSH_AUTH_SOCK','LANG','LC_ALL','TMPDIR'].flatMap(name=>{const value=process.env[name];return value?[[name,value]]:[];}))};
    setUserGit(user:UserGit):void{this.userGit=user;}
    // The agent's branch, the base it started from and the repository recorded for its worktree; never while it works or asks.
    private async mergeTarget(id:string):Promise<MergeTarget>{
        if(!isUUID(id))throw new Error('Invalid session UUID');
        const live=this.sessions.get(id);if(!live)throw new Error('Session not found');
        this.undoIdle(live);
        const record=live.info.worktree?this.worktreeRecords.get(live.info.worktree):undefined;
        if(!record?.repo||!record.baseBranch||!live.info.branch||!live.info.worktree)throw new MergeError('This agent has no worktree branch to merge');
        let settings:Settings|null=null;try{settings=await new SettingsStore(this.paths.root).get();}catch{this.log.error('Settings unreadable; the secret scan stays on');}
        return {title:live.info.title,repo:record.repo,worktree:live.info.worktree,branch:live.info.branch,base:record.baseBranch,scan:settings?.secretScan!==false};
    }
    private mergeError(error:unknown):Error{
        // The reason under a fixed message is logged by its class or code only, never its text (git's stderr isn't kept).
        if(error instanceof MergeError){const cause=error.cause;if(cause)this.log.error(`Merge or PR step failed (${cause instanceof Error?cause.constructor.name:'unknown'}${cause&&typeof cause==='object'&&'code'in cause&&typeof cause.code==='string'?` ${cause.code}`:''})`);return error;}
        if(error instanceof CheckpointError)return error;
        this.log.error(`Merge or PR failed: ${error instanceof GitError?error.message:'unexpected error'}`);
        return new MergeError('Merge unavailable; git could not read the repository');
    }
    async mergePlan(id:string):Promise<MergePlan>{const t=await this.mergeTarget(id);return this.inCheckpointQueue(id,()=>mergePlan(t).catch((e:unknown)=>{throw this.mergeError(e);}));}
    async merge(id:string,fingerprint:string,override:boolean):Promise<{commit:string}>{const t=await this.mergeTarget(id);return this.inCheckpointQueue(id,()=>merge(t,fingerprint,override,this.userGit).catch((e:unknown)=>{throw this.mergeError(e);}));}
    async prPlan(id:string):Promise<PrPlan>{const t=await this.mergeTarget(id);return this.inCheckpointQueue(id,()=>prPlan(t,this.userGit).catch((e:unknown)=>{throw this.mergeError(e);}));}
    async pr(id:string,fingerprint:string,override:boolean):Promise<{url:string}>{const t=await this.mergeTarget(id);return this.inCheckpointQueue(id,()=>openPr(t,fingerprint,override,this.userGit).catch((e:unknown)=>{throw this.mergeError(e);}));}
    // v0.7.4 auto-test (D55, on). The project is your checkout (the repository AI Term recorded for a worktree, else the
    // folder's own); its command is kept in settings as an argument list and runs in the agent's worktree.
    private testRuns=new Map<string,AbortController>();
    private async projectOf(cwd:string):Promise<string>{
        for(const [path,record]of this.worktreeRecords)if(record.repo&&pathInside(path,cwd))return projectRepo(record.repo);
        // An agent's worktree AI Term has no record of: its .git file (the agent's to write) could name any repository.
        const worktrees=join(this.paths.root,'worktrees');
        if(pathInside(worktrees,cwd))throw new TestRunError("Set /test-cmd from your checkout; this folder is an agent's worktree AI Term has no record of");
        return projectRepo(cwd);
    }
    async testCommand(cwd:string):Promise<ProjectTestCommand>{
        const repo=await this.projectOf(cwd),settings=await new SettingsStore(this.paths.root).get();
        return {repo,command:Object.hasOwn(settings.testCommands??{},repo)?settings.testCommands?.[repo]??null:null};
    }
    async setTestCommand(cwd:string,command:string[]|null):Promise<ProjectTestCommand>{
        const repo=await this.projectOf(cwd);
        await new SettingsStore(this.paths.root).update(async settings=>{const next={...settings.testCommands??{}};if(command)next[repo]=command;else delete next[repo];return {...settings,testCommands:next};});
        return {repo,command};
    }
    // B26: whether the project's sandboxed tests may reach 127.0.0.1 (off by default; l in /test).
    async setTestLoopback(cwd:string,allowed:boolean):Promise<{repo:string;loopback:boolean}>{
        const repo=await this.projectOf(cwd);
        await new SettingsStore(this.paths.root).update(async settings=>{const others=(settings.testLoopback??[]).filter(r=>r!==repo);return {...settings,testLoopback:allowed?[...others,repo]:others};});
        return {repo,loopback:allowed};
    }
    // The run's sandbox, or null when this Mac can't give one (not macOS, no sandbox-exec, a path no profile can hold, or a
    // profile the system refuses): then nothing runs by itself. The caller disposes what it gets.
    // loopback: a dev server listens on 127.0.0.1 whatever the project's test switch says (v0.9.2).
    // readable: more folders the run may read but never write (/bisect's dependency folders that couldn't be cloned, B32/B33).
    private async sandboxFor(path:string,repo:string|undefined,force?:{loopback:boolean;ports?:number[]},readable:readonly string[]=[]):Promise<PreparedSandbox|null>{
        // Windows has no sandbox: said as it is, not as a path that couldn't go into a profile (gate).
        if(process.platform==='win32'){this.log.error('Test sandbox: Windows has none; tests ask first');return null;}
        let loopback=false;
        if(force)loopback=force.loopback;else if(repo)try{loopback=(await new SettingsStore(this.paths.root).get()).testLoopback?.includes(await projectRepo(repo))===true;}catch{this.log.error('Settings unreadable; tests run without 127.0.0.1');}
        // The repository's git folder stays readable (a worktree's .git file points into it); the rest of home doesn't.
        let gitDir:string|undefined;
        if(repo)try{gitDir=await repoCommonDir(repo);}catch{this.log.error('Test sandbox: the repository\'s git folder is unknown; git inside tests may fail');}
        let box:PreparedSandbox;
        try{box=await prepareSandbox(path,{home:homedir(),private:[this.paths.root],loopback,...(force?.ports?{ports:force.ports}:{}),...(SessionManager.sandboxExec?{program:SessionManager.sandboxExec}:{}),env:buildTestEnv(process.env),readable:[...gitDir?[gitDir]:[],...readable],log:text=>this.log.error(text)});}
        catch(error){this.log.error(error instanceof SandboxPathError?'Test sandbox: a path can\'t go into a profile; tests ask first':'Test sandbox: its temp folder could not be made; tests ask first');return null;}
        if(await sandboxReady(box.profile,box.program,box.prefix))return box;
        this.log.error('Test sandbox unavailable; tests ask first');
        await box.dispose().catch(()=>this.log.error('Test sandbox: its temp folder could not be removed'));
        return null;
    }
    // The agent's worktree, its recorded start and the project's command; null when there's nothing to run.
    private async testTarget(live:Live):Promise<{path:string;base:string;repo?:string;command:string[]}|null>{
        const record=live.info.worktree?this.worktreeRecords.get(live.info.worktree):undefined;
        if(!record?.repo)return null;
        const command=(await this.testCommand(record.repo)).command;
        if(!command)return null;
        const {path,base,repo}=await this.diffTarget(live);
        return {path,base,...(repo?{repo}:{}),command};
    }
    private setTests(live:Live,tests:SessionInfo['tests']|undefined):void{
        if(tests)live.info.tests=tests;else delete live.info.tests;
        if(this.sessions.get(live.info.id)!==live)return;
        this.event({kind:'session.updated',session:{...live.info}});void this.persist();
    }
    // After a finished turn: the tests, unless the agent changed the test setup (then the card asks for /test). Errors
    // are logged and the agent goes on; tests are a check, never a reason to stop work.
    // A turn end that arrives while the last one is still handled (auto-review can take two minutes) runs right after it.
    private turnEnds=new Set<string>();private turnEndsAgain=new Set<string>();
    async afterTurn(id:string):Promise<void>{
        const live=this.sessions.get(id);if(!live||live.info.status!=='done')return;
        if(this.turnEnds.has(id)){this.turnEndsAgain.add(id);return;}
        this.turnEnds.add(id);
        try{
            let settings:Settings;try{settings=await new SettingsStore(this.paths.root).get();}catch{this.log.error('Settings unreadable; auto-test skipped');this.testsFailed(live);return;}
            // Auto-review (off by default) reads the diff before the tests run (they may write files into the worktree).
            if(settings.autoReview===true&&settings.reviewModel)await this.autoReview(live,settings,settings.reviewModel);
            // An add-on that keeps tests green (/fix, /cover, /refactor) runs them even with auto-test off (v1.1).
            if(settings.autoTest===false&&!this.addons.wantsTests(id))return;
            const target=await this.testTarget(live);if(!target)return;
            const setup=await testSetup(target.path,target.base,target.repo,target.command);
            // The agent went back to work (or away) while this was checked: its next turn end decides.
            if(live.info.status!=='done'||this.sessions.get(id)!==live)return;
            // B26: code the agent wrote never runs outside a sandbox without asking; without one, /test asks every time.
            const box=await this.sandboxFor(target.path,target.repo);
            if(!box){this.setTests(live,{state:'nosandbox'});return;}
            if(live.info.status!=='done'||this.sessions.get(id)!==live||setup.changed.length&&(setup.unverifiable||setup.fingerprint!==live.approvedSetup)){
                await box.dispose().catch(()=>this.log.error('Test sandbox: its temp folder could not be removed'));
                if(live.info.status==='done'&&this.sessions.get(id)===live)this.setTests(live,{state:'ask',changed:setup.changed.slice(0,MAX_TEST_CHANGED)});
                return;
            }
            await this.startTests(live,target.command,target.path,box,setup.unverifiable?undefined:target);
        }catch(error){
            // Said on the card (`✗ tests couldn't start`), not only in the log: a turn with no result reads as untested.
            this.log.error(`Auto-test skipped (${error instanceof Error?error.constructor.name:'unknown'}${error instanceof Error&&'code' in error?` ${String(error.code)}`:''})`);
            this.testsFailed(live);
        }
        finally{this.turnEnds.delete(id);if(this.turnEndsAgain.delete(id))void this.afterTurn(id);}
    }
    private testsFailed(live:Live):void{if(live.info.status==='done'&&this.sessions.get(live.info.id)===live)this.setTests(live,{state:'error'});}
    async testPlan(id:string):Promise<TestPlan>{const {plan,box}=await this.testPlanSetup(id);await box?.dispose().catch(()=>this.log.error('Test sandbox: its temp folder could not be removed'));return plan;}
    private async testPlanSetup(id:string):Promise<{plan:TestPlan;unverifiable:boolean;setup:string;box:PreparedSandbox|null;target:{path:string;base:string;repo?:string;command:string[]}}>{
        if(!isUUID(id))throw new Error('Invalid session UUID');
        const live=this.sessions.get(id);if(!live)throw new Error('Session not found');
        this.undoIdle(live);
        if(!live.info.worktree)throw new TestRunError('This agent has no worktree to test');
        let target;
        try{target=await this.testTarget(live);}catch(error){this.log.error('Test plan: git could not read the worktree');throw new TestRunError('Tests unavailable; git could not read the worktree',{cause:error});}
        if(!target)throw new TestRunError('No test command for this project · /test-cmd <command>');
        let setup:import('./test-run.js').TestSetup;
        try{setup=await testSetup(target.path,target.base,target.repo,target.command);}catch(error){this.log.error('Test plan: git could not read the worktree');throw new TestRunError('Tests unavailable; git could not read the worktree',{cause:error});}
        const box=await this.sandboxFor(target.path,target.repo),loopback=box?.spec.loopback??false;
        // The fingerprint covers the sandbox too: y never runs unsandboxed (or with 127.0.0.1) a plan shown otherwise.
        const fingerprint=createHash('sha256').update(setup.fingerprint).update(`\0sandbox=${box?'on':'off'}\0loopback=${loopback}`).digest('hex');
        return {plan:{title:live.info.title,command:target.command,cwd:target.path,changed:setup.changed.slice(0,MAX_TEST_CHANGED),fingerprint,sandbox:!!box,loopback},unverifiable:setup.unverifiable,setup:setup.fingerprint,box,target};
    }
    // Runs exactly what /test showed; the result arrives on the card.
    async runTestPlan(id:string,fingerprint:string):Promise<void>{
        // Everything that can fail is worked out before the sandbox exists (testPlanSetup); from here it is used or removed.
        const {plan,unverifiable,setup,box,target}=await this.testPlanSetup(id),live=this.sessions.get(id);
        if(!live||plan.fingerprint!==fingerprint){await box?.dispose().catch(()=>this.log.error('Test sandbox: its temp folder could not be removed'));throw new TestRunError('The test setup changed since it was shown; run /test again');}
        // You approved this setup: later sandboxed turns that leave it as it is run without asking again (unless part of it
        // can't be checked, like a link out of the worktree: then every turn asks). Without a sandbox your y is for this run.
        if(box)live.approvedSetup=unverifiable?undefined:setup;
        void this.startTests(live,plan.command,plan.cwd,box,unverifiable||!box?undefined:target);
    }
    // target: given when the run started from a setup you approved (or one with nothing to ask about); what the run itself
    // wrote (build output, caches) then becomes the approved setup, so the next turn asks only about the agent's changes.
    // box: the run's sandbox; null only for a run you approved in /test knowing there was none.
    private async startTests(live:Live,command:string[],cwd:string,box:PreparedSandbox|null,target?:{path:string;base:string;repo?:string;command:string[]}):Promise<void>{
        this.cancelTests(live.info.id,false);
        const controller=new AbortController();this.testRuns.set(live.info.id,controller);
        this.setTests(live,{state:'running'});
        let outcome:import('./test-run.js').TestOutcome;
        try{outcome=await runTests(command,cwd,{...buildTestEnv(process.env),...box?.env},{signal:controller.signal,log:text=>this.log.error(text),...(box?{sandbox:box}:{})});}
        catch{this.log.error('Test command could not start');outcome={state:'error'};}
        finally{await box?.dispose().catch(()=>this.log.error('Test sandbox: its temp folder could not be removed'));}
        if(outcome.state==='nosandbox')this.log.error('Test sandbox refused its profile; tests ask first');
        if(this.testRuns.get(live.info.id)===controller)this.testRuns.delete(live.info.id);
        // Cancelled: the agent works again (or went away); its result is cleared there.
        if(outcome.state==='cancelled'||controller.signal.aborted)return;
        if(outcome.state==='error')this.log.error('Test command could not start');
        if(target&&outcome.state!=='nosandbox')try{const after=await testSetup(target.path,target.base,target.repo,target.command);live.approvedSetup=after.unverifiable?undefined:after.fingerprint;}catch{this.log.error('Test setup unreadable after the run; the next turn asks');live.approvedSetup=undefined;}
        this.setTests(live,outcome);
    }
    // keep: a result already shown stays (the agent was removed or the daemon stops); else it is cleared with the run.
    cancelTests(id:string,keep=false):void{
        this.testRuns.get(id)?.abort();this.testRuns.delete(id);
        const live=this.sessions.get(id);if(!keep&&live?.info.tests)this.setTests(live,undefined);
    }
    // v0.7.4 /review: the diff as the reviewer will read it, the token range and the models you may pick (D49 asks with
    // this); the fingerprint is the reviewed text's, so ⏎ reviews exactly the diff the ask described.
    private reviewResults=new Map<string,ReviewResult>();
    private reviewing=new Set<string>();
    private reviewedDiff=new Map<string,string>();
    private autoReviews?:AutoReviewLedger;
    private async reviewInput(id:string):Promise<{live:Live;prompt:string;fingerprint:string;plan:Omit<ReviewPlan,'models'|'selected'>;writers:import('./handoff.js').KeyedWriter[];settings:Settings}>{
        if(!isUUID(id))throw new Error('Invalid session UUID');
        const live=this.sessions.get(id);if(!live)throw new Error('Session not found');
        this.undoIdle(live);
        const diff=await this.diff(id);
        if(!diff.files.length)throw new ReviewError('The diff is empty; nothing to review');
        const text=diffForReview(diff),prompt=reviewPrompt(text),tokens=estimateTokens(prompt),settings=await new SettingsStore(this.paths.root).get();
        const plan={title:live.info.title,files:diff.files.length,added:diff.added,removed:diff.removed,cut:diff.capped||text.includes('(the diff is cut here:'),
            inputTokens:{low:Math.round(tokens*0.8),high:Math.round(tokens*1.25)},outputTokens:{low:200,high:REVIEW_OUTPUT_TOKENS},fingerprint:createHash('sha256').update(text).digest('hex')};
        return {live,prompt,fingerprint:plan.fingerprint,plan,writers:reviewWriters(await this.keys.list(),settings,this.handoffWriter.prices),settings};
    }
    // v1.0.2 /brain. The repository is the one the folder belongs to (a worktree maps its main repository).
    private brainBuilding=new Set<string>();
    private async brainRepo(cwd:string):Promise<string>{
        try{return await projectRepo(cwd);}catch(error){if(error instanceof TestRunError)throw new BrainError("This folder isn't in a git repository; /brain maps one",{cause:error});throw error;}
    }
    // Old maps get a safe index on demand, so a prior whole-map setting can stay on without injecting the whole map.
    private async brainFor(cwd:string,trusted:boolean):Promise<{file:string;builtAt:string}|null>{
        try {
            const top=await this.brainRepo(cwd),index=await readBrain(this.paths.root,top);
            if(!index)return null;
            return {file:await writeBrainIndex(this.paths.root,top,index,trusted,true),builtAt:index.builtAt};
        }catch(error){if(error instanceof BrainError&&error.message.includes("isn't in a git"))return null;this.log.error('Brain: index unavailable; the agent starts without it');return null;}
    }
    async brainPreferences(cwd:string, knownSettings?:Settings):Promise<{agents:boolean;trusted:boolean}>{
        const settings=knownSettings??await new SettingsStore(this.paths.root).get();
        let top:string;
        try{top=await this.brainRepo(cwd);}catch(error){if(error instanceof BrainError&&error.message.includes("isn't in a git"))return {agents:settings.brainForAgents===true,trusted:false};throw error;}
        const saved=settings.brainRepositories?.[repoDirectory(top)];
        return {agents:saved?.agents??settings.brainForAgents===true,trusted:saved?.trusted===true};
    }
    async setBrainPreferences(cwd:string,patch:{agents?:boolean;trusted?:boolean}):Promise<void>{
        const top=await this.brainRepo(cwd),id=repoDirectory(top);
        await serialize('brain:'+top,async()=>{
            const settings=await new SettingsStore(this.paths.root).update(async current=>({...current,brainRepositories:{...current.brainRepositories,[id]:{...current.brainRepositories?.[id],...patch}}}));
            const index=await readBrain(this.paths.root,top);
            if(index)await writeBrainIndex(this.paths.root,top,index,settings.brainRepositories?.[id]?.trusted===true);
        });
    }
    private async brainInput(cwd:string){
        const top=await this.brainRepo(cwd),previous=await readBrain(this.paths.root,top),scan=await scanRepo(top,previous),settings=await new SettingsStore(this.paths.root).get();
        // Modules to summarize: TS/JS and Python files new or changed since the last map (or every one, the first time a
        // model pass runs, so a map built locally first still gets its summaries).
        const trusted=settings.brainRepositories?.[repoDirectory(top)]?.trusted===true;
        const pending=trusted?Object.keys(scan.index.files).filter(path=>scan.index.files[path]?.lang!=='other'&&!scan.index.files[path]?.summary):[];
        const batches:{path:string;text:string}[][]=[];let batch:{path:string;text:string}[]=[],size=0;
        for(const path of pending){
            const text=scan.texts.get(path)??await this.brainText(top,path,scan.index.files[path]?.hash??'');if(text===null)continue;
            const cut=text.slice(0,BRAIN_SUMMARY_FILE_CHARS);
            if(size+cut.length>BRAIN_BATCH_CHARS&&batch.length){batches.push(batch);batch=[];size=0;}
            batch.push({path,text:cut});size+=cut.length;
        }
        if(batch.length)batches.push(batch);
        const prompts=batches.map(files=>({prompt:brainPrompt(files),paths:files.map(f=>f.path)}));
        const tokens=prompts.reduce((sum,p)=>sum+estimateTokens(p.prompt),0),files=prompts.reduce((sum,p)=>sum+p.paths.length,0);
        const inputTokens={low:Math.round(tokens*0.8),high:Math.round(tokens*1.25)},outputTokens={low:files*BRAIN_OUTPUT_PER_FILE.low,high:files*BRAIN_OUTPUT_PER_FILE.high+prompts.length*300};
        const writers=files?reviewWriters(await this.keys.list(),settings,this.handoffWriter.prices):[];
        // What you approved: the files and their hashes, what is left to summarize and the map it builds on (review: a
        // /brain rm or another build between plan and build changed what would be sent).
        const fingerprint=createHash('sha256').update(JSON.stringify([top,Object.entries(scan.index.files).map(([path,file])=>[path,file.hash]),scan.removed,scan.index.skipped,prompts.map(p=>p.paths),previous?.builtAt??null,trusted])).digest('hex');
        return {top,previous,scan,settings,prompts,inputTokens,outputTokens,writers,fingerprint,files,trusted};
    }
    // A file's text for the model pass when the scan kept it from the last map (unchanged, but never summarized).
    // Only the very text that was hashed: a file changed since the scan waits for the next /brain (review).
    private async brainText(top:string,path:string,hash:string):Promise<string|null>{const read=await readRepoFile(top,path);return read.kind==='file'&&read.hash===hash?read.text.slice(0,BRAIN_SUMMARY_FILE_CHARS):null;}
    async brainPlan(cwd:string):Promise<BrainPlan>{
        const input=await this.brainInput(cwd),{scan,previous,settings,writers}=input;
        const last=settings.reviewModel,selected=writers.length?Math.max(0,writers.findIndex(w=>w.key.id===last?.keyId&&w.model===last.model)):0;
        return {repo:input.top,files:Object.keys(scan.index.files).length,changed:previous?scan.parsed.length:Object.keys(scan.index.files).length,removed:scan.removed.length,skipped:scan.index.skipped,builtAt:previous?.builtAt??null,
            summarize:input.files,inputTokens:input.inputTokens,outputTokens:input.outputTokens,models:writers.map(w=>reviewModelView(w,input.inputTokens,input.outputTokens)),selected,fingerprint:input.fingerprint,agents:settings.brainRepositories?.[repoDirectory(input.top)]?.agents??settings.brainForAgents===true,trusted:input.trusted};
    }
    // The plan you saw, and only that one: a repository that changed since refuses. The model pass is held against the
    // budgets request by request, and its worst case must fit the per-run cap (/settings c).
    async buildBrain(cwd:string,fingerprint:string,model?:{keyId:string;model:string}):Promise<BrainResult>{
        const input=await this.brainInput(cwd),{top,scan,settings}=input;
        if(model&&!input.trusted)throw new BrainError('Model summaries need /brain trust first');
        if(input.fingerprint!==fingerprint)throw new BrainError('The repository changed since the plan was shown; run /brain again');
        if(this.brainBuilding.has(top))throw new BrainError('A /brain build for this repository is already running');
        const writer=model?input.writers.find(w=>w.key.id===model.keyId&&w.model===model.model):undefined;
        if(model&&!writer)throw new BrainError('Pick one of the models /brain offered');
        this.brainBuilding.add(top);
        try{
            const index=scan.index;let summarized=0,costUsd:number|null=null;
            if(writer&&input.prompts.length){
                const worst=reviewModelView(writer,input.inputTokens,input.outputTokens).priceUsd.high;
                // An empty cap (null) is no cap, as for agents.
                const cap=settings.agentCaps?settings.agentCaps.spendUsd:DEFAULT_AGENT_CAPS.spendUsd;
                if(cap!==null&&worst>cap)throw new BrainError("The brain's model pass would pass the per-run cap in /settings c");
                const decisions:string[]=[];costUsd=0;const job=randomUUID();
                // Earlier design notes first; new ones after (review: a small rescan pushed out the whole-repo ones).
                const merge=()=>{index.design=[...new Set([...index.design,...decisions])].slice(0,BRAIN_MAX_DECISIONS);index.model=writer.model;};
                try{for(const part of input.prompts){
                    if(!(await this.brainPreferences(cwd)).trusted)throw new BrainError('Model pass stopped: repository is untrusted');
                    const tokens=estimateTokens(part.prompt),share={low:Math.round(tokens*0.8),high:Math.round(tokens*1.25)};
                    const out={low:part.paths.length*BRAIN_OUTPUT_PER_FILE.low,high:part.paths.length*BRAIN_OUTPUT_PER_FILE.high+300};
                    const written=await this.keyedRequest(job,writer,part.prompt,{worst:reviewModelView(writer,share,out).priceUsd.high,maxOutput:out.high,what:'brain'},settings);
                    const read=parseSummaries(written.text,part.paths);
                    for(const [path,summary] of Object.entries(read.summaries)){const file=index.files[path];if(file){index.files[path]={...file,summary};summarized++;}}
                    decisions.push(...read.decisions);costUsd+=written.summary.costUsd??0;
                }}catch(error){
                    // A request that failed partway keeps what the earlier ones paid for: the map is written with them.
                    if(summarized||decisions.length){merge();await this.publishBrain(top,index).catch(()=>{this.log.error('Brain: the partial map could not be saved');});}
                    throw error;
                }
                merge();
            }
            const written=await this.publishBrain(top,index);
            return {repo:top,path:written.path,lines:written.lines,files:Object.keys(index.files).length,changed:input.previous?scan.parsed.length:Object.keys(index.files).length,summarized,costUsd,model:writer?.model??null};
        }finally{this.brainBuilding.delete(top);}
    }
    private publishBrain(top:string,index:import('../shared/brain.js').BrainIndex):Promise<{path:string;lines:number}>{
        return serialize('brain:'+top,async()=>{const preferences=await this.brainPreferences(top);return writeBrain(this.paths.root,top,index,new Date(),preferences.trusted);});
    }
    async brainShow(cwd:string):Promise<{repo:string;text:string;builtAt:string}>{
        const top=await this.brainRepo(cwd),{markdown}=brainPaths(this.paths.root,top);
        if(!await brainFolderSafe(this.paths.root,top))throw new BrainError('No brain for this repository yet · /brain builds one');
        let file;
        try{file=await open(markdown,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW|fsConstants.O_NONBLOCK);}catch(error){if(isFsError(error,'ENOENT'))throw new BrainError('No brain for this repository yet · /brain builds one',{cause:error});throw error;}
        try{const info=await file.stat();if(!info.isFile()||info.size>4*1024*1024)throw new BrainError('No brain for this repository yet · /brain builds one');return {repo:top,text:await file.readFile('utf8'),builtAt:info.mtime.toISOString()};}
        finally{await file.close();}
    }
    async brainRemove(cwd:string):Promise<boolean>{return removeBrain(this.paths.root,await this.brainRepo(cwd));}
    async setBrainForAgents(on:boolean):Promise<void>{await new SettingsStore(this.paths.root).update(async current=>({...current,brainForAgents:on}));}
    async reviewPlan(id:string):Promise<ReviewPlan>{
        const {plan,writers,settings}=await this.reviewInput(id);
        if(!writers.length)throw new ReviewError('No priced model among your keys · add an API key in /settings');
        const last=settings.reviewModel,selected=Math.max(0,writers.findIndex(w=>w.key.id===last?.keyId&&w.model===last.model));
        return {...plan,models:writers.map(w=>reviewModelView(w,plan.inputTokens,plan.outputTokens)),selected};
    }
    async review(id:string,keyId:string,model:string,fingerprint:string,auto=false):Promise<ReviewResult>{
        const {live,prompt,plan,writers,settings}=await this.reviewInput(id);
        if(plan.fingerprint!==fingerprint)throw new ReviewError('The diff changed since it was shown; run /review again');
        const writer=writers.find(w=>w.key.id===keyId&&w.model===model);
        if(!writer)throw new ReviewError('Pick one of the models /review offered');
        if(this.reviewing.has(id))throw new ReviewError('A review of this agent is already running');
        const worst=reviewModelView(writer,plan.inputTokens,plan.outputTokens).priceUsd.high,before=live.info.review;
        this.reviewing.add(id);this.setReview(live,{state:'running'});
        let written:{text:string;summary:HandoffSummary};
        try{written=await this.keyedRequest(id,writer,prompt,{worst,maxOutput:REVIEW_OUTPUT_TOKENS,what:'review'},settings);}
        catch(error){
            // Refused before anything was sent (a budget, the key): the card keeps what it showed. A failed request says so.
            // An agent back at work meanwhile has no review on its card.
            this.setReview(live,this.working(live)?undefined:error instanceof Error&&error.message==='The review request failed'?{state:'failed'}:before);
            throw error;
        }finally{this.reviewing.delete(id);}
        const text=reviewText(written.text),counts=countFindings(text);
        const result:ReviewResult={title:live.info.title,model:writer.model,text,counts,inputTokens:written.summary.inputTokens,outputTokens:written.summary.outputTokens,costUsd:written.summary.costUsd};
        this.reviewResults.set(id,result);
        // Back at work meanwhile: the diff it read is stale, so the card shows nothing (/review show still has it).
        if(this.working(live))this.setReview(live,undefined);
        else{this.reviewedDiff.set(id,fingerprint);this.setReview(live,{state:'done',...counts,...(auto?{auto:true as const}:{})});}
        // The model you picked is the default next time, and the one auto-review uses.
        if(!auto)await new SettingsStore(this.paths.root).update(async current=>({...current,reviewModel:{keyId,model}})).catch(()=>{this.log.error('Review model could not be saved as the default');});
        return result;
    }
    private working(live:Live):boolean{return ['starting','running','waiting'].includes(live.info.status);}
    async lastReview(id:string):Promise<ReviewResult>{
        const result=this.reviewResults.get(id);if(!result)throw new ReviewError('No review yet for this agent · /review <agent>');
        return result;
    }
    private setReview(live:Live,review:SessionInfo['review']|undefined):void{
        if(review)live.info.review=review;else delete live.info.review;
        if(this.sessions.get(live.info.id)!==live)return;
        this.event({kind:'session.updated',session:{...live.info}});void this.persist();
    }
    // Auto-review (D55, off): the model last picked in /review, once per new diff, while today's auto-reviews fit their
    // own daily budget (the usual budgets apply too). A skip or a failure is logged; the agent goes on.
    private async autoReview(live:Live,settings:Settings,pick:{keyId:string;model:string}):Promise<void>{
        const id=live.info.id;
        try{
            const plan=await this.reviewPlan(id);
            if(this.reviewedDiff.get(id)===plan.fingerprint)return;
            const model=plan.models.find(m=>m.keyId===pick.keyId&&m.model===pick.model);
            if(!model){this.log.error('Auto-review skipped: its model is no longer offered; pick one with /review');return;}
            const ledger=this.autoReviews??=new AutoReviewLedger(this.paths.root),worst=model.priceUsd.high;
            const hold=await ledger.take(worst,settings.autoReviewDailyUsd??1);
            if(!hold){this.log.error("Auto-review skipped: today's auto-review budget is used");return;}
            // Nothing sent (refused first): nothing spent. A request that failed after it was sent may have been billed.
            let spent=0;
            try{spent=(await this.review(id,pick.keyId,pick.model,plan.fingerprint,true)).costUsd??worst;}
            catch(error){if(error instanceof Error&&error.message==='The review request failed')spent=worst;throw error;}
            finally{await ledger.settle(hold,spent);}
        }catch(error){this.log.error(`Auto-review skipped (${error instanceof ReviewError||error instanceof CheckpointError?error.message:'unexpected error'})`);}
    }
    // v0.7.4 /fork: what would start (D49 asks with this), and the start itself. The new agent runs in its own worktree
    // from the commit the source started from, in the matching folder, always in Ask mode.
    private forkSource(id:string):{live:Live;record:WorktreeRecord;firstMessage:string;cwd:string}{
        if(!isUUID(id))throw new Error('Invalid session UUID');
        const live=this.sessions.get(id);if(!live)throw new Error('Session not found');
        if(live.info.engine==='shell')throw new ForkError('Only an AI agent can be forked');
        if(live.firstMessage===undefined)throw new ForkError("Fork needs the agent's first message; it started without one, or before the background service restarted");
        const record=live.info.worktree?this.worktreeRecords.get(live.info.worktree):undefined;
        if(!record?.repo||!record.baseCommit||!live.info.worktree)throw new ForkError('Fork needs an agent with a worktree, so the two can be compared');
        // The same folder inside the repository as the source (its worktree path swapped for your checkout's).
        const inside=live.info.cwd===live.info.worktree?'':live.info.cwd.startsWith(live.info.worktree+sep)?live.info.cwd.slice(live.info.worktree.length+1):'';
        return {live,record,firstMessage:live.firstMessage,cwd:inside?join(record.repo,inside):record.repo};
    }
    async forkPlan(id:string,target:ForkTarget):Promise<ForkPlan>{
        const {live,record,firstMessage}=this.forkSource(id);
        let authLabel:string,price:import('../shared/protocol.js').ModelPrice|undefined,subscription=false;
        if(target.auth.kind==='key'){
            const key=await this.keys.view(target.auth.keyId);authLabel=keyAuthLabel(key.provider,key.last4);
            if(target.model){const settings=await new SettingsStore(this.paths.root).get();price=findPrice(this.handoffWriter.prices,key.provider,target.model,overridesFor(settings,key.provider),key.provider==='foundry'?deploymentAlias(settings,target.model):undefined);}
        }else{
            const engine=target.engine==='ai-term'?null:target.engine,status=engine?await checkEngine(engine,process.env).catch(()=>null):null;
            subscription=status?.authMethod==='subscription';authLabel=target.auth.profile&&target.auth.profile!==OWN_ACCOUNT?`account ${target.auth.profile}`:ownLoginLabel(status?.authMethod);
        }
        const used=live.info.taskUsage?.tokens,tokens=used?{low:Math.round(used/2),high:used*2}:null;
        // Mostly input (an agent rereads its context each request): priced at 90% input, 10% output.
        const priceUsd=tokens&&price?{low:estimateCost(price,tokens.low*0.9,tokens.low*0.1)??0,high:estimateCost(price,tokens.high*0.9,tokens.high*0.1)??0}:null;
        const preview=cleanNote(firstMessage).replace(/\s+/g,' ');
        return {source:live.info.title,engine:target.engine,model:target.model,authLabel,firstMessage:[...preview].length>FORK_PREVIEW_CHARS?[...preview].slice(0,FORK_PREVIEW_CHARS).join('')+'…':preview,base:`${record.baseBranch??'start'} @ ${(record.baseCommit??'').slice(0,7)}`,tokens,priceUsd,subscription};
    }
    async fork(id:string,target:ForkTarget):Promise<SessionInfo>{
        const {live,record,firstMessage,cwd}=this.forkSource(id);
        const title=forkTitle(live.info.title);
        return this.create({engine:target.engine,model:target.model,...(target.effort!==undefined?{effort:target.effort}:{}),auth:target.auth,cwd,permission:'ask',title,firstMessage,useWorktree:true},undefined,{startCommit:record.baseCommit??''});
    }
    // v0.7.1 /export: the session's screen text (its end, ~1 MiB) and, for AI Term's own agent, its transcript, all redacted.
    async exportSession(id:string):Promise<SessionExport>{
        const text=await this.text(id),live=this.sessions.get(id);if(!live)throw new Error('Session not found');
        const info=live.info,clean=redactSecrets(text.text),cutText=clean.length>EXPORT_TEXT_CHARS;
        let transcript:SessionExport['transcript']=null,transcriptTruncated:boolean|undefined;
        if(info.engine==='ai-term'){
            try{const read=await transcriptFor(await agentTranscript(this.paths.root,id));transcript=read.entries;transcriptTruncated=read.truncated;}
            catch{this.log.error('Export: the agent transcript could not be read');transcript=[];transcriptTruncated=true;}
        }
        return fitExport(redactExportMeta({title:info.title,engine:info.engine,model:info.model,cwd:info.cwd,...(info.branch?{branch:info.branch}:{}),createdAt:info.createdAt,exportedAt:new Date().toISOString(),
            text:cutText?clean.slice(clean.length-EXPORT_TEXT_CHARS):clean,truncated:text.truncated||cutText,transcript,...(transcriptTruncated!==undefined?{transcriptTruncated}:{})}));
    }
    // v0.7.1 d and /diff: the agent's worktree against the commit it started from. Read-only; text only (src/daemon/diff.ts).
    async diff(id:string,against?:string):Promise<AgentDiff>{
        if(!isUUID(id)||against!==undefined&&!isUUID(against))throw new Error('Invalid session UUID');
        const live=this.sessions.get(id);if(!live)throw new Error('Session not found');
        const {path,base,label,repo}=against===undefined?await this.diffTarget(live):await this.compareTarget(live,against);
        let body;
        try{body=await worktreeDiff(path,base,repo);}catch(error){this.log.error(`Diff failed: ${error instanceof GitError?error.message:'unexpected error'}`);throw new Error('Diff unavailable; git could not read the worktree',{cause:error});}
        return {title:live.info.title,branch:live.info.branch??'',base:label,...body};
    }
    // v0.7.4 `/diff <agent> vs <other>`: this worktree against the other agent's last checkpoint (its worktree at its last
    // turn end), else its branch's last commit. Both worktrees must belong to the same repository AI Term recorded.
    private async compareTarget(live:Live,otherId:string):Promise<{path:string;base:string;label:string;repo?:string}>{
        if(otherId===live.info.id)throw new Error('Pick two different agents to compare');
        const other=this.sessions.get(otherId);if(!other)throw new Error('Session not found');
        const own=await this.diffTarget(live),theirs=await this.diffTarget(other),record=other.info.worktree?this.worktreeRecords.get(other.info.worktree):undefined;
        if(!own.repo||own.repo!==theirs.repo||!record?.repo)throw new Error('These agents are in different repositories');
        let checkpoint:import('./checkpoints.js').Checkpoint|undefined;
        try{checkpoint=(await listCheckpoints(theirs.path,this.checkpointSlug(other),await this.checkpointContext(otherId))).at(-1);}
        catch(error){if(!(error instanceof CheckpointError))this.log.error(`Compare: checkpoints unreadable (${error instanceof GitError?error.message:'unexpected error'})`);}
        if(checkpoint)return {path:own.path,base:checkpoint.commit,label:`${other.info.title} @ checkpoint ${checkpoint.n}`,repo:own.repo};
        let head:string;
        try{head=(await runGit(record.repo,[`--git-dir=${join(record.repo,'.git')}`,'rev-parse','--verify','--end-of-options',`refs/heads/${other.info.branch??''}^{commit}`],'Git check failed')).trim();}
        catch(error){this.log.error('Compare: the other branch is unreadable');throw new Error('Diff unavailable; git could not read the worktree',{cause:error});}
        if(!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head))throw new Error('Diff unavailable; git could not read the worktree');
        return {path:own.path,base:head,label:`${other.info.branch??other.info.title} @ ${head.slice(0,7)} (committed work only)`,repo:own.repo};
    }
    private async diffTarget(live:Live):Promise<{path:string;base:string;label:string;repo?:string}>{
        const path=live.info.worktree,record=path?this.worktreeRecords.get(path):undefined;
        if(!path||!live.info.branch)throw new Error('This agent has no worktree to diff');
        const base=record?.baseCommit;
        if(!base||!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(base))throw new Error('This worktree has no recorded start to diff against');
        // The folder must still be that worktree: an agent can rewrite its .git file to point somewhere else.
        if(!await isWorktreeTop(path))throw new Error('Diff unavailable; git could not read the worktree');
        return {path,base,label:`${record?.baseBranch??'start'} @ ${base.slice(0,7)}`,...(record?.repo?{repo:record.repo}:{})};
    }
    private async refreshDiffStat(live:Live):Promise<void>{
        // Only the latest count lands, and only while the agent is still listed and finished.
        const seq=live.diffStatSeq=(live.diffStatSeq??0)+1;
        try{const {path,base,repo}=await this.diffTarget(live),stat=await worktreeStat(path,base,repo);if(seq!==live.diffStatSeq||this.sessions.get(live.info.id)!==live||live.info.status!=='done')return;live.info.diffStat=stat;this.event({kind:'session.updated',session:{...live.info}});void this.persist();}
        catch{this.log.error('Diff stat unavailable for a finished agent');}
    }
    async stop(id: string): Promise<void> { const live = this.sessions.get(id); if (!live)
        throw new Error('Session not found'); await live.host?.stop(); await live.output; }
    async remove(id: string): Promise<void> { if (this.closing) throw new Error('Background service is stopping'); const live = this.sessions.get(id); if (!live)
        throw new Error('Session not found'); if (!['exited', 'error'].includes(live.info.status))
        throw new Error('Only exited sessions can be removed'); await this.stopDev(id); this.cancelTests(id,true); this.reviewResults.delete(id); this.reviewedDiff.delete(id); if(live.mirrorFailed)await this.stop(id); await live.output; await removeSessionFiles(this.paths.root,id);live.outputClock?.dispose();live.lastReply=undefined;live.mirror.dispose(); this.sessions.delete(id); await this.persist(); this.event({ kind: 'session.removed', sessionId: id }); }
    // A worktree shared by resumed agents belongs to whichever is still live, else the newest record.
    private worktreeAgent(path:string):SessionInfo|undefined{
        const agents=[...this.sessions.values()].map(s=>s.info).filter(info=>info.worktree===path);
        return agents.find(info=>!['exited','error'].includes(info.status))??agents.sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];
    }
    private async viewWorktree(record:WorktreeRecord):Promise<WorktreeView>{
        const {view}=await checkWorktree(this.paths.root,record,this.worktreeAgent(record.path),this.busyWorktrees.has(record.path));
        if(view.refusal==='Git check failed')this.log.error('Worktree check failed');
        return view;
    }
    async worktreeViews():Promise<WorktreeView[]>{
        const views:WorktreeView[]=[];
        for(const record of this.worktreeRecords.values())views.push(await this.viewWorktree(record));
        for(const path of await unrecordedFolders(this.paths.root,new Set(this.worktreeRecords.keys())))views.push({path,refusal:"Not in AI Term's record"});
        return views;
    }
    async checkWorktree(path:string):Promise<WorktreeView>{
        const record=this.worktreeRecords.get(path);
        return record?this.viewWorktree(record):{path,refusal:"Not in AI Term's record"};
    }
    async deleteWorktree(path:string,fingerprint:string,confirm?:string):Promise<void>{
        const record=this.worktreeRecords.get(path);
        if(!record)throw new WorktreeError("Not in AI Term's record");
        if(this.busyWorktrees.has(path))throw new WorktreeError('Worktree is busy');
        this.busyWorktrees.add(path);
        try{
            // The agent is read inside the queue, so a start or resume that finished first is seen.
            await serialize(this.paths.root,()=>deleteWorktree(this.paths.root,record,this.worktreeAgent(path),{fingerprint,...(confirm?{confirm}:{})}));
            this.worktreeRecords.delete(path);
            await this.dropWorktreeCheckpoints(record);
        }catch(error){
            // The worktree itself is gone once its step succeeded; the kept branch stays in git for the user.
            if(error instanceof WorktreeError&&error.message==='Worktree removed; branch delete failed'){this.worktreeRecords.delete(path);await this.dropWorktreeCheckpoints(record);}
            throw error;
        }finally{this.busyWorktrees.delete(path);await this.persist();}
    }
    // v0.7.2: a worktree's checkpoints and redo go with it (after the unchanged v0.3.2 removal), from its repository.
    private async dropWorktreeCheckpoints(record:WorktreeRecord):Promise<void>{
        if(!record.repo||!record.branch.startsWith('ai/'))return;
        try{await dropCheckpoints(record.repo,record.branch.slice(3),{repo:record.repo,key:await this.checkpointKey(),scope:record.createdAt});}catch{this.log.error('Checkpoints of a removed worktree could not be removed');}
    }
    async rename(id: string, title: string): Promise<SessionInfo> { if (this.closing) throw new Error('Background service is stopping'); const live = this.sessions.get(id); if (!live || !isTitle(title))
        throw new Error('Invalid session or title'); live.info.title = title; await this.persist(); this.event({ kind: 'session.updated', session: { ...live.info } }); return { ...live.info }; }
    async previewSize(cols: number, rows: number): Promise<void> { if (!isSize(cols, rows))
        throw new Error('Invalid preview size'); this.size = { cols, rows }; for (const live of this.sessions.values()) {
        await live.output;
        if(!live.attached && (live.mirror.terminal.cols !== cols || live.mirror.terminal.rows !== rows)){
            live.mirror.resize(cols, rows);live.host?.resize(cols, rows);
            this.event({kind:'session.previewResized',sessionId:live.info.id,cols,rows});
        }
    } }
    private updatePause(live:Live):void {
        const blocked=live.clientPaused||live.queuedBytes>=1024*1024;
        if(blocked&&!live.paused){live.host?.pause();live.paused=true;}
        else if(!live.clientPaused&&live.queuedBytes<=256*1024&&live.paused){live.host?.resume();live.paused=false;}
    }
    clientBackpressure(id:string,paused:boolean):void {const live=this.sessions.get(id);if(!live)return;live.clientPaused=paused;this.updatePause(live);}
    input(id:string,data:Buffer):void {
        const live=this.sessions.get(id);if(!live?.attached)return;live.host?.write(data);
        // Enter after a finished turn or an answered prompt starts work; plain CR or the kitty-protocol Enter (CSI 13 u).
        if(live.info.engine!=='codex')return;
        // A bracketed paste may carry newlines without submitting anything, and a long one spans several chunks.
        const start=data.lastIndexOf('\x1b[200~'),end=data.lastIndexOf('\x1b[201~'),inPaste=live.pasting||start>=0||end>=0;
        live.pasting=start>end||(start<0&&end<0&&live.pasting===true);
        if(!inPaste&&(data.includes(0x0d)||data.includes('\x1b[13u')||data.includes('\x1b[13;1u')))this.codexStatus(live,{kind:'running'},state=>state.status==='done'||state.status==='waiting');
    }
    async attach(id:string,cols:number,rows:number,publish:(snapshot:string,size:{cols:number;rows:number},modes:TerminalModes)=>void):Promise<void> {
        const live=this.sessions.get(id);if(!live||!isSize(cols,rows)||this.closing)throw new Error('Invalid attach');
        live.attaching=(live.attaching??0)+1;
        const task=live.output.finally(()=>{live.attaching=(live.attaching??1)-1;}).then(()=>{
            if(this.closing||this.sessions.get(id)!==live)throw new Error('Session unavailable');
            live.mirror.resize(cols,rows);live.host?.resize(cols,rows);
            const snapshot=live.mirror.snapshot();
            live.attached=true;live.mirror.setAttached(true);
            publish(snapshot,{cols,rows},live.mirror.modes());
            this.event({kind:'session.previewResized',sessionId:id,cols,rows});
        });
        live.output=task.catch(()=>{this.log.error('Attach failed');});await task;
    }
    async detach(id:string,owned:()=>boolean):Promise<void> {
        const live=this.sessions.get(id);if(!live)return;
        const task=live.output.then(()=>{
            if(!owned())return;
            live.attached=false;live.mirror.setAttached(false);live.clientPaused=false;this.updatePause(live);
            live.mirror.resize(this.size.cols,this.size.rows);live.host?.resize(this.size.cols,this.size.rows);
            this.event({kind:'session.previewResized',sessionId:id,...this.size});
        });
        live.output=task.catch(()=>{this.log.error('Attachment change failed');});await task;
    }
    async resizeAttached(id:string,cols:number,rows:number,owned:()=>boolean):Promise<void> {
        const live=this.sessions.get(id);if(!live||!isSize(cols,rows))throw new Error('Invalid resize');
        const task=live.output.then(()=>{if(!owned())throw new Error('Not attached');live.mirror.resize(cols,rows);live.host?.resize(cols,rows);this.event({kind:'session.previewResized',sessionId:id,cols,rows});});
        live.output=task.catch(()=>{this.log.error('Attachment change failed');});await task;
    }
    // v0.9.2 dev servers per worktree (D55, off by default): /dev-cmd per project, a plan shown before any start, one
    // port per worktree on 127.0.0.1, the test sandbox with 127.0.0.1 open on macOS. Linux's sandbox gives a run its own
    // network, which your browser can't reach, so there (and on Windows) it runs as you after your y, every time.
    async setDevCommand(cwd:string,command:string[]|null):Promise<{repo:string;command:string[]|null}>{
        const repo=await this.projectOf(cwd);
        await new SettingsStore(this.paths.root).update(async settings=>{const next={...settings.devCommands??{}};if(command)next[repo]=command;else delete next[repo];return {...settings,devCommands:next};});
        return {repo,command};
    }
    private async devSetup(id:string):Promise<{plan:DevPlan;box:PreparedSandbox|null;env:Record<string,string>;live:Live}>{
        if(!isUUID(id))throw new Error('Invalid session UUID');
        const live=this.sessions.get(id);if(!live)throw new Error('Session not found');
        let settings:Settings;try{settings=await new SettingsStore(this.paths.root).get();}catch{throw new Error(DEV_OFF);}
        if(settings.devServers!==true)throw new Error(DEV_OFF);
        const worktree=live.info.worktree,record=worktree?this.worktreeRecords.get(worktree):undefined;
        if(!worktree||!record?.repo)throw new Error(DEV_NO_TREE);
        const command=settings.devCommands?.[await projectRepo(record.repo)];
        if(!command)throw new Error(DEV_NO_CMD);
        // A port is only held while its server runs (review: viewing /dev reserved one for good).
        const port=await allocateFreePort(worktree,this.devPorts);if(port===null)throw new Error(DEV_NO_PORT);
        // The approval covers the files the command's code comes from (package.json, Makefile, its script…), as /test's
        // does: an agent that rewrites them after you saw the plan gets a refusal, not a run (review).
        let setup:string;
        try{const {base,repo}=await this.diffTarget(live);setup=(await testSetup(worktree,base,repo,command)).fingerprint;}catch(error){this.log.error('Dev plan: git could not read the worktree');throw new Error("The dev server setup couldn't be read",{cause:error});}
        const box=process.platform==='darwin'?await this.sandboxFor(worktree,record.repo,{loopback:true,ports:[port]}):null;
        const why=box?undefined:process.platform==='linux'?"no sandbox: on Linux a sandboxed server can't be reached from your browser":process.platform==='win32'?'no sandbox: Windows has none AI Term can use':"no sandbox: this Mac couldn't start one";
        const runs=await scriptOf(worktree,command);
        const fingerprint=createHash('sha256').update(JSON.stringify({command,cwd:worktree,port,sandbox:!!box,setup})).digest('hex');
        return {plan:{title:live.info.title,command,cwd:worktree,port,sandbox:!!box,...(why?{why}:{}),...(runs?{runs}:{}),fingerprint,running:this.dev.has(id),tail:this.dev.tail(id)},box,env:devEnv(process.env,port),live};
    }
    async devPlan(id:string):Promise<DevPlan>{const {plan,box}=await this.devSetup(id);await box?.dispose().catch(()=>this.log.error('Dev server: its temp folder could not be removed'));return plan;}
    // y on the plan you saw, and only that plan: a command, port, sandbox or setup file changed since refuses. One start at
    // a time per agent; one that lands while the agent is removed or the daemon stops starts nothing.
    async runDevPlan(id:string,fingerprint:string):Promise<void>{
        if(this.devStarting.has(id))throw new Error(DEV_RUNNING);
        this.devStarting.add(id);
        try{
            const {plan,box,env,live}=await this.devSetup(id);
            const drop=async(message:string)=>{await box?.dispose().catch(()=>this.log.error('Dev server: its temp folder could not be removed'));throw new Error(message);};
            if(plan.fingerprint!==fingerprint)return await drop(DEV_CHANGED);
            if(plan.running)return await drop(DEV_RUNNING);
            if(this.closing||this.sessions.get(id)!==live)return await drop('Session not found');
            const worktree=plan.cwd;
            // Two plans can show the same free port (nothing is held until a server runs): the port is checked and taken
            // with no await in between, so the second y is refused rather than starting a server that dies at once (gate).
            if([...this.devPorts].some(([tree,port])=>tree!==worktree&&port===plan.port))return await drop(DEV_PORT_TAKEN);
            const setDev=(dev:DevState|undefined)=>{if(dev)live.info.dev=dev;else delete live.info.dev;if(this.sessions.get(id)===live)this.event({kind:'session.updated',session:{...live.info}});};
            this.devPorts.set(worktree,plan.port);
            try{await this.dev.start(id,{command:plan.command,cwd:worktree,port:plan.port,sandbox:box,env},code=>{this.devPorts.delete(worktree);setDev({state:'exited',port:plan.port,code});});}
            catch(error){this.devPorts.delete(worktree);throw error;}
            setDev({state:'running',port:plan.port});
        }finally{this.devStarting.delete(id);}
    }
    async stopDev(id:string):Promise<void>{
        const live=this.sessions.get(id);await this.dev.stop(id);
        if(live?.info.worktree)this.devPorts.delete(live.info.worktree);
        if(live?.info.dev){delete live.info.dev;this.event({kind:'session.updated',session:{...live.info}});}
    }
    async shutdown(): Promise<void> {
        this.closing=true;
        // Dev servers go with the daemon: nothing of an agent's keeps running unseen, and none starts after this.
        this.dev.close();
        await this.dev.stopAll();
        for(const id of [...this.testRuns.keys()])this.cancelTests(id,true);
        const ids=[...this.sessions.keys()];
        const stopped=await Promise.allSettled(ids.map(id=>this.stop(id)));
        for(const [index,result]of stopped.entries())if(result.status==='rejected')this.log.error(`Session stop failed: ${ids[index]}`);
        // Each exit records itself in its session's output chain; the last state write must come after all of them, or
        // it can land after the caller already removed the folder (seen as ENOTEMPTY in tests/agent-retry).
        await Promise.allSettled([...this.sessions.values()].map(live=>live.output));
        // A task total still waiting for its coalesced write is saved now; otherwise only the queue is awaited.
        const pending=this.taskTimers.size>0||this.taskDirty;for(const timer of this.taskTimers.values())clearTimeout(timer);this.taskTimers.clear();
        await (pending?this.persist():this.saving);
        this.shutDown = true;
        await Promise.allSettled([...this.releases]);
        await this.ledger?.close();
        try{await this.mcp.shutdown();}catch{this.log.error('MCP shutdown failed');}
        for(const live of this.sessions.values()){live.outputClock?.dispose();live.mirror.dispose();}
        this.log.off('writeFailed',this.onLogFailure);this.log.off('writeRecovered',this.onLogRecovery);
    }
}
import { AddonService, type AddonRunOptions, type ReversePlan } from './addons.js';
import { bisectPlan, BisectError, runBisect } from './bisect.js';
import { AddonError } from './addon-error.js';
import { AB_RUN_TIMEOUT_MS, copyBenchFile, runAb } from './perf-ab.js';
import { tempClone } from './temp-clone.js';
import { githubView } from './github.js';
import { depsQueries } from './deps-query.js';
import { opensourceScan } from './opensource-scan.js';
import { changelogRange, contextFiles, stagedChanges, type Gathered } from './addon-gather.js';
import { agentWork, commitWork } from './agent-commit.js';
import { ExtensionReader } from '../agent/extensions/reader.js';
import { JailError, resolveInside } from '../agent/jail.js';
import { privateDirectory } from '../shared/paths.js';
import { resolveExecutable } from './engines.js';
import { buildBisectEnv, buildGhEnv } from './env.js';
import { AB_NO_SANDBOX, viewable, type AbView, type AddonResult } from '../shared/addon-results.js';
import type { BisectAsk } from '../shared/addons.js';
import { isTestCommand } from '../shared/test-run.js';
import { cutText } from '../shared/text-cut.js';
// Room for an agent's diff in an add-on's first message, next to its prompt and format (16 KB in all).
const ADDON_DIFF_BYTES=8800,ADDON_FILE_MAX=64*1024*1024;
// o on a made file: your default app (a browser for HTML), argv only.
async function openWithDefaultApp(path:string):Promise<void>{
    const opener=process.platform==='darwin'?'/usr/bin/open':process.platform==='linux'?await resolveExecutable('xdg-open',process.env.PATH??''):null;
    if(!opener)throw new Error('Opening a file is available on macOS and Linux');
    await new Promise<void>((done,fail)=>{execFile(opener,[path],{timeout:15_000,windowsHide:true},error=>error?fail(new Error('The file could not be opened')):done());});
}
import { checkAddonCli, checkReverseCli } from './addon-cli.js';
import { inertHtml, svgPage } from './inert-copy.js';
import { answerRefusal, approvable, screenFingerprint } from './remote/backend.js';
const REMOTE_SCREEN_ROWS=200;
import { findRea, reaIdentity, reverseServer, reverseTarget } from './reverse.js';
