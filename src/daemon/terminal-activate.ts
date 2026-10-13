import { execFile } from 'node:child_process';
import type { TerminalBundle } from '../shared/protocol.js';
import { isTerminalBundle } from '../shared/validate.js';
export type ActivationRunner = (executable: string, args: string[], options: {env:Record<string,string>;timeout:number}) => Promise<void>;
const launch: ActivationRunner = (executable,args,options) => new Promise((resolve,reject) => {
    execFile(executable,args,options,error=>error?reject(new Error('Terminal activation failed')):resolve());
});
export async function activateTerminal(bundle: TerminalBundle, runner: ActivationRunner = launch): Promise<void> {
    if(!isTerminalBundle(bundle))throw new Error('Invalid terminal app');
    await runner('/usr/bin/open',['-b',bundle],{env:{PATH:'/usr/bin:/bin'},timeout:5000});
}
