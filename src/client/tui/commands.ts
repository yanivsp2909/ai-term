import type {AgentEngine,Effort,Permission,ThemeName} from '../../shared/protocol.js';
import {EFFORT_LEVELS} from '../../shared/validate.js';
// dontAsk: false where AI Term's agent can't have its bash sandbox (v0.8.1); it then offers Ask only.
export interface CommandContext {engine:AgentEngine;model:string|null;cwd:string;theme:ThemeName;effort?:Effort|null;permission?:Permission;selectedTitle?:string;agents?:readonly string[];dontAsk?:boolean}
export interface Command {name:string;description:string;argumentHint?:(context:CommandContext)=>string;values?:(context:CommandContext)=>readonly string[];current:(context:CommandContext)=>string}
export const modeValues=(engine:AgentEngine,dontAsk=true):readonly Permission[]=>engine==='claude-code'?['ask','auto','dontAsk']:engine==='ai-term'&&!dontAsk?['ask']:['ask','dontAsk'];
export const modeLabel=(mode:Permission):string=>mode==='dontAsk'?"! don't ask":mode;
export const effortValues=(engine:AgentEngine):readonly string[]=>['CLI default',...EFFORT_LEVELS[engine]];
const none=()=>'';
// D58 add-ons typed as commands (review-deep is reached through /review <agent> deep). A hint in <> needs an argument;
// one in [] has a default: the whole folder, or the selected agent.
export const ADDON_COMMANDS=['plan','prompt','explain','teach','fix','cover','bisect','refactor','perf','types','failures','security','issue','pr-review','deps','commit','changelog','docs','handover','standup','adr','context','opensource','deck','slides','diagram','design','polish','a11y','e2e','animate','video','research','study','reverse'] as const;
// Add-ons that run no model: no engine target is sent (their m or follow-ups ask for one themselves).
export const LOCAL_ADDON_COMMANDS:readonly string[]=['bisect','standup','study-due'];
// Add-ons that need an engine with its own web tools: AI Term's agent is offered only when nothing else is.
export const WEB_ADDON_COMMANDS:readonly string[]=['research'];
export const ADDON_HINTS:Readonly<Record<string,string>>={plan:'<goal>',prompt:'<file or text>',explain:'<path or question>',teach:'[agent]',fix:'<error text or file>',cover:'[path]',bisect:'[--no-deps] <test command> [good ref]',refactor:'[path]',perf:'[path or command]',types:'[path]',failures:'[path]',security:'[path]','review-deep':'[agent]',issue:'<#number or issue URL>','pr-review':'<#number or PR URL>',deps:'[path]',commit:'[agent]',changelog:'[from..to]',docs:'[path]',handover:'[path]',standup:'',adr:'<decision>',context:'',opensource:'',deck:'<topic>',slides:'<topic>',diagram:'<what to draw>',design:'<screen>',polish:'<path>',a11y:'<path>',e2e:'<app or flow>',animate:'<motion>',video:'<topic>',research:'<question>',study:'[topic]','study-due':'',reverse:'<target> | path <path>'};
export const commandRegistry:readonly Command[]=[
 {name:'/model',description:'Choose model and provider',current:c=>`${c.model??'CLI default'} · ${c.engine==='codex'?'codex':'claude code'}`},
 {name:'/cd',description:'Choose the next agent folder',current:c=>c.cwd},
 {name:'/skills',description:'Browse and enable skills, agents and commands',current:none},
 {name:'/mcp',description:'MCP servers and per-tool load controls',argumentHint:()=> '[add|remove <name>]',current:none},
 {name:'/agents',description:'Browse subagents in the extensions popup',current:none},
 {name:'/preset',description:'Saved start setups: open, save, list, remove',argumentHint:()=>'[<name> | save <name> [first message] | rm <name>]',current:none},
 {name:'/account',description:'Accounts per engine: add (CLI login), default, use, remove',argumentHint:()=>'[add claude|codex <name> | default <name> | use <name|own> | rm <name>]',current:none},
 {name:'/handoff',description:'Hand an agent over to another engine (spends tokens; asks first)',argumentHint:()=>'<agent> claude|codex[:account]',current:none},
 {name:'/settings',description:'Keys and saved defaults',current:none},
 {name:'/login',description:'Connect an engine or API key',current:none},
 {name:'/effort',description:'Reasoning for the next agent',argumentHint:c=>effortValues(c.engine).join('|'),values:c=>effortValues(c.engine),current:c=>c.effort??'CLI default'},
 {name:'/mode',description:'Permissions for the next agent',argumentHint:c=>modeValues(c.engine,c.dontAsk).map(m=>m==='dontAsk'?"don't ask":m).join('|'),values:c=>modeValues(c.engine,c.dontAsk).map(m=>m==='dontAsk'?"don't ask":m),current:c=>modeLabel(c.permission??'ask')+(c.engine==='codex'?' · auto unavailable':'')},
 {name:'/resume',description:'Continue the selected finished agent',current:c=>c.selectedTitle??''},
 {name:'/retry',description:'Restart the selected finished agent fresh',current:c=>c.selectedTitle??''},
 {name:'/diff',description:'What an agent changed in its worktree (d on a card); a vs b compares two',argumentHint:()=>'[agent] [vs <agent>]',values:c=>c.agents??[],current:c=>c.selectedTitle??''},
 {name:'/export',description:'Save a session as one HTML file (keys removed)',argumentHint:()=>'[agent] [folder]',current:c=>c.selectedTitle??''},
 {name:'/merge',description:'Merge an agent\'s branch into your checkout (asks first; secret scan)',argumentHint:()=>'[agent] [rebase]',values:c=>c.agents??[],current:c=>c.selectedTitle??''},
 {name:'/pr',description:'Push an agent\'s branch and open a pull request with gh (asks first)',argumentHint:()=>'[agent]',values:c=>c.agents??[],current:c=>c.selectedTitle??''},
 {name:'/fork',description:'The same first message on another model, in its own worktree (spends tokens; asks first)',argumentHint:()=>'[agent] <model>',current:c=>c.selectedTitle??''},
 {name:'/review',description:'One reviewer pass on an agent\'s diff by a keyed model you pick (spends tokens; asks first)',argumentHint:()=>'[agent] [show | deep] | budget <usd>',values:c=>c.agents??[],current:c=>c.selectedTitle??''},
 {name:'/test',description:'Run the project\'s tests in an agent\'s worktree (asks first; the card shows the result)',argumentHint:()=>'[agent]',values:c=>c.agents??[],current:c=>c.selectedTitle??''},
 {name:'/test-cmd',description:'The project\'s test command, run when an agent finishes (none clears it)',argumentHint:()=>'[<command> | none]',current:none},
 {name:'/undo',description:'Restore an agent\'s worktree to its previous checkpoint (asks first)',argumentHint:()=>'[agent]',values:c=>c.agents??[],current:c=>c.selectedTitle??''},
 {name:'/redo',description:'Bring back what the last /undo replaced (asks first)',argumentHint:()=>'[agent]',values:c=>c.agents??[],current:c=>c.selectedTitle??''},
 {name:'/send',description:'Send text to a running agent',argumentHint:()=>'<agent> <text>',values:c=>c.agents??[],current:none},
 {name:'/find',description:'Search every agent\'s screen and scrollback',argumentHint:()=>'<text>',current:none},
 {name:'/open',description:'Open the selected agent\'s folder in Finder',argumentHint:()=>'[code]',values:()=>['code'],current:c=>c.selectedTitle??''},
 {name:'/shell',description:'Start a plain login shell',current:c=>c.cwd},
 {name:'/clean',description:'Remove finished records; worktrees are kept',current:none},
 {name:'/worktrees',description:'Review and delete AI Term worktrees',current:none},
 {name:'/copy',description:'Copy Claude last reply; cleaned session fallback',argumentHint:()=> '[all]',values:()=>['all'],current:c=>c.selectedTitle??''},
 {name:'/budget',description:'Daily, weekly and monthly USD limits',current:none},
 {name:'/usage',description:'API spend and tokens by provider',current:none},
 {name:'/doctor',description:'Check Node, daemon, files and CLIs',current:none},
 {name:'/help',description:'Commands and keyboard help',current:none},
 {name:'/theme',description:'Choose the saved theme',argumentHint:()=> 'graphite|slate|ink|auto|light',values:()=>['graphite','slate','ink','auto','light'],current:c=>c.theme},
 {name:'/exit',description:'Quit AI Term; agents keep running',current:none},
 {name:'/brain',description:'Map this repository for agents: a free local pass, an optional model pass that asks first',argumentHint:()=>'[show | rm | trust | untrust]',values:()=>['show','rm','trust','untrust'],current:none},
 {name:'/plan',description:'Propose a step plan; a saves it, s starts a step (asks first)',argumentHint:()=>'<goal>',current:none},
 {name:'/prompt',description:'Audit a builder prompt read-only; copy the improved diff (asks first)',argumentHint:()=>'<file or text>',current:none},
 {name:'/explain',description:'Explain inspected code in small chunks; Space advances (asks first)',argumentHint:()=>'<path or question>',current:none},
 {name:'/teach',description:'Teach the diff an agent just made in small chunks; a quiz only if you ask (asks first)',argumentHint:()=>ADDON_HINTS.teach??'',values:c=>c.agents??[],current:c=>c.selectedTitle??''},
 {name:'/fix',description:'Root cause, a failing test, then the fix, in a worktree; stops if it can\'t reproduce (asks first)',argumentHint:()=>ADDON_HINTS.fix??'',current:none},
 {name:'/cover',description:'Write tests for untested behavior in a worktree; sandboxed test run (asks first)',argumentHint:()=>ADDON_HINTS.cover??'',current:none},
 {name:'/bisect',description:'Find the first bad commit with git bisect in a sandboxed temporary copy with your dependencies linked read-only; no model, no tokens',argumentHint:()=>ADDON_HINTS.bisect??'',current:none},
 {name:'/refactor',description:'Tech-debt list; Space picks items, r refactors only those in a worktree (asks first)',argumentHint:()=>ADDON_HINTS.refactor??'',current:none},
 {name:'/perf',description:'Measure, optimize in a worktree, then an A/B before and after (asks first)',argumentHint:()=>ADDON_HINTS.perf??'',current:none},
 {name:'/types',description:'Read-only type-design review; f fixes a finding in a worktree (asks first)',argumentHint:()=>ADDON_HINTS.types??'',current:none},
 {name:'/failures',description:'Read-only hunt for silently swallowed errors; a long, expensive read (asks first)',argumentHint:()=>ADDON_HINTS.failures??'',current:none},
 {name:'/issue',description:'Work a GitHub issue in a worktree, read with your gh login; /pr publishes (asks first)',argumentHint:()=>ADDON_HINTS.issue??'',current:none},
 {name:'/pr-review',description:'Read-only review of a GitHub pull request; c copies it, nothing is posted (asks first)',argumentHint:()=>ADDON_HINTS['pr-review']??'',current:none},
 {name:'/deps',description:'Outdated and vulnerable dependencies; the agent upgrades in a worktree (asks first)',argumentHint:()=>ADDON_HINTS.deps??'',current:none},
 {name:'/commit',description:'A commit message for the staged changes or an agent\'s work; c copies, y commits in its worktree (asks first)',argumentHint:()=>ADDON_HINTS.commit??'',values:c=>c.agents??[],current:none},
 {name:'/changelog',description:'A changelog section from git history; c copies, w writes it in a worktree (asks first)',argumentHint:()=>ADDON_HINTS.changelog??'',current:none},
 {name:'/docs',description:'Bring README and docs up to date with the code, in a worktree (asks first)',argumentHint:()=>ADDON_HINTS.docs??'',current:none},
 {name:'/handover',description:'Write a handover for this repository in a worktree (asks first)',argumentHint:()=>ADDON_HINTS.handover??'',current:none},
 {name:'/standup',description:'What every agent did today, from AI Term\'s records; no model; m polishes it',current:none},
 {name:'/adr',description:'Write a decision record into the repository\'s decision log, in a worktree (asks first)',argumentHint:()=>ADDON_HINTS.adr??'',current:none},
 {name:'/context',description:'Audit what an agent loads here: size, contradictions, stale rules; read-only (asks first)',argumentHint:()=>ADDON_HINTS.context??'',current:none},
 {name:'/opensource',description:'Is this repository ready to be public? Read-only scan; f fixes what files can fix (asks first)',argumentHint:()=>ADDON_HINTS.opensource??'',current:none},
 {name:'/deck',description:'An investor or pitch deck from the product\'s real facts, as HTML in a worktree; missing facts stay TODO (asks first)',argumentHint:()=>ADDON_HINTS.deck??'',current:none},
 {name:'/slides',description:'A presentation (a talk, a lesson, a walkthrough) as HTML in a worktree (asks first)',argumentHint:()=>ADDON_HINTS.slides??'',current:none},
 {name:'/diagram',description:'A Mermaid or D2 diagram drawn from the real code, under docs/diagrams/ in a worktree (asks first)',argumentHint:()=>ADDON_HINTS.diagram??'',current:none},
 {name:'/design',description:'UI mockups for a screen as HTML in a worktree; o opens them (asks first)',argumentHint:()=>ADDON_HINTS.design??'',current:none},
 {name:'/polish',description:'Polish an existing UI\'s details in a worktree, without redesigning it (asks first)',argumentHint:()=>ADDON_HINTS.polish??'',current:none},
 {name:'/a11y',description:'Read-only accessibility review (WCAG 2.2 AA); f fixes a finding in a worktree (asks first)',argumentHint:()=>ADDON_HINTS.a11y??'',current:none},
 {name:'/e2e',description:'Browser tests for an app\'s key flows in a worktree, run in the test sandbox (asks first)',argumentHint:()=>ADDON_HINTS.e2e??'',current:none},
 {name:'/animate',description:'Decide whether something should animate at all, then build it in a worktree (asks first)',argumentHint:()=>ADDON_HINTS.animate??'',current:none},
 {name:'/video',description:'A short video as code (Remotion) or a terminal demo (VHS) in a worktree (asks first)',argumentHint:()=>ADDON_HINTS.video??'',current:none},
 {name:'/reverse',description:'Reverse-engineer an app or binary that is yours with REA\'s MCP tools, read-only; REA runs sandboxed with no network (asks first)',argumentHint:()=>ADDON_HINTS.reverse??'',current:none},
 {name:'/research',description:'Web research with sources, saved under docs/research/ in a worktree; Claude Code or Codex only (asks first)',argumentHint:()=>ADDON_HINTS.research??'',current:none},
 {name:'/study',description:'A short study session, one idea and one check question per chunk; /study alone shows what is due',argumentHint:()=>ADDON_HINTS.study??'',current:none},
 {name:'/security',description:'Read-only security review and bug-bounty hunt, reproduced against this repo only (asks first)',argumentHint:()=>ADDON_HINTS.security??'',current:none},
 {name:'/remote',description:'Reach your agents from your phone over your own Tailscale tailnet while on: on (QR pairing), off, revoke <phone> (D54, off; /settings R)',argumentHint:()=>'[on | off | revoke <phone>]',values:()=>['on','off','revoke'],current:none},
 {name:'/dev',description:'Run the project\'s dev server in an agent\'s worktree on its own port (asks first; D55, off; /settings y)',argumentHint:()=>'[agent]',values:c=>c.agents??[],current:c=>c.selectedTitle??''},
 {name:'/dev-cmd',description:'The project\'s dev server command, like npm run dev (none clears it)',argumentHint:()=>'<command> | none',current:none},
 {name:'/queue',description:'Agents that start after an agent finishes or at a time, each with a limit (D55, off; /settings b)',argumentHint:()=>'[add]',values:()=>['add'],current:none},
];
export const aiSubcommands=['ai','ai --attach <id>','ai --version','ai doctor','ai status-line','ai status-notify <json>','ai agent','ai daemon','ai daemon stop','ai debug stats','ai debug usage','ai debug ls','ai debug shell [cwd]','ai debug attach <id>','ai debug stop <id>','ai debug peek <id>'] as const;
export const debugActions=aiSubcommands.filter(c=>c.startsWith('ai debug ')).map(c=>c.split(' ')[2]??'');
export const keyTable:readonly [string,string][]=[
 ['Add-on e / m / b / y / Enter / Esc','Engine or key / model / free local brain first / start / no action / close'],
 ['/plan a / ↑↓ / PgUp/PgDn / s','Approve and save / select step / page details / start that step in Ask mode in a worktree'],
 ['/prompt c · /explain Space','Copy improved diff / next chunk, then three-line recap'],
 ['/teach Space / y / n','Next chunk; at the end y starts the quiz, n skips it; Space shows each answer'],
 ['/refactor ↑↓ / Space / r','Select item / pick it / refactor the picked items in a worktree'],
 ['/types f · /failures, /security, /review deep ↑↓','Fix the selected finding in a worktree / select a finding to read it'],
 ['/perf a / Y','Run the A/B in the sandbox / without one, only after AI Term says there is none'],
 ['/bisect y / Y','Start in the test sandbox / start without one (capital Y) when there is none'],
 ['/commit c / y','Copy the message / commit it in the agent\'s worktree (never in your checkout)'],
 ['/changelog c / w','Copy the section / write it into CHANGELOG.md in a worktree'],
 ['/pr-review c · /standup m','Copy the review (nothing is posted) / polish today\'s standup with a model'],
 ['/opensource f','Fix every finding a file change can fix, in a worktree'],
 ['Made files o / s','Open the selected file with your default app / save a copy to Downloads (only when you press it)'],
 ['/a11y f · /study Space','Fix the selected accessibility finding in a worktree / next chunk, then the recap'],
 ['c','Empty field copies Claude last reply; cleaned session fallback (v0.2)'],['u','Empty field opens usage details by period and provider'],['/find ↑↓ / Enter / Esc','Select a hit / select its agent and scroll the preview to it / close'],['/doctor, /usage ↑↓ / PgUp / PgDn / Esc','Scroll / page / close'],
 ['/skills, /agents ←→ / ↑↓ / Space / Enter / Esc','Tab / item / on-off / read-only full file / close'],
 ['Paste','Over 1 line or 200 chars: [pasted · N lines]; 16 KB first-message limit'],
 ['↑↓','Menu/pickers/settings select rows; otherwise select agent'],['Enter','Pick command; attach selected agent; task opens start box'],['Tab','Complete command, cycle argument values; start box cycles mode'],['p','Empty field toggles preview'],['b','Empty field opens daily/weekly/monthly USD budgets'],['r','Empty field renames selected agent; Enter saves'],['s, then y/n','Stop selected agent with confirmation'],['x','Remove selected exited/failed record; then keep or delete its worktree'],['d','Empty field opens the selected agent\'s diff: ↑↓ files · PgUp/PgDn scroll · m merges · x discards · Esc closes'],['Worktree question k / d / Esc / Enter','Keep / delete a clean worktree / keep / keep'],['Worktree question with loss','type the branch name, then ⏎ deletes · k, Esc or ⏎ on an empty field keeps it'],['/worktrees ↑↓ / Enter / Esc','Select / keep or delete / close'],['Space','Empty field marks/unmarks the selected agent for a split (up to 4)'],['v','Empty field opens marked agents side by side; none marked reopens the last split'],['Split Ctrl+\\','Next pane, or close ended panes; twice within 0.4 s sends Ctrl+\\ to the agent'],['Split click','Focus that pane; mouse goes to its agent'],['PgUp/PgDn/End','Scroll preview; follow live (End: empty field only)'],['Mouse wheel/drag','Scroll preview; copy selection'],['Esc','Close popup, cancel form, drop a field selection, or clear command field'],['Backspace','Delete the selection or before the cursor; a paste token whole'],['Delete','Delete the selection or after the cursor; a paste token whole'],['←/→ · Alt+←/→','Command field: move the cursor by character / word; a paste token is one step'],['Home/End · Ctrl+A/Ctrl+E','Command field: cursor to start / end; End with an empty field follows the preview live'],['Shift+←/→','Command field: extend a selection from the cursor'],['Command field drag','Select text (paste tokens whole); a click places the cursor and clears a selection; never copies'],['Ctrl+U','Clear the command field'],['Alt+Backspace','Delete the previous word or paste token (Ctrl+W too)'],['Ctrl+C twice','Quit client; agents keep running'],['Ctrl+E','Inside a session or split, return home; sessions keep running'],['SIGTERM/SIGHUP/SIGQUIT','Client cleanup; exit 143/129/131'],
 ['Start box ↑↓ / m / c / e / a / p','Select row / model / folder / effort / account / next saved preset; message row edits text'],['Model ←→ / ↑↓ / Enter / Esc','Provider / model / select / back; type searches tabs'],['Folder Tab/Enter','Complete directory / accept folder'],['Effort/mode ↑↓ / Enter / Esc','Choose value / apply / back'],['/login ↑↓ / Enter','Provider/method; masked form advances/saves'],['/settings a/+ / i / l','Add key / import env file / login'],['/settings ↑↓ / Enter / x / t','Select/activate row / remove key / test key'],['/settings d / f / e / Tab / p / n','Save model / folder / effort / theme / your price for a model / notifications on-off'],['Import ↑↓ / Space / Enter','Select name / toggle / import'],['Budget/price ↑↓ / ←→ / Enter / Esc','Fields / price provider / save / cancel'],['/test y / n / l','Run the plan / run nothing / 127.0.0.1 on or off for the project'],['Help ↑↓ / PgUp/PgDn / Esc','Scroll / page / close'],
];
export function commandRows(text:string,context:CommandContext){const prefix=text.split(' ')[0]??'';return commandRegistry.filter(c=>c.name.startsWith(prefix)).map(c=>({name:c.name,description:c.description,hint:c.argumentHint?.(context)??'',value:c.current(context)}));}
export function completeCommand(text:string,highlight:number,context:CommandContext):string{
 const space=text.indexOf(' '),name=space<0?text:text.slice(0,space),command=space<0?commandRegistry.find(c=>c.name===commandRows(text,context)[highlight]?.name):commandRegistry.find(c=>c.name===name);if(!command)return text;
 if(space<0)return command.name+(command.argumentHint?' ':'');if(command.name==='/send')return completeSend(text.slice(space+1),context.agents??[])??text;const values=command.values?.(context);if(!values?.length)return text;const current=text.slice(space+1),index=values.indexOf(current);return command.name+' '+(values[(index+1)%values.length]??values[0]);
}
// /send completes agent names, then cycles them; once text follows a full name, Tab leaves the field alone.
function completeSend(rest:string,names:readonly string[]):string|undefined{
 const exact=names.findIndex(n=>rest===n||rest===n+' ');
 if(exact>=0)return `/send ${names[(exact+1)%names.length]??''} `;
 if(names.some(n=>rest.startsWith(n+' ')))return undefined;
 const match=names.find(n=>n.toLowerCase().startsWith(rest.toLowerCase()));
 return match===undefined?undefined:`/send ${match} `;
}
export function helpLines(context:CommandContext):string[]{return ['COMMANDS',...commandRows('/',context).map(c=>`${c.name}${c.hint?' '+c.hint:''} · ${c.description}`),'/copy all · Copy cleaned whole session','', 'KEYBOARD',...keyTable.map(([key,description])=>`${key} · ${description}`),'','AI SUBCOMMANDS',...aiSubcommands];}
