import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {debugUsage} from '../src/cli/debug-usage.js';
it('diagnostic prints only receiver port and candidate numeric attribute names values',async()=>{
 const output:string[]=[];await debugUsage({request:async()=>({id:randomUUID(),ok:true,usageDiagnostics:{port:1234,sessions:[{sessionId:randomUUID(),at:new Date().toISOString(),values:[{name:'input_token_count',value:1000}]}]}})},line=>{output.push(line);});expect(output[0]).toBe('receiver port 1234\n');expect(output.join('')).toContain('input_token_count=1000');expect(output.join('')).not.toMatch(/credential|headers|body/);
});
it('invalid diagnostic strings never reach stdout',async()=>{
 const output:string[]=[];await expect(debugUsage({request:async()=>({id:randomUUID(),ok:true,usageDiagnostics:{port:1234,sessions:[{sessionId:randomUUID(),at:new Date().toISOString(),values:[{name:'user.email',value:'AITERMCANARY fake@example.com'}]}]}} as never)},line=>{output.push(line);})).rejects.toThrow();expect(output).toEqual([]);
});
