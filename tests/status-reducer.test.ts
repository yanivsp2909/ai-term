import {expect,it} from 'vitest';
import {reduceStatus,initialStatus} from '../src/daemon/status-reducer.js';
import {parseClaudeStatus} from '../src/daemon/claude-status.js';
const at='2026-10-13T00:00:00.000Z';
it('reduces running, permission, tool activity, done, questions and failed turns in order',()=>{
 const start=initialStatus(at);const running=reduceStatus(start,{seq:1,at,kind:'running',tool:'Bash',phase:'tool-start'});
 expect(start.status).toBe('starting');expect(running).toMatchObject({status:'running',lastActivity:{tool:'Bash',at}});
 const waiting=reduceStatus(running,{seq:2,at,kind:'waiting',reason:'permission'});expect(waiting.statusDetail).toBe('permission');
 const approved=reduceStatus(waiting,{seq:3,at,kind:'running',tool:'Bash',phase:'tool-finish'});expect(approved.status).toBe('running');
 const backup=reduceStatus(approved,{seq:4,at,kind:'waiting',reason:'permission',backup:true});expect(backup.status).toBe('running');
 const done=reduceStatus(backup,{seq:5,at,kind:'done'});expect(done.status).toBe('done');
 expect(reduceStatus(done,{seq:6,at,kind:'waiting',reason:'question'})).toMatchObject({status:'waiting',statusDetail:'question'});
 expect(reduceStatus(done,{seq:6,at,kind:'waiting',reason:'turn failed',error:'rate_limit'})).toMatchObject({status:'waiting',statusDetail:'turn failed: rate_limit'});
 expect(reduceStatus(done,{seq:6,at,kind:'context',percent:30})).toMatchObject({status:'done',ctxPercent:30});
 expect(reduceStatus(done,{seq:4,at,kind:'running'})).toBe(done);
});
it('process exit always wins even with an older seq, and all later events are ignored',()=>{
 const running=reduceStatus(initialStatus(at),{seq:50,at,kind:'running'});
 const exited=reduceStatus(running,{seq:2,at,kind:'exit',status:'exited',detail:'exit 0',exitCode:0});
 expect(exited).toMatchObject({status:'exited',exitCode:0});
 for(const event of [{kind:'running'},{kind:'done'},{kind:'context',percent:50},{kind:'waiting',reason:'question'}]as const)expect(reduceStatus(exited,{seq:100,at,...event})).toBe(exited);
});
it.each([
 ['UserPromptSubmit','running'],['PreToolUse','running'],['PostToolUse','running'],['PostToolUseFailure','running'],['PermissionRequest','waiting'],['Stop','done'],['StopFailure','waiting']
])('maps %s without carrying unrelated fields', (hook,kind)=>{
 const update=parseClaudeStatus({hook_event_name:hook,tool_name:'Bash',tool_input:{canary:'AITERMCANARY'},error:'AITERMCANARY',sessionId:'forged',seq:999},1,at);
 expect(update?.event).toMatchObject({kind,seq:1});expect(JSON.stringify(update)).not.toContain('AITERMCANARY');expect(JSON.stringify(update)).not.toContain('forged');
});
it('drops unknown hooks and maps only supported notifications and valid context',()=>{
 expect(parseClaudeStatus({hook_event_name:'SessionEnd'},1,at)).toBeNull();expect(parseClaudeStatus({hook_event_name:'unknown'},1,at)).toBeNull();
 for(const type of ['elicitation_dialog','elicitation_url_dialog','agent_needs_input'])expect(parseClaudeStatus({hook_event_name:'Notification',notification_type:type},1,at)?.event).toMatchObject({reason:'question'});
 expect(parseClaudeStatus({hook_event_name:'Notification',notification_type:'idle_prompt'},1,at)).toBeNull();
 expect(parseClaudeStatus({hook_event_name:'Notification',notification_type:'permission_prompt'},1,at)?.event).toMatchObject({reason:'permission',backup:true});
 expect(parseClaudeStatus({hook_event_name:'AITermContext',used_percentage:12.5},1,at)?.event).toMatchObject({kind:'context',percent:12.5});
 for(const percent of [-1,101,'4',NaN])expect(parseClaudeStatus({hook_event_name:'AITermContext',used_percentage:percent},1,at)).toBeNull();
});
it('Stop retains a bounded reply only separately from status; tool/error metadata stays safe',()=>{
 const result=parseClaudeStatus({hook_event_name:'Stop',last_assistant_message:'AITERMCANARY'+'界'.repeat(100000)},1,at);
 expect(Buffer.byteLength(result?.reply??'')).toBeLessThanOrEqual(256*1024);expect(result?.reply).toMatch(/^AITERMCANARY/);expect(result?.reply).not.toContain('�');expect(JSON.stringify(result?.event)).not.toContain('AITERMCANARY');
 expect(parseClaudeStatus({hook_event_name:'PreToolUse',tool_name:'\x1b[31mAITERMCANARY'},1,at)?.event).not.toHaveProperty('tool');
 expect(parseClaudeStatus({hook_event_name:'StopFailure',error:'unknown'},1,at)?.event).toMatchObject({error:'unknown'});
});
