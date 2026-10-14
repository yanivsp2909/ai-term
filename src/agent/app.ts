import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import type { LanguageModel } from 'ai';
import { KeyReader, type KeyEvent } from './key-reader.js';
import type { Screen } from './screen.js';
import type { Agent, AgentIO, AgentPermission, ToolName } from './agent.js';
import { loadInstructions } from './instructions.js';
import { killAllBash } from './bash.js';
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
const HELP = ['/model [id]   switch to another model of this key', '/caps [turns N|off] [spend N|off]   show or change this run\'s caps', '/clear        forget the conversation (frees the context)', '/cd <folder>  work in another folder (AGENTS.md is read again)', '/exit         quit (Ctrl+C twice also quits)', 'Esc interrupts a turn · Ctrl+K kills the request and every running command at once · y / n answer an approval · ⏎ goes on at a limit pause · a message sent during a turn waits for it to end'];

// One controller per agent process: it owns the prompt, the queue of messages typed during a turn, the approval in
// progress and the quit gesture. The agent turn itself lives in agent.ts.
export class AgentApp implements AgentIO {
  private readonly reader = new KeyReader();
  private readonly agent: Agent;
  private buffer = '';
  private queued: string[] = [];
  private turn: AbortController | null = null;
  private approval: { resolve(allowed: boolean): void; title: string; pages: string[][]; page: number } | null = null;
  private paused: { resolve(go: boolean): void } | null = null;
  private quitArmedAt = 0;
  private closed = false;
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
  approve(request: { title: string; body: string }, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    const pages = this.options.screen.approvalPages(request.body);
    this.options.screen.approvalPage(request.title, pages, 0);
    return new Promise(resolvePromise => {
      const finish = (allowed: boolean) => { if (!this.approval) return; this.approval = null; signal.removeEventListener('abort', onAbort); this.options.screen.answered(allowed); resolvePromise(allowed); };
      const onAbort = () => finish(false);
      signal.addEventListener('abort', onAbort, { once: true });
      this.approval = { resolve: finish, title: request.title, pages, page: 0 };
    });
  }

  // A command (/model, /cd) in progress counts as running too: what you type meanwhile waits for it.
  private commandBusy = false;
  get running(): boolean { return this.turn !== null || this.commandBusy; }
  // Runs the next queued message or command, or shows the prompt when there's none.
  private next(): void { if (this.closed) return; const queued = this.queued.shift(); if (queued !== undefined) this.submit(queued); else this.options.screen.prompt(this.buffer); }
  start(firstMessage?: string): void { if (firstMessage?.trim()) this.submit(firstMessage); else this.options.screen.prompt(this.buffer); }
  input(data: string): void { for (const event of this.reader.push(data)) this.key(event); }

  private key(event: KeyEvent): void {
    if (this.closed) return;
    if (event.kind === 'ctrl-c' || event.kind === 'ctrl-d' && !this.running && !this.buffer) { this.quitKey(); return; }
    this.quitArmedAt = 0;
    if (event.kind === 'ctrl-k') { this.kill(); return; }
    if (this.paused) {
      // Only a typed ⏎ goes on past a limit; a paste never does.
      if (event.kind === 'enter') this.paused.resolve(true);
      else if (event.kind === 'escape') { this.paused.resolve(false); this.turn?.abort(); }
      return;
    }
    if (this.approval) {
      // Only a typed key answers; a paste never does. y counts once every page of what runs has been on screen.
      const approval = this.approval, last = approval.page === approval.pages.length - 1;
      if (event.kind === 'text' && event.text === ' ' && !last) { approval.page++; this.options.screen.approvalPage(approval.title, approval.pages, approval.page); }
      else if (event.kind === 'text' && /^[yY]$/.test(event.text) && last) approval.resolve(true);
      else if (event.kind === 'text' && /^[nN]$/.test(event.text)) this.approval.resolve(false);
      else if (event.kind === 'escape') { this.approval.resolve(false); this.turn?.abort(); }
      return;
    }
    if (event.kind === 'escape') { if (this.running) this.turn?.abort(); else { this.buffer = ''; this.options.screen.prompt(''); } return; }
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
    const commands = killAllBash();
    if (!this.running) { this.options.screen.note(commands ? `killed ${commands} running command${commands > 1 ? 's' : ''}` : 'nothing is running'); this.options.screen.prompt(this.buffer); return; }
    this.queued = []; this.approval?.resolve(false); this.paused?.resolve(false); this.turn?.abort();
    this.options.screen.note(`killed: the request${commands ? ` and ${commands} running command${commands > 1 ? 's' : ''}` : ''}`, 'error');
  }
  close(): void { if (this.closed) return; this.closed = true; killAllBash(); this.paused?.resolve(false); this.approval?.resolve(false); this.turn?.abort(); this.options.screen.hidePrompt(); this.options.quit(); }

  private submit(message: string): void {
    const command = message.trim().match(/^\/(help|exit|model|cd|caps|clear)(?:\s+(.*))?$/s);
    if (command) { this.commandBusy = true; void this.command(command[1] ?? '', (command[2] ?? '').trim()).finally(() => { this.commandBusy = false; this.next(); }); return; }
    this.options.screen.user(message); this.options.screen.working();
    const turn = new AbortController(); this.turn = turn;
    void this.agent.turn(message, turn.signal).then(result => { this.turn = null; this.options.screen.turnEnd(result); this.next(); },
      () => { this.turn = null; this.options.screen.note('the turn stopped unexpectedly', 'error'); this.next(); });
  }
  private async command(name: string, argument: string): Promise<void> {
    const screen = this.options.screen;
    if (name === 'exit') { this.close(); return; }
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
