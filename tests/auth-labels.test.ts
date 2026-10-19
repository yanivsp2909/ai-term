import { expect,it } from 'vitest';
import { modelChoices, ownLoginLabel } from '../src/shared/models.js';
import {renderHomepage} from '../src/client/tui/layout.js';
import {plainText} from '../src/client/tui/grid.js';
import {createTheme} from '../src/client/tui/theme.js';
import type {SessionInfo} from '../src/shared/protocol.js';
import {randomUUID} from 'node:crypto';
it('own login labels use only the known engine auth method',()=>{
 expect(ownLoginLabel('subscription')).toBe('own login · sub');expect(ownLoginLabel('api-key')).toBe('own login · API key');expect(ownLoginLabel('unknown')).toBe('own login');expect(ownLoginLabel(undefined)).toBe('own login');
 const engines={claudeCode:{installed:true,path:'/stub',version:'1',loggedIn:true,authMethod:'subscription' as const},codex:{installed:true,path:'/stub',version:'1',loggedIn:true,authMethod:'api-key' as const}};
 const rows=modelChoices([],engines);expect(rows.find(c=>c.engine==='codex')?.authLabel).toBe('own login · API key');expect(rows.find(c=>c.engine==='claude-code')?.authLabel).toBe('own login · sub');
});
it('cards and next-agent defaults explicitly show own login auth or last4 only',()=>{
 const now=new Date().toISOString();const session:SessionInfo={id:randomUUID(),title:'Codex',engine:'codex',model:'gpt-6.1-sol',auth:{kind:'account'},authMethod:'api-key',cwd:'/tmp',permission:'ask',status:'running',statusDetail:'running',statusSince:now,createdAt:now,lastOutputAt:null,exitCode:null,ctxPercent:null};
 const text=plainText(renderHomepage({cols:130,rows:45,sessions:[session],selectedId:session.id,input:'',note:'',previewVisible:true,cwd:'/tmp',now:0,engine:'codex',model:'gpt-6.1-sol',authLabel:'own login · API key'},createTheme('graphite')));
 expect(text.split('\n').slice(2,5).join('\n')).toContain('own login · API key');expect(text.split('\n').at(-1)).toContain('· own login · API key');
});
it('long auth labels do not overwrite model text or hide the dontAsk marker',()=>{
 const now=new Date().toISOString();const session:SessionInfo={id:randomUUID(),title:'Codex',engine:'codex',model:null,auth:{kind:'account'},authMethod:'api-key',cwd:'/tmp',permission:'dontAsk',status:'running',statusDetail:'running',statusSince:now,createdAt:now,lastOutputAt:null,exitCode:null,ctxPercent:null};
 const frame=renderHomepage({cols:130,rows:45,sessions:[session],selectedId:session.id,input:'',note:'',previewVisible:true,cwd:'/tmp',now:0},createTheme('graphite'));const text=plainText(frame);
 expect(text.split('\n')[3]).toContain('CLI default · codex');expect(text.split('\n')[4]).toContain('own login · API key');expect(text).toContain("! don't ask");expect(frame[2]?.some(c=>c.char==='!'&&c.fg===createTheme('graphite').colors['status-error'])).toBe(true);
});
it('next-agent auth stays visible even when the folder is long',()=>{
 const text=plainText(renderHomepage({cols:100,rows:30,sessions:[],selectedId:null,input:'',note:'',previewVisible:true,cwd:'/tmp/'+ 'folder'.repeat(30),now:0,engine:'codex',model:'gpt-6.1-sol',authLabel:'key ····WXYZ'},createTheme('graphite')));
 expect(text.split('\n').at(-1)).toContain('key ····WXYZ');
});
it('finished own-login cards retain a status word alongside explicit auth',()=>{
 const now=new Date().toISOString();const session:SessionInfo={id:randomUUID(),title:'Codex',engine:'codex',model:'gpt-6.1-sol',auth:{kind:'account'},authMethod:'api-key',cwd:'/tmp',permission:'ask',status:'exited',statusDetail:'exit 0',statusSince:now,createdAt:now,lastOutputAt:null,exitCode:0,ctxPercent:null};
 const text=plainText(renderHomepage({cols:130,rows:45,sessions:[session],selectedId:session.id,input:'',note:'',previewVisible:true,cwd:'/tmp',now:0},createTheme('graphite')));
 expect(text.split('\n').slice(2,5).join('\n')).toContain('exited');expect(text).toContain('own login · API key');
});
it('long custom model IDs are clipped before the required next-agent auth label',()=>{
 const text=plainText(renderHomepage({cols:100,rows:30,sessions:[],selectedId:null,input:'',note:'',previewVisible:true,cwd:'/tmp',now:0,engine:'codex',model:'m'.repeat(80),authLabel:'own login · API key'},createTheme('graphite')));
 expect(text.split('\n').at(-1)).toContain('own login · API key');
});
