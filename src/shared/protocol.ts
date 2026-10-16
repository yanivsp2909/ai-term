import { isUUID } from './validate.js';
export const PROTOCOL_VERSION = 1;
// Length counts the type byte and payload, excluding the four-byte prefix.
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
export const MAX_COPY_BYTES = 5 * 1024 * 1024;
// /send (D50): text pasted into a running agent, capped like a first message.
export const MAX_SEND_BYTES = 16 * 1024;
// /find: plain-text search of every agent's mirror. Queries and results are capped so one search stays one small frame.
export const MAX_FIND_CHARS = 200, MAX_FIND_RESULTS = 200, MAX_FIND_PER_AGENT = 50, FIND_LINE_CHARS = 160;
// One /find hit: fromEnd counts rows up from the bottom of the agent's buffer (0 = last row), so the preview can find
// the row even though its own buffer holds a different amount of scrollback. start/length mark the match in text.
export interface FindMatch {sessionId:string;fromEnd:number;text:string;start:number;length:number}
export const COPY_CHUNK_BYTES = 1024 * 1024;
export interface SessionText {sessionId:string;text:string;truncated:boolean;source?:'last-reply'|'session'}
export type Engine = 'claude-code' | 'codex' | 'ai-term' | 'shell'; // Shell spawning remains internal; the homepage can display it.
export type Status = 'starting' | 'running' | 'waiting' | 'done' | 'exited' | 'error';
export type ThemeName = 'graphite' | 'slate' | 'ink' | 'auto' | 'light';
// 'ai-term' is AI Term's own agent (v0.4): it runs only on an API key (D47). The official CLIs are CliEngine.
export type CliEngine = 'claude-code' | 'codex';
export type AgentEngine = CliEngine | 'ai-term';
// D47's fallback: where a key whose provider AI Term's agent supports starts. Absent means 'ai-term'.
export type KeysRunOn = 'ai-term' | 'cli';
export type Permission = 'ask' | 'auto' | 'dontAsk';
export type Effort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | 'persistent';
export type AuthMethod = 'subscription' | 'api-key' | 'unknown';
export type EngineCheckError = 'Engine executable check failed' | 'Engine version check failed' | 'Engine login check failed';
export type ProviderFailureReason = 'Provider request timed out' | 'Provider connection failed' | 'Provider reply too large' | 'Provider request failed';
export interface EngineStatus { installed: boolean; path: string | null; version: string | null; loggedIn: boolean | null; authMethod: AuthMethod; error?: EngineCheckError }
export interface EnginesStatus { claudeCode: EngineStatus; codex: EngineStatus }
// v0.6.5 adds xAI, Moonshot, Z.ai, OpenRouter, Bedrock, Vertex (express) and Ollama (local, no key): src/shared/providers.ts.
export type KeyProvider = 'anthropic' | 'foundry' | 'openai' | 'xai' | 'moonshot' | 'zai' | 'openrouter' | 'bedrock' | 'vertex' | 'ollama';
// 'ready': the Responses API answered. 'chat': only Chat Completions did (v0.4.2; older saved results say 'not a chat model'),
// which AI Term's agent can use and Codex can't (D30).
export interface DeploymentTest { model: string; status: 'ready' | 'chat' | 'not a chat model' | 'error'; httpStatus?: number; errorCode?: string; reason?: ProviderFailureReason }
export interface KeyView { id: string; provider: KeyProvider; label: string; last4: string; endpoint?: string; deployments?: string[]; lastTest?: DeploymentTest[] }
// v0.6.4: an account reference may name a profile (or `own` for your normal login); absent means the engine's default.
export type AuthRef = {kind:'account';profile?:string} | {kind:'key';keyId:string};
export type AuthView = {kind:'account';profile?:string} | {kind:'key';keyId:string;provider:KeyProvider;keyLabel:string;last4:string};
export interface Budgets {daily:number|null;weekly:number|null;monthly:number|null}
export interface ModelPrice {input:number;output:number;cacheRead?:number}
// cachedTokens is the cache-read share already inside tokens; optional only for summaries from older daemons.
export interface UsageTotal {costUsd:number;tokens:number;cachedTokens?:number;unknownPrice:boolean}
export interface UsagePeriod extends UsageTotal {providers:({provider:KeyProvider}&UsageTotal)[]}
export interface UsageSummary {today:UsagePeriod;week:UsagePeriod;month:UsagePeriod}
export interface UsageDiagnostic {sessionId:string;at:string;values:{name:string;value:number}[]}
export interface UsageDiagnostics {port:number;sessions:UsageDiagnostic[]}
export interface UsageRecord {ts:string;sessionId:string;provider:KeyProvider;model:string;inputTokens:number;outputTokens:number;cachedTokens?:number;costUsd:number|null;costSource:'cli-estimate'|'price-table'|'worst-case'}
export interface Settings {mcp?:import('./mcp.js').McpServer[];mcpApprovals?:Record<string,string>;mcpOverrides?:Record<string,{enabled?:boolean;tools:Record<string,boolean>}>;extensions?:Record<string,boolean>;budgets?:Budgets;priceOverrides?:Record<string,ModelPrice>;providerPrices?:Partial<Record<KeyProvider,Record<string,ModelPrice>>>; theme: ThemeName; defaultEngine?: CliEngine; keysRunOn?: KeysRunOn; deploymentModels?: Record<string,string>; agentCaps?: import('./agent-facts.js').AgentCaps; contextWarning?: boolean; taskCost?: boolean; handoff?: boolean; checkpoints?: boolean; secretScan?: boolean; autoTest?: boolean; queue?: boolean; devServers?: boolean; lspDiagnostics?: boolean; brainForAgents?: boolean; brainRepositories?: Record<string, { agents?: boolean; trusted?: boolean }>; devCommands?: Record<string, string[]>; testCommands?: Record<string, string[]>; testLoopback?: string[]; autoReview?: boolean; autoReviewDailyUsd?: number; reviewModel?: { keyId: string; model: string }; accounts?: import('./accounts.js').AccountProfile[]; defaultAccounts?: Partial<Record<CliEngine, string>>; presets?: Record<string, import('./presets.js').Preset>; presetsEnabled?: boolean; defaultModel?: string | null; defaultEffort?:Effort|null; defaultCwd?: string; permission?: 'ask'; notifications?: boolean; bar?: 'on'|'off'; worktrees?: 'on'|'off'; [key: string]: unknown }
export type SettingsPatch = Partial<Settings>;
export type WorktreeNote = 'worktree off: not a git repo' | 'worktree off: repo has no commits' | 'worktree off: git check failed' | 'worktree off: creation failed';
export interface WorktreePreview {branch?:string;head?:string;dirty?:boolean;note?:WorktreeNote}
// The daemon's own record of a worktree it created; it outlives the agent. Older v0.3.1 records lack repo and base.
export interface WorktreeRecord {path:string;branch:string;repo?:string;baseBranch?:string;baseCommit?:string;createdAt:string}
export type WorktreeRefusal = "Not in AI Term's record" | 'Outside the worktrees folder' | 'Path has a symlink' | 'Original repo unknown' | 'Worktree does not match its repo' |
    'Main checkout is never deleted' | 'Git does not list this worktree' | 'Worktree is not on its ai/ branch' | 'Worktree is locked' | 'Branch is checked out elsewhere' |
    'Stop the agent first' | 'Worktree is busy' | 'Git check failed';
