import type {AgentEngine,Effort,Permission,ThemeName} from '../../shared/protocol.js';
import {EFFORT_LEVELS} from '../../shared/validate.js';
export interface CommandContext {engine:AgentEngine;model:string|null;cwd:string;theme:ThemeName;effort?:Effort|null;permission?:Permission;selectedTitle?:string}
export interface Command {name:string;description:string;argumentHint?:(context:CommandContext)=>string;values?:(context:CommandContext)=>readonly string[];current:(context:CommandContext)=>string}
export const modeValues=(engine:AgentEngine):readonly Permission[]=>engine==='claude-code'?['ask','auto','dontAsk']:['ask','dontAsk'];
export const modeLabel=(mode:Permission):string=>mode==='dontAsk'?"! don't ask":mode;
export const effortValues=(engine:AgentEngine):readonly string[]=>['CLI default',...EFFORT_LEVELS[engine]];
const none=()=>'';
export const commandRegistry:readonly Command[]=[
 {name:'/model',description:'Choose model and provider',current:c=>`${c.model??'CLI default'} · ${c.engine==='codex'?'codex':'claude code'}`},
 {name:'/cd',description:'Choose the next agent folder',current:c=>c.cwd},
 {name:'/settings',description:'Keys and saved defaults',current:none},
 {name:'/login',description:'Connect an engine or API key',current:none},
 {name:'/effort',description:'Reasoning for the next agent',argumentHint:c=>effortValues(c.engine).join('|'),values:c=>effortValues(c.engine),current:c=>c.effort??'CLI default'},
 {name:'/mode',description:'Permissions for the next agent',argumentHint:c=>modeValues(c.engine).map(m=>m==='dontAsk'?"don't ask":m).join('|'),values:c=>modeValues(c.engine).map(m=>m==='dontAsk'?"don't ask":m),current:c=>modeLabel(c.permission??'ask')+(c.engine==='codex'?' · auto unavailable':'')},
 {name:'/resume',description:'Continue the selected finished agent',current:c=>c.selectedTitle??''},
 {name:'/shell',description:'Start a plain login shell',current:c=>c.cwd},
 {name:'/clean',description:'Remove finished records after confirmation',current:none},
 {name:'/copy',description:'Copy Claude last reply; cleaned session fallback',argumentHint:()=> '[all]',values:()=>['all'],current:c=>c.selectedTitle??''},
 {name:'/help',description:'Commands and keyboard help',current:none},
 {name:'/theme',description:'Choose the saved theme',argumentHint:()=> 'graphite|slate|ink|auto|light',values:()=>['graphite','slate','ink','auto','light'],current:c=>c.theme},
 {name:'/exit',description:'Quit AI Term; agents keep running',current:none},
];
export const aiSubcommands=['ai','ai --version','ai doctor','ai status-line','ai status-notify <json>','ai daemon','ai daemon stop','ai debug stats','ai debug usage','ai debug ls','ai debug shell [cwd]','ai debug attach <id>','ai debug stop <id>','ai debug peek <id>'] as const;
export const debugActions=aiSubcommands.filter(c=>c.startsWith('ai debug ')).map(c=>c.split(' ')[2]??'');
export const keyTable:readonly [string,string][]=[
 ['c','Empty field copies Claude last reply; cleaned session fallback (v0.2)'],
 ['Paste','Over 1 line or 200 chars: [pasted · N lines]; 16 KB first-message limit'],
 ['↑↓','Menu/pickers/settings select rows; otherwise select agent'],['Enter','Pick command; attach selected agent; task opens start box'],['Tab','Complete command, cycle argument values; start box cycles mode'],['p','Empty field toggles preview'],['b','Empty field opens daily/weekly/monthly USD budgets'],['r','Empty field renames selected agent; Enter saves'],['s, then y/n','Stop selected agent with confirmation'],['x','Remove selected exited/failed record'],['PgUp/PgDn/End','Scroll preview; follow live'],['Mouse wheel/drag','Scroll preview; copy selection'],['Esc','Close popup, cancel form, or clear command field'],['Backspace','Edit current field; delete a paste token whole'],['Ctrl+C twice','Quit client; agents keep running'],['Ctrl+E','Inside session, return home; session keeps running'],['SIGTERM/SIGHUP/SIGQUIT','Client cleanup; exit 143/129/131'],
 ['Start box ↑↓ / m / c / e','Select row / model / folder / effort; message row edits text'],['Model ←→ / ↑↓ / Enter / Esc','Provider / model / select / back; type searches tabs'],['Folder Tab/Enter','Complete directory / accept folder'],['Effort/mode ↑↓ / Enter / Esc','Choose value / apply / back'],['/login ↑↓ / Enter','Provider/method; masked form advances/saves'],['/settings a/+ / i / l','Add key / import env file / login'],['/settings ↑↓ / Enter / x / t','Select/activate row / remove key / test key'],['/settings d / f / e / Tab / p','Save model / folder / effort / theme / Foundry price'],['Import ↑↓ / Space / Enter','Select name / toggle / import'],['Budget/price ↑↓ / Enter / Esc','Fields / save / cancel'],['Help ↑↓ / PgUp/PgDn / Esc','Scroll / page / close'],
];
export function commandRows(text:string,context:CommandContext){const prefix=text.split(' ')[0]??'';return commandRegistry.filter(c=>c.name.startsWith(prefix)).map(c=>({name:c.name,description:c.description,hint:c.argumentHint?.(context)??'',value:c.current(context)}));}
export function completeCommand(text:string,highlight:number,context:CommandContext):string{
 const space=text.indexOf(' '),name=space<0?text:text.slice(0,space),command=space<0?commandRegistry.find(c=>c.name===commandRows(text,context)[highlight]?.name):commandRegistry.find(c=>c.name===name);if(!command)return text;
 if(space<0)return command.name+(command.argumentHint?' ':'');const values=command.values?.(context);if(!values?.length)return text;const current=text.slice(space+1),index=values.indexOf(current);return command.name+' '+(values[(index+1)%values.length]??values[0]);
}
export function helpLines(context:CommandContext):string[]{return ['COMMANDS',...commandRows('/',context).map(c=>`${c.name}${c.hint?' '+c.hint:''} · ${c.description}`),'/copy all · Copy cleaned whole session','', 'KEYBOARD',...keyTable.map(([key,description])=>`${key} · ${description}`),'','AI SUBCOMMANDS',...aiSubcommands];}
