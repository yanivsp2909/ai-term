import { ExtensionsPanel } from '../client/tui/extensions-panel.js';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import type { LanguageModel } from 'ai';
import { KeyReader, type KeyEvent } from './key-reader.js';
import type { Screen } from './screen.js';
import type { Agent, AgentIO, AgentPermission, ToolName } from './agent.js';
import { loadInstructions } from './instructions.js';
import { killAllBash } from './bash.js';
import { visible } from './display.js';
import { MAX_CAP_TURNS, MAX_CAP_USD } from '../shared/agent-facts.js';

export interface AppOptions {
  screen: Screen; permission: AgentPermission; models: readonly string[];
  // Async: the daemon says how to reach a model (a Foundry deployment's wire) before it is built.
  makeModel(id: string): Promise<LanguageModel>;
  // Builds the agent once the app exists, because the app is the agent's IO.
  agent(io: AgentIO): Agent;
  quit(): void;
}
const QUIT_WINDOW_MS = 3000;
const HELP = ['/mcp [add|remove <name>]   manage MCP servers; a allows a prompted tool for this session', '/skills · /agents   browse Skills, Agents, Commands and MCP; Space toggles, Enter reads', '/name [arguments]   run an enabled extension command', '/model [id]   switch to another model of this key', '/caps [turns N|off] [spend N|off]   show or change this run\'s caps', '/clear        forget the conversation (frees the context)', '/cd <folder>  work in another folder (AGENTS.md is read again)', '/exit         quit (Ctrl+C twice also quits)', 'Esc interrupts a turn · Ctrl+K kills the request and every running command at once · y / n answer an approval · ⏎ goes on at a limit pause · a message sent during a turn waits for it to end'];

// One controller per agent process: it owns the prompt, the queue of messages typed during a turn, the approval in
// progress and the quit gesture. The agent turn itself lives in agent.ts.
export class AgentApp implements AgentIO {
  private readonly reader = new KeyReader();
  private readonly agent: Agent;
  private buffer = '';
  private queued: string[] = [];
  private turn: AbortController | null = null;
  private approval: { resolve(allowed: boolean): void; title: string; pages: string[][]; page: number; job:boolean;session?:()=>void } | null = null;
  private paused: { resolve(go: boolean): void } | null = null;
  private quitArmedAt = 0;
  private closed = false;
  private popup?: ExtensionsPanel;
  private generation = 0;
  private popupQueue: Promise<void> = Promise.resolve();
  constructor(private readonly options: AppOptions) { this.agent = options.agent(this); }

