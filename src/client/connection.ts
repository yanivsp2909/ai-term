import { createConnection, type Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { validateSuccess } from '../shared/validate.js';
import type { Paths } from '../shared/paths.js';
import { preparePaths, isFsError } from '../shared/paths.js';
import { FrameDecoder, encodeControl, encodeData, decodeControl, PROTOCOL_VERSION, MAX_COPY_BYTES, COPY_CHUNK_BYTES, type SessionText, type Request, type SuccessResponse } from '../shared/protocol.js';
import packageInfo from '../../package.json' with { type: 'json' };
export type RequestBody = Request extends infer R ? R extends Request ? Omit<R, 'id'> : never : never;
export class DaemonRequestError extends Error {}
export class Connection extends EventEmitter {
    private pending = new Map<string, {
        resolve: (value: SuccessResponse) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
        textSession?:string;
        copy?:{parts:string[];bytes:number;truncated:boolean};
    }>();
    readonly hello: Promise<SuccessResponse>;
    private constructor(readonly socket: Socket) {
        super();
        const decoder = new FrameDecoder();
        socket.on('error', error => this.fail(error));
        socket.on('close', () => {this.fail(new Error('Daemon connection closed'));this.emit('disconnected');});
        socket.on('data', data => {
            try {
                for (const frame of decoder.push(data)) {
                    if(frame.type===3)throw new Error('Unexpected daemon input frame');
                    if (frame.type === 2) {
                        this.emit('output', frame.payload.subarray(0, 36).toString('ascii'), frame.payload.subarray(36));
                        continue;
                    }
                    const value = decodeControl(frame);
                    if (!value || typeof value !== 'object')
                        throw new Error('Invalid daemon response');
                    const v = value as Record<string, unknown>;
                    const pending = typeof v.id === 'string' ? this.pending.get(v.id) : undefined;
                    if (pending && typeof v.id === 'string') {
                        if(v.ok===true)validateSuccess(value);
                        else if(v.kind!=='helloMismatch'&&(v.ok!==false||!v.error||typeof v.error!=='object'||!('code' in v.error)||typeof v.error.code!=='string'||!('message' in v.error)||typeof v.error.message!=='string'))throw new Error('Invalid daemon response');
                        if(v.ok===true&&v.copy!==undefined){
                            const copy=validateSuccess(value).copy;if(!copy||copy.sessionId!==pending.textSession||Buffer.byteLength(copy.text)>COPY_CHUNK_BYTES||copy.more===true&&!copy.text)throw new Error('Invalid copy chunk');
                            const combined=pending.copy??{parts:[],bytes:0,truncated:copy.truncated};if(combined.truncated!==copy.truncated)throw new Error('Inconsistent copy chunks');
                            combined.bytes+=Buffer.byteLength(copy.text);if(combined.bytes>MAX_COPY_BYTES||combined.parts.length>=6)throw new Error('Session text exceeds copy limit');combined.parts.push(copy.text);pending.copy=combined;
                            if(copy.more===true)continue;
                            const result=validateSuccess({...v,copy:{sessionId:copy.sessionId,text:combined.parts.join(''),truncated:copy.truncated} satisfies SessionText});
                            clearTimeout(pending.timer);this.pending.delete(v.id);pending.resolve(result);continue;
                        }
                        if(v.ok===true&&pending.textSession)throw new Error('Missing session text');
                        clearTimeout(pending.timer);
                        this.pending.delete(v.id);
                        if (v.kind === 'helloMismatch')
                            pending.reject(new Error('Daemon protocol mismatch; stop it explicitly before restarting'));
                        else if (v.ok === true)
                            pending.resolve(validateSuccess(value));
                        else
                            pending.reject(new DaemonRequestError((v.error as {message:string}).message));
                    }
                    else
                        this.emit('event', value);
                }
            }
            catch (error) {
                this.fail(error instanceof Error ? error : new Error('Invalid daemon frame'));
                socket.destroy();
            }
        });
        this.hello = this.request({ kind: 'hello', protocol: PROTOCOL_VERSION, version: packageInfo.version });
    }
    private fail(error: Error): void { for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(error);
    } this.pending.clear(); }
    request(body: RequestBody): Promise<SuccessResponse> {
        const id = randomUUID();
        return new Promise((resolve, reject) => {
            // Up to forty deployments, each with a Responses and fallback probe (15 s each).
            // Create/resume may run two 5 s engine checks and wait on a Keychain prompt before spawning.
            const timeout=body.kind==='keys.test'?40*30_000+5000:['keys.add','keys.importEnv','sessions.create','sessions.resume'].includes(body.kind)?60_000:5000;
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Daemon request timed out')); }, timeout);
            this.pending.set(id, { resolve, reject, timer, ...(body.kind==='sessions.text'?{textSession:body.sessionId}:{}) });
            this.socket.write(encodeControl({ ...body, id }), error => { if (error) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(error);
            } });
        });
    }
    pauseOutput():void {this.socket.pause();}
    resumeOutput():void {this.socket.resume();}
    input(id:string,data:Buffer):void {this.socket.write(encodeData(3,id,data));}
    close(): void { this.socket.destroy(); }
    static async connect(paths: Paths, options: {
        entry: string;
        autoStart?: boolean;
        readOnly?: boolean;
    }): Promise<Connection> {
        if (!options.readOnly)
            await preparePaths(paths);
        const attempt = async () => {
            const stat = await lstat(paths.socket);
            if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600)
                throw new Error('Unsafe daemon socket');
            return new Promise<Socket>((resolve, reject) => { const socket = createConnection(paths.socket); const timer = setTimeout(() => { socket.destroy(); reject(new Error('Daemon connect timeout')); }, 300); socket.once('error', error => { clearTimeout(timer); reject(error); }); socket.once('connect', () => { clearTimeout(timer); resolve(socket); }); });
        };
        let socket: Socket;
        try {
            socket = await attempt();
        }
        catch (error) {
            if (!isFsError(error, 'ENOENT') && !isFsError(error, 'ECONNREFUSED'))
                throw error;
            if (options.autoStart === false)
                throw error;
            let startupError: Error | undefined;
            const file = await open(paths.log, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
            try {
                const stat = await file.stat();
                if (!stat.isFile() || stat.uid !== process.getuid?.())
                    throw new Error('Unsafe daemon log', { cause: error });
                await file.chmod(0o600);
                const args = options.entry.endsWith('.ts') ? ['--import', 'tsx', options.entry, 'daemon'] : [options.entry, 'daemon'];
                const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', env: { ...process.env, AI_TERM_HOME: paths.root } });
                child.on('error', error => { startupError = error; });
                child.unref();
            }
            finally {
                await file.close();
            }
            const deadline = Date.now() + 3000;
            while (true) {
                if (startupError)
                    throw startupError;
                try {
                    socket = await attempt();
                    break;
                }
                catch (retryError) {
                    if (!isFsError(retryError, 'ENOENT') && !isFsError(retryError, 'ECONNREFUSED'))
                        throw retryError;
                }
                if (Date.now() >= deadline)
                    throw new Error(`Daemon did not start within 3 s; see ${paths.log}`, { cause: error });
                await new Promise(r => setTimeout(r, 50));
            }
        }
        const connection = new Connection(socket);
        try {
            const hello=await connection.hello;if(hello.kind!=='hello')throw new Error('Expected daemon hello');
            return connection;
        }
        catch (error) {
            connection.close();
            throw error;
        }
    }
}
