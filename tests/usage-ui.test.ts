import {expect,it} from 'vitest';
import {renderHomepage} from '../src/client/tui/layout.js';
import {plainText} from '../src/client/tui/grid.js';
import {createTheme} from '../src/client/tui/theme.js';
import {BudgetForm,PriceForm} from '../src/client/tui/usage-forms.js';
import {CredentialsPanel} from '../src/client/tui/credentials.js';
import {randomUUID} from 'node:crypto';
const period={costUsd:2.76,tokens:1900000,unknownPrice:false,providers:[]};
it('renders estimated spend compact tokens and budget warning without blocking',()=>{
 const theme=createTheme('graphite');const frame=renderHomepage({cols:130,rows:45,sessions:[],selectedId:null,input:'',note:'',previewVisible:true,cwd:'/tmp',now:0,usage:{today:period,week:period,month:{...period,unknownPrice:true}},budgets:{daily:2,weekly:null,monthly:50}},theme);const text=plainText(frame);expect(text).toContain('≈ spend');expect(text).toContain('$2.76');expect(text).toContain('1.9M');expect(text).toContain('price ?');expect(text).toContain('b add');expect(text).toContain('budget: today');expect(frame[0]?.some(c=>c.fg===theme.colors['status-waiting'])).toBe(true);
});
it('budget form accepts only nonnegative USD limits with empty values meaning none',()=>{
 const form=new BudgetForm({daily:null,weekly:null,monthly:null});form.paste('10');form.key('down');form.paste('-1');expect(()=>form.values()).toThrow();form.key('backspace');form.key('backspace');expect(form.values()).toEqual({daily:10,weekly:null,monthly:null});
});
it('deployment price form validates model id and numeric input output per million',()=>{
 const form=new PriceForm();form.paste('test');form.key('down');form.paste('2');form.key('down');form.paste('10');expect(form.values()).toEqual({model:'test',price:{input:2,output:10}});
 const bad=new PriceForm();bad.paste('-bad');expect(()=>bad.values()).toThrow();
});
it('Usage rendering is confined to its panel at the 100-column breakpoint',()=>{
 const theme=createTheme('graphite'),frame=renderHomepage({cols:100,rows:30,sessions:[],selectedId:null,input:'',note:'',previewVisible:true,cwd:'/tmp',now:0,usage:{today:period,week:period,month:period},budgets:{daily:10,weekly:20,monthly:30}},theme);
 for(const y of [19,20,21,22]){expect(frame[y]?.[61]?.char).toBe('│');expect(frame[y]?.[64]?.char).toBe('│');}
});
it('settings price override is reachable by arrows and Enter as well as p',async()=>{let opened=0;const panel=new CredentialsPanel({request:async()=>({id:randomUUID(),ok:true,keys:[],settings:{theme:'graphite'}}),changed:()=>{},close:()=>{},login:async()=>{},defaults:()=>{},theme:async()=>{},price:()=>{opened++;}});await panel.open('settings');for(let i=0;i<7;i++)await panel.key('down');expect(panel.lines().some(line=>line.startsWith('› ')&&line.includes('price'))).toBe(true);await panel.key('enter');expect(opened).toBe(1);panel.dispose();});
