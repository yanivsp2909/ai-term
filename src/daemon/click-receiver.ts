import { createServer, type Server, type Socket } from 'node:net';
import type { SessionInfo } from '../shared/protocol.js';
import { listenPrivate, closePrivate, type SocketIdentity } from './private-socket.js';
// The notifier helper's click route: ~/.ai-term/run/click.sock, a fixed path because a cold click relaunches the helper
// without argv. It carries one line, {"clicked":"<uuid>"}, and can only select or open an agent: never send text to it.
export const CLICK_SOCKET = 'click.sock';
const MAX_CLICK_BYTES = 128, READ_DEADLINE_MS = 1000, ACTION_GAP_MS = 1000, MAX_CONNECTIONS = 4;
const CLICK_LINE = /^\{"clicked":"([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})"\}\n$/;
export interface ClickRoutes {
    session(id: string): SessionInfo | null;
    hasClient(): boolean;
    select(id: string): void;
    openTerminal(id: string): Promise<void>;
}
// Exactly the helper's bytes: one line, strict JSON with the single key, a lowercase UUID. Anything else is null.
export function parseClick(bytes: Buffer): string | null {
    if (bytes.length > MAX_CLICK_BYTES) return null;
    const text = bytes.toString('utf8'), id = text.match(CLICK_LINE)?.[1];
    if (!id) return null;
    let value: unknown;
    try { value = JSON.parse(text.slice(0, -1)); } catch { return null; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const keys = Object.keys(value);
    return keys.length === 1 && keys[0] === 'clicked' && 'clicked' in value && value.clicked === id ? id : null;
}
export class ClickReceiver {
    private readonly server: Server;
    private identity: SocketIdentity | undefined;
    private lastAction = -Infinity;
    private limitLogged = false;
    constructor(private readonly path: string, private readonly routes: ClickRoutes, private readonly log: { info(text: string): void; error(text: string): void }, private readonly now: () => number = Date.now) {
        this.server = createServer(socket => this.accept(socket));
        this.server.maxConnections = MAX_CONNECTIONS;
        this.server.on('error', () => this.log.error('Notification click socket failed'));
    }
    async listen(): Promise<void> { this.identity = await listenPrivate(this.server, this.path); }
    async close(): Promise<void> { await closePrivate(this.server, this.path, this.identity); }
    private accept(socket: Socket): void {
        const chunks: Buffer[] = [];
        let size = 0, finished = false;
        const finish = (id: string | null) => {
            if (finished) return;
            finished = true; socket.destroy();
            if (id === null) this.log.info('Notification click rejected'); else this.route(id);
        };
        socket.setTimeout(READ_DEADLINE_MS, () => finish(null));
        socket.on('error', () => finish(null));
        socket.on('data', (data: Buffer) => {
            size += data.length;
            if (size > MAX_CLICK_BYTES) { finish(null); return; }
            chunks.push(data);
            const bytes = Buffer.concat(chunks), newline = bytes.indexOf(0x0a);
            // One line only: the newline must be the last byte received.
            if (newline >= 0) finish(newline === bytes.length - 1 ? parseClick(bytes) : null);
        });
        socket.on('end', () => finish(parseClick(Buffer.concat(chunks))));
    }
    private route(id: string): void {
        const session = this.routes.session(id);
        if (!session) { this.log.info('Notification click for unknown agent dropped'); return; }
        if (session.status === 'exited' || session.status === 'error') { this.log.info('Notification click for finished agent dropped'); return; }
        const now = this.now();
        if (now - this.lastAction < ACTION_GAP_MS) { if (!this.limitLogged) this.log.info('Notification click rate limited'); this.limitLogged = true; return; }
        this.lastAction = now; this.limitLogged = false;
        if (this.routes.hasClient()) { this.routes.select(id); return; }
        void this.routes.openTerminal(id).catch(() => this.log.error('Notification click could not open Terminal'));
    }
}
