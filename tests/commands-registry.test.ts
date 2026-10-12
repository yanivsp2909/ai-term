import {expect,it} from 'vitest';
import {readFile} from 'node:fs/promises';
import {commandRegistry,aiSubcommands,completeCommand,commandRows,helpLines} from '../src/client/tui/commands.js';
const context={engine:'claude-code' as const,model:'opus',cwd:'/tmp/work',theme:'graphite' as const,effort:'high' as const,permission:'ask' as const};
it('one registry supplies menu descriptions values hints completion and help',()=>{
 expect(commandRegistry.map(c=>c.name)).toContain('/resume');const rows=commandRows('/',context);expect(rows.find(c=>c.name==='/model')).toMatchObject({value:'opus · claude code'});expect(rows.find(c=>c.name==='/effort')?.hint).toContain('max');expect(rows.find(c=>c.name==='/mode')?.hint).toContain('auto');expect(commandRows('/mode',{...context,engine:'codex'}).find(c=>c.name==='/mode')?.hint).not.toContain('auto');
 expect(completeCommand('/ef',0,context)).toBe('/effort ');expect(completeCommand('/effort ',0,context)).toBe('/effort CLI default');expect(completeCommand('/effort CLI default',0,context)).toBe('/effort low');expect(completeCommand('/mode ask',0,context)).toBe('/mode auto');expect(completeCommand('/mode ask',0,{...context,engine:'codex'})).toBe("/mode don't ask");expect(helpLines(context).join('\n')).toContain('/clean');expect(helpLines(context).join('\n')).toContain('Ctrl+E');
});
it('README lists every registry command and ai subcommand',async()=>{const readme=await readFile(new URL('../README.md',import.meta.url),'utf8');for(const c of commandRegistry)expect(readme).toContain('`'+c.name);for(const command of aiSubcommands)expect(readme).toContain('`'+command);});
