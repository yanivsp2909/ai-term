import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import type { RequestBody } from '../connection.js';
import { attach, type AttachReason } from '../attach.js';
import { RESET_MODES } from '../terminal-modes.js';
import type { SessionInfo, SuccessResponse, AgentEngine, EnginesStatus, AuthRef, KeyView, SystemStats } from '../../shared/protocol.js';
import { isSize, isUUID, validateSession, validateSettings, validateSuccess, isThemeName, warningText, validCwd, isValidModelId, validateSystemStats } from '../../shared/validate.js';
import { redact } from '../../daemon/log.js';
import { ClientSignal } from '../signals.js';
import { CommandField, InputParser, type InputEvent } from './keys.js';
import { Preview, type Point } from './preview.js';
import { copyText } from './clipboard.js';
import { BACKGROUND_QUERY, BackgroundReplies, createTheme, type Theme } from './theme.js';
import { diffFrame, type Frame } from './grid.js';
import { homepageLayout, renderHomepage, sortSessions, filteredCommands } from './layout.js';
import { CredentialsPanel } from './credentials.js';
import { modelChoices, ownLoginLabel } from '../../shared/models.js';
import { drawAgentBox, type AgentBox } from './agent-box.js';
import { folderPath, completeFolder } from './folders.js';
import { SPARKLINE_SAMPLES } from './this-mac.js';
interface Input extends EventEmitter { isTTY?: boolean; isRaw?: boolean; setRawMode(raw: boolean): unknown; resume(): unknown; pause(): unknown }
interface Output extends EventEmitter { isTTY?: boolean; columns?: number; rows?: number; write(data: string | Buffer): boolean }
// The homepage's connection capability intentionally excludes input(). Attach gets the real connection separately.
export interface HomepageConnection extends EventEmitter { request(body: RequestBody): Promise<SuccessResponse> }
interface Options { stdin?: Input; stdout?: Output; signals?: EventEmitter; cwd?: string; truecolor?: boolean; copy?: (text: string) => Promise<void>; attachSession?: (id: string) => Promise<AttachReason> }
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
  private theme: Theme = createTheme('graphite');
  private background?: string;
  private backgroundResolve?: () => void;
  private backgroundTimer?: ReturnType<typeof setTimeout>;
  private inputTimer?: ReturnType<typeof setTimeout>;
  private noteTimer?: ReturnType<typeof setTimeout>;
  private note = '';
  private warning = '';
  private engine: AgentEngine = 'claude-code';
  private model: string | null = null;
  private folder: string;
  private engines?: EnginesStatus;
  private box?: AgentBox;
  private returnToStart = false;
  private credentials?:CredentialsPanel;
  private savingDefault=false;
  private keys:KeyView[]=[];
  private auth:AuthRef={kind:'account'};
  private copying = false;
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
  private blocked = false;
  private forceRedraw = true;
  private drag: Point | null = null;
  private stats: SystemStats | null = null;
  private cpuHistory: number[] = [];
  private statsOn = false;
  private disconnected = false;
  private readonly parser: InputParser;
  private readonly replies: BackgroundReplies;
  constructor(private readonly connection: HomepageConnection, private readonly options: Options = {}) {
    this.stdin = options.stdin ?? process.stdin; this.stdout = options.stdout ?? process.stdout; this.signals = options.signals ?? process;
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
      if (settings.defaultEngine) this.engine = settings.defaultEngine;
      if (settings.defaultModel !== undefined) this.model = settings.defaultModel;
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
      this.draw(true);await this.updatePreview(true);await this.subscribeStats(true);
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
    if (this.drawTimer) clearTimeout(this.drawTimer); if (this.inputTimer) clearTimeout(this.inputTimer);
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
    this.ended = true; this.loading = null; this.credentials?.dispose();
    if (this.backgroundTimer) clearTimeout(this.backgroundTimer); this.backgroundResolve?.();
    if (this.noteTimer) clearTimeout(this.noteTimer);
    this.connection.off('event', this.onEvent); this.connection.off('output', this.onOutput); this.connection.off('disconnected', this.onDisconnect);
    for (const [name, guard] of this.guards) this.signals.off(name, guard);
    try { this.leave(); } catch (cleanupError) { error ??= cleanupError instanceof Error ? cleanupError : new Error('Terminal restore failed'); }
    for (const preview of this.previews.values()) preview.dispose(); this.previews.clear();
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
    if (event.kind === 'mouse') { this.mouse(event); return; }
    if (event.kind === 'paste') { if(this.credentials){const panel=this.credentials;this.enqueue(async()=>{panel.paste(event.text);});} else if (this.box) this.boxText(event.text); else {this.field.paste(event.text);this.menuChoice=0;} this.draw(true); return; }
    if (event.key === 'ctrl-c') {
      const action = this.field.key('ctrl-c');
      if (action.kind === 'quit') void this.stop();
      else if (action.kind === 'note') this.showNote(action.text, 1000);
      return;
    }
    if(this.credentials){const panel=this.credentials;if(event.key==='escape'){panel.dispose();this.credentials=undefined;this.draw(true);}else this.enqueue(()=>panel.key(event.key));return;}
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
    if(this.field.text.startsWith('/')){
      const choices=filteredCommands(this.field.text);
      if(event.key==='up'||event.key==='down'){
        if(choices.length)this.menuChoice=(this.menuChoice+(event.key==='up'?-1:1)+choices.length)%choices.length;
        this.draw(true);return;
      }
      if(event.key==='enter'&&!this.field.text.includes(' ')){
        const command=choices[this.menuChoice];if(!command)return;
        if(command==='/theme'){this.field.text='/theme ';this.menuChoice=0;this.draw(true);return;}
        this.field.text='';this.menuChoice=0;this.enqueue(()=>this.submit(command));return;
      }
    }
    const beforeText=this.field.text, action = this.field.key(event.key);
    if(this.field.text!==beforeText)this.menuChoice=0;
    switch (action.kind) {
      case 'quit': void this.stop(); return;
      case 'note': this.showNote(action.text, 1000); return;
      case 'submit': this.enqueue(() => this.submit(action.text)); break;
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
      case 'remove': { const session = this.sessions.find(s => s.id === this.selectedId); if (session && ['exited', 'error'].includes(session.status)) this.enqueue(() => this.operation({ kind: 'sessions.remove', sessionId: session.id })); break; }
    }
    this.draw(true);
  }
  private async operation(body: RequestBody): Promise<void> {
    try { await this.connection.request(body); this.showNote(''); }
    catch (error) { this.showNote(error instanceof Error ? error.message : 'Operation failed'); }
  }
  private async submit(text: string): Promise<void> {
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
      request:body=>this.connection.request(body),changed:()=>this.draw(true),close:()=>{panel.dispose();if(this.credentials===panel)this.credentials=undefined;this.draw(true);},
      login:async engine=>{const response=await this.connection.request({kind:'sessions.create',engine,model:null,auth:{kind:'account'},cwd:this.folder,permission:'ask',login:true,title:engine==='codex'?'Codex login':'Claude login'});const session=validateSession(response.session);this.sessions=[session,...this.sessions.filter(s=>s.id!==session.id)];this.selectedId=session.id;this.credentials=undefined;await this.openSelected();},
      defaults:kind=>{this.credentials=undefined;this.openBox(kind);this.savingDefault=true;},
      theme:async theme=>{await this.submit('/theme '+theme);},
    });this.credentials=panel;this.draw(true);await panel.load();
  }
  private openBox(kind: AgentBox['kind'], message = ''): void {
    this.box = {kind,engine:this.engine,model:this.model,cwd:this.folder,permission:'ask',message,error:'',checking:false,row:0,filter:'',choices:modelChoices(this.keys,this.engines),choice:0,path:'',completions:[],auth:this.auth,authLabel:this.nextAuthLabel()};
    this.returnToStart = false; this.resetModelTabs();this.draw(true);
  }
  private async checkSelectedEngine(): Promise<void> {
    const box = this.box; if (!box) return;
    box.checking = true; box.error = ''; this.draw(true);
    try {
      this.engines = (await this.connection.request({kind:'engines.status'})).engines;box.authLabel=this.nextAuthLabel();
      const status = box.engine === 'codex' ? this.engines?.codex : this.engines?.claudeCode;
      if (!status?.installed) box.error = `${box.engine === 'codex' ? 'codex' : 'claude'} not found in PATH`;
      else if (box.auth?.kind!=='key' && status.loggedIn !== true) box.error = status.loggedIn === false ? 'Engine is not logged in' : 'Engine login status unavailable';
    } catch (error) { box.error = error instanceof Error ? error.message : 'Engine check failed'; }
    finally { box.checking = false; this.draw(true); }
  }
  private boxText(text: string): void {
    const b = this.box; if (!b) return;
    if (b.kind === 'start') { if (b.row === 3) b.message = (b.message + text).slice(0,16384); }
    else if (b.kind === 'folder') { b.path = (b.path + text).slice(0,4096); b.completions = []; }
    else { b.filter = (b.filter + text).slice(0,80); this.modelChoices(); }
    b.error = ''; this.draw(true);
  }
  private nextAuthLabel():string {
    if(this.auth.kind==='key'){const id=this.auth.keyId;return `key ····${this.keys.find(k=>k.id===id)?.last4??''}`;}
    return ownLoginLabel(this.engine==='codex'?this.engines?.codex.authMethod:this.engines?.claudeCode.authMethod);
  }
  private allModelChoices():import('../../shared/models.js').ModelChoice[]{
    const b=this.box,choices=modelChoices(this.keys,this.engines);if(!b)return choices;
    const matches=choices.filter(c=>c.label.toLowerCase().includes(b.filter.toLowerCase()));
    if(b.filter&&isValidModelId(b.filter)&&!matches.some(c=>c.model===b.filter)){
      const engine=b.tab==='ANTHROPIC'?'claude-code':b.tab==='OPENAI'?'codex':null;
      if(engine)matches.push({engine,model:b.filter,label:`${b.filter} (custom)`,auth:{kind:'account'},authLabel:ownLoginLabel(engine==='codex'?this.engines?.codex.authMethod:this.engines?.claudeCode.authMethod),group:b.tab});
    }
    return matches;
  }
  private resetModelTabs():void {
    const b=this.box;if(!b)return;const choices=modelChoices(this.keys,this.engines);
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
      else { if (b.kind === 'start') this.field.text = b.message; this.box = undefined; }
      this.draw(true); return;
    }
    if (key === 'backspace') {
      if (b.kind === 'model') { b.filter = [...b.filter].slice(0,-1).join(''); this.modelChoices(); }
      else if (b.kind === 'folder') b.path = [...b.path].slice(0,-1).join('');
      else if (b.row === 3) b.message = [...b.message].slice(0,-1).join('');
      b.error = ''; this.draw(true); return;
    }
    if(b.kind==='model'&&(key==='left'||key==='right')){
      const tabs=b.tabs??[],index=tabs.indexOf(b.tab??'');b.tab=tabs[(index+(key==='left'?-1:1)+tabs.length)%tabs.length];
      b.choices=this.allModelChoices().filter(c=>c.group===b.tab);b.choice=0;this.draw(true);return;
    }
    if (key === 'up' || key === 'down') {
      const delta = key === 'up' ? -1 : 1;
      if (b.kind === 'start') b.row = Math.max(0,Math.min(3,b.row+delta));
      if (b.kind === 'model') b.choice = Math.max(0,Math.min(b.choices.length-1,b.choice+delta));
      this.draw(true); return;
    }
    if (key === 'tab') {
      if (b.kind === 'start') b.permission = b.permission === 'ask' ? 'dontAsk' : 'ask';
      else if (b.kind === 'model') { this.boxInput('right');return; }
      else this.enqueue(async () => { b.completions = await completeFolder(b.path || b.cwd, b.cwd); if (b.completions.length === 1) b.path = b.completions[0] ?? b.path; this.draw(true); });
      this.draw(true); return;
    }
    if (b.kind === 'start' && b.row !== 3 && (key === 'm' || key === 'c')) { b.kind = key === 'm' ? 'model' : 'folder'; this.returnToStart = true;if(b.kind==='model')this.resetModelTabs();this.draw(true);return; }
    if (key === 'enter') {
      this.enqueue(async () => {
        if (b.kind === 'model') {
          const choice = b.choices[b.choice]; if (!choice) { b.error = 'Enter a valid model id'; this.draw(true); return; }
          b.engine = choice.engine; b.model = choice.model; b.auth=choice.auth??{kind:'account'};this.auth=b.auth;this.engine = choice.engine; this.model = choice.model;b.authLabel=this.nextAuthLabel();
          if(this.savingDefault){await this.connection.request({kind:'settings.set',patch:{defaultEngine:choice.engine,defaultModel:choice.model}});this.savingDefault=false;}
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
          if (this.returnToStart) { b.kind = 'start'; this.returnToStart = false; } else this.box = undefined;
          this.draw(true); return;
        }
        if (b.checking || b.error) return;
        try {
          const result = await this.connection.request({kind:'sessions.create',engine:b.engine,model:b.model,auth:b.auth??{kind:'account'},cwd:b.cwd,permission:b.permission,firstMessage:b.message});
          const session = validateSession(result.session); this.sessions = [session,...this.sessions.filter(s => s.id !== session.id)]; this.selectedId = session.id;
          this.box = undefined; this.field.text = ''; this.previewCells = undefined; await this.updatePreview(false);
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
    }
    if (this.ended) return;
    try {
      if (!value || typeof value !== 'object') throw new Error('Invalid daemon event');
      const v = value as Record<string, unknown>;
      if (v.kind === 'system.stats') { this.onStats(v.stats); return; }
      if (v.kind === 'session.updated') {
        const session = validateSession(v.session), index = this.sessions.findIndex(s => s.id === session.id);
        if (index >= 0) this.sessions[index] = session; else this.sessions.push(session);
        if (!this.selectedId) { this.selectedId = session.id; this.enqueue(() => this.updatePreview(false)); }
      } else if (v.kind === 'session.previewResized') {
        if (!isUUID(v.sessionId) || !isSize(v.cols, v.rows)) throw new Error('Invalid preview dimensions');
        if (!this.attached && v.sessionId === this.selectedId) this.enqueue(() => this.updatePreview(false));
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
  private async openSelected(): Promise<void> {
    const id = this.selectedId, session = this.sessions.find(s => s.id === id);
    if (session && (session.status === 'exited' || session.status === 'error')) { this.showNote(`${session.title} has exited · x removes it`); return; }
    if (!id || !this.options.attachSession) { this.showNote(id ? 'Attach unavailable' : 'No session selected'); return; }
    await this.connection.request({ kind: 'sessions.preview', sessionId: null }); this.previewId = null; this.loading = null;
    await this.subscribeStats(false);
    this.attached = true; this.leave();
    let note = '';
    try { const reason = await this.options.attachSession(id); if (reason !== 'home key') note = reason; }
    catch (error) { if (error instanceof ClientSignal) throw error; note = error instanceof Error ? error.message : 'Attach failed'; }
    finally { this.attached = false; }
    if (this.ended) return;
    if (this.pendingSignal) throw this.pendingSignal;
    this.enter();
    const result = await this.connection.request({ kind: 'sessions.list' }); this.sessions = (result.sessions ?? []).map(validateSession);
    await this.updatePreview(true); await this.subscribeStats(true); this.showNote(note);
  }
  private mouse(event: Extract<InputEvent, { kind: 'mouse' }>): void {
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
      let grid = renderHomepage({ cols, rows, sessions: this.sessions, selectedId: this.selectedId, input: this.field.text, note: this.note, warning: this.warning, copying: this.copying, previewVisible: this.visible, cwd: cwd === home ? '~' : cwd.startsWith(home + '/') ? '~' + cwd.slice(home.length) : cwd, engine:this.engine, model:this.model, now: Date.now(), previewCells: this.previewCells, linesBack: preview?.linesBack, newLines: preview?.newLines, stats: this.stats, cpuHistory: this.cpuHistory,authLabel:this.nextAuthLabel(),menuChoice:this.menuChoice }, this.theme);
      if (this.box) grid = drawAgentBox(grid,this.box,this.theme);
      if(this.credentials)grid=this.credentials.draw(grid,this.theme);
      const output = diffFrame(grid, this.previous, this.theme, this.options.truecolor ?? true); this.previous = grid; this.forceRedraw = false;
      if (output) this.blocked = !this.stdout.write(output);
    } catch (error) { this.onError(error); }
  }
}
export async function homepage(connection: import('../connection.js').Connection): Promise<void> {
  const home = new Homepage(connection, { truecolor: process.env.COLORTERM === 'truecolor' || process.env.COLORTERM === '24bit' || process.env.TERM_PROGRAM === 'Apple_Terminal' || process.env.TERM_PROGRAM === 'iTerm.app', attachSession: id => attach(connection, id) });
  await Promise.all([home.start(), home.done]);
}
