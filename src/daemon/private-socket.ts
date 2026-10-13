import { createConnection, type Server } from 'node:net';
import { lstat, unlink, chmod, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { isFsError } from '../shared/paths.js';
export interface SocketIdentity { ino: number; dev: number }
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
// Binds a user-only Unix socket at path. A stale socket of ours is replaced; a live one or anything else there is refused.
export async function listenPrivate(server: Server, path: string): Promise<SocketIdentity> {
    try {
        const stat = await lstat(path);
        if (!stat.isSocket() || stat.uid !== process.getuid?.())
            throw new Error('Unsafe socket path');
        if (await socketAnswers(path))
            throw new Error('Daemon socket already in use');
        const current = await lstat(path);
        if (current.ino !== stat.ino || current.dev !== stat.dev)
            throw new Error('Socket changed during stale check');
        await unlink(path);
    }
    catch (error) {
        if (!isFsError(error, 'ENOENT'))
            throw error;
    }
    // libuv unlinks a pipe server's bound path on close(), whatever is there by then (B6). Binding a
    // private temp name and renaming it into place means close() only ever unlinks that temp name.
    const temp = join(dirname(path), `.${randomBytes(3).toString('hex')}.sock`);
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        // Unix sockets start with 0777 & ~umask. Create as 0600 before clients can lstat it.
        const previousMask=process.umask(0o177);
        try{server.listen(temp, () => { server.off('error', reject); resolve(); });}
        finally{process.umask(previousMask);}
    });
    try {
        await chmod(temp, 0o600);
        await rename(temp, path);
    }
    catch (error) {
        await new Promise<void>(resolve => server.close(() => resolve()));
        throw error;
    }
    const stat = await lstat(path);
    return { ino: stat.ino, dev: stat.dev };
}
// Closes the server and removes the socket only if it is still the one this server bound (never a replacement's).
export async function closePrivate(server: Server, path: string, identity: SocketIdentity | undefined): Promise<void> {
    if (server.listening)
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    try {
        const stat = await lstat(path);
        if (stat.ino === identity?.ino && stat.dev === identity.dev)
            await unlink(path);
    }
    catch (error) {
        if (!isFsError(error, 'ENOENT'))
            throw error;
    }
}
