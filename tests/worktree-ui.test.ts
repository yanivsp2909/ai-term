import { expect,it,vi } from 'vitest';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {CredentialsPanel} from '../src/client/tui/credentials.js';
import {Homepage} from '../src/client/tui/homepage.js';
import {cardText} from '../src/client/tui/agent-card.js';
import {frameBar} from '../src/client/tui/frame-bar.js';
import {drawAgentBox} from '../src/client/tui/agent-box.js';
import {Grid} from '../src/client/tui/grid.js';
import {createTheme} from '../src/client/tui/theme.js';
import type {SessionInfo,Settings,SuccessResponse} from '../src/shared/protocol.js';
import type {RequestBody} from '../src/client/connection.js';
const now=new Date().toISOString(),theme=createTheme('graphite');
const agent:SessionInfo={id:randomUUID(),title:'agent',engine:'codex',model:'gpt',auth:{kind:'account'},cwd:'/tmp',worktree:'/tmp/tree',branch:'ai/agent',permission:'ask',status:'exited',statusDetail:'exit 0',statusSince:now,createdAt:now,lastOutputAt:null,exitCode:0,ctxPercent:null};
const plain=(frame:ReturnType<typeof frameBar>)=>frame.map(row=>row.map(c=>c.char).join('')).join('\n');
it('cards and bars display branch, dropping branch before model and retaining status',()=>{
 expect(cardText(agent,Date.now(),80).model).toBe('gpt · codex · ai/agent');expect(cardText(agent,Date.now(),15).model).toBe('gpt · codex');
 expect(plain(frameBar(130,agent,[],theme))).toContain('codex · gpt · ai/agent');
 const narrow=plain(frameBar(45,agent,[],theme));expect(narrow).toContain('codex · gpt');expect(narrow).not.toContain('ai/agent');expect(narrow).toContain('○ exited');
 expect(cardText({...agent,worktreeNote:'worktree off: not a git repo',worktree:undefined,branch:undefined},Date.now(),80).line3).toBe('worktree off: not a git repo');
});
it('start box displays a quiet worktree and dirty-checkout notice',()=>{
 const frame=new Grid(130,45,theme).cells;
 const box=drawAgentBox(frame,{kind:'start',engine:'codex',model:null,cwd:'/tmp',permission:'ask',message:'task',error:'',checking:false,row:0,filter:'',choices:[],choice:0,path:'',completions:[],worktreePreview:{branch:'ai/codex',head:'a'.repeat(40),dirty:true}},theme);
 expect(plain(box)).toContain('new worktree · ai/codex from aaaaaaa');expect(plain(box)).toContain("uncommitted changes in your checkout aren't included");
});
it('settings default on and keyboard/Enter toggle saved worktrees',async()=>{
 let settings:Settings={theme:'graphite'};
 const panel=new CredentialsPanel('settings',{request:async body=>{if(body.kind==='settings.set')settings={...settings,...body.patch};return {id:randomUUID(),ok:true,settings};},changed(){},close(){},login:async()=>{},defaults(){},theme:async()=>{}});
 await panel.load();expect(panel.lines().join('\n')).toContain('worktrees: on (w)');await panel.key('w');expect(settings.worktrees).toBe('off');
 for(let i=0;i<10;i++)await panel.key('down');await panel.key('enter');expect(settings.worktrees).toBe('on');
});
class TTY extends EventEmitter {isTTY=true;isRaw=false;columns=130;rows=45;output='';setRawMode(v:boolean){this.isRaw=v;}resume(){}pause(){}write(data:string|Buffer){this.output+=data.toString();return true;}}
class Client extends EventEmitter {
 requests:RequestBody[]=[];
 async request(body:RequestBody):Promise<SuccessResponse>{this.requests.push(body);const response:SuccessResponse={id:randomUUID(),ok:true};
 if(body.kind==='settings.get')response.settings={theme:'graphite'};
 if(body.kind==='sessions.list')response.sessions=[agent];
 if(body.kind==='engines.status')response.engines={claudeCode:{installed:true,path:'/stub',version:'1',loggedIn:true,authMethod:'subscription'},codex:{installed:true,path:'/stub',version:'1',loggedIn:true,authMethod:'subscription'}};
 if(body.kind==='sessions.preview'){response.snapshot='';response.cols=85;response.rows=30;}
 if(body.kind==='worktrees.preview')response.worktreePreview={branch:'ai/claude-code',head:'a'.repeat(40),dirty:true};
 if(body.kind==='sessions.remove'){this.emit('event',{kind:'session.removed',sessionId:agent.id});response.keptWorktree=agent.worktree;}
 return response;
 }
}
it('start preview requests current folder and removal shows the kept path exactly once',async()=>{
 const tty=new TTY(),client=new Client(),home=new Homepage(client,{stdin:tty,stdout:tty,signals:new EventEmitter(),cwd:'/tmp',terminalProgram:'unknown'});await home.start();
 try{tty.emit('data',Buffer.from('x'));await vi.waitFor(()=>expect(tty.output).toContain('worktree kept: /tmp/tree'));expect(client.requests.filter(r=>r.kind==='sessions.remove')).toHaveLength(1);
 tty.emit('data',Buffer.from('task\r'));await vi.waitFor(()=>expect(client.requests).toContainEqual({kind:'worktrees.preview',cwd:'/tmp',title:'Claude Code'}));expect(tty.output).toContain('new worktree · ai/claude-code');
 }finally{await home.stop();}
});