export interface WorktreeLoss {changed:number;untracked:number;ignored:number;repos:number;commits:number;base:string;baseSource:'recorded'|'start commit'|'checkout';missing:boolean}
// fingerprint identifies exactly what was shown; a delete must send it back unchanged.
export interface WorktreeView {path:string;branch?:string;agent?:{id:string;title:string;status:Status};loss?:WorktreeLoss;fingerprint?:string;refusal?:WorktreeRefusal}
// Ignored files go with any delete but are not counted as loss; a folder already gone has no files left to lose.
export function wouldLose(loss: WorktreeLoss): boolean { return loss.changed + loss.untracked + loss.commits > 0; }
export type TerminalBundle = 'com.apple.Terminal' | 'com.googlecode.iterm2' | 'com.mitchellh.ghostty' | 'com.github.wez.wezterm';
export type CreateSession = { engine: 'shell'; cwd: string; title?: string } | { engine: AgentEngine; model: string | null; effort?:Effort|null; auth: AuthRef; cwd: string; permission: Permission; title?: string; firstMessage?: string; login?: boolean; useWorktree?: boolean; brain?: boolean; brainMention?: boolean };
export interface SessionInfo {
    id: string;
    title: string;
    engine: Engine;
    model: string | null;
    effort?:Effort|null;
    conversationId?:string; // AI Term-generated Claude CLI UUID; absent on legacy records and Codex.
    auth: AuthView;
    cwd: string;
    worktree?: string;
    branch?: string;
    worktreeNote?: WorktreeNote;
    // A /login session (claude auth login, codex login); /retry runs the same login again.
    login?: boolean;
    permission: Permission;
    authMethod?: AuthMethod;
    status: Status;
    statusDetail: string;
    statusSince: string;
    exitCode: number | null;
    createdAt: string;
    lastOutputAt: string | null;
    ctxPercent: number|null;
    lastActivity?:{tool:string;at:string}|null; // Missing on legacy records; new records use null.
    taskUsage?:TaskUsage; // v0.6.1: this agent's own total since it started (absent until its first usage).
    limit?:{resets:string|null}; // v0.6.4: its account hit a usage limit (read from its screen); resets HH:MM when it says.
    handoffTo?:string; // v0.6.3: the agent this one handed its work to (`handed off → <name>` on the card).
    diffStat?:import('./diff.js').DiffStat; // v0.7.1: its worktree's changes since it started, counted when it finished a turn.
    tests?:import('./test-run.js').TestResult;
    brain?:{builtAt:string}; // v1.0.2: the repository map it was given at start, and when that map was built.
    dev?:import('./dev.js').DevState; // v0.9.2: its worktree's dev server, while it runs or after it ended by itself. // v0.7.4: the project's test command, run in its worktree when it finished a turn.
    review?:import('./review.js').ReviewState; // v0.7.4: the last /review (or auto-review) of its diff.
    priceYours?:true; // B28: AI Term's agent runs on a price you typed (/settings p, or p at a pause), $0 included.
}
// v0.6.1 cost per task (D55): tokens always; dollars for API-key sessions only (null on a subscription, which bills
// against the plan). unknownPrice: some of it had no price, so the dollars are a lower bound.
export interface TaskUsage {tokens:number;costUsd:number|null;unknownPrice?:true}
export type ClaudeStatusEvent = {seq:number;at:string} & (
    {kind:'running';tool?:string;phase?:'turn-start'|'tool-start'|'tool-finish'} | {kind:'waiting';reason:'permission'|'question'|'turn failed';error?:string;backup?:boolean} |
    {kind:'done'} | {kind:'context';percent:number|null} | {kind:'exit';status:'exited'|'error';detail:string;exitCode:number|null}
);
// This Mac (§10). Numbers only: no process name, command line, user or pid ever crosses the socket.
// cpuPercent is a share of the whole machine (0–100) for the machine and for each session alike.
export interface SessionStats { sessionId: string; cpuPercent: number; rssBytes: number }
export interface SystemStats { cpuPercent: number; memUsedBytes: number; memTotalBytes: number; netRxBytesPerSec: number; netTxBytesPerSec: number; sessions: SessionStats[] }
// `id` identifies the request; `sessionId` identifies its target (no ambiguous duplicate id).
export type Request = {
    id: string;
} & (import('./mcp.js').McpRequest | {
    kind: 'hello';
    protocol: number;
    version: string;
    // Windows (v0.8.2): the pipe's token from run/daemon.pipe, and a fresh nonce the daemon must answer with proof of the
    // token (pipe-server.ts), so a squatter on a stale pipe name is found out before anything else is sent.
    token?: string;
    nonce?: string;
} | {
    // Windows: a graceful stop (TerminateProcess would skip the cleanup and leave the pipe file behind).
    kind: 'daemon.stop';
} | {
    // v0.9.1 queue (D55, off by default).
    kind: 'queue.list';
} | {
    kind: 'queue.add';
    trigger: import('./queue.js').QueueTrigger;
    limit: import('./queue.js').QueueLimit;
    request: import('./queue.js').QueueRequest;
} | {
    kind: 'queue.remove';
    itemId: string;
} | {
    kind: 'settings.get';
    refreshNotifications?:boolean;
} | {
    kind: 'settings.set';
    patch: SettingsPatch;
} | {kind:'addons.plan';name:string;args:string;cwd:string;target:import('./addons.js').AddonTarget}
  | {kind:'addons.start';receipt:string}
  | {kind:'addons.result'|'addons.approve';sessionId:string}
  | {kind:'addons.step';sessionId:string;step:number}
  | {kind:'extensions.list';cwd:string} | {kind:'extensions.read';cwd:string;extensionId:string} | {kind:'extensions.toggle';cwd:string;extensionId:string;enabled:boolean} | {
    kind: 'sessions.list';
} | {
    kind: 'engines.status';
} | { kind: 'keys.list' }
  // v1.0.1 ai doctor: whether the OS keychain answers (a probe entry that never holds a key), asked of the daemon.
  | { kind: 'keys.health' }
  // secret is absent only for Ollama, which has no key; deployments are the model ids for every provider but Anthropic and OpenAI.
  | { kind: 'keys.add'; provider: KeyProvider; label: string; secret?: string; endpoint?: string; deployments?: string[] }
  | { kind: 'keys.remove' | 'keys.test'; keyId: string }
  | { kind: 'keys.scanEnvFile'; path: string }
  | { kind: 'keys.importEnv'; path: string; names: string[] }
  | {kind:'worktrees.preview';cwd:string;title:string}
  | {kind:'worktrees.list'} | {kind:'worktrees.check';path:string}
  | {kind:'worktrees.delete';path:string;fingerprint:string;confirm?:string}
  | ({ kind: 'sessions.create' } & CreateSession) | {
    kind: 'sessions.preview';
    sessionId: string | null;
} | {
    kind: 'sessions.stop' | 'sessions.remove' | 'sessions.resume' | 'sessions.retry';
    sessionId: string;
} | {
    // v0.7.1: the agent's worktree against the commit it started from, as text (d, /diff).
    kind:'sessions.diff'; sessionId:string; against?:string; // v0.7.4: compare with another agent's work
} | {
    // v0.7.1 /export: the session's text (and AI Term agent transcript), redacted, for one HTML file the client saves.
    kind:'sessions.export'; sessionId:string;
} | {
    // v0.7.2 /undo and /redo (D55, on): the plan first (the ask), then the restore it bound with its fingerprint.
    kind:'sessions.undoPlan'; sessionId:string; redo:boolean;
} | {
    kind:'sessions.undo'; sessionId:string; redo:boolean; fingerprint:string;
} | {
    // v0.7.3 /merge and /pr: the plan (exact commands, secret scan), then the action bound to it; override only when typed.
    kind:'sessions.mergePlan' | 'sessions.prPlan' | 'sessions.testPlan' | 'sessions.reviewPlan' | 'sessions.lastReview'; sessionId:string;
} | {
    kind:'sessions.review'; sessionId:string; keyId:string; model:string; fingerprint:string;
} | ({
    kind:'sessions.forkPlan' | 'sessions.fork'; sessionId:string;
} & import('./fork.js').ForkTarget) | {
    kind:'sessions.test'; sessionId:string; fingerprint:string;
} | {
    kind:'project.testCommand'; cwd:string;
} | {
    kind:'project.setTestCommand'; cwd:string; command:string[]|null;
} | {
    // v0.9.2 dev servers per worktree (D55, off by default).
    kind:'sessions.devPlan'|'sessions.devStop'; sessionId:string;
} | {
    kind:'sessions.dev'; sessionId:string; fingerprint:string;
} | {
    // v1.0.2 /brain: plan (what changed, the local pass is free, the models with prices), build (local, or with the model
    // you picked from the plan), show (brain.md), remove; and whether agents get it (D55, on).
    kind:'brain.plan'|'brain.show'|'brain.remove'|'brain.preferences'; cwd:string;
} | {
    kind:'brain.configure'; cwd:string; agents?:boolean; trusted?:boolean;
} | {
    kind:'brain.build'; cwd:string; fingerprint:string; model?:{keyId:string;model:string};
} | {
    kind:'brain.agents'; on:boolean;
} | {
    kind:'project.setDevCommand'; cwd:string; command:string[]|null;
} | {
    kind:'project.setTestLoopback'; cwd:string; allowed:boolean;
} | {
    kind:'prices.set'; provider:KeyProvider; model:string; price:ModelPrice;
} | {
    kind:'sessions.merge' | 'sessions.pr'; sessionId:string; fingerprint:string; override:boolean;
} | {
    kind:'sessions.text'; sessionId:string; lastReply?:boolean;
} | {
    kind:'sessions.send'; sessionId:string; text:string;
} | {
    // v0.6.3 engine handoff (D55, off by default): what it would run and cost (D49), then the handoff itself.
    kind:'sessions.handoffPlan'; sessionId:string; engine:CliEngine; account?:string;
} | {
    // writer: the one the user approved in the ask; a different one now refuses.
    kind:'sessions.handoff'; sessionId:string; engine:CliEngine; writer: import('./handoff.js').HandoffWriter; account?:string; // v0.6.4: continue on that account (D53)
} | {
    kind:'sessions.find'; text:string;
} | {
    kind: 'sessions.rename';
    sessionId: string;
    title: string;
} | {
    kind: 'sessions.attach' | 'sessions.resize';
    sessionId: string;
    cols: number;
    rows: number;
} | {
    kind: 'sessions.detach';
    sessionId:string;
} | {
    kind: 'layout.previewSize';
    cols: number;
    rows: number;
} | {
    kind: 'usage.subscribe'; on:boolean;
} | {
    // A homepage that handles notification clicks; while one is connected a click selects the agent there.
    kind: 'clicks.subscribe'; on:boolean; terminal?:TerminalBundle;
} | {kind:'usage.summary'|'usage.diagnostics'} | {
    kind: 'system.subscribe';
    on: boolean;
});
// Whether the daemon can post notifications; only these fixed states cross the socket.
export type NotificationAuthorization='allowed'|'denied'|'not-asked'|'unknown';
// none: Linux without notify-send (v0.8.1); there notifications have no click-through.
// v0.8.1: whether AI Term's agent may run in Don't ask here (its bash sandboxed); note says why not, in one line.
export interface AgentSandbox { dontAsk: boolean; note?: string }
export type NotifierState = 'ready' | 'not built' | 'launch failed' | 'none';
export interface SuccessResponse {
    id: string;
    ok: true;
    addonAsk?: import('./addons.js').AddonAsk;
    addonResult?: import('./addons.js').AddonResult | null;
    addonUsage?: TaskUsage | null;
    savedPlan?: string;
    kind?: 'hello';
    protocol?: number;
    version?: string;
    daemonPid?: number;
    proof?: string;
    queue?: import('./queue.js').QueueItem[];
    devPlan?: import('./dev.js').DevPlan;
    brainPlan?: import('./brain.js').BrainPlan;
    brainPreferences?: { agents: boolean; trusted: boolean };
    brainResult?: import('./brain.js').BrainResult;
    // /brain show: brain.md, and how old.
    brainText?: { repo: string; text: string; builtAt: string };
    devCommand?: { repo: string; command: string[] | null };
    usage?:UsageSummary;usageDiagnostics?:UsageDiagnostics;
    worktreePreview?: WorktreePreview;
    keptWorktree?: string;
    worktrees?: WorktreeView[];
    worktree?: WorktreeView;
    deletedWorktree?: string;
    mcp?: import('./mcp.js').McpCatalog;
    mcpSchema?: Record<string,unknown>;
    mcpResult?: string;
    extensions?: import('./extensions.js').ExtensionCatalog;
    extension?: import('./extensions.js').ExtensionFile;
    settings?: Settings;
    engines?: EnginesStatus;
    notifier?: NotifierState;
    agentSandbox?: AgentSandbox;
    keychain?: { reachable: boolean; note?: string };
    notificationPermission?:NotificationAuthorization;
    keys?: KeyView[];
    key?: KeyView;
    diff?: import('./diff.js').AgentDiff;
    exportData?: import('./session-export.js').SessionExport;
    undoPlan?: import('./checkpoints.js').UndoPlan;
    undone?: {restored:number};
    mergePlan?: import('./merge.js').MergePlan;
    testPlan?: import('./test-run.js').TestPlan;
    reviewPlan?: import('./review.js').ReviewPlan;
    forkPlan?: import('./fork.js').ForkPlan;
    review?: import('./review.js').ReviewResult;
    testCommand?: import('./test-run.js').ProjectTestCommand;
    testLoopback?: import('./test-run.js').ProjectTestLoopback;
    prPlan?: import('./merge.js').PrPlan;
    merged?: {commit:string};
    pr?: {url:string};
    results?: DeploymentTest[];
    found?: {name:string;provider:KeyProvider}[];
    sessions?: SessionInfo[];
    session?: SessionInfo;
    snapshot?: string;
    sessionId?: string;
    cols?: number;
    rows?: number;
    modes?: TerminalModes;
    matches?:FindMatch[]; moreMatches?:boolean;
    handoffPlan?: import('./handoff.js').HandoffPlan;
    handoffSummary?: import('./handoff.js').HandoffSummary | null;
    handoffOldRunning?: boolean;
    copy?:SessionText & {more?:boolean}; // Bounded chunks echo the same request id; client joins before resolving.
}
export type Response = SuccessResponse | {
    id?: string;
    ok: false;
    error: {
        code: string;
        message: string;
    };
} | {
    id: string;
    kind: 'helloMismatch';
    protocol: number;
};
export interface TerminalModes {
    applicationCursorKeys:boolean; applicationKeypad:boolean; bracketedPaste:boolean;
    mouseTracking:'none'|'x10'|'vt200'|'drag'|'any';
    mouseEncoding:'default'|'utf8'|'sgr'|'urxvt'; focusEvents:boolean; cursorVisible:boolean;
    cursorShape?:number;title?:string;kittyFlags?:number[];themeReports?:boolean;
}
export type SessionEvent = {
    kind: 'daemon.warning'; text: string;
} | {
    // v0.9.1: the queue changed (an item added, started, failed, removed).
    kind: 'queue.updated'; queue: import('./queue.js').QueueItem[];
} | {
    // A one-line homepage note for this daemon's lifetime (B24: the agent list was moved aside); unlike a warning it
    // never hides other notes.
    kind: 'daemon.notice'; text: string;
} | {
    kind: 'daemon.warningCleared';
} | {
    kind: 'session.previewResized'; sessionId: string; cols: number; rows: number;
} | {
    kind:'session.detached'; sessionId:string; reason:'attached elsewhere';
} | {
    kind: 'session.updated';
    session: SessionInfo;
} | {
    kind: 'session.removed';
    sessionId: string;
} | {
    // A notification click: clicks.subscribe clients select this agent. Carries the UUID only.
    kind: 'session.select'; sessionId: string;
} | {
    kind: 'usage.updated'; usage:UsageSummary;
} | {
    kind: 'system.stats';
    stats: SystemStats;
};
export interface Frame {
    type: 1 | 2 | 3;
    payload: Buffer;
}
export class ProtocolError extends Error {
    constructor(public readonly code: string, message: string) { super(message); }
}
function encode(type: 1 | 2 | 3, payload: Buffer): Buffer {
    if (payload.length + 1 > MAX_FRAME_BYTES)
        throw new ProtocolError('FRAME_TOO_LARGE', 'Frame exceeds 4 MB');
    const result = Buffer.allocUnsafe(payload.length + 5);
    result.writeUInt32BE(payload.length + 1);
    result[4] = type;
    payload.copy(result, 5);
    return result;
}
export function encodeControl(value: unknown): Buffer { return encode(1, Buffer.from(JSON.stringify(value))); }
export function encodeData(type: 2 | 3, sessionId: string, data: Buffer): Buffer {
    if (!isUUID(sessionId))
        throw new ProtocolError('INVALID_ID', 'Expected a session UUID');
    return encode(type, Buffer.concat([Buffer.from(sessionId, 'ascii'), data]));
}
export function decodeControl(frame: Frame): unknown {
    if (frame.type !== 1)
        throw new ProtocolError('INVALID_FRAME', 'Expected control frame');
    try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame.payload)) as unknown;
    }
    catch {
        throw new ProtocolError('INVALID_JSON', 'Control payload must be valid UTF-8 JSON');
    }
}
export class FrameDecoder {
    private pending = Buffer.alloc(0);
    private filled = 0;
    private expected: number | null = null;
    push(input: Buffer | string): Frame[] {
        let chunk = typeof input === 'string' ? Buffer.from(input) : input;
        const frames: Frame[] = [];
        while (chunk.length) {
            const target = this.expected === null ? 4 : this.expected;
            if (this.pending.length === 0)
                this.pending = Buffer.allocUnsafe(target);
            const count = Math.min(target - this.filled, chunk.length);
            chunk.copy(this.pending, this.filled, 0, count);
            this.filled += count;
            chunk = chunk.subarray(count);
            if (this.filled !== target)
                continue;
            if (this.expected === null) {
                const length = this.pending.readUInt32BE();
                this.pending = Buffer.alloc(0);
                this.filled = 0;
                if (length < 1 || length > MAX_FRAME_BYTES)
                    throw new ProtocolError('INVALID_LENGTH', 'Frame length outside 1–4 MB');
                this.expected = length;
            }
            else {
                const type = this.pending[0];
                if (type !== 1 && type !== 2 && type !== 3)
                    throw new ProtocolError('INVALID_TYPE', 'Unknown frame type');
                const payload = this.pending.subarray(1);
                if (type !== 1 && (payload.length < 36 || !isUUID(payload.subarray(0, 36).toString('ascii'))))
                    throw new ProtocolError('INVALID_ID', 'Data frame needs a session UUID');
                frames.push({ type, payload });
                this.pending = Buffer.alloc(0);
                this.filled = 0;
                this.expected = null;
            }
        }
        return frames;
    }
}
