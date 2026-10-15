import type {AgentEngine,Effort,Permission,ThemeName} from '../../shared/protocol.js';
import {EFFORT_LEVELS} from '../../shared/validate.js';
export interface CommandContext {engine:AgentEngine;model:string|null;cwd:string;theme:ThemeName;effort?:Effort|null;permission?:Permission;selectedTitle?:string;agents?:readonly string[]}
export interface Command {name:string;description:string;argumentHint?:(context:CommandContext)=>string;values?:(context:CommandContext)=>readonly string[];current:(context:CommandContext)=>string}
export const modeValues=(engine:AgentEngine):readonly Permission[]=>engine==='claude-code'?['ask','auto','dontAsk']:['ask','dontAsk'];
export const modeLabel=(mode:Permission):string=>mode==='dontAsk'?"! don't ask":mode;
export const effortValues=(engine:AgentEngine):readonly string[]=>['CLI default',...EFFORT_LEVELS[engine]];
const none=()=>'';
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
 {name:'/mode',description:'Permissions for the next agent',argumentHint:c=>modeValues(c.engine).map(m=>m==='dontAsk'?"don't ask":m).join('|'),values:c=>modeValues(c.engine).map(m=>m==='dontAsk'?"don't ask":m),current:c=>modeLabel(c.permission??'ask')+(c.engine==='codex'?' · auto unavailable':'')},
 {name:'/resume',description:'Continue the selected finished agent',current:c=>c.selectedTitle??''},
 {name:'/retry',description:'Restart the selected finished agent fresh',current:c=>c.selectedTitle??''},
 {name:'/diff',description:'What an agent changed in its worktree (d on a card); a vs b compares two',argumentHint:()=>'[agent] [vs <agent>]',values:c=>c.agents??[],current:c=>c.selectedTitle??''},
 {name:'/export',description:'Save a session as one HTML file (keys removed)',argumentHint:()=>'[agent] [folder]',current:c=>c.selectedTitle??''},
 {name:'/merge',description:'Merge an agent\'s branch into your checkout (asks first; secret scan)',argumentHint:()=>'[agent] [rebase]',values:c=>c.agents??[],current:c=>c.selectedTitle??''},
 {name:'/pr',description:'Push an agent\'s branch and open a pull request with gh (asks first)',argumentHint:()=>'[agent]',values:c=>c.agents??[],current:c=>c.selectedTitle??''},
 {name:'/fork',description:'The same first message on another model, in its own worktree (spends tokens; asks first)',argumentHint:()=>'[agent] <model>',current:c=>c.selectedTitle??''},
 {name:'/review',description:'One reviewer pass on an agent\'s diff by a keyed model you pick (spends tokens; asks first)',argumentHint:()=>'[agent] [show] | budget <usd>',values:c=>c.agents??[],current:c=>c.selectedTitle??''},
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
];
export const aiSubcommands=['ai','ai --attach <id>','ai --version','ai doctor','ai status-line','ai status-notify <json>','ai agent','ai daemon','ai daemon stop','ai debug stats','ai debug usage','ai debug ls','ai debug shell [cwd]','ai debug attach <id>','ai debug stop <id>','ai debug peek <id>'] as const;
export const debugActions=aiSubcommands.filter(c=>c.startsWith('ai debug ')).map(c=>c.split(' ')[2]??'');
export const keyTable:readonly [string,string][]=[
 ['c','Empty field copies Claude last reply; cleaned session fallback (v0.2)'],['u','Empty field opens usage details by period and provider'],['/find ↑↓ / Enter / Esc','Select a hit / select its agent and scroll the preview to it / close'],['/doctor, /usage ↑↓ / PgUp / PgDn / Esc','Scroll / page / close'],
 ['/skills, /agents ←→ / ↑↓ / Space / Enter / Esc','Tab / item / on-off / read-only full file / close'],
 ['Paste','Over 1 line or 200 chars: [pasted · N lines]; 16 KB first-message limit'],
 ['↑↓','Menu/pickers/settings select rows; otherwise select agent'],['Enter','Pick command; attach selected agent; task opens start box'],['Tab','Complete command, cycle argument values; start box cycles mode'],['p','Empty field toggles preview'],['b','Empty field opens daily/weekly/monthly USD budgets'],['r','Empty field renames selected agent; Enter saves'],['s, then y/n','Stop selected agent with confirmation'],['x','Remove selected exited/failed record; then keep or delete its worktree'],['d','Empty field opens the selected agent\'s diff: ↑↓ files · PgUp/PgDn scroll · m merge · x discard · Esc later'],['Worktree question k / d / Esc / Enter','Keep / delete a clean worktree / keep / keep'],['Worktree question with loss','Type the branch name, then Enter deletes; k, Esc or Enter on an empty field keep'],['/worktrees ↑↓ / Enter / Esc','Select / keep or delete / close'],['Space','Empty field marks/unmarks the selected agent for a split (up to 4)'],['v','Empty field opens marked agents side by side; none marked reopens the last split'],['Split Ctrl+\\','Next pane, or close ended panes; twice within 0.4 s sends Ctrl+\\ to the agent'],['Split click','Focus that pane; mouse goes to its agent'],['PgUp/PgDn/End','Scroll preview; follow live (End: empty field only)'],['Mouse wheel/drag','Scroll preview; copy selection'],['Esc','Close popup, cancel form, drop a field selection, or clear command field'],['Backspace','Delete the selection or before the cursor; a paste token whole'],['Delete','Delete the selection or after the cursor; a paste token whole'],['←/→ · Alt+←/→','Command field: move the cursor by character / word; a paste token is one step'],['Home/End · Ctrl+A/Ctrl+E','Command field: cursor to start / end; End with an empty field follows the preview live'],['Shift+←/→','Command field: extend a selection from the cursor'],['Command field drag','Select text (paste tokens whole); a click places the cursor and clears a selection; never copies'],['Ctrl+U','Clear the command field'],['Alt+Backspace','Delete the previous word or paste token (Ctrl+W too)'],['Ctrl+C twice','Quit client; agents keep running'],['Ctrl+E','Inside a session or split, return home; sessions keep running'],['SIGTERM/SIGHUP/SIGQUIT','Client cleanup; exit 143/129/131'],
 ['Start box ↑↓ / m / c / e / a / p','Select row / model / folder / effort / account / next saved preset; message row edits text'],['Model ←→ / ↑↓ / Enter / Esc','Provider / model / select / back; type searches tabs'],['Folder Tab/Enter','Complete directory / accept folder'],['Effort/mode ↑↓ / Enter / Esc','Choose value / apply / back'],['/login ↑↓ / Enter','Provider/method; masked form advances/saves'],['/settings a/+ / i / l','Add key / import env file / login'],['/settings ↑↓ / Enter / x / t','Select/activate row / remove key / test key'],['/settings d / f / e / Tab / p / n','Save model / folder / effort / theme / Foundry price / notifications on-off'],['Import ↑↓ / Space / Enter','Select name / toggle / import'],['Budget/price ↑↓ / Enter / Esc','Fields / save / cancel'],['Help ↑↓ / PgUp/PgDn / Esc','Scroll / page / close'],
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
