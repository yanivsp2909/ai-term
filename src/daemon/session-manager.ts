import { McpService } from './mcp/service.js';
import { ExtensionService } from './extensions.js';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { stripVTControlCharacters } from 'node:util';
import { writeClaudeSettings,claudeStatusLine } from './claude-settings.js';
import { agentTranscript,removeSessionFiles } from './session-files.js';
import {parseAgentStatus} from './agent-status.js';
import { AGENT_PROVIDERS, engineTitle, keyEngine, deploymentWire } from '../shared/models.js';
import { catalogModels } from '../shared/model-catalog.js';
import { DEFAULT_AGENT_CAPS, type AgentFacts } from '../shared/agent-facts.js';
import { findPrice, findLimits, deploymentAlias, estimateCost, type PriceSnapshot } from './usage-prices.js';
import { cheapestWriter, handoffPlan, summarizeWithKey, type Summarize } from './handoff.js';
import { cleanNote, handoffInstructions, handoffMessage, handoffPrompt, type HandoffPlan, type HandoffSummary, type HandoffWriter } from '../shared/handoff.js';
import { engineLabel } from '../shared/models.js';
import priceData from '../../data/usage-prices.json' with {type:'json'};
const PRICES=priceData as PriceSnapshot;
import {parseClaudeStatus} from './claude-status.js';
import {parseCodexStatus,codexTitle,isCodexApproval,type CodexRun} from './codex-status.js';
import {initialStatus,reduceStatus,type StatusState} from './status-reducer.js';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { isFsError, type Paths } from '../shared/paths.js';
import { MAX_FIND_PER_AGENT, MAX_FIND_RESULTS, type SessionInfo, type SessionEvent, type TerminalModes, type CreateSession, type ClaudeStatusEvent, type WorktreeRecord, type WorktreeView, type FindMatch, type KeyView, type Settings, type TaskUsage, type UsageRecord, type CliEngine } from '../shared/protocol.js';
import { isUUID, isTitle, isSize, validCwd, validateSession, validateWorktreeRecord, isSendText, isFindQuery } from '../shared/validate.js';
import { SettingsStore } from './settings.js';
import { GitError, isWorktreeTop } from './git.js';
import { worktreeDiff, worktreeStat } from './diff.js';
import type { AgentDiff } from '../shared/diff.js';
import { fitExport, redactExportMeta, transcriptFor } from './session-export.js';
import { EXPORT_TEXT_CHARS, type SessionExport } from '../shared/session-export.js';
import { redactSecrets } from '../shared/redact.js';
import { prepareWorktree, serialize } from './worktrees.js';
import { checkWorktree, deleteWorktree, unrecordedFolders, WorktreeError } from './worktree-removal.js';
import { atomicWrite, keepCopy, moveAside, readState, StateLoadError } from './store.js';
import { Logger } from './log.js';
import { PtyHost, type SpawnRecipe } from './pty-host.js';
import { Mirror, type MirrorSignal } from './mirror.js';
import { electronNodeNeeded } from '../shared/runtime-paths.js';
import { buildShellEnv, buildSpawnEnv, buildArgs, buildUsageEnv, buildUsageArgs,buildStatusEnv,buildStatusArgs,buildAgentArgs,buildAgentEnv } from './env.js';
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
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_RECORD_COST_USD } from '../shared/validate.js';
import { OutputClock } from './output-clock.js';
// Fixed reasons /retry, /send and /find may return; the server passes only these through to the client.
export const AGENT_COMMAND_ERRORS = ['Retry needs a finished agent','Retry already starting','Worktree in use by a running agent','Its worktree is gone','Its folder is gone',
    'Agent has exited','Agent is open in a session','Agent is asking for permission','Agent is asking a question','Agent has not reported its status yet',
    'Agent does not accept pasted lines','Agent is printing too fast to check','Agent is running a tool','Text pasted but not sent; go inside','Agent is busy with another send','Invalid send request','Invalid find request','Worktree is busy'] as const;
