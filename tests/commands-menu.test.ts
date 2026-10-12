import {expect,it} from 'vitest';
import {renderHomepage} from '../src/client/tui/layout.js';
import {createTheme} from '../src/client/tui/theme.js';
import {plainText} from '../src/client/tui/grid.js';
it('menu shows registry descriptions current values and hints with selected-card highlight',()=>{
 const theme=createTheme('graphite'),frame=renderHomepage({cols:130,rows:45,sessions:[],selectedId:null,input:'/',note:'session exited',previewVisible:true,cwd:'/tmp/x',engine:'claude-code',model:'opus',effort:'high',permission:'auto',now:0}as never,theme),text=plainText(frame);for(const value of ['Reasoning for the next agent','high','Choose model and provider','opus · claude code','/clean','graphite|slate|ink|auto|light'])expect(text).toContain(value);expect(text).not.toContain('session exited');const row=frame.find(r=>r.some(c=>c.char==='▎'));expect(row?.[1]?.bg).toBe(theme.colors['surface-2']);
});
it('short terminals keep the highlighted command visible and defaults display actual effort and mode',()=>{
 const frame=renderHomepage({cols:100,rows:20,sessions:[],selectedId:null,input:'/',note:'',previewVisible:true,cwd:'/tmp',engine:'codex',model:'test',effort:'xhigh',permission:'dontAsk',menuChoice:11,now:0}as never,createTheme('graphite'));expect(plainText(frame)).toContain('/exit');expect(plainText(frame)).toContain('xhigh');expect(plainText(frame)).toContain("! don't ask");
});
