import { ExtensionsPanel } from './extensions-panel.js';
import { socketExtensions } from '../extensions.js';
import { terminalBundle, RAISE_WINDOW } from '../../shared/terminal-app.js';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { DaemonRequestError, type RequestBody } from '../connection.js';
import { type AttachReason } from '../attach.js';
import { split, type SplitResult } from '../split.js';
import { configuredAttach } from '../configured-attach.js';
import { RESET_MODES } from '../terminal-modes.js';
import { MAX_FIND_CHARS, type FindMatch, type SessionInfo, type SuccessResponse, type AgentEngine, type EnginesStatus, type AuthRef, type KeyView, type SystemStats, type UsageSummary, type Budgets, type Effort, type Permission, type KeysRunOn } from '../../shared/protocol.js';
import { isSize, isUUID, validateSession, validateSettings, validateSuccess, isThemeName, warningText, validCwd, isValidModelId, validateSystemStats, validateUsageSummary, validateBudgets, isEffortForEngine, isPermissionForEngine, validateSessionText, validateWorktreePreview, isCliEngine } from '../../shared/validate.js';
import { getPaths } from '../../shared/paths.js';
import { Logger, redact } from '../../daemon/log.js';
import { ClientSignal } from '../signals.js';
import { CommandField, InputParser, type InputEvent } from './keys.js';
import { MessageField, FIRST_MESSAGE_TOO_LONG, type FieldView } from './message-field.js';
import { FIELD_X, fieldIndexAt, fieldStart } from './command-bar.js';
import { Preview, type Point } from './preview.js';
import { copyText } from './clipboard.js';
import { cleanSessionText } from './copy-clean.js';
import { BACKGROUND_QUERY, BackgroundReplies, createTheme, type Theme } from './theme.js';
import { diffFrame, type Frame } from './grid.js';
import { homepageLayout, renderHomepage, sortSessions, filteredCommands, visibleCards } from './layout.js';
import { nextCardTick } from './agent-card.js';
import { CredentialsPanel } from './credentials.js';
import { modelChoices, ownLoginLabel, engineTitle, keyEngine } from '../../shared/models.js';
import { drawAgentBox, type AgentBox } from './agent-box.js';
import { folderPath, completeFolder } from './folders.js';
import { BudgetForm, PriceForm, CapsForm, drawUsageForm } from './usage-forms.js';
import { DEFAULT_AGENT_CAPS } from '../../shared/agent-facts.js';
import {WorktreeQuestion} from './worktree-question.js';
import {WorktreesPanel} from './worktrees-panel.js';
import {commandRegistry,completeCommand,effortValues,modeValues,modeLabel,helpLines,type CommandContext} from './commands.js';
import {drawHelp,wrapHelpLines} from './help.js';
import { SPARKLINE_SAMPLES } from './this-mac.js';
import { MAX_PANES } from '../split-layout.js';
import { FindPanel } from './find-panel.js';
import { TextPanel } from './text-panel.js';
import { usageDetailLines } from './usage-details.js';
import { openFolder, OpenError, type FolderApp } from './open-folder.js';
import { parseSend, sendFailure, sendRefusal, SEND_TOO_LONG } from './send-command.js';
interface Input extends EventEmitter { isTTY?: boolean; isRaw?: boolean; setRawMode(raw: boolean): unknown; resume(): unknown; pause(): unknown }
interface Output extends EventEmitter { isTTY?: boolean; columns?: number; rows?: number; write(data: string | Buffer): boolean }
// The homepage's connection capability intentionally excludes input(). Attach gets the real connection separately.
export interface HomepageConnection extends EventEmitter { request(body: RequestBody): Promise<SuccessResponse> }
interface Options { stdin?: Input; stdout?: Output; signals?: EventEmitter; cwd?: string; truecolor?: boolean; copy?: (text: string) => Promise<void>;copyLog?:Pick<Logger,'error'>; attachSession?: (id: string) => Promise<AttachReason>; splitSessions?: (ids: string[], theme: Theme) => Promise<SplitResult>; attachOnStart?: string; terminalProgram?:string; doctor?: () => Promise<string[]>; openFolder?: (path: string, app: FolderApp) => Promise<string> }
const ENTER_HOME = RESET_MODES + '\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?1002h\x1b[?1006h\x1b[?2004h';
export class Homepage {
  readonly done: Promise<void>;
  private resolveDone: () => void = () => {};
  private rejectDone: (error: Error) => void = () => {};
  private readonly stdin: Input;
  private readonly stdout: Output;
  private readonly signals: EventEmitter;
  private originalRaw = false;
  private showing = false;
  private ended = false;
  private attached = false;
  private sessions: SessionInfo[] = [];
  private selectedId: string | null = null;
  private visible = true;
  private field = new CommandField();
  private menuChoice = 0;
  private effort:Effort|null=null;private permission:Permission='ask';private cleanIds:string[]|null=null;private helpOffset:number|null=null;
  // The keep/delete question after x, or the /worktrees popup; its keys never reach the command field.
  private worktreeUi?:WorktreeQuestion|WorktreesPanel;
  // /find results, or the read-only /doctor and /usage popups; their keys never reach the command field.
  private popup?:FindPanel|TextPanel|ExtensionsPanel;
  // Agents marked with Space for the next split (list order when it opens), and the last split Ctrl+E left.
  private marked=new Set<string>();
  private lastSplit:string[]=[];
  private theme: Theme = createTheme('graphite');
  private background?: string;
  private backgroundResolve?: () => void;
  private backgroundTimer?: ReturnType<typeof setTimeout>;
  private inputTimer?: ReturnType<typeof setTimeout>;
  private noteTimer?: ReturnType<typeof setTimeout>;
  private note = '';
  private warning = '';
  private engine: AgentEngine = 'claude-code';
  private keysRunOn: KeysRunOn = 'ai-term';
  private contextWarning = true;
  private model: string | null = null;
  private folder: string;
  private worktrees:'on'|'off'='on';
  private readonly terminal:import('../../shared/protocol.js').TerminalBundle|undefined;
  private engines?: EnginesStatus;
  private box?: AgentBox;
  private returnToStart = false;
  private credentials?:CredentialsPanel;
  private savingDefault=false;
  private keys:KeyView[]=[];
  private auth:AuthRef={kind:'account'};
  private copying = false;
  private pasteNote = '';
  private confirmId: string | null = null;
  private renameId: string | null = null;
  private previews = new Map<string, Preview>();
  private previewId: string | null = null;
  private previewRequestId: string | null = null;
  private loading: { id: string; chunks: Buffer[]; bytes: number } | null = null;
  private serial: Promise<void> = Promise.resolve();
  private previous: Frame | null = null;
  private previewCells?: Frame;
  private nextPreview = 0;
  private drawTimer?: ReturnType<typeof setTimeout>;
  private cardTimer?: ReturnType<typeof setTimeout>;
  private blocked = false;
  private forceRedraw = true;
  private drag: Point | null = null;
  private fieldDrag: { x: number; index: number } | null = null;
  private fieldScroll = 0;
  private stats: SystemStats | null = null;
  private cpuHistory: number[] = [];
  private statsOn = false;
  private usageOn=false;private usage:UsageSummary|null=null;private budgets:Budgets={daily:null,weekly:null,monthly:null};
  private usageForm?:BudgetForm|PriceForm|CapsForm;private usageFormError='';
  private disconnected = false;
  private readonly parser: InputParser;
  private readonly replies: BackgroundReplies;
  constructor(private readonly connection: HomepageConnection, private readonly options: Options = {}) {
    this.stdin = options.stdin ?? process.stdin; this.stdout = options.stdout ?? process.stdout; this.signals = options.signals ?? process;
    this.terminal=terminalBundle(options.terminalProgram??process.env.TERM_PROGRAM);
    this.folder = options.cwd ?? process.cwd();
    this.done = new Promise((resolve, reject) => { this.resolveDone = resolve; this.rejectDone = reject; });
    this.parser = new InputParser(event => this.handleInput(event));
    this.replies = new BackgroundReplies(background => { this.background = background; this.backgroundResolve?.(); });
  }
  private size() { const cols = this.stdout.columns ?? 80, rows = this.stdout.rows ?? 24; if (!isSize(cols, rows)) throw new Error('Terminal size outside supported range'); return { cols, rows }; }
  async start(): Promise<void> {
    if (!this.stdin.isTTY || !this.stdout.isTTY) throw new Error('Homepage requires an interactive terminal');
    this.originalRaw = this.stdin.isRaw ?? false;
    this.connection.on('event', this.onEvent); this.connection.on('output', this.onOutput); this.connection.on('disconnected', this.onDisconnect);
    for (const [name, guard] of this.guards) this.signals.on(name, guard);
    try {
      this.enter();
      const settings = validateSettings((await this.connection.request({ kind: 'settings.get' })).settings);
      this.worktrees=settings.worktrees??'on';this.keysRunOn=settings.keysRunOn??'ai-term';this.contextWarning=settings.contextWarning!==false;
      this.budgets=validateBudgets(settings.budgets??{});
      if (settings.defaultEngine) this.engine = settings.defaultEngine;
      if (settings.defaultModel !== undefined) this.model = settings.defaultModel;
      if(settings.defaultEffort!==undefined&&isEffortForEngine(this.engine,settings.defaultEffort))this.effort=settings.defaultEffort;
      if(settings.defaultCwd && await validCwd(settings.defaultCwd))this.folder=settings.defaultCwd;
      if (settings.theme === 'auto') await this.detectBackground();
      if (this.ended) return;
      this.theme = createTheme(settings.theme, this.background);
      const result = await this.connection.request({ kind: 'sessions.list' });
      if (!Array.isArray(result.sessions)) throw new Error('Missing daemon sessions');
      this.sessions = result.sessions.map(validateSession); this.selectedId = sortSessions(this.sessions)[0]?.id ?? null;
      const engines=(await this.connection.request({kind:'engines.status'})).engines;this.engines=engines;
      this.keys=(await this.connection.request({kind:'keys.list'})).keys??[];
      if(engines && engines.claudeCode.loggedIn!==true && engines.codex.loggedIn!==true && !this.keys.length)await this.openCredentials('login');
      this.draw(true);await this.updatePreview(true);await this.subscribeStats(true);await this.subscribeUsage(true);
      // Notification clicks select agents here while this homepage is open. An older daemon refuses the request;
      // its clicks then open a new Terminal window instead, which is all this homepage needs to know.
      await this.connection.request({ kind: 'clicks.subscribe', on: true, ...(this.terminal?{terminal:this.terminal}:{}) }).catch((error: unknown) => { if (!(error instanceof DaemonRequestError)) throw error; });
      if (this.options.attachOnStart) this.attachOnStart(this.options.attachOnStart);
    } catch (error) { await this.stop(error instanceof Error ? error : new Error('Homepage failed')); throw error; }
  }
  private enter(): void {
    if (this.ended) return;
    this.showing = true; this.stdout.write(ENTER_HOME); this.stdin.setRawMode(true); this.stdin.resume();
    this.stdin.on('data', this.onData); this.stdin.on('error', this.onError); this.stdout.on('error', this.onError); this.stdout.on('drain', this.onDrain);
    this.signals.on('SIGWINCH', this.onResize); this.signals.on('SIGINT', this.onSignal); this.signals.on('SIGTERM', this.onTerm); this.signals.on('SIGHUP', this.onHup); this.signals.on('SIGQUIT', this.onQuit); this.signals.on('uncaughtException', this.onError); this.signals.on('unhandledRejection', this.onError); this.signals.on('exit', this.onExit);
    this.previous = null; this.previewCells = undefined; this.forceRedraw = true; this.blocked = false;
  }
  private leave(): void {
    if (this.drawTimer) clearTimeout(this.drawTimer); if (this.inputTimer) clearTimeout(this.inputTimer); if (this.cardTimer) clearTimeout(this.cardTimer); this.cardTimer = undefined;
    this.parser.dispose();
    this.stdin.off('data', this.onData); this.stdin.off('error', this.onError); this.stdout.off('error', this.onError); this.stdout.off('drain', this.onDrain);
    this.signals.off('SIGWINCH', this.onResize); this.signals.off('SIGINT', this.onSignal); this.signals.off('SIGTERM', this.onTerm); this.signals.off('SIGHUP', this.onHup); this.signals.off('SIGQUIT', this.onQuit); this.signals.off('uncaughtException', this.onError); this.signals.off('unhandledRejection', this.onError); this.signals.off('exit', this.onExit);
    if (!this.showing) return;
    this.showing = false;
    this.drawTimer = undefined; this.inputTimer = undefined;
    try { this.stdout.write(RESET_MODES + '\x1b[?1049l'); }
    finally { try { this.stdin.setRawMode(this.originalRaw); } finally { this.stdin.pause(); } }
  }
  async stop(error?: Error): Promise<void> {
    if (this.ended) return;
    this.ended = true; this.loading = null; this.credentials?.dispose();this.usageForm=undefined;this.worktreeUi=undefined;this.popup=undefined;
    if (this.backgroundTimer) clearTimeout(this.backgroundTimer); this.backgroundResolve?.();
    if (this.noteTimer) clearTimeout(this.noteTimer);
    this.connection.off('event', this.onEvent); this.connection.off('output', this.onOutput); this.connection.off('disconnected', this.onDisconnect);
    for (const [name, guard] of this.guards) this.signals.off(name, guard);
    try { this.leave(); } catch (cleanupError) { error ??= cleanupError instanceof Error ? cleanupError : new Error('Terminal restore failed'); }
    for (const preview of this.previews.values()) preview.dispose(); this.previews.clear();
    // Quitting never waits on the daemon; it drops a closed connection's usage subscription, as with stats below.
    if(this.usageOn){this.usageOn=false;void this.connection.request({kind:'usage.subscribe',on:false}).catch(()=>undefined);}
    if (this.statsOn && !this.disconnected) {
      this.statsOn = false;
      // Not awaited: quitting never waits on a slow daemon. The CLI closes the connection right after, and the
      // daemon drops a closed connection's subscription, so a failed request here leaves nothing behind.
      void this.connection.request({ kind: 'system.subscribe', on: false }).catch(() => undefined);
    }
    if (error) this.rejectDone(error); else this.resolveDone();
  }
  private onExit = () => { this.leave(); };
  private onError = (error: unknown) => { void this.stop(error instanceof Error ? error : new Error('Homepage failed')); };
  private onSignal = () => { void this.stop(); };
  private onTerm = () => { void this.stop(new ClientSignal(143)); };
  private onHup = () => { void this.stop(new ClientSignal(129)); };
  private onQuit = () => { void this.stop(new ClientSignal(131)); };
  // Leaving a session, attach drops its signal listeners and awaits the detach reply before enter() takes them back.
  // With no listener Node restores the default action and the signal kills the client, so these stay installed for
  // the homepage's whole life and keep a signal nobody else heard until attach returns.
  private pendingSignal: ClientSignal | null = null;
  private guard = (name: string, code: number) => () => { if (this.signals.listenerCount(name) === 1) this.pendingSignal ??= new ClientSignal(code); };
  private readonly guards: [string, () => void][] = [['SIGTERM', this.guard('SIGTERM', 143)], ['SIGHUP', this.guard('SIGHUP', 129)], ['SIGQUIT', this.guard('SIGQUIT', 131)]];
  private onDisconnect = () => { this.disconnected = true; void this.stop(new Error('Daemon connection closed')); };
  private onDrain = () => { this.blocked = false; this.draw(true); };
  private onResize = () => {
    try { this.previous = null; this.previewCells = undefined; this.forceRedraw = true; this.draw(true); this.enqueue(() => this.updatePreview(true)); }
    catch (error) { this.onError(error); }
  };
  private onData = (value: Buffer | string) => {
    try {
      if (this.inputTimer) clearTimeout(this.inputTimer);
      const data = this.replies.push(typeof value === 'string' ? Buffer.from(value) : value); this.parser.push(data);
      this.inputTimer = setTimeout(() => { try { this.parser.push(this.replies.flush()); } catch (error) { this.onError(error); } }, 30);
    } catch (error) { this.onError(error); }
  };
  private enqueue(task: () => Promise<void>): void {
    this.serial = this.serial.then(async () => { if (!this.ended) await task(); }).catch(error => this.onError(error));
  }
  private showNote(text: string, duration?: number, copying = false): void {
    if (this.noteTimer) clearTimeout(this.noteTimer);
    this.note = text; this.copying = copying; this.draw(true);
    if (duration) this.noteTimer = setTimeout(() => { this.note = ''; this.copying = false; this.draw(true); }, duration);
  }
  private handleInput(event: InputEvent): void {
    if (!this.showing || this.ended) return;
    if (event.kind === 'mouse') { if(this.helpOffset===null&&!this.box&&!this.credentials&&!this.cleanIds&&!this.worktreeUi&&!this.popup)this.mouse(event); return; }
    if (event.kind === 'paste') {
      // A paste never reaches the worktree question: deleting work needs the branch name typed.
      if(this.helpOffset!==null||this.cleanIds||this.worktreeUi||this.popup)return;
      if(event.tooLong&&!this.box&&this.field.text.startsWith('/send ')){this.pasteNote=SEND_TOO_LONG;this.draw(true);return;}
      if(event.tooLong){if(this.box?.kind==='start')this.box.messageNote=FIRST_MESSAGE_TOO_LONG;else this.pasteNote=FIRST_MESSAGE_TOO_LONG;this.draw(true);return;}
      this.pasteNote='';
      if(this.credentials){const panel=this.credentials;this.enqueue(async()=>{panel.paste(event.text);});}
      else if(this.usageForm)this.usageForm.paste(event.text);
      else if(this.box)this.boxText(event.text,true);
      else {const error=this.field.paste(event.text);this.menuChoice=0;this.pasteNote=error===FIRST_MESSAGE_TOO_LONG&&this.field.text.startsWith('/send ')?SEND_TOO_LONG:error??'';}
      this.draw(true);return;
    }
    this.pasteNote='';
    if (event.key === 'ctrl-c') {
      const action = this.field.key('ctrl-c');
      if (action.kind === 'quit') void this.stop();
      else if (action.kind === 'note') this.showNote(action.text, 1000);
      return;
    }
    if(this.helpOffset!==null){if(event.key==='escape')this.helpOffset=null;else{const page=Math.max(1,this.size().rows-8),delta=event.key==='up'?-1:event.key==='down'?1:event.key==='page-up'?-page:event.key==='page-down'?page:0;this.helpOffset=Math.max(0,Math.min(Math.max(0,wrapHelpLines(helpLines(this.commandContext()),Math.min(this.size().cols,110)-6).length-page),this.helpOffset+delta));}this.draw(true);return;}
    if(this.worktreeUi){const ui=this.worktreeUi;this.enqueue(()=>ui.key(event.key));return;}
    if(this.popup){const popup=this.popup;if(popup instanceof ExtensionsPanel)this.enqueue(()=>popup.key(event.key));else popup.key(event.key);this.draw(true);return;}
    if(this.cleanIds){
      const ids=this.cleanIds;
      if(event.key==='y'){this.cleanIds=null;this.enqueue(async()=>{
        // /clean never deletes worktrees: it removes list records only and counts the worktrees it kept.
        let failure='',removed=0,failed=0,kept=0;for(const id of ids){const session=this.sessions.find(s=>s.id===id);if(session&&['exited','error'].includes(session.status)){
          try{const result=await this.connection.request({kind:'sessions.remove',sessionId:id});if(result.keptWorktree)kept++;removed++;}catch(error){failed++;if(!failure)failure=error instanceof Error?error.message:'Record could not remove';}
        }}this.showNote(`removed ${removed}, ${failed} failed${failure?' · '+failure:''}${kept?` · kept ${kept} worktree${kept===1?'':'s'} · /worktrees reviews them`:''}`);
      });}else if(event.key==='n'||event.key==='escape'){this.cleanIds=null;this.showNote('');}return;
    }
    if(this.usageForm){const form=this.usageForm;if(event.key==='escape'){this.usageForm=undefined;this.usageFormError='';}else if(event.key==='enter')this.enqueue(async()=>{try{if(form instanceof BudgetForm){const budgets=form.values();await this.connection.request({kind:'settings.set',patch:{budgets}});this.budgets=budgets;}else if(form instanceof CapsForm){await this.connection.request({kind:'settings.set',patch:{agentCaps:form.values()}});}else{const {model,price}=form.values(),settings=(await this.connection.request({kind:'settings.get'})).settings;await this.connection.request({kind:'settings.set',patch:{priceOverrides:{...settings?.priceOverrides,[model]:price}}});}this.usageForm=undefined;}catch(error){this.usageFormError=error instanceof Error?error.message:'Settings could not save';}this.draw(true);});else form.key(event.key);this.draw(true);return;}
    if(this.credentials){const panel=this.credentials;if(event.key==='escape'){panel.dispose();this.credentials=undefined;this.enqueue(async()=>{await this.refreshSettings();this.draw(true);});}else this.enqueue(()=>panel.key(event.key));return;}
    if (this.box) { this.boxInput(event.key); return; }
    if (this.confirmId) {
      const id = this.confirmId;
      if (event.key === 'y') { this.confirmId = null; this.enqueue(async () => { await this.operation({ kind: 'sessions.stop', sessionId: id }); }); }
      else if (event.key === 'n' || event.key === 'escape') { this.confirmId = null; this.showNote(''); }
      return;
    }
    if (this.renameId) {
      if (event.key === 'escape') { this.renameId = null; this.field.text = ''; this.showNote(''); return; }
      if (event.key === 'enter') {
        const id = this.renameId, title = this.field.text;
        this.renameId = null; this.field.text = ''; this.enqueue(() => this.operation({ kind: 'sessions.rename', sessionId: id, title })); return;
      }
      this.field.key(event.key); this.showNote('rename: type a name, ⏎ save · Esc cancel'); return;
    }
    if(!this.field.hasPastes&&this.field.text.startsWith('/')){
      const choices=filteredCommands(this.field.text);
      if(event.key==='up'||event.key==='down'){
        if(choices.length)this.menuChoice=(this.menuChoice+(event.key==='up'?-1:1)+choices.length)%choices.length;
        this.draw(true);return;
      }
      if(event.key==='tab'){this.field.text=completeCommand(this.field.text,this.menuChoice,this.commandContext());this.menuChoice=0;this.draw(true);return;}
      if(event.key==='enter'&&!this.field.text.includes(' ')){
        const command=choices[this.menuChoice];if(!command)return;
        if(command!=='/copy'&&command!=='/open'&&commandRegistry.find(c=>c.name===command)?.argumentHint){this.field.text=command+' ';this.menuChoice=0;this.draw(true);return;}
        this.field.text='';this.menuChoice=0;this.queueSubmit(command);return;
      }
    }
    if(event.key==='b'&&!this.field.text){this.usageForm=new BudgetForm(this.budgets);this.draw(true);return;}
    if(event.key==='u'&&!this.field.text){this.enqueue(()=>this.openUsage());return;}
    const beforeText=this.field.text, action = this.field.key(event.key);
    if(this.field.text!==beforeText)this.menuChoice=0;
    switch (action.kind) {
      case 'quit': void this.stop(); return;
      case 'note': this.showNote(action.text, 1000); return;
      case 'submit': this.queueSubmit(action.text,action.message); break;
      case 'attach': this.enqueue(() => this.openSelected()); break;
      case 'preview': this.visible = !this.visible; this.previewCells = undefined; this.enqueue(() => this.updatePreview(true)); break;
      case 'up': case 'down': {
        const sessions = sortSessions(this.sessions), index = sessions.findIndex(s => s.id === this.selectedId), next = sessions[Math.max(0, Math.min(sessions.length - 1, index + (action.kind === 'up' ? -1 : 1)))];
        if (next && next.id !== this.selectedId) { this.selectedId = next.id; this.drag = null; this.previewCells = undefined; this.enqueue(() => this.updatePreview(false)); }
        break;
      }
      case 'page-up': case 'page-down': this.currentPreview()?.scroll((action.kind === 'page-up' ? -1 : 1) * homepageLayout(this.size().cols, this.size().rows).terminal.h); break;
      case 'end': this.currentPreview()?.follow(); break;
      case 'stop': { const session = this.sessions.find(s => s.id === this.selectedId); if (session) { this.confirmId = session.id; this.showNote(`stop ${session.title}? y/n`); } break; }
      case 'rename': { const session = this.sessions.find(s => s.id === this.selectedId); if (session) { this.renameId = session.id; this.field.text = session.title; this.showNote('rename: type a name, ⏎ save · Esc cancel'); } break; }
      case 'copy': {const selected=this.sessions.find(s=>s.id===this.selectedId)??null;this.enqueue(()=>this.copySelected(selected));break;}
      case 'remove': { const session = this.sessions.find(s => s.id === this.selectedId); if (session && ['exited', 'error'].includes(session.status)) this.enqueue(() => this.removeSession(session.id)); break; }
      case 'mark': this.mark(); break;
      case 'split': this.enqueue(() => this.openSplit()); break;
    }
    this.draw(true);
  }
  private async operation(body: RequestBody): Promise<void> {
    try { await this.connection.request(body); this.showNote(''); }
    catch (error) { this.showNote(error instanceof Error ? error.message : 'Operation failed'); }
  }
  private splittable(id:string):boolean{const session=this.sessions.find(s=>s.id===id);return !!session&&!['exited','error'].includes(session.status);}
  // Space marks or unmarks the selected agent for a split; an ended agent can't join one, and a split holds four.
  private mark():void{
    const session=this.sessions.find(s=>s.id===this.selectedId);if(!session)return;
    if(!this.marked.has(session.id)&&!this.splittable(session.id)){this.showNote(`${session.title} has exited · x removes it`);return;}
    const count=[...this.marked].filter(id=>this.splittable(id)).length;
    if(!this.marked.has(session.id)&&count>=MAX_PANES){this.showNote(`a split holds ${MAX_PANES} agents · Space unmarks one`);return;}
    const marked=new Set(this.marked);if(marked.has(session.id))marked.delete(session.id);else marked.add(session.id);this.marked=marked;
    const now=[...marked].filter(id=>this.splittable(id)).length;
    this.showNote(now?`${now} marked · ${now>=2?'v opens them side by side':'Space marks one more'}`:'');
  }
  // v opens the marked agents side by side in list order; with none marked it reopens the split Ctrl+E left.
  private async openSplit():Promise<void>{
    const marked=sortSessions(this.sessions).filter(s=>this.marked.has(s.id)&&this.splittable(s.id)).map(s=>s.id);
    const ids=marked.length?marked:this.lastSplit.filter(id=>this.splittable(id));
    if(ids.length<2){this.showNote(marked.length===1?'Space marks one more agent · v opens the split':'Space marks 2–4 agents · v opens them side by side');return;}
    const split=this.options.splitSessions;if(!split){this.showNote('Split unavailable');return;}
    this.marked=new Set();
    await this.away(async()=>{
      const result=await split(ids,this.theme);
      this.lastSplit=result.reason==='home key'?ids:[];
      if(!result.remaining)return result.reason==='client interrupted'?result.reason:'';
      // One pane left (or only one fits) is a normal attach.
      const note=result.dropped?`only one pane fits · ${result.dropped} ${result.dropped===1?'agent':'agents'} didn't fit`:'';
      const reason=this.options.attachSession?await this.options.attachSession(result.remaining):'home key';
      return reason==='home key'?note:reason;
    });
  }
  // The record goes first; its worktree then gets one keep/delete question, and keeping is the default.
  private async removeSession(id:string):Promise<void>{
    let kept:string|undefined;
    try{kept=(await this.connection.request({kind:'sessions.remove',sessionId:id})).keptWorktree;}
    catch(error){this.showNote(error instanceof Error?error.message:'Operation failed');return;}
    if(!kept){this.showNote('');return;}
    const question:WorktreeQuestion=new WorktreeQuestion(kept,body=>this.connection.request(body),()=>this.draw(true),note=>{if(this.worktreeUi===question)this.worktreeUi=undefined;this.showNote(note);});
    this.worktreeUi=question;await question.load();
  }
  private async openWorktrees():Promise<void>{
    const panel:WorktreesPanel=new WorktreesPanel(body=>this.connection.request(body),()=>this.draw(true),()=>{if(this.worktreeUi===panel)this.worktreeUi=undefined;this.draw(true);});
    this.worktreeUi=panel;this.draw(true);await panel.load();
  }
  // D50: the one way text typed on the homepage reaches an agent, and only through this explicit command.
  private async send(input:string):Promise<void>{
    const parsed=parseSend(input,this.sessions);
    if('note' in parsed){this.showNote(parsed.note);return;}
    const {session,text}=parsed,refused=sendRefusal(session);
    if(refused){this.showNote(refused);return;}
    try{await this.connection.request({kind:'sessions.send',sessionId:session.id,text});}
    catch(error){this.showNote(sendFailure(session.title,error instanceof Error?error.message:'Send failed'));return;}
    const lines=text.split('\n').length;
    this.showNote(`✓ sent to ${session.title}${lines>1?` · ${lines} lines`:''}`,2000);
  }
  // A fresh start of a finished agent with its saved recipe; the new agent replaces it in the list.
  private async retrySelected(session:SessionInfo|null):Promise<void>{
    if(!session){this.showNote('select an agent first');return;}
    if(!['exited','error'].includes(session.status)){this.showNote(`${session.title} is still running · /retry restarts finished agents`);return;}
    let result:SuccessResponse;
    try{result=await this.connection.request({kind:'sessions.retry',sessionId:session.id});}
    catch(error){const reason=error instanceof Error?error.message:'Retry failed';this.showNote(reason==='Its worktree is gone'||reason==='Its folder is gone'?`${session.title}: ${reason.toLowerCase()} · start a new agent`:reason);return;}
    this.sessions=this.sessions.filter(s=>s.id!==session.id);this.previews.get(session.id)?.dispose();this.previews.delete(session.id);
    await this.selectNew(result);
    this.showNote(`✓ restarted ${session.title}${session.worktree?' in its worktree':''}${session.engine==='shell'?'':' · its first message isn\'t resent'}`,3000);
  }
  private async openExtensions(tab:'skills'|'agents'):Promise<void>{
    const panel=new ExtensionsPanel(socketExtensions(body=>this.connection.request(body)),this.folder,tab,()=>this.draw(true),()=>{if(this.popup===panel)this.popup=undefined;this.draw(true);});
    this.popup=panel;this.draw(true);await panel.load();
  }
  private async openUsage():Promise<void>{
    const panel:TextPanel=new TextPanel('Usage',()=>this.draw(true),()=>{if(this.popup===panel)this.popup=undefined;this.draw(true);});
    this.popup=panel;this.draw(true);
    try{const usage=validateUsageSummary((await this.connection.request({kind:'usage.summary'})).usage);panel.set(usageDetailLines(usage,this.budgets));}
    catch(error){panel.set([{text:`Usage unavailable: ${error instanceof Error?error.message:'request failed'}`,tone:'status-error'}]);}
  }
  private async openDoctor():Promise<void>{
    const panel:TextPanel=new TextPanel('Doctor',()=>this.draw(true),()=>{if(this.popup===panel)this.popup=undefined;this.draw(true);},'· checking Node, the daemon, files and the CLIs');
    this.popup=panel;this.draw(true);
    const doctor=this.options.doctor;
    if(!doctor){panel.set([{text:'Doctor unavailable here; run ai doctor',tone:'ink-3'}]);return;}
    try{panel.set((await doctor()).map(text=>({text,tone:'ink-2'})));}
    catch(error){panel.set([{text:`Doctor failed: ${error instanceof Error?error.message:'check failed'}`,tone:'status-error'}]);}
  }
  private async openFind(query:string):Promise<void>{
    const text=query.replace(/[\p{C}]/gu,'');
    if(!text.trim()){this.showNote('/find <text> · plain text, any case');return;}
    if([...text].length>MAX_FIND_CHARS){this.showNote(`/find takes at most ${MAX_FIND_CHARS} characters`);return;}
    const panel:FindPanel=new FindPanel(text,body=>this.connection.request(body),()=>this.sessions,()=>this.draw(true),()=>{if(this.popup===panel)this.popup=undefined;this.draw(true);},match=>this.enqueue(()=>this.showMatch(match)));
    this.popup=panel;this.draw(true);await panel.load();
  }
  // ⏎ on a /find hit: select its agent and scroll the preview so the line is in view.
  private async showMatch(match:FindMatch):Promise<void>{
    if(!this.sessions.some(s=>s.id===match.sessionId)){this.showNote('that agent is gone');return;}
    const resize=!this.visible;this.visible=true;this.selectedId=match.sessionId;this.drag=null;this.previewCells=undefined;
    await this.updatePreview(resize);
    this.currentPreview()?.scrollTo(match.fromEnd,match.text.slice(match.start,match.start+match.length));this.draw(true);
  }
  private async openFolderOf(session:SessionInfo|null,app:FolderApp):Promise<void>{
    if(!session){this.showNote('select an agent first');return;}
    const path=session.worktree??session.cwd,home=homedir(),shown=path.startsWith(`${home}/`)?`~${path.slice(home.length)}`:path;
    try{const where=await (this.options.openFolder??openFolder)(path,app);this.showNote(`opened ${shown} in ${where}`,2000);}
    catch(error){
      // OpenError messages are fixed text, so they can go to the log as they are.
      (this.options.copyLog??new Logger(getPaths().log)).error(`Open folder failed (${app}): ${error instanceof OpenError?error.message:'unexpected error'}`);
      this.showNote(error instanceof OpenError?`${error.message} · ${shown}`:`couldn't open ${shown}`);
    }
  }
  private async copySelected(session:SessionInfo|null,all=false):Promise<void>{
    if(!session){this.showNote('select an agent first');return;}
    let copy:ReturnType<typeof validateSessionText>;
    try{const result=await this.connection.request({kind:'sessions.text',sessionId:session.id,...(!all&&session.engine!=='shell'?{lastReply:true}:{})});copy=validateSessionText(result.copy);if(copy.sessionId!==session.id||copy.more===true)throw new Error('Invalid session text');}
    catch{this.showNote('Copy failed: session text unavailable');return;}
    if(this.ended)return;
    const text=copy.source==='last-reply'?copy.text:cleanSessionText(copy.text);
    try{await (this.options.copy??copyText)(text);}
    catch{(this.options.copyLog??new Logger(getPaths().log)).error('Clipboard copy failed');this.showNote('Copy failed: clipboard unavailable');return;}
    const lines=text?text.split('\n').length:0;
    if(!this.ended)this.showNote(`✓ copied ${lines} lines from ${session.title}${copy.truncated?' (oldest lines cut at 5 MB)':''}${all||copy.source==='last-reply'?'':' · last reply only comes with v0.2'}`,2000,true);
  }
  private commandContext():CommandContext{return {engine:this.engine,model:this.model,cwd:this.folder,theme:this.theme.name,effort:this.effort,permission:this.permission,selectedTitle:this.sessions.find(s=>s.id===this.selectedId)?.title,agents:sortSessions(this.sessions).filter(s=>!['exited','error'].includes(s.status)).map(s=>s.title)};}
  private async selectNew(result:SuccessResponse):Promise<void>{const session=validateSession(result.session);this.sessions=[session,...this.sessions.filter(s=>s.id!==session.id)];this.selectedId=session.id;this.previewCells=undefined;await this.updatePreview(false);this.draw(true);}
  private queueSubmit(text:string,message?:MessageField):void{const selected=this.sessions.find(s=>s.id===this.selectedId)??null;this.enqueue(()=>this.submit(text,selected,message));}
  private async submit(text: string, copyTarget:SessionInfo|null=null,message?:MessageField): Promise<void> {
    // /send carries its text, paste tokens included, to the agent; it never opens the start box.
    if(text==='/send'||text.startsWith('/send ')){await this.send(text);return;}
    if(message?.hasPastes){this.openBox('start',text,message);await this.checkSelectedEngine();return;}
    const [command,...parts]=text.trim().split(/\s+/),argument=parts.join(' ');
    if(command==='/copy'){if(argument&&argument!=='all'){this.showNote('/copy or /copy all');return;}await this.copySelected(copyTarget,argument==='all');return;}
    if(command==='/skills'||command==='/agents'){if(argument){this.showNote(`${command} takes no argument`);return;}await this.openExtensions(command==='/skills'?'skills':'agents');return;}
    if(command==='/help'){this.helpOffset=0;this.draw(true);return;}
    if(['/retry','/budget','/usage','/doctor'].includes(command??'')&&argument){this.showNote(`${command} takes no argument${command==='/retry'?'; it uses the selected agent':''}`);return;}
    if(command==='/retry'){await this.retrySelected(copyTarget);return;}
    if(command==='/budget'){this.usageForm=new BudgetForm(this.budgets);this.draw(true);return;}
    if(command==='/usage'){await this.openUsage();return;}
    if(command==='/doctor'){await this.openDoctor();return;}
    if(command==='/find'){await this.openFind(text.trim().slice('/find'.length).trim());return;}
    if(command==='/open'){if(argument&&argument!=='code'){this.showNote('/open or /open code');return;}await this.openFolderOf(copyTarget,argument==='code'?'code':'finder');return;}
    if(command==='/worktrees'){if(argument){this.showNote('/worktrees takes no argument');return;}await this.openWorktrees();return;}
    if(command==='/clean'){if(argument){this.showNote('/clean takes no argument');return;}this.cleanIds=this.sessions.filter(s=>['exited','error'].includes(s.status)).map(s=>s.id);if(!this.cleanIds.length){this.cleanIds=null;this.showNote('No finished agents to remove');}else this.showNote(`remove ${this.cleanIds.length} finished agents? y/n`);return;}
    if(command==='/shell'){if(argument){this.showNote('/shell takes no argument; use /cd');return;}try{await this.selectNew(await this.connection.request({kind:'sessions.create',engine:'shell',cwd:this.folder}));}catch(error){this.showNote(error instanceof Error?error.message:'Shell could not start');}return;}
    if(command==='/resume'){if(argument){this.showNote('/resume uses the selected agent');return;}const session=this.sessions.find(s=>s.id===this.selectedId);if(!session||!['exited','error'].includes(session.status)){this.showNote('Select an exited or failed agent to resume');return;}if(session.engine==='shell'){this.showNote('A shell has no AI conversation to resume');return;}if(session.engine==='claude-code'&&!session.conversationId){this.showNote('This older Claude agent has no conversation ID');return;}try{await this.selectNew(await this.connection.request({kind:'sessions.resume',sessionId:session.id}));if(session.engine==='codex')this.showNote('Codex resume picker · choose its conversation');}catch(error){this.showNote(error instanceof Error?error.message:'Resume failed');}return;}
    if(command==='/effort'){if(!argument){this.openBox('effort');return;}const effort=argument==='CLI default'?null:argument;if(!isEffortForEngine(this.engine,effort)){this.showNote('/effort '+effortValues(this.engine).join('|'));return;}this.effort=effort;this.showNote('');return;}
    if(command==='/mode'){if(!argument){this.openBox('mode');return;}const permission=argument==="don't ask"||argument==='dontAsk'?'dontAsk':argument;if(!isPermissionForEngine(this.engine,permission)){this.showNote(this.engine==='codex'&&permission==='auto'?'Codex has no distinct auto mode; choose ask or don\'t ask':'/mode ask|auto|don\'t ask');return;}this.permission=permission;this.showNote('');return;}
    if (text === '/exit') { await this.stop(); return; }
    const theme = text.match(/^\/theme (graphite|slate|ink|auto|light)$/)?.[1];
    if (isThemeName(theme)) {
      const result = await this.connection.request({ kind: 'settings.set', patch: { theme } });
      validateSettings(result.settings);
      if (theme === 'auto') await this.detectBackground();
      this.theme = createTheme(theme, this.background); this.previewCells = undefined; this.previous = null; this.forceRedraw = true; this.showNote(''); return;
    }
    if (text.startsWith('/theme')) { this.showNote('/theme graphite|slate|ink|auto|light'); return; }
    if (text === '/model' || text === '/cd') { this.engines=(await this.connection.request({kind:'engines.status'})).engines;this.keys=(await this.connection.request({kind:'keys.list'})).keys??[]; this.openBox(text === '/model' ? 'model' : 'folder'); return; }
    if (text==='/settings'||text==='/login') { await this.openCredentials(text==='/settings'?'settings':'login'); return; }
    if (text.startsWith('/')) { this.showNote('Unknown command'); return; }
    this.openBox('start', text); await this.checkSelectedEngine();
  }
  private async openCredentials(kind:'login'|'settings'):Promise<void>{
    this.box=undefined;
    const panel=new CredentialsPanel(kind,{
      request:body=>this.connection.request(body),changed:()=>this.draw(true),close:()=>{panel.dispose();if(this.credentials===panel)this.credentials=undefined;this.enqueue(async()=>{await this.refreshSettings();this.draw(true);});},
      login:async engine=>{const response=await this.connection.request({kind:'sessions.create',engine,model:null,auth:{kind:'account'},cwd:this.folder,permission:'ask',login:true,title:engine==='codex'?'Codex login':'Claude login'});const session=validateSession(response.session);this.sessions=[session,...this.sessions.filter(s=>s.id!==session.id)];this.selectedId=session.id;this.credentials=undefined;await this.openSelected();},
      price:()=>{this.credentials=undefined;this.usageForm=new PriceForm();this.draw(true);},
      caps:current=>{this.credentials=undefined;this.usageForm=new CapsForm(current??DEFAULT_AGENT_CAPS);this.draw(true);},
      defaults:kind=>{this.credentials=undefined;this.openBox(kind);this.savingDefault=true;},
      theme:async theme=>{await this.submit('/theme '+theme);},
    });this.credentials=panel;this.draw(true);await panel.load();
  }
  private openBox(kind: AgentBox['kind'], message = '',messageField?:MessageField): void {
    // The box edits its first message only at the end; a cursor or selection left in the bar would act there unseen.
    const draft=messageField?.copy()??new MessageField();if(!messageField)draft.text=message;else draft.moveToEnd(true);
    this.box = {kind,engine:this.engine,model:this.model,cwd:this.folder,permission:this.permission,effort:this.effort,message,messageField:draft,error:'',checking:false,row:0,filter:'',choices:modelChoices(this.keys,this.engines,this.keysRunOn),choice:0,path:'',completions:[],auth:this.auth,authLabel:this.nextAuthLabel()};
    this.returnToStart = false;if(kind==='effort'||kind==='mode')this.valueChoices();else this.resetModelTabs();this.draw(true);
  }
  private valueChoices():void{const b=this.box;if(!b)return;b.values=b.kind==='effort'?effortValues(b.engine):modeValues(b.engine).map(modeLabel);const value=b.kind==='effort'?b.effort??'CLI default':modeLabel(b.permission);b.choice=Math.max(0,b.values.indexOf(value));}
  // After /settings closes: worktrees and D47's keys setting may have changed. A key picked for the next agent follows
  // the keys setting, so the start box always shows the engine the daemon will start.
  private async refreshSettings():Promise<void>{
    const settings=(await this.connection.request({kind:'settings.get'})).settings;
    this.worktrees=settings?.worktrees??'on';this.keysRunOn=settings?.keysRunOn??'ai-term';this.contextWarning=settings?.contextWarning!==false;
    if(this.auth.kind==='key'){const id=this.auth.keyId,provider=this.keys.find(k=>k.id===id)?.provider;if(provider){this.engine=keyEngine(provider,this.keysRunOn);this.compatibleDefaults(this.engine);}}
  }
  private compatibleDefaults(engine:AgentEngine):void{if(!isEffortForEngine(engine,this.effort))this.effort=null;if(!isPermissionForEngine(engine,this.permission))this.permission='ask';}
  private async checkSelectedEngine(): Promise<void> {
    const box = this.box; if (!box) return;
    box.checking = true; box.error = ''; this.draw(true);
    try {
      this.engines = (await this.connection.request({kind:'engines.status'})).engines;box.authLabel=this.nextAuthLabel();
      if(box.kind==='start'){
        try{box.worktreePreview=validateWorktreePreview((await this.connection.request({kind:'worktrees.preview',cwd:box.cwd,title:engineTitle(box.engine)})).worktreePreview);}catch{box.worktreePreview=undefined;}
      }
      // AI Term's agent is this program: nothing to install or log in to; its key is checked when it starts.
      const status = box.engine === 'ai-term' ? null : box.engine === 'codex' ? this.engines?.codex : this.engines?.claudeCode;
      if (status !== null && !status?.installed) box.error = `${box.engine === 'codex' ? 'codex' : 'claude'} not found in PATH`;
      else if (status !== null && box.auth?.kind!=='key' && status.loggedIn !== true) box.error = status.loggedIn === false ? 'Engine is not logged in' : 'Engine login status unavailable';
    } catch (error) { box.error = error instanceof Error ? error.message : 'Engine check failed'; }
    finally { box.checking = false; this.draw(true); }
  }
  private boxText(text: string,paste=false): void {
    const b = this.box; if (!b) return;
    if (b.kind === 'start') { if (b.row === 4 && b.messageField) {b.messageNote=paste?b.messageField.paste(text):b.messageField.type(text);b.message=b.messageField.text;} }
    else if (b.kind === 'folder') { b.path = (b.path + text).slice(0,4096); b.completions = []; }
    else if(b.kind==='model') { b.filter = (b.filter + text).slice(0,80); this.modelChoices(); }
    b.error = ''; this.draw(true);
  }
  private nextAuthLabel():string {
    if(this.auth.kind==='key'){const id=this.auth.keyId;return `key ····${this.keys.find(k=>k.id===id)?.last4??''}`;}
    return ownLoginLabel(this.engine==='codex'?this.engines?.codex.authMethod:this.engines?.claudeCode.authMethod);
  }
  private allModelChoices():import('../../shared/models.js').ModelChoice[]{
    const b=this.box,choices=modelChoices(this.keys,this.engines,this.keysRunOn);if(!b)return choices;
    const matches=choices.filter(c=>c.label.toLowerCase().includes(b.filter.toLowerCase()));
    if(b.filter&&isValidModelId(b.filter)&&!matches.some(c=>c.model===b.filter)){
      const engine=b.tab==='ANTHROPIC'?'claude-code':b.tab==='OPENAI'?'codex':null;
      if(engine)matches.push({engine,model:b.filter,label:`${b.filter} (custom)`,auth:{kind:'account'},authLabel:ownLoginLabel(engine==='codex'?this.engines?.codex.authMethod:this.engines?.claudeCode.authMethod),group:b.tab});
    }
    return matches;
  }
  private resetModelTabs():void {
    const b=this.box;if(!b)return;const choices=modelChoices(this.keys,this.engines,this.keysRunOn);
    b.tabs=[...new Set(choices.map(c=>c.group??''))];
    const current=choices.find(c=>c.engine===b.engine&&c.model===b.model&&(c.auth?.kind??'account')===(b.auth?.kind??'account')&&(c.auth?.kind!=='key'||b.auth?.kind==='key'&&c.auth.keyId===b.auth.keyId));
    b.tab=current?.group??(b.engine==='codex'?'OPENAI':'ANTHROPIC');
    b.choices=choices.filter(c=>c.group===b.tab);b.choice=Math.max(0,b.choices.indexOf(current as import('../../shared/models.js').ModelChoice));
  }
  private modelChoices(): void {
    const b=this.box;if(!b)return;const matches=this.allModelChoices();
    if(b.filter&&matches.length)b.tab=matches[0]?.group;
    b.choices=matches.filter(c=>c.group===b.tab);b.choice=0;
  }
  private boxInput(key: string): void {
    const b = this.box; if (!b) return;
    if (key === 'escape') {
      this.savingDefault=false;
      if (b.kind !== 'start' && this.returnToStart) { b.kind = 'start'; this.returnToStart = false; this.enqueue(() => this.checkSelectedEngine()); }
      else { if (b.kind === 'start'){if(b.messageField)this.field.restore(b.messageField);else this.field.text=b.message;this.permission='ask';} this.box = undefined; }
      this.draw(true); return;
    }
    if (key === 'backspace') {
      if (b.kind === 'model') { b.filter = [...b.filter].slice(0,-1).join(''); this.modelChoices(); }
      else if (b.kind === 'folder') b.path = [...b.path].slice(0,-1).join('');
      else if (b.row === 4 && b.messageField) {b.messageField.backspace();b.message=b.messageField.text;b.messageNote=undefined;}
      b.error = ''; this.draw(true); return;
    }
    if(b.kind==='model'&&(key==='left'||key==='right')){
      const tabs=b.tabs??[],index=tabs.indexOf(b.tab??'');b.tab=tabs[(index+(key==='left'?-1:1)+tabs.length)%tabs.length];
      b.choices=this.allModelChoices().filter(c=>c.group===b.tab);b.choice=0;this.draw(true);return;
    }
    if (key === 'up' || key === 'down') {
      const delta = key === 'up' ? -1 : 1;
      if (b.kind === 'start') b.row = Math.max(0,Math.min(4,b.row+delta));
      if(b.kind==='effort'||b.kind==='mode')b.choice=Math.max(0,Math.min((b.values?.length??1)-1,b.choice+delta));
      if (b.kind === 'model') b.choice = Math.max(0,Math.min(b.choices.length-1,b.choice+delta));
      this.draw(true); return;
    }
    if (key === 'tab') {
      if (b.kind === 'start'){const modes=modeValues(b.engine);b.permission=modes[(modes.indexOf(b.permission)+1)%modes.length]??'ask';}
      else if (b.kind === 'model') { this.boxInput('right');return; }
      else if(b.kind==='effort'||b.kind==='mode'){b.choice=(b.choice+1)%(b.values?.length??1);}
      else this.enqueue(async () => { b.completions = await completeFolder(b.path || b.cwd, b.cwd); if (b.completions.length === 1) b.path = b.completions[0] ?? b.path; this.draw(true); });
      this.draw(true); return;
    }
    if (b.kind === 'start' && b.row !== 4 && (key === 'm' || key === 'c' || key==='e')) { b.kind = key === 'm' ? 'model' : key==='e'?'effort':'folder'; this.returnToStart = true;if(b.kind==='model')this.resetModelTabs();else if(b.kind==='effort')this.valueChoices();this.draw(true);return; }
    if (key === 'enter') {
      this.enqueue(async () => {
        if(b.kind==='effort'||b.kind==='mode'){
          const value=b.values?.[b.choice];if(value===undefined)return;
          try{
            if(b.kind==='effort'){const effort=value==='CLI default'?null:value;if(!isEffortForEngine(b.engine,effort))return;
              if(this.savingDefault)await this.connection.request({kind:'settings.set',patch:{...(isCliEngine(b.engine)?{defaultEngine:b.engine}:{}),defaultEffort:effort}});
              b.effort=effort;this.effort=effort;
            }else{b.permission=modeValues(b.engine)[b.choice]??'ask';this.permission=b.permission;}
            this.savingDefault=false;if(this.returnToStart){b.kind='start';this.returnToStart=false;}else this.box=undefined;
          }catch(error){b.error=error instanceof Error?error.message:'Effort could not save';}this.draw(true);return;
        }
        if (b.kind === 'model') {
          const choice = b.choices[b.choice]; if (!choice) { b.error = 'Enter a valid model id'; this.draw(true); return; }
          // Saved defaults carry no key, so an AI Term model saved as one would start a CLI login instead.
          if (this.savingDefault && !isCliEngine(choice.engine)) { b.error = "AI Term agent models can't be the saved default yet"; this.draw(true); return; }
          b.engine = choice.engine; b.model = choice.model; b.auth=choice.auth??{kind:'account'};this.auth=b.auth;this.engine = choice.engine;this.compatibleDefaults(choice.engine);if(!isEffortForEngine(choice.engine,b.effort??null))b.effort=null;if(!isPermissionForEngine(choice.engine,b.permission))b.permission='ask'; this.model = choice.model;b.authLabel=this.nextAuthLabel();
          if(this.savingDefault){await this.connection.request({kind:'settings.set',patch:{defaultEngine:isCliEngine(choice.engine)?choice.engine:'codex',defaultModel:choice.model,defaultEffort:this.effort}});this.savingDefault=false;}
          if (this.returnToStart) { b.kind = 'start'; this.returnToStart = false; await this.checkSelectedEngine(); }
          else this.box = undefined;
          this.draw(true); return;
        }
        if (b.kind === 'folder') {
          const path = folderPath(b.path || b.cwd,b.cwd);
          try { if (!(await validCwd(path))) { b.error = 'Folder must be an existing directory'; this.draw(true); return; } }
          catch { b.error = 'Cannot access folder'; this.draw(true); return; }
          b.cwd = path; this.folder = path;
          if(this.savingDefault){await this.connection.request({kind:'settings.set',patch:{defaultCwd:path}});this.savingDefault=false;}
          if (this.returnToStart) { b.kind = 'start'; this.returnToStart = false; await this.checkSelectedEngine(); } else this.box = undefined;
          this.draw(true); return;
        }
        if (b.checking || b.error) return;
        try {
          const result = await this.connection.request({kind:'sessions.create',engine:b.engine,model:b.model,auth:b.auth??{kind:'account'},cwd:b.cwd,permission:b.permission,effort:b.effort??null,firstMessage:b.message});
          const session = validateSession(result.session); this.sessions = [session,...this.sessions.filter(s => s.id !== session.id)]; this.selectedId = session.id;
          this.box = undefined;this.permission='ask'; this.field.text = ''; this.previewCells = undefined; await this.updatePreview(false);
        } catch (error) { b.error = error instanceof Error ? error.message : 'Agent could not start'; }
        this.draw(true);
      }); return;
    }
    if ([...key].length === 1) this.boxText(key);
  }
  private async detectBackground(): Promise<void> {
    if (this.background) return;
    await new Promise<void>(resolve => {
      this.backgroundResolve = () => { if (this.backgroundTimer) clearTimeout(this.backgroundTimer); this.backgroundResolve = undefined; resolve(); };
      this.backgroundTimer = setTimeout(() => this.backgroundResolve?.(), 200); this.stdout.write(BACKGROUND_QUERY);
    });
  }
  private async subscribeUsage(on:boolean):Promise<void>{
    if(this.ended||this.usageOn===on)return;this.usageOn=on;try{await this.connection.request({kind:'usage.subscribe',on});if(on){const usage=(await this.connection.request({kind:'usage.summary'})).usage;if(usage)this.usage=validateUsageSummary(usage);this.draw(true);}}catch{this.usageOn=false;this.showNote('Usage unavailable');}
  }
  // This Mac samples run in the daemon only while someone subscribes (architecture §10).
  private async subscribeStats(on: boolean): Promise<void> {
    if (this.ended || this.statsOn === on) return;
    this.statsOn = on;
    // Old numbers are never shown as current: after a gap the panel waits for a fresh sample.
    if (!on) { this.stats = null; this.cpuHistory = []; }
    try { await this.connection.request({ kind: 'system.subscribe', on }); }
    catch (error) {
      if (!on) throw error;
      // This Mac is not worth losing the homepage over; say so and carry on without it.
      this.statsOn = false; this.showNote(`This Mac unavailable: ${error instanceof Error ? error.message : 'subscribe failed'}`);
    }
  }
  private onStats(value: unknown): void {
    const stats = validateSystemStats(value);
    if (this.attached || !this.statsOn) return; // a sample already in flight when we unsubscribed
    this.stats = stats; this.cpuHistory = [...this.cpuHistory, stats.cpuPercent].slice(-SPARKLINE_SAMPLES);
    this.draw(true);
  }
  private currentPreview(): Preview | undefined { return this.selectedId ? this.previews.get(this.selectedId) : undefined; }
  private async updatePreview(resize: boolean): Promise<void> {
    const { cols, rows } = this.size(), layout = homepageLayout(cols, rows, this.visible);
    // Without a visible preview there is no area to match; never reflow detached sessions down to it.
    if (resize && layout.preview) {
      await this.connection.request({ kind: 'layout.previewSize', cols: layout.terminal.w, rows: layout.terminal.h });
      // Re-subscribe below: an attached session can have a different size from our layout.
    }
    const id = layout.preview ? this.selectedId : null;
    this.previewId = null; this.previewRequestId = null;
    if (!id) { await this.connection.request({ kind: 'sessions.preview', sessionId: null }); this.draw(true); return; }
    const loading = { id, chunks: [] as Buffer[], bytes: 0 }; this.loading = loading;
    const result = await this.connection.request({ kind: 'sessions.preview', sessionId: id });
    if (this.ended || this.loading !== loading) return;
    this.previewRequestId = result.id; this.previewId = id;
    await this.replacePreview(id, result, loading.chunks);
    if (this.loading === loading) this.loading = null;
    this.draw(true);
  }
  private async replacePreview(id: string, result: SuccessResponse, chunks: Buffer[] = []): Promise<void> {
    if (typeof result.snapshot !== 'string' || !isSize(result.cols, result.rows)) throw new Error('Invalid preview snapshot');
    const preview = new Preview(result.cols ?? 2, result.rows ?? 1, () => { if (this.selectedId === id) this.draw(); });
    this.previews.get(id)?.dispose(); this.previews.set(id, preview); this.previewCells = undefined;
    await preview.write(result.snapshot);
    // Drain chunks appended while the snapshot parses, preserving snapshot-before-live order.
    for (let i = 0; i < chunks.length; i++) { const chunk = chunks[i]; if (chunk) await preview.write(chunk); }
  }
  private onOutput = (id: string, data: Buffer) => {
    if (this.ended || this.attached) return;
    if (this.loading?.id === id) {
      this.loading.bytes += data.length;
      if (this.loading.bytes > 8 * 1024 * 1024) { this.onError(new Error('Preview startup queue exceeded')); return; }
      this.loading.chunks.push(data); return;
    }
    if (id === this.previewId) { const preview = this.previews.get(id); if (preview) void preview.write(data).catch(this.onError); }
  };
  private onEvent = (value: unknown) => {
    if (value && typeof value === 'object' && 'kind' in value) {
      if (value.kind === 'daemon.warning' && 'text' in value && typeof value.text === 'string') { this.warning = warningText(redact(warningText(value.text))); this.draw(true); return; }
      if (value.kind === 'daemon.warningCleared') { this.warning = ''; this.draw(true); return; }
      if (value.kind === 'daemon.notice' && 'text' in value && typeof value.text === 'string') { this.showNote(warningText(redact(warningText(value.text)))); return; }
    }
    if (this.ended) return;
    try {
      if (!value || typeof value !== 'object') throw new Error('Invalid daemon event');
      const v = value as Record<string, unknown>;
      if (v.kind === 'system.stats') { this.onStats(v.stats); return; }
      if(v.kind==='usage.updated'){this.usage=validateUsageSummary(v.usage);this.draw(true);return;}
      if (v.kind === 'session.updated') {
        const session = validateSession(v.session), index = this.sessions.findIndex(s => s.id === session.id);
        if (index >= 0) this.sessions[index] = session; else this.sessions.push(session);
        if (!this.selectedId) { this.selectedId = session.id; this.enqueue(() => this.updatePreview(false)); }
      } else if (v.kind === 'session.previewResized') {
        if (!isUUID(v.sessionId) || !isSize(v.cols, v.rows)) throw new Error('Invalid preview dimensions');
        if (!this.attached && v.sessionId === this.selectedId) this.enqueue(() => this.updatePreview(false));
      } else if (v.kind === 'session.select') {
        // A notification click. Selecting never attaches; an agent this homepage doesn't list is ignored.
        if (!isUUID(v.sessionId)) throw new Error('Invalid selected session');
        const id = v.sessionId;
        const selected=this.sessions.find(s=>s.id===id);
        if(selected){if(this.terminal)this.stdout.write(RAISE_WINDOW);else this.showNote(`selected ${selected.title} from a notification`);}
        if (selected && id !== this.selectedId) { this.selectedId = id; this.drag = null; this.previewCells = undefined; if (!this.attached) this.enqueue(() => this.updatePreview(false)); }
      } else if (v.kind === 'session.removed') {
        if (!isUUID(v.sessionId)) throw new Error('Invalid removed session');
        this.sessions = this.sessions.filter(s => s.id !== v.sessionId); this.previews.get(v.sessionId)?.dispose(); this.previews.delete(v.sessionId);
        if (this.selectedId === v.sessionId) { this.selectedId = sortSessions(this.sessions)[0]?.id ?? null; this.previewCells = undefined; this.enqueue(() => this.updatePreview(false)); }
      } else if (v.ok === true && v.snapshot !== undefined) {
        const result = validateSuccess(v);
        if (result.id === this.previewRequestId && result.sessionId === this.previewId && this.previewId) {
          const id = this.previewId, loading = { id, chunks: [] as Buffer[], bytes: 0 }; this.loading = loading;
          this.enqueue(async () => { if (this.loading !== loading || this.previewId !== id) return; await this.replacePreview(id, result, loading.chunks); if (this.loading === loading) this.loading = null; this.draw(true); });
        }
      }
      this.draw();
    } catch (error) { this.onError(error); }
  };
  // ai --attach <id>: straight into that agent, as if selected and entered. Gone or finished agents stay home with a note.
  private attachOnStart(id: string): void {
    if (!this.sessions.some(s => s.id === id)) { this.showNote('That agent is gone'); return; }
    this.selectedId = id; this.previewCells = undefined;
    this.enqueue(() => this.openSelected());
  }
  private async openSelected(): Promise<void> {
    const id = this.selectedId, session = this.sessions.find(s => s.id === id);
    if (session && (session.status === 'exited' || session.status === 'error')) { this.showNote(`${session.title} has exited · x removes it`); return; }
    const attachSession = this.options.attachSession;
    if (!id || !attachSession) { this.showNote(id ? 'Attach unavailable' : 'No session selected'); return; }
    await this.away(async () => { const reason = await attachSession(id); return reason === 'home key' ? '' : reason; });
  }
  // Hands the terminal to an attach or a split and takes it back afterwards, with the returned note.
  private async away(run: () => Promise<string>): Promise<void> {
    await this.connection.request({ kind: 'sessions.preview', sessionId: null }); this.previewId = null; this.loading = null;
    await this.subscribeStats(false);await this.subscribeUsage(false);
    this.attached = true; this.leave();
    let note: string;
    try { note = await run(); }
    catch (error) { if (error instanceof ClientSignal) throw error; note = error instanceof Error ? error.message : 'Attach failed'; }
    finally { this.attached = false; }
    if (this.ended) return;
    if (this.pendingSignal) throw this.pendingSignal;
    this.enter();
    const result = await this.connection.request({ kind: 'sessions.list' }); this.sessions = (result.sessions ?? []).map(validateSession);
    await this.updatePreview(true); await this.subscribeStats(true);await this.subscribeUsage(true); this.showNote(note);
  }
  private fieldView(cols: number): FieldView {
    const view = this.field.view(); this.fieldScroll = fieldStart(view, cols, this.fieldScroll);
    return { ...view, start: this.fieldScroll };
  }
  // A drag in the command field selects whole units (a paste token is one) from the pressed cell to the pointer's cell;
  // a click there only places the caret. A click anywhere else drops the field's selection. Nothing here copies.
  private fieldMouse(event: Extract<InputEvent, { kind: 'mouse' }>): boolean {
    const { cols, rows } = this.size(), press = !event.release && !(event.button & 32) && (event.button & 3) === 0;
    const view = { ...this.field.view(), start: this.fieldScroll }, index = fieldIndexAt(view, cols, Math.max(FIELD_X, event.x));
    // A new press always starts over: a drag whose release was lost (an overlay opened mid-drag) must not capture it.
    if (press) this.fieldDrag = null;
    if (press && event.y === rows - 3 && event.x >= 1 && event.x <= cols - 2) { this.fieldDrag = { x: event.x, index }; this.field.select(index, index); this.draw(true); return true; }
    const start = this.fieldDrag;
    if (!start) { if (press && this.field.selection) { this.field.clearSelection(); this.draw(true); } return false; }
    if (event.x === start.x) this.field.select(start.index, start.index);
    else if (index >= start.index) this.field.select(start.index, index + 1);
    else this.field.select(start.index + 1, index);
    if (event.release) this.fieldDrag = null;
    this.draw(true); return true;
  }
  private mouse(event: Extract<InputEvent, { kind: 'mouse' }>): void {
    if (!(event.button & 64) && this.fieldMouse(event)) return;
    const layout = homepageLayout(this.size().cols, this.size().rows, this.visible), area = layout.terminal, preview = this.currentPreview();
    if (!layout.preview || !preview || event.button & 4 || event.button & 8) return;
    const firstRow = preview.linesBack ? 1 : 0, lastRow = area.h - (preview.newLines ? 1 : 0);
    const inside = event.x >= area.x && event.x < area.x + area.w && event.y >= area.y + firstRow && event.y < area.y + lastRow;
    if (event.button & 64) { if (inside) preview.scroll(event.button & 1 ? 3 : -3); return; }
    const point = { x: Math.max(0, Math.min(area.w - 1, event.x - area.x)), y: Math.max(firstRow, Math.min(lastRow - 1, event.y - area.y)) };
    if (!event.release && !(event.button & 32) && (event.button & 3) === 0 && inside) { this.drag = point; preview.select(point, point); }
    else if (this.drag) {
      const start = this.drag; preview.select(start, point);
      // A click without movement is not a selection; it must never overwrite the clipboard.
      if (event.release && start.x === point.x && start.y === point.y) { this.drag = null; preview.clearSelection(); }
      else if (event.release) {
        this.drag = null; const text = preview.selectedText(area.w);
        void (this.options.copy ?? copyText)(text).then(() => { if (!this.ended) this.showNote(`✓ copied ${text.split('\n').length} lines`, 1200, true); }).catch(error => this.showNote(error instanceof Error ? error.message : 'Copy failed'));
      }
    }
    this.previewCells = undefined; this.draw(true);
  }
  // "quiet Ns" changes with time alone: wake once at the next 10 s crossing, then once a second only while a visible card shows it.
  private scheduleCardTick(cards: readonly import('../../shared/protocol.js').SessionInfo[]): void {
    if (this.cardTimer) clearTimeout(this.cardTimer); this.cardTimer = undefined;
    const wait = nextCardTick(cards, Date.now()); if (wait === null) return;
    // A few ms past the boundary so the floored second has really changed when the frame is drawn.
    this.cardTimer = setTimeout(() => { this.cardTimer = undefined; this.draw(true); }, wait + 5);
  }
  private draw(immediate = false): void {
    if (!this.showing || this.ended || this.blocked) return;
    const now = performance.now();
    if (!immediate && now < this.nextPreview) {
      if (!this.drawTimer) this.drawTimer = setTimeout(() => { this.drawTimer = undefined; this.draw(); }, this.nextPreview - now);
      return;
    }
    try {
      const { cols, rows } = this.size(), layout = homepageLayout(cols, rows, this.visible), preview = this.currentPreview();
      if (this.forceRedraw || now >= this.nextPreview || !this.previewCells) {
        this.previewCells = layout.preview ? preview?.cells(this.theme, layout.terminal.w, layout.terminal.h) : undefined;
        this.nextPreview = now + 1000 / 30;
      }
      const cwd = this.folder, home = homedir();
      let grid = renderHomepage({ cols, rows, sessions: this.sessions, selectedId: this.selectedId, input: this.field.display(), field: this.fieldView(cols), commandMenu: !this.field.hasPastes, note: this.pasteNote||this.note, notePriority: !!this.pasteNote, warning: this.warning, copying: this.copying, previewVisible: this.visible, cwd: cwd === home ? '~' : cwd.startsWith(home + '/') ? '~' + cwd.slice(home.length) : cwd, engine:this.engine, model:this.model, now: Date.now(), previewCells: this.previewCells, linesBack: preview?.linesBack, newLines: preview?.newLines, stats: this.stats, cpuHistory: this.cpuHistory,authLabel:this.nextAuthLabel(),menuChoice:this.menuChoice,effort:this.box?.effort??this.effort,permission:this.box?.permission??this.permission,worktrees:this.worktrees,usage:this.usage,budgets:this.budgets,marked:this.marked,contextWarning:this.contextWarning }, this.theme);
      if (this.box) grid = drawAgentBox(grid,this.box,this.theme);
      if(this.credentials)grid=this.credentials.draw(grid,this.theme);
      if(this.helpOffset!==null)grid=drawHelp(grid,helpLines(this.commandContext()),this.helpOffset,this.theme);
      if(this.usageForm)grid=drawUsageForm(grid,this.usageForm.lines(),this.usageFormError,this.theme);
      if(this.worktreeUi)grid=this.worktreeUi.draw(grid,this.theme);
      if(this.popup)grid=this.popup.draw(grid,this.theme);
      const output = diffFrame(grid, this.previous, this.theme, this.options.truecolor ?? true); this.previous = grid; this.forceRedraw = false;
      this.scheduleCardTick(visibleCards({ cols, rows, sessions: this.sessions, selectedId: this.selectedId, previewVisible: this.visible }));
      if (output) this.blocked = !this.stdout.write(output);
    } catch (error) { this.onError(error); }
  }
}
// `connect` opens one more daemon connection: a split gives each pane its own (split.ts).
export async function homepage(connection: import('../connection.js').Connection, connect: () => Promise<import('../connection.js').Connection>, attachOnStart?: string, doctor?: () => Promise<string[]>): Promise<void> {
  const truecolor = process.env.COLORTERM === 'truecolor' || process.env.COLORTERM === '24bit' || process.env.TERM_PROGRAM === 'Apple_Terminal' || process.env.TERM_PROGRAM === 'iTerm.app', log = new Logger(getPaths().log);
  const home = new Homepage(connection, { truecolor, attachSession: id => configuredAttach(connection, id), splitSessions: (ids, theme) => split(ids, { connect, theme, truecolor, log: text => log.error(text) }), ...(attachOnStart ? { attachOnStart } : {}), ...(doctor ? { doctor } : {}) });
  await Promise.all([home.start(), home.done]);
}
