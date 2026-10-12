import { execFile } from 'node:child_process';
import { access, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { Connection } from '../client/connection.js';
import { getPaths, isFsError } from '../shared/paths.js';
import { redact } from '../daemon/log.js';
import { buildSpawnEnv } from '../daemon/env.js';
export function versionNumber(output: string): string { return output.match(/\b\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?\b/)?.[0] ?? 'unavailable'; }
export function claudeAuth(output: string): string {
    let value: unknown;
    try {
        value = JSON.parse(output) as unknown;
    }
    catch {
        return 'status unavailable (invalid JSON)';
    }
    if (!value || typeof value !== 'object' || !('loggedIn' in value) || typeof value.loggedIn !== 'boolean')
        return 'status unavailable (unknown schema)';
    if (!value.loggedIn)
        return 'logged in no';
    const method = 'authMethod' in value ? value.authMethod : undefined;
    return `logged in yes; ${method === 'claude.ai' ? 'subscription' : method === 'api_key' ? 'API key' : 'method unknown'}`;
}
export function codexAuth(code: number | null, output: string): string {
    return `exit ${code ?? 'unavailable'}; ${code === 0 ? /ChatGPT/i.test(output) ? 'ChatGPT' : /API key/i.test(output) ? 'API key' : 'method unknown' : 'logged in no'}`;
}
async function executable(name: string): Promise<string | null> {
    for (const folder of (process.env.PATH ?? '').split(delimiter)) {
        if (!isAbsolute(folder))
            continue;
        const candidate = join(folder, name);
        try {
            await access(candidate, constants.X_OK);
            return candidate;
        }
        catch (error) {
            if (!isFsError(error, 'ENOENT') && !isFsError(error, 'EACCES') && !isFsError(error, 'ENOTDIR'))
                throw error;
        }
    }
    return null;
}
function run(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<{
    code: number | null;
    output: string;
}> {
    return new Promise(resolve => execFile(file, args, { env, timeout: 3000, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
        const code = error ? typeof error.code === 'number' ? error.code : null : 0;
        resolve({ code, output: stdout + stderr }); // Only the parsers' allowlisted fields ever reach stdout.
    }));
}
export async function doctor(entry: string): Promise<void> {
    const print = (line: string) => process.stdout.write(redact(line) + '\n');
    const paths = getPaths();
    print(`Node: ${process.version}`);
    let client: Connection | undefined;
    try {
        client = await Connection.connect(paths, { entry, autoStart: false, readOnly: true });
        print(`Daemon: running; protocol ${(await client.hello).protocol}`);
    }
    catch (error) {
        if (isFsError(error, 'ENOENT') || isFsError(error, 'ECONNREFUSED'))
            print('Daemon: not running');
        else
            print(`Daemon: unavailable (${error instanceof Error ? error.message : 'connection failed'})`);
    }
    finally {
        client?.close();
    }
    for (const path of [paths.root, paths.run]) {
        try {
            const stat = await lstat(path);
            print(`${path}: mode ${(stat.mode & 0o777).toString(8).padStart(4, '0')}${stat.isSymbolicLink() ? ' (symlink: unsafe)' : ''}`);
        }
        catch (error) {
            if (isFsError(error, 'ENOENT'))
                print(`${path}: absent`);
            else
                throw error;
        }
    }
    for (const name of ['claude', 'codex']) {
        const path = await executable(name);
        if (!path) {
            print(`${name}: not found`);
            continue;
        }
        // Same own-provider cleanup as engine checks and account sessions (§7.3), so doctor reports what sessions see.
        const env = buildSpawnEnv(name === 'claude' ? 'claude-code' : 'codex', { kind: 'account' }, process.env);
        const version = await run(path, ['--version'], env);
        print(`${name}: ${path}; version ${versionNumber(version.output)}`);
        const auth = await run(path, name === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status'], env);
        print(`${name} auth: ${name === 'claude' ? claudeAuth(auth.output) : codexAuth(auth.code, auth.output)}`);
    }
}
