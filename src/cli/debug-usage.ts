import type {SuccessResponse} from '../shared/protocol.js';
import type {RequestBody} from '../client/connection.js';
import {validateUsageDiagnostics} from '../shared/validate.js';
export async function debugUsage(client:{request(body:RequestBody):Promise<SuccessResponse>},write=(text:string)=>{process.stdout.write(text);}):Promise<void>{
 const result=await client.request({kind:'usage.diagnostics'}),diagnostics=validateUsageDiagnostics(result.usageDiagnostics);
 write(`receiver port ${diagnostics.port}\n`);
 for(const entry of diagnostics.sessions)write(`${entry.sessionId} ${entry.at} ${entry.values.map(v=>`${v.name}=${v.value}`).join(' ')}\n`);
}
