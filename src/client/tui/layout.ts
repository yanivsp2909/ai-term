import { engineLabel } from '../../shared/models.js';
// design.md: two letters for the model family (CL Claude, GP GPT, KI Kimi, GR Grok, DS DeepSeek, GL GLM). AI Term's agent can
// run any of them, so its badge follows the deployment name; an unknown family reads AT.
const FAMILIES: [RegExp, string][] = [[/^claude|^opus|^sonnet|^haiku/i, 'CL'], [/^gpt|^o\d|^codex/i, 'GP'], [/^kimi/i, 'KI'], [/^grok/i, 'GR'], [/^deepseek/i, 'DS'], [/^glm/i, 'GL']];
function badge(session: SessionInfo): string {
  if (session.engine === 'shell') return 'SH';
  if (session.engine === 'codex') return 'GP';
  if (session.engine === 'claude-code') return 'CL';
  return FAMILIES.find(([pattern]) => pattern.test(session.model ?? ''))?.[1] ?? 'AT';
}
import type { SessionInfo, AgentEngine, SystemStats, UsageSummary, Budgets, Effort, Permission } from '../../shared/protocol.js';
import { Grid, graphemes, type Frame } from './grid.js';
import { textWidth } from '../../shared/unicode-width.js';
import type { Theme } from './theme.js';
import { drawUsage, budgetWarning } from './usage-panel.js';
import { marks, cardText } from './agent-card.js';
import { commandRegistry, commandRows, modeLabel } from './commands.js';
import { agentUsage, drawThisMac } from './this-mac.js';
import { drawField } from './command-bar.js';
import type { FieldView } from './message-field.js';
export interface Rect { x: number; y: number; w: number; h: number }
export function homepageLayout(cols: number, rows: number, visible = true) {
  const tiny = cols < 60 || rows < 16, compact = cols < 100 || rows < 30;
  const left = compact || !visible ? cols : 36, rightX = 38, rightW = cols - rightX;
  const previewHeight = rows - 14;
  return { tiny, compact, agents: { x: 0, y: 1, w: left, h: compact ? rows - 6 : !visible ? rows - 15 : rows - 6 },
    preview: !tiny && !compact && visible ? { x: rightX, y: 1, w: rightW, h: previewHeight } : null,
    terminal: { x: rightX + 2, y: 3, w: Math.max(2, rightW - 4), h: Math.max(1, previewHeight - 4) },
    statsY: rows - 12, statsX: visible ? rightX : 0, statsW: visible ? rightW : cols };
}
export function sortSessions(sessions: SessionInfo[]): SessionInfo[] { return [...sessions].sort((a, b) => Number(b.status === 'waiting') - Number(a.status === 'waiting') || Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id)); }
// The cards the Agents panel draws, so the homepage can time quiet redraws for exactly what is on screen.
export function visibleCards(view: Pick<HomepageView, 'cols' | 'rows' | 'sessions' | 'selectedId' | 'previewVisible' | 'listStart'>): SessionInfo[] {
  const layout = homepageLayout(view.cols, view.rows, view.previewVisible); if (layout.tiny) return [];
  const sessions = sortSessions(view.sessions), capacity = Math.max(1, Math.floor((layout.agents.h - 2) / 3)), index = sessions.findIndex(s => s.id === view.selectedId), start = visibleStart(Math.max(0, index), capacity, view.listStart ?? 0);
  return sessions.slice(start, start + capacity);
}
export function visibleStart(selected: number, capacity: number, start: number): number { return selected < start ? selected : selected >= start + capacity ? selected - capacity + 1 : start; }
export const commands = commandRegistry.map(c=>c.name);
export function filteredCommands(text: string): string[] { return commands.filter(command => command.startsWith(text.split(' ')[0] ?? '')); }
export interface HomepageView { cols: number; rows: number; sessions: SessionInfo[]; selectedId: string | null; input: string; note: string; notePriority?: boolean; commandMenu?: boolean; warning?: string; previewVisible: boolean; cwd: string; engine?: AgentEngine; model?: string | null; now: number; listStart?: number; previewCells?: Frame; linesBack?: number; newLines?: number; copying?: boolean; stats?: SystemStats | null; cpuHistory?: readonly number[]; menuChoice?: number; authLabel?: string; field?: FieldView;usage?:UsageSummary|null;budgets?:Budgets;effort?:Effort|null;permission?:Permission;worktrees?:'on'|'off';themeName?:import('../../shared/protocol.js').ThemeName;marked?:ReadonlySet<string>;contextWarning?:boolean;taskCost?:boolean }
export const SPLIT_MARK = '◆ marked';
export function renderHomepage(view: HomepageView, theme: Theme): Frame {
  const { cols, rows } = view, t = theme.colors, grid = new Grid(cols, rows, theme), layout = homepageLayout(cols, rows, view.previewVisible);
  if (layout.tiny) { const label = 'make the window bigger'; grid.text(Math.floor((cols - label.length) / 2), Math.floor(rows / 2), label, t['ink-3']); return grid.cells; }
  grid.text(1, 0, 'AI Term', t.ink, t.bg, true); grid.text(8, 0, '_', t.accent);
  const budget=budgetWarning(view.usage,view.budgets);
  const counts: [string, string, boolean][] = budget?[[budget,t['status-waiting'],false]]:[];
  for (const [status, word] of [['waiting', 'waiting'], ['running', 'running'], ['done', 'to review'], ['error', 'failed']] as const) {
    const count = view.sessions.filter(s => s.status === status || status === 'running' && s.status === 'starting').length;
    if (count) { const [glyph, color] = marks[status]; counts.push([`${glyph} ${count} ${word}`, t[color], status === 'waiting']); }
  }
  let countX = Math.max(12, cols - 1 - counts.reduce((n, [label]) => n + textWidth(label) + 2, -2));
  for (const [label, color, bold] of counts) { grid.text(countX, 0, label, color, t.bg, bold); countX += textWidth(label) + 2; }
  const panel = layout.agents; grid.box(panel.x, panel.y, panel.w, panel.h, `Agents ${view.sessions.length}`);
  const sessions = sortSessions(view.sessions);
  for (const [i, session] of visibleCards(view).entries()) {
    const y = 2 + i * 3, selected = session.id === view.selectedId, bg = selected ? t['surface-2'] : t.bg, textW = panel.w - 9, card = cardText(session, view.now, textW, { contextWarning: view.contextWarning !== false, taskCost: view.taskCost !== false }), statusW = textWidth(card.status.text);
    grid.fill(1, y, panel.w - 2, 3, bg);
    if (selected) for (let r = 0; r < 3; r++) grid.text(1, y + r, '▎', t.accent, bg);
    grid.text(2, y, ` ${badge(session)} `, t.ink, t['surface-2'], true);
    grid.text(2, y + 1, '    ', t.ink, t['surface-2']);
    grid.text(7, y, session.title, t.ink, bg, selected, textW - statusW - 1);
    grid.text(panel.w - statusW - 2, y, card.status.text, t[card.status.color], bg, card.status.bold);
    if(session.permission==='dontAsk')grid.text(panel.w-statusW-2,y,'!',t['status-error'],bg);
    grid.text(7, y + 1, card.model, t['ink-2'], bg, false, card.ctx ? textW - card.ctx.text.length - 1 : textW);
    if (card.ctx) grid.text(panel.w - card.ctx.text.length - 2, y + 1, card.ctx.text, t[card.ctx.color], bg);
    // A split mark (Space) sits at the end of line 3 as glyph + word; the line's own text gives it room.
    const marked = view.marked?.has(session.id) ?? false, lineW = marked ? Math.max(0, textW - textWidth(SPLIT_MARK) - 2) : textW;
    // Activity in its own color; the auth that follows it (when it fits whole) stays calm.
    if (card.activity) { const end = grid.text(7, y + 2, card.activity.text, t[card.activity.color], bg, false, lineW); if (card.line3 !== card.activity.text) grid.text(end, y + 2, card.line3.slice(card.activity.text.length), t['ink-3'], bg, false, 7 + lineW - end); }
    else grid.text(7, y + 2, card.line3, session.engine === 'shell' && (session.status === 'error' || session.status === 'waiting') ? t[card.status.color] : t['ink-3'], bg, false, lineW);
    if (marked) grid.text(panel.w - textWidth(SPLIT_MARK) - 2, y + 2, SPLIT_MARK, t.accent, bg, true);
  }
  if (!sessions.length) grid.text(3, 3, 'No sessions yet', t['ink-3']);
  const selected = sessions.find(s => s.id === view.selectedId);
  if (layout.preview) {
    const p = layout.preview, area = layout.terminal;
    grid.box(p.x, p.y, p.w, p.h, '', t.surface);
    grid.text(p.x + 2, p.y, ` ${selected?.title ?? 'Preview'} `, t['ink-2'], t.surface, true, p.w - 23);
    const label = view.linesBack ? '◌ scrolled back' : '◉ live'; grid.text(p.x + p.w - label.length - 3, p.y, ` ${label} `, t.accent, t.surface);
    // Per-agent usage sits on the header's right, before any ctx/diff text (design.md is silent; calmest spot).
    const usage = agentUsage(view.stats, selected?.id) ?? '', ctx = selected && selected.engine !== 'shell' && selected.ctxPercent !== null ? `ctx ${Math.round(selected.ctxPercent)}%` : '';
    // design.md: the agent's cpu/RAM sits before any ctx text; two cells keep them apart.
    const rightW = textWidth(usage) + (usage && ctx ? 2 : 0) + ctx.length, usageW = rightW ? rightW + 2 : 0;
    grid.text(p.x + 2, 2, selected?.engine === 'shell' ? 'shell' : selected ? `${selected.engine} · ${selected.model ?? 'CLI default'}` : 'Your agents, together in one terminal', t['ink-2'], t.surface, false, p.w - 4 - usageW);
    if (usage) grid.text(p.x + p.w - 2 - rightW, 2, usage, t['ink-3'], t.surface);
    if (ctx && selected) grid.text(p.x + p.w - 2 - ctx.length, 2, ctx, (selected.ctxPercent ?? 0) >= 85 ? t['status-waiting'] : t['ink-3'], t.surface);
    if(selected?.permission==='dontAsk'){grid.text(p.x+2,p.y,"! don't ask · ",t['status-error'],t.surface);grid.text(p.x+15,p.y,selected.title,t['ink-2'],t.surface,true,p.w-35);}
    for (let y = 0; y < area.h; y++) for (let x = 0; x < area.w; x++) { const cell = view.previewCells?.[y]?.[x]; if (cell) grid.put(area.x + x, area.y + y, cell); }
    if (!selected) { grid.text(area.x + 1, area.y + 2, 'Build with AI coding agents.', t['ink-3'], t.surface); grid.text(area.x + 1, area.y + 4, 'Type a task · ⏎ to start', t['ink-3'], t.surface); grid.text(area.x + 1, area.y + 6, 'Account logins · /model to choose', t['ink-3'], t.surface); }
    if (view.linesBack) { grid.fill(area.x, area.y, area.w, 1, t.surface); grid.text(area.x, area.y, `↑ ${view.linesBack} lines back · the agent keeps running  End follow live`, t['ink-2'], t.surface, false, area.w); }
    if (view.newLines) { grid.fill(area.x, area.y + area.h - 1, area.w, 1, t.surface); grid.text(area.x, area.y + area.h - 1, `● ${view.newLines} new lines below`, selected?.status === 'waiting' ? t['status-waiting'] : t.accent, t.surface); }
  } else if (!layout.compact) { grid.box(0, rows - 14, cols, 2, '▸ preview hidden · p'); }
  if (!layout.compact) {
    const w = layout.statsW, x = layout.statsX, macW = 36, usageW = w - macW - 2;
    grid.box(x, layout.statsY, usageW, 7, 'Usage'); grid.box(x + usageW + 2, layout.statsY, macW, 7, 'This Mac');
    drawUsage(grid,x+2,layout.statsY+1,usageW-4,view.usage,view.budgets,theme);
    drawThisMac(grid, x + usageW + 4, layout.statsY + 1, macW - 4, view.stats, view.cpuHistory ?? [], theme);
    grid.text(x + usageW + 4, layout.statsY + 5, 'v0.1.8', t['ink-3'], t.bg, false, macW - 4, true);
  }
  grid.box(0, rows - 4, cols, 3, '', t.surface); grid.text(2, rows - 3, '›', t.accent, t.surface);
  const units = graphemes(view.input); drawField(grid, view.field ?? { units, caret: units.length, selection: null }, cols, rows - 3, theme);
  const hints = '↑↓ agents  ⏎ open  p preview  / commands', hintsX = cols - hints.length - 1;
  const defaultWidth=Math.max(0,hintsX-2),auth=view.engine?` · ${view.authLabel??'own login'} · ${view.effort??'CLI default'} · ${modeLabel(view.permission??'ask')}${view.worktrees?' · worktree '+view.worktrees:''}`:'',model=view.engine?`${view.model??'CLI default'} · ${engineLabel(view.engine)}`:'shell';
  let clippedModel='';for(const char of graphemes(model)){if(textWidth(clippedModel+char)>Math.max(0,defaultWidth-textWidth(auth)-3))break;clippedModel+=char;}
  const prefix=`${clippedModel} · `,folderWidth=Math.max(0,defaultWidth-textWidth(prefix)-textWidth(auth));
  let folder='';for(const char of graphemes(view.cwd)){if(textWidth(folder+char)>folderWidth)break;folder+=char;}
  grid.text(1, rows - 1, prefix+folder+auth, t['ink-3'], t.bg, false, defaultWidth); if(view.permission==='dontAsk')grid.text(1+textWidth(prefix+folder+auth)-textWidth(modeLabel('dontAsk'))-textWidth(view.worktrees?' · worktree '+view.worktrees:''),rows-1,modeLabel('dontAsk'),t['status-error'],t.bg,false,textWidth(modeLabel('dontAsk'))); grid.text(hintsX, rows - 1, hints, t['ink-3']);
  const commandMenu = view.commandMenu!==false&&view.input.startsWith('/')&&!view.notePriority;
  if (commandMenu) {
    const choices = commandRows(view.input,{engine:view.engine??'claude-code',model:view.model??null,cwd:view.cwd,theme:theme.name,effort:view.effort,permission:view.permission,selectedTitle:selected?.title}), capacity=Math.max(1,Math.min(choices.length,rows-7)),choice=Math.min(view.menuChoice??0,Math.max(0,choices.length-1)),start=visibleStart(choice,capacity,0),h=capacity+2,y=rows-4-h,w=cols;
    grid.box(0,y,w,h,'Commands',t.surface);
    choices.slice(start,start+capacity).forEach((command,i)=>{
      const selected=start+i===choice,bg=selected?t['surface-2']:t.surface,row=y+1+i;
      grid.fill(1,row,w-2,1,bg);if(selected)grid.text(1,row,'▎',t.accent,bg);
      const valueW=Math.min(Math.floor(w/3),textWidth(command.value)),valueX=w-3-valueW,leftW=Math.max(0,valueX-5);
      const label=command.name+(command.hint?' '+command.hint:'');
      const end=grid.text(3,row,label,t['ink-2'],bg,selected,Math.min(leftW,Math.max(14,Math.floor(w/2)-4)));
      if(command.description&&end+3<valueX)grid.text(end+2,row,command.description,t['ink-2'],bg,false,valueX-end-3);
      grid.text(valueX,row,command.value,t['ink-3'],bg,false,valueW);
    });
  }
  if (view.note && !commandMenu) { grid.fill(0, rows - 5, cols, 1, view.copying ? t.accent : t.bg); grid.text(2, rows - 5, view.note, view.copying ? t['on-accent'] : t['ink-3'], view.copying ? t.accent : t.bg, false, cols - 4); }
  if(budget&&!commandMenu&&!view.notePriority){grid.fill(0,rows-5,cols,1,t.bg);grid.text(2,rows-5,budget,t['status-waiting'],t.bg,false,cols-4);}
  if (view.warning&&!view.notePriority) { grid.fill(0, rows - 5, cols, 1, t.bg); grid.text(2, rows - 5, '✗ ' + view.warning, t['status-error'], t.bg, false, cols - 4); }
  return grid.cells;
}