  // AgentIO: the agent's output goes straight to the screen.
  text(delta: string): void { this.options.screen.text(delta); }
  toolStart(tool: ToolName, summary: string): void { this.options.screen.toolStart(tool, summary); }
  toolEnd(tool: ToolName, outcome: 'ok' | 'denied' | 'failed', summary: string): void { this.options.screen.toolEnd(tool, outcome, summary); }
  note(text: string, tone: 'info' | 'warn' | 'error' = 'info'): void { this.options.screen.note(text, tone); }
  pause(text: string, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    this.options.screen.pause(text);
    return new Promise(resolvePromise => {
      const finish = (go: boolean) => { if (!this.paused) return; this.paused = null; signal.removeEventListener('abort', onAbort); this.options.screen.resumed(go); resolvePromise(go); };
      const onAbort = () => finish(false);
      signal.addEventListener('abort', onAbort, { once: true });
      this.paused = { resolve: finish };
    });
  }
  async approveMcp(request:{title:string;body:string},signal:AbortSignal):Promise<'allow'|'deny'|'session'>{let session=false;const allowed=await this.approve(request,signal,false,()=>{session=true;});return allowed?(session?'session':'allow'):'deny';}
  confirmJob(request:{title:string;body:string},signal:AbortSignal):Promise<boolean>{return this.approve(request,signal,true);}
  approve(request: { title: string; body: string }, signal: AbortSignal, job=false,session?:()=>void): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    // Every title and body is untrusted text (model arguments, task prompts, project .mcp.json), so it is made visible
    // here, once, for every gate: escapes and invisible characters show as markers and can't hide what runs (S20).
    const title = visible(request.title), pages = this.options.screen.approvalPages(visible(request.body));
    this.options.screen.approvalPage(title, pages, 0, job,!!session);
    return new Promise(resolvePromise => {
      const finish = (allowed: boolean) => { if (!this.approval) return; this.approval = null; signal.removeEventListener('abort', onAbort); this.options.screen.answered(allowed); resolvePromise(allowed); };
      const onAbort = () => finish(false);
      signal.addEventListener('abort', onAbort, { once: true });
      this.approval = { resolve: finish, title, pages, page: 0, job,...(session?{session}:{}) };
    });
  }

  // A command (/model, /cd) in progress counts as running too: what you type meanwhile waits for it.
  private commandBusy = false;
  get running(): boolean { return this.turn !== null || this.commandBusy; }
  // Runs the next queued message or command, or shows the prompt when there's none.
  private next(): void { if (this.closed || this.popup) return; const queued = this.queued.shift(); if (queued !== undefined) this.submit(queued); else this.options.screen.prompt(this.buffer); }
  start(firstMessage?: string): void { if (firstMessage?.trim()) this.submit(firstMessage); else this.options.screen.prompt(this.buffer); }
  input(data: string): void { for (const event of this.reader.push(data)) this.key(event); }

  private key(event: KeyEvent): void {
    if (this.closed) return;
    if (event.kind === 'ctrl-c' || event.kind === 'ctrl-d' && !this.running && !this.buffer) { this.quitKey(); return; }
    this.quitArmedAt = 0;
    if (event.kind === 'ctrl-k') { this.kill(); return; }
    if(this.popup){const panel=this.popup;const key=event.kind==='text'?event.text:event.kind; if(event.kind==='paste')panel.paste(event.text);else this.popupQueue=this.popupQueue.then(()=>panel.key(key));return;}
    if (this.paused) {
      // Only a typed ⏎ goes on past a limit; a paste never does.
      if (event.kind === 'enter') this.paused.resolve(true);
      else if (event.kind === 'escape') { this.paused.resolve(false); this.turn?.abort(); }
      return;
    }
    if (this.approval) {
      // Only a typed key answers; a paste never does. y counts once every page of what runs has been on screen.
      const approval = this.approval, last = approval.page === approval.pages.length - 1;
      if (event.kind === 'text' && event.text === ' ' && !last) { approval.page++; this.options.screen.approvalPage(approval.title, approval.pages, approval.page, approval.job,!!approval.session); }
      else if(last&&event.kind==='text'&&event.text==='a'&&approval.session){approval.session();approval.resolve(true);}
      else if (last && (approval.job ? event.kind==='enter' : event.kind === 'text' && /^[yY]$/.test(event.text))) approval.resolve(true);
      else if (event.kind === 'text' && /^[nN]$/.test(event.text)) this.approval.resolve(false);
      else if (event.kind === 'escape') { this.approval.resolve(false); this.turn?.abort(); }
      return;
    }
    if (event.kind === 'escape') { if (this.running) { this.generation++; this.turn?.abort(); } else { this.buffer = ''; this.options.screen.prompt(''); } return; }
    if (event.kind === 'text' || event.kind === 'paste') this.buffer = (this.buffer + event.text).slice(0, 64 * 1024);
    else if (event.kind === 'newline') this.buffer += '\n';
    else if (event.kind === 'backspace') this.buffer = [...this.buffer].slice(0, -1).join('');
    else if (event.kind === 'enter') {
      const message = this.buffer; this.buffer = '';
      if (!message.trim()) { if (!this.running) this.options.screen.prompt(''); return; }
      if (this.running) { this.queued.push(message); this.options.screen.note(`queued until this turn ends: ${message.split('\n')[0] ?? ''}`); return; }
      this.submit(message); return;
    }
    if (!this.running) this.options.screen.prompt(this.buffer);
  }
  private quitKey(): void {
    const now = Date.now();
    if (this.quitArmedAt && now - this.quitArmedAt <= QUIT_WINDOW_MS) { this.close(); return; }
    this.quitArmedAt = now; this.options.screen.note('press Ctrl+C again to quit');
    if (!this.running) this.options.screen.prompt(this.buffer);
  }
  // The kill switch (D53): the request stops, every running command's process group gets SIGKILL now (no grace), queued
  // messages are dropped, and nothing more is sent until you type again.
  kill(): void {
    this.generation++;
    const commands = killAllBash();
    void this.agent.stopMcp().catch(()=>this.options.screen.note('MCP stop failed','error'));
    if (!this.running) { this.options.screen.note(commands ? `killed ${commands} running command${commands > 1 ? 's' : ''}` : 'nothing is running'); this.options.screen.prompt(this.buffer); return; }
    this.queued = []; this.approval?.resolve(false); this.paused?.resolve(false); this.turn?.abort();
    this.options.screen.note(`killed: the request${commands ? ` and ${commands} running command${commands > 1 ? 's' : ''}` : ''}`, 'error');
  }
  close(): void { if (this.closed) return; this.closed = true; this.generation++; this.options.screen.closePopup(); killAllBash(); this.paused?.resolve(false); this.approval?.resolve(false); this.turn?.abort(); this.options.screen.hidePrompt();if(!this.agent.mcpAccess){this.options.quit();return;}void this.agent.stopMcp().then(()=>this.options.quit(),()=>{this.options.screen.note('MCP stop failed','error');this.options.quit();}); }

  private submit(message: string): void {
    const command = message.trim().match(/^\/(help|exit|model|cd|caps|clear|skills|agents|mcp)(?:\s+(.*))?$/s);
    if (command) { this.commandBusy = true; void this.command(command[1] ?? '', (command[2] ?? '').trim()).finally(() => { this.commandBusy = false; this.next(); }); return; }
    const slash=message.trim().match(/^\/([A-Za-z0-9][A-Za-z0-9._:-]{0,79})(?:\s+([\s\S]*))?$/);
    if(slash&&this.agent.extensionAccess){const generation=this.generation;this.commandBusy=true;void this.agent.slash(slash[1]??'',slash[2]??'').then(expanded=>{this.commandBusy=false;if(this.closed||generation!==this.generation){this.next();return;}if(expanded===null){this.options.screen.note('Unknown or disabled command; /skills lists commands','error');this.next();}else this.runTurn(expanded);},()=>{this.commandBusy=false;this.options.screen.note('Command could not load','error');this.next();});return;}
    this.runTurn(message);
  }
  private runTurn(message:string):void {
    this.options.screen.user(message); this.options.screen.working();
    const turn = new AbortController(); this.turn = turn;
    void this.agent.turn(message, turn.signal).then(result => { this.turn = null; this.options.screen.turnEnd(result); this.next(); },
      () => { this.turn = null; this.options.screen.note('the turn stopped unexpectedly', 'error'); this.next(); });
  }
  private async command(name: string, argument: string): Promise<void> {
    const screen = this.options.screen;
    if (name === 'exit') { this.close(); return; }
    if(name==='mcp'){if(argument.startsWith('remove ')){try{await this.agent.mcpAccess?.remove(argument.slice(7).trim());screen.note('MCP server removed');}catch{screen.note('MCP removal failed','error');}}else if(!argument||argument==='add')await this.openExtensions('mcp',argument==='add');else screen.note('usage: /mcp [add|remove <name>]','error');return;}
    if(name==='skills'||name==='agents'){await this.openExtensions(name);return;}
    if (name === 'help') for (const line of HELP) screen.note(line);
    else if (name === 'model') {
      if (!argument) for (const id of this.options.models) screen.note(`${id === this.agent.modelId ? '›' : ' '} ${id}`);
      else if (!this.options.models.includes(argument)) screen.note(`${argument} isn't a tested deployment of this key; /model lists them`, 'error');
      else {
        try { this.agent.setModel(await this.options.makeModel(argument), argument); screen.note(`model: ${argument}`); }
        catch { screen.note(`couldn't switch to ${argument}`, 'error'); }
      }
    } else if (name === 'caps') screen.note(this.caps(argument));
    else if (name === 'clear') { this.agent.clear(); screen.note('conversation cleared; the next message starts fresh'); }
    else if (name === 'cd') {
      try { await this.changeFolder(argument); } catch { screen.note(`couldn't switch to ${argument}`, 'error'); }
    }
  }
  private async openExtensions(tab:'skills'|'agents'|'mcp',add=false):Promise<void>{
    const access=this.agent.extensionAccess;if(!access){this.options.screen.note('Extensions unavailable','error');return;}
    const panel=new ExtensionsPanel(access,this.agent.root,tab,()=>{if(!this.closed&&this.popup===panel)this.options.screen.popup(panel);},()=>{this.popup=undefined;this.options.screen.closePopup();this.next();},()=>{this.agent.clear();},this.agent.mcpAccess,add);
    this.popup=panel;this.options.screen.popup(panel);await panel.load();
  }
  // /caps, /caps turns 50, /caps spend 2.5, /caps turns off spend off: this run only; /settings holds the defaults.
  private caps(argument: string): string {
    const limits = this.agent.limits;
    if (!argument) return limits.describe();
    const words = argument.split(/\s+/), next: { turns?: number | null; spendUsd?: number | null } = {};
    for (let i = 0; i < words.length; i += 2) {
      const name = words[i], value = words[i + 1], number = value === 'off' ? null : Number(value);
      if (name === 'turns' && (number === null || Number.isSafeInteger(number) && number > 0 && number <= MAX_CAP_TURNS)) next.turns = number;
      else if (name === 'spend' && (number === null || Number.isFinite(number) && number > 0 && number <= MAX_CAP_USD)) next.spendUsd = number;
      else return 'usage: /caps [turns N|off] [spend USD|off]';
    }
    limits.change(next);
    return limits.describe();
  }
  private async changeFolder(argument: string): Promise<void> {
    const screen = this.options.screen;
    if (!argument) { screen.note(`folder: ${this.agent.root}`); return; }
    const wanted = argument === '~' ? homedir() : argument.startsWith('~/') ? resolve(homedir(), argument.slice(2)) : isAbsolute(argument) ? argument : resolve(this.agent.root, argument);
    let folder: string;
    try { folder = await realpath(wanted); if (!(await stat(folder)).isDirectory()) throw new Error('not a folder'); }
    catch { screen.note(`${argument} isn't a folder you can open`, 'error'); return; }
    const instructions = await loadInstructions(folder);
    this.agent.setRoot(folder, instructions);
    screen.note(`folder: ${folder}${instructions.files.length ? ` · read ${instructions.files.join(', ')}` : ''}`);
    for (const note of instructions.notes) screen.note(note);
  }
}
