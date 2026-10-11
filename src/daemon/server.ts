import { createServer, createConnection, type Socket, type Server } from 'node:net';
import { lstat, unlink, chmod } from 'node:fs/promises';
import type { Paths } from '../shared/paths.js';
import { isFsError } from '../shared/paths.js';
import { FrameDecoder, encodeControl, encodeData, decodeControl, ProtocolError, PROTOCOL_VERSION, type Request, type SessionEvent } from '../shared/protocol.js';
import { validateRequest } from '../shared/validate.js';
import { SessionManager } from './session-manager.js';
import { Logger } from './log.js';
import packageInfo from '../../package.json' with { type: 'json' };
interface Peer {
    socket: Socket;
    hello: boolean;
    preview: string | null;
    refreshing: boolean;
    lagged: boolean;
    queue: Promise<void>;
    snapshotId?: string;
}
export async function socketAnswers(path: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
        const socket = createConnection(path);
        let settled = false;
        const finish = (alive: boolean) => { if (!settled) {
            settled = true;
            socket.destroy();
            resolve(alive);
        } };
        socket.setTimeout(300, () => finish(true)); // A hung listener still owns the address; never unlink it.
        socket.once('connect', () => finish(true));
        socket.once('error', error => { if (isFsError(error, 'ENOENT') || isFsError(error, 'ECONNREFUSED'))
            finish(false);
        else {
            settled = true;
            socket.destroy();
            reject(error);
        } });
    });
}
export class DaemonServer {
    private server: Server;
    private peers = new Set<Peer>();
    private socketIdentity: {
        ino: number;
        dev: number;
    } | undefined;
    constructor(private readonly paths: Paths, private readonly manager: SessionManager, private readonly log: Logger) {
        this.server = createServer(socket => this.accept(socket));
        this.server.on('error', error => { this.log.error(`Server failed: ${error.message}`); this.manager.emit('fatal', error); });
        manager.on('event', (event: SessionEvent) => { for (const peer of this.peers)
            if (peer.hello)
                this.control(peer, event); });
        manager.on('output', (id: string, data: Buffer) => {
            for (const peer of this.peers) {
                if (peer.preview !== id || peer.refreshing || peer.lagged)
                    continue;
                if (peer.socket.writableLength > 1024 * 1024) {
                    peer.lagged = true;
                    continue;
                }
                peer.socket.write(encodeData(2, id, data));
            }
        });
    }
    clientCount(): number { return this.peers.size; }
    private control(peer: Peer, value: unknown): void {
        if (peer.socket.destroyed)
            return;
        // Control/event consumers cannot keep an unbounded queue either.
        if (peer.socket.writableLength > 2 * 1024 * 1024) {
            peer.socket.destroy();
            return;
        }
        peer.socket.write(encodeControl(value));
    }
    async listen(): Promise<void> {
        try {
            const stat = await lstat(this.paths.socket);
            if (!stat.isSocket() || stat.uid !== process.getuid?.())
                throw new Error('Unsafe socket path');
            if (await socketAnswers(this.paths.socket))
                throw new Error('Daemon socket already in use');
            const current = await lstat(this.paths.socket);
            if (current.ino !== stat.ino || current.dev !== stat.dev)
                throw new Error('Socket changed during stale check');
            await unlink(this.paths.socket);
        }
        catch (error) {
            if (!isFsError(error, 'ENOENT'))
                throw error;
        }
        await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.paths.socket, () => { this.server.off('error', reject); resolve(); }); });
        await chmod(this.paths.socket, 0o600);
        const stat = await lstat(this.paths.socket);
        this.socketIdentity = { ino: stat.ino, dev: stat.dev };
    }
    private accept(socket: Socket): void {
        const peer: Peer = { socket, hello: false, preview: null, refreshing: false, lagged: false, queue: Promise.resolve() };
        this.peers.add(peer);
        const decoder = new FrameDecoder();
        let queued = 0;let queuedBytes=0;
        socket.setTimeout(5000, () => { if (!peer.hello)
            socket.destroy(); });
        socket.on('error', error => this.log.error(`Client socket failed: ${error.message}`));
        socket.on('close', () => this.peers.delete(peer));
        socket.on('drain', () => { if (peer.lagged && peer.preview && !peer.refreshing)
            void this.refresh(peer).catch(error => { this.log.error(`Preview refresh failed: ${error instanceof Error ? error.message : 'unknown'}`); socket.destroy(); }); });
        socket.on('data', data => {
            try {
                for (const frame of decoder.push(data)) {
                    if (frame.type !== 1)
                        throw new ProtocolError('UNSUPPORTED_FRAME', 'Input/attach is not implemented');
                    const value = decodeControl(frame);
                    queuedBytes+=frame.payload.length;
                    if (++queued > 128 || queuedBytes > 8*1024*1024)
                        throw new ProtocolError('TOO_MANY_REQUESTS', 'Request queue exceeded');
                    peer.queue = peer.queue.then(async () => { if (!socket.destroyed)
                        await this.handle(peer, value); }).catch(error => { this.log.error(`Request failed: ${error instanceof Error ? error.message : 'unknown'}`); this.control(peer, { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Request failed' } }); }).finally(() => { queued--;queuedBytes-=frame.payload.length; });
                }
            }
            catch (error) {
                this.control(peer, { ok: false, error: { code: error instanceof ProtocolError ? error.code : 'INVALID_FRAME', message: error instanceof ProtocolError ? error.message : 'Invalid frame' } });
                socket.end();
            }
        });
    }
    private async refresh(peer: Peer, requestId?: string): Promise<void> {
        const id = peer.preview;
        if (!id)
            return;
        peer.refreshing = true;
        try {
            await this.manager.snapshot(id, snapshot => {
                if (peer.preview !== id || peer.socket.destroyed)
                    return;
                this.control(peer, { id: requestId ?? peer.snapshotId, ok: true, sessionId: id, snapshot, ...size });
                peer.lagged = false;
                peer.refreshing = false;
            });
        }
        finally {
            peer.refreshing = false;
        }
    }
    private async handle(peer: Peer, value: unknown): Promise<void> {
        let request: Request;
        try {
            request = await validateRequest(value);
        }
        catch (error) {
            const id = value && typeof value === 'object' && 'id' in value && typeof value.id === 'string' ? value.id : undefined;
            this.control(peer, { id, ok: false, error: { code: 'INVALID_REQUEST', message: error instanceof Error ? error.message : 'Invalid request' } });
            return;
        }
        if (request.kind === 'hello') {
            if (request.protocol !== PROTOCOL_VERSION) {
                this.control(peer, { id: request.id, kind: 'helloMismatch', protocol: PROTOCOL_VERSION });
                peer.socket.end();
                return;
            }
            peer.hello = true;
            peer.socket.setTimeout(0);
            this.control(peer, { id: request.id, ok: true, kind: 'hello', protocol: PROTOCOL_VERSION, version: packageInfo.version, pid: process.pid });
            return;
        }
        if (!peer.hello) {
            this.control(peer, { id: request.id, ok: false, error: { code: 'HELLO_REQUIRED', message: 'Send hello first' } });
            return;
        }
        try {
            switch (request.kind) {
                case 'sessions.list':
                    this.control(peer, { id: request.id, ok: true, sessions: this.manager.list() });
                    break;
                case 'sessions.create':
                    this.control(peer, { id: request.id, ok: true, session: await this.manager.create(request) });
                    break;
                case 'sessions.preview':
                    if (request.sessionId !== null)
                        this.manager.get(request.sessionId);
                    peer.preview = request.sessionId;
                    peer.snapshotId = request.id;
                    peer.lagged = false;
                    if (peer.preview) {
                        try{await this.refresh(peer,request.id);}catch(error){peer.preview=null;throw error;}
                    }
                    else
                        this.control(peer, { id: request.id, ok: true, snapshot: '' });
                    break;
                case 'sessions.stop':
                    await this.manager.stop(request.sessionId);
                    this.control(peer, { id: request.id, ok: true });
                    break;
                case 'sessions.remove':
                    await this.manager.remove(request.sessionId);
                    for (const p of this.peers)
                        if (p.preview === request.sessionId)
                            p.preview = null;
                    this.control(peer, { id: request.id, ok: true });
                    break;
                case 'sessions.rename':
                    this.control(peer, { id: request.id, ok: true, session: await this.manager.rename(request.sessionId, request.title) });
                    break;
                case 'layout.previewSize':
                    await this.manager.previewSize(request.cols, request.rows);
                    this.control(peer, { id: request.id, ok: true });
                    break;
            }
        }
        catch (error) {
            this.log.error(`Operation failed: ${error instanceof Error ? error.message : 'unknown'}`);
            this.control(peer, { id: request.id, ok: false, error: { code: 'OPERATION_FAILED', message: 'Session operation failed' } });
        }
    }
    async close(): Promise<void> {
        for (const peer of this.peers)
            peer.socket.destroy();
        if (this.server.listening)
            await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
        try {
            const stat = await lstat(this.paths.socket);
            if (stat.ino === this.socketIdentity?.ino && stat.dev === this.socketIdentity.dev)
                await unlink(this.paths.socket);
        }
        catch (error) {
            if (!isFsError(error, 'ENOENT'))
                throw error;
        }
    }
}