interface Live {
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
export const HANDOFF_ERRORS=[HANDOFF_NOT_STOPPED,'Handoff is off · /settings g turns it on (it spends tokens)','Only an AI agent can hand off','Handoff already running','Agent has exited','Agent is asking for permission','Agent is asking a question','Agent is running a tool','The handoff note came back empty','The handoff summary request failed','Agent exited before writing its handoff note',"The agent didn't write its handoff note in time; it keeps running",'The handoff would pass your daily budget','The handoff would pass your weekly budget','The handoff would pass your monthly budget','Budget check unavailable; try again',HANDOFF_NOT_STARTED,HANDOFF_NOT_STARTED_PAID,"Agent hasn't started yet",'The summary writer changed; run /handoff again','Agent exited before the handoff finished','Agent is still working · hand off when it is done',"Agent hit its limit and can't write the note · add an API key for the summary",'Agent is being handed off'];
const HANDOFF_SUMMARY_MS=120_000,HANDOFF_REPLY_MS=300_000;
function sameWriter(approved:HandoffWriter,writer:import('./handoff.js').KeyedWriter|null):boolean{return approved.kind==='agent'?writer===null:writer!==null&&approved.provider===writer.key.provider&&approved.model===writer.model&&approved.last4===writer.key.last4;}
export class SessionManager extends EventEmitter {
    // /send: how long Enter waits behind the paste (static so a test can widen the window it races).
    static sendEnterDelayMs = 50;
    // v0.6.3: how long a handed-off agent has to start (a test shortens it).
    static handoffStartMs = 30_000;
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
        const data = { sessions: [...this.sessions.values()].map(s => ({ ...s.info, pid: s.host?.pty.pid ?? null, recipe: { engine: s.info.engine, model: s.info.model, auth: s.info.auth.kind==='key'?{kind:'key',keyId:s.info.auth.keyId}:{ kind: 'account' }, cwd: s.info.cwd, permission: s.info.permission, ...(s.info.effort!==undefined?{effort:s.info.effort}:{}), ...(s.info.conversationId?{conversationId:s.info.conversationId}:{}) } })), worktrees: [...this.worktreeRecords.values()] };
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
    async create(request: CreateSession | { cwd: string; title?: string }, continuation?:{resume?:boolean;conversationId?:string;worktree?:string;branch?:string}): Promise<SessionInfo> {
        const cwdValid=await validCwd(request.cwd);
        if (this.closing || !cwdValid || (request.title !== undefined && !isTitle(request.title)))
            throw new Error('Invalid session request');
        const agent = 'engine' in request && request.engine !== 'shell' ? await this.route(request) : null;
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
        const conversationId=agent?.engine==='claude-code'&&!agent.login?(continuation?.conversationId??randomUUID()):undefined;
        // Status is not billing: subscription and key sessions both report it. Login sessions only sign in.
        const withStatus=Boolean(agent&&!agent.login&&this.usage);
        const codexStatus=withStatus&&agent?.engine==='codex'?{node:process.execPath,entry:this.cliEntry,...(this.cliEntry.endsWith('.ts')?{loader:createRequire(import.meta.url).resolve('tsx')}:{})}:undefined;
        const argvRequest=agent?{...agent,...(conversationId?{conversationId}:{}),...(continuation?.resume?{resume:true}:{}),...(codexStatus?{codexStatus}:{})}:null;
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
            if (agent.auth.kind==='account' && !agent.login && status.loggedIn !== true) throw new Error(status.loggedIn === false ? 'Engine is not logged in' : 'Engine login status unavailable');
            authMethod = status.authMethod;
            if(agent.auth.kind==='key'){
                const key=await this.keys.view(agent.auth.keyId);
                // Routing already sends every other provider to AI Term's agent; this is the second guard (v0.6.5).
                if(!CLI_KEY_PROVIDERS.includes(key.provider)||engine==='claude-code'&&key.provider!=='anthropic'||engine==='codex'&&key.provider==='anthropic')throw new KeyError('Key provider does not match engine');
                if(key.provider==='foundry'&&(!agent.model||!key.deployments?.includes(agent.model)||!key.lastTest?.some(r=>r.model===agent.model&&r.status==='ready')))throw new KeyError('Foundry deployment must pass its test first');
                authMethod='api-key';
                recipe={executable:status.path,args:buildArgs({...agent,...argvRequest,engine,...(key.provider==='foundry'?{foundryEndpoint:key.endpoint}:{}),...(key.provider==='openai'?{openaiKey:true}:{})}),env:{}};
            }else recipe = { executable: status.path, args: agent.login ? (engine==='codex'?['--no-daemon','-c','check_for_update_on_startup=false','login']:['auth','login']) : buildArgs({...agent,...argvRequest,engine}), env: buildSpawnEnv(engine, {kind:'account'}, process.env, {keepElectronNode:electronNodeNeeded(process.execPath,process.versions.electron),...(profilePath?{profileDir:profilePath}:{})}) };
        } else recipe = this.recipe ? {executable:this.recipe.executable,args:[...this.recipe.args],env:{...this.recipe.env}} : { executable: process.env.SHELL || '/bin/zsh', args: ['-l'], env: buildShellEnv(process.env) };
        const keyView=agent?.auth.kind==='key'?await this.keys.view(agent.auth.keyId):null;
        const now = new Date().toISOString();
        const info: SessionInfo = { id: randomUUID(), title: request.title ?? (agent ? engineTitle(agent.engine) : 'shell'), engine: agent?.engine ?? 'shell', model: agent ? agent.model : 'shell', ...(agent&&!agent.login?{effort:agent.effort??null}:{}), ...(agent?.login?{login:true as const}:{}), ...(conversationId?{conversationId}:{}), auth: keyView?{kind:'key',keyId:keyView.id,provider:keyView.provider,keyLabel:keyView.label,last4:keyView.last4}:{ kind: 'account',...(profile?{profile}:{}) }, cwd: request.cwd, permission: agent?.permission ?? 'ask', ...(authMethod ? {authMethod} : {}), status: 'starting', statusDetail: 'starting', statusSince: now, exitCode: null, createdAt: now, lastOutputAt: null, ctxPercent: null,lastActivity:null };
        if(continuation?.worktree){info.worktree=continuation.worktree;info.branch=continuation.branch;}
        else if(agent&&!agent.login&&!continuation){
            // Isolation is the default: settings that can't be read keep it on rather than quietly turning it off.
            // v0.6.2: a preset's own worktree choice wins for this one agent.
            const isolate='useWorktree' in request&&request.useWorktree!==undefined?request.useWorktree:settings?.worktrees!=='off';
            if(isolate){
                try {
                    const {repo,baseBranch,baseCommit,...start}=await prepareWorktree(this.paths.root,request.cwd,info.title,text=>this.log.error(text));Object.assign(info,start);
                    if(start.worktree&&start.branch&&repo)this.worktreeRecords.set(start.worktree,{path:start.worktree,branch:start.branch,repo,...(baseBranch?{baseBranch}:{}),...(baseCommit?{baseCommit}:{}),createdAt:now});
                } catch { info.worktreeNote='worktree off: git check failed'; }
            }
            // Not a repo and no commits are the user's situation; anything else lost isolation by failing, so it's an error.
            if(info.worktreeNote)(['worktree off: not a git repo','worktree off: repo has no commits'].includes(info.worktreeNote)?this.log.info:this.log.error).call(this.log,info.worktreeNote);
        }
        const statusTelemetry=withStatus&&agent?this.usage?.registerStatus(info.id,agent.engine):undefined;
        // Usage counts API-key sessions (D27). Cost per task (v0.6.1, D55, on by default) also asks a subscription or
        // unknown-auth CLI for its usage, but only for its own token total: never Usage, a budget or a price.
        const counted=agent&&!agent.login&&this.usage?(authMethod==='api-key'?'usage':agent.engine!=='ai-term'&&settings?.taskCost!==false?'task':null):null;
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
        this.sessions.set(info.id, live);
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
            if(agent?.engine==='ai-term'&&agent.auth.kind==='key'){const spawnAgent=(secret:string|null,binding:FoundryBinding|null)=>{
                // B12: only the Keychain's bound endpoint and deployments decide where the key goes and which models it may run
                // (Foundry, Bedrock). Fixed-host providers' hosts are in the agent's code; Ollama's endpoint is local only.
                const provider=agentKey?.view.provider,bound=provider!==undefined&&isBoundProvider(provider),model=agent.model,models=(agentKey?.models??[]).filter(id=>!bound||binding?.deployments.includes(id));
                if(bound&&!binding||!model||!models.includes(model)||!transcript||!agentKey)throw new KeyError(provider==='bedrock'?'Bedrock key details changed outside AI Term; add the key again':'Foundry key details changed outside AI Term; add the key again');
                const endpoint=bound&&binding?binding.endpoint:provider==='ollama'&&isLocalEndpoint(agentKey.view.endpoint)?agentKey.view.endpoint:null;
                live.agentModels=models;
                const command={node:process.execPath,entry:this.cliEntry,...(this.cliEntry.endsWith('.ts')?{loader:createRequire(import.meta.url).resolve('tsx')}:{})};
                const built=buildAgentArgs({command,provider:agentKey.view.provider,model,models,permission:agent.permission,theme:settings?.theme??'graphite',transcript,...(agent.firstMessage!==undefined?{firstMessage:agent.firstMessage}:{})});
                recipe={executable:built.executable,args:built.args,env:buildAgentEnv(process.env,{secret,endpoint,...(statusTelemetry?{status:statusTelemetry}:{}),...(telemetry?{usage:telemetry}:{}),entry:this.cliEntry})};
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
                    this.emit('output', info.id, Buffer.from(data));
                }).catch(async () => {
                    if(live.mirrorFailed)return;
                    live.mirrorFailed=true;this.usage?.revoke(info.id);live.outputClock?.dispose();
                    info.status='error';info.statusDetail='terminal mirror failed';info.exitCode=null;info.statusSince=new Date().toISOString();
                    this.log.error('Session terminal mirror failed');
                    await this.persist();this.event({kind:'session.updated',session:{...info}});
                    // Stop the failed child without waiting on live.output, which is this very task.
                    try{await host.stop();}catch{this.log.error('Failed to stop session after terminal mirror failure');}
                }).finally(()=>{
                    live.queuedBytes-=bytes;
                    this.updatePause(live);
                });
            });
            host.pty.onExit(event => {
                this.usage?.revoke(info.id);this.trackRelease(info.id);if(live.limitTimer){clearTimeout(live.limitTimer);live.limitTimer=undefined;}live.outputClock?.dispose();void this.mcp.stop(info.id).catch(()=>this.log.error('MCP session stop failed'));
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
            this.usage?.revoke(info.id);
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
        if(raw&&typeof raw==='object'&&!Array.isArray(raw)&&'kind' in raw)return new ExtensionService(new SettingsStore(this.paths.root)).query(raw as Record<string,unknown>);
        return this.agentFacts(id,raw);
    }
    async agentFacts(id:string,raw:unknown):Promise<AgentFacts|null>{
        const live=this.sessions.get(id);
        if(!live||live.info.engine!=='ai-term'||live.info.auth.kind!=='key'||['exited','error'].includes(live.info.status)||!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length!==1)return null;
        const model=(raw as {model?:unknown}).model;
        if(typeof model!=='string'||!live.agentModels?.includes(model))return null;
        const key=await this.keys.view(live.info.auth.keyId),settings=await new SettingsStore(this.paths.root).get();
        const alias=key.provider==='foundry'?deploymentAlias(settings,model):undefined,overrides=settings.priceOverrides??{};
        const price=findPrice(PRICES,key.provider,model,overrides,alias)??null,limits=findLimits(PRICES,key.provider,model,alias),usage=this.usage?.summary();
        return {model,wire:key.provider==='foundry'?deploymentWire(key.lastTest?.find(r=>r.model===model)):null,context:limits.context??null,output:limits.output??null,price,
            spent:{day:usage?.today.costUsd??0,week:usage?.week.costUsd??0,month:usage?.month.costUsd??0},budgets:{daily:settings.budgets?.daily??null,weekly:settings.budgets?.weekly??null,monthly:settings.budgets?.monthly??null},
            caps:settings.agentCaps??DEFAULT_AGENT_CAPS,contextWarning:settings.contextWarning!==false,reserved:this.ledger?.reserved()??0};
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
        const plan=handoffPlan(live.info.title,engine,screen,writer,false),worst=plan.priceUsd?.high??0,usage=this.usage?.summary();
        this.lastHandoffWorst=worst;
        // No ledger, no budget check: a keyed summary is never sent unchecked (v0.6 gate).
        if(!this.ledger)throw new Error('Budget check unavailable; try again');
        const held=this.ledger.reserve({sessionId:id,provider:writer.key.provider,model:writer.model,amountUsd:worst},{daily:settings.budgets?.daily??null,weekly:settings.budgets?.weekly??null,monthly:settings.budgets?.monthly??null},{day:usage?.today.costUsd??0,week:usage?.week.costUsd??0,month:usage?.month.costUsd??0});
        if('refused' in held)throw new Error(held.refused.budget==='unavailable'?'Budget check unavailable; try again':`The handoff would pass your ${held.refused.budget} budget`);
        const grant=held.grant.id,controller=new AbortController(),timer=setTimeout(()=>controller.abort(),HANDOFF_SUMMARY_MS);
        const settle=(worstCase:boolean):Promise<unknown>=>grant?this.ledger?.settle(id,grant,worstCase).catch(()=>{this.log.error('Budget reservation could not be booked');})??Promise.resolve():Promise.resolve();
        let result:import('./handoff.js').Summary;
        try{
            result=await this.keys.withSecret(writer.key.id,(secret,binding)=>{
                // B12: a Foundry key goes only to its Keychain-bound endpoint and deployments.
                if(writer.key.provider==='foundry'&&(!binding||!binding.deployments.includes(writer.model)))throw new KeyError('Foundry key details changed outside AI Term; add the key again');
                return this.handoffWriter.summarize(writer,secret,writer.key.provider==='foundry'?binding?.endpoint??null:null,handoffPrompt(engine,screen),controller.signal);
            });
        }catch(error){
            await settle(true);
            if(error instanceof KeyError)throw error;
            this.log.error('Handoff summary request failed');
            // eslint-disable-next-line preserve-caught-error -- provider errors may carry anything the provider sent; only fixed words leave.
            throw new Error('The handoff summary request failed');
        }finally{clearTimeout(timer);}
        // The agent exited meanwhile: its hold was already booked at the worst case, so the real usage isn't added on top.
        const stillHeld=grant!==null&&this.ledger?.holds(grant)===true;
        if(result.inputTokens===null||result.outputTokens===null||grant!==null&&!stillHeld){await settle(true);return {text:result.text,summary:{inputTokens:result.inputTokens??0,outputTokens:result.outputTokens??0,costUsd:worst}};}
        const costUsd=estimateCost(writer.price,result.inputTokens,result.outputTokens);
        try{await this.usage?.job({ts:new Date().toISOString(),sessionId:id,provider:writer.key.provider,model:writer.model,inputTokens:result.inputTokens,outputTokens:result.outputTokens,costUsd,costSource:'price-table'});await settle(false);}
        catch{this.log.error('Handoff summary usage could not be recorded; counted at its worst case');await settle(true);}
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
        // Working again: the last count is stale until the next finished turn.
        if(next.status==='running'&&live.info.diffStat){delete live.info.diffStat;live.diffStatSeq=(live.diffStatSeq??0)+1;}
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
    async diff(id:string):Promise<AgentDiff>{
        if(!isUUID(id))throw new Error('Invalid session UUID');
        const live=this.sessions.get(id);if(!live)throw new Error('Session not found');
        const {path,base,label}=await this.diffTarget(live);
        let body;
        try{body=await worktreeDiff(path,base);}catch(error){this.log.error(`Diff failed: ${error instanceof GitError?error.message:'unexpected error'}`);throw new Error('Diff unavailable; git could not read the worktree',{cause:error});}
        return {title:live.info.title,branch:live.info.branch??'',base:label,...body};
    }
    private async diffTarget(live:Live):Promise<{path:string;base:string;label:string}>{
        const path=live.info.worktree,record=path?this.worktreeRecords.get(path):undefined;
        if(!path||!live.info.branch)throw new Error('This agent has no worktree to diff');
        const base=record?.baseCommit;
        if(!base||!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(base))throw new Error('This worktree has no recorded start to diff against');
        // The folder must still be that worktree: an agent can rewrite its .git file to point somewhere else.
        if(!await isWorktreeTop(path))throw new Error('Diff unavailable; git could not read the worktree');
        return {path,base,label:`${record?.baseBranch??'start'} @ ${base.slice(0,7)}`};
    }
    private async refreshDiffStat(live:Live):Promise<void>{
        // Only the latest count lands, and only while the agent is still listed and finished.
        const seq=live.diffStatSeq=(live.diffStatSeq??0)+1;
        try{const {path,base}=await this.diffTarget(live),stat=await worktreeStat(path,base);if(seq!==live.diffStatSeq||this.sessions.get(live.info.id)!==live||live.info.status!=='done')return;live.info.diffStat=stat;this.event({kind:'session.updated',session:{...live.info}});void this.persist();}
        catch{this.log.error('Diff stat unavailable for a finished agent');}
    }
    async stop(id: string): Promise<void> { const live = this.sessions.get(id); if (!live)
        throw new Error('Session not found'); await live.host?.stop(); await live.output; }
    async remove(id: string): Promise<void> { if (this.closing) throw new Error('Background service is stopping'); const live = this.sessions.get(id); if (!live)
        throw new Error('Session not found'); if (!['exited', 'error'].includes(live.info.status))
        throw new Error('Only exited sessions can be removed'); if(live.mirrorFailed)await this.stop(id); await live.output; await removeSessionFiles(this.paths.root,id);live.outputClock?.dispose();live.lastReply=undefined;live.mirror.dispose(); this.sessions.delete(id); await this.persist(); this.event({ kind: 'session.removed', sessionId: id }); }
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
        }catch(error){
            // The worktree itself is gone once its step succeeded; the kept branch stays in git for the user.
            if(error instanceof WorktreeError&&error.message==='Worktree removed; branch delete failed')this.worktreeRecords.delete(path);
            throw error;
        }finally{this.busyWorktrees.delete(path);await this.persist();}
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
        const task=live.output.then(()=>{
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
    async shutdown(): Promise<void> {
        this.closing=true;
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
