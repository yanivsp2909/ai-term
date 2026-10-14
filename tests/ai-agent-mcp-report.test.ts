import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { HttpReporter } from '../src/agent/report.js';
const state=vi.hoisted(()=>({paths:[] as string[],requests:[] as {kind?:string}[]}));
vi.mock('node:http',()=>({request:(options:{path:string},callback:(res:EventEmitter&{statusCode:number;resume():void})=>void)=>{
 state.paths.push(options.path);const req=new EventEmitter();return Object.assign(req,{end(text:string){const body=JSON.parse(text) as {kind?:string};state.requests.push(body);if(body.kind==='mcp.call')return;queueMicrotask(()=>{const res=Object.assign(new EventEmitter(),{statusCode:200,resume(){}});callback(res);res.emit('data',Buffer.from('{}'));res.emit('end');req.emit('close');});},destroy(){req.emit('close');}});
}}));
it('a slow MCP request cannot block status or the separate abort request',async()=>{
 const reporter=new HttpReporter({port:12345,status:'a'.repeat(64)},vi.fn()),controller=new AbortController();const pending=reporter.mcp.call('/tmp','0'.repeat(16),'1'.repeat(64),'slow',{},controller.signal).catch(()=>null);
 await reporter.status({event:'permission'});expect(state.paths).toContain('/v1/status/ai-term');controller.abort();expect(await pending).toBeNull();await vi.waitFor(()=>expect(state.requests.some(r=>r.kind==='mcp.cancel')).toBe(true));await reporter.mcp.stop();expect(state.requests.some(r=>r.kind==='mcp.stop')).toBe(true);
});
