import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { findExecutable } from '../shared/executable.js';
import { Connection } from '../client/connection.js';
import { getPaths, isFsError } from '../shared/paths.js';
import { redact } from '../daemon/log.js';
import { buildSpawnEnv } from '../daemon/env.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentSandbox } from '../shared/protocol.js';
import { agentSandbox } from '../daemon/agent-sandbox.js';
import { notifierAppPath, NOTIFIER_EXECUTABLE } from '../daemon/notifier.js';
import { systemTool } from '../shared/executable.js';
import { EXTRA_ENGINES, EXTRA_ENGINE_FACTS } from '../shared/cli-engines.js';
import { checkExtraEngine } from '../daemon/engines.js';
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
    // null: the check never finished (spawn failure, timeout, output cap), which says nothing about the login.
    if (code === null)
        return 'status unavailable';
    return `exit ${code ?? 'unavailable'}; ${code === 0 ? /ChatGPT/i.test(output) ? 'ChatGPT' : /API key/i.test(output) ? 'API key' : 'method unknown' : 'logged in no'}`;
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
export async function doctor(entry: string, deps: Partial<DoctorDeps> = {}): Promise<void> {
    await doctorLines(entry, line => process.stdout.write(line + '\n'), deps);
}
// v1.0.1: what the four extra lines are read from; tests swap each one (no real keychain, gh or sandbox probe).
export interface DoctorDeps {
    platform: NodeJS.Platform;
    sandbox: () => Promise<AgentSandbox>;
    // null: the daemon isn't running, and only the daemon touches the keychain.
    keychain: () => Promise<{ reachable: boolean; note?: string } | null>;
    gh: () => Promise<string | null>;
    ghStatus: (file: string, args: string[]) => Promise<{ code: number | null; output: string }>;
    // 'built' when the macOS notifier helper is there.
    notifier: (entry: string) => string;
    notifySend: () => Promise<string | null>;
}
const STORE_NAME: Partial<Record<NodeJS.Platform, string>> = { darwin: 'macOS Keychain', linux: 'Secret Service', win32: 'Windows Credential Manager' };
const SANDBOX_NAME: Partial<Record<NodeJS.Platform, string>> = { darwin: 'sandbox-exec · agent bash, tests and dev servers run in it', linux: 'bwrap · agent bash and tests run in it' };
export async function extraLines(entry: string, deps: DoctorDeps): Promise<string[]> {
    const sandbox = await deps.sandbox(), gh = await deps.gh();
    // A daemon that refuses keys.health (an older one), times out or dies costs this one line, not the report (review).
    let keychain: Awaited<ReturnType<DoctorDeps['keychain']>> | 'no answer';
    try { keychain = await deps.keychain(); } catch { keychain = 'no answer'; }
    // gh's own words never reach the report: they name the account and may show part of its token. Only the exit code.
    // A check that never finished (gh validates over the network; offline it times out) says nothing about the login.
    const ghCode = gh ? (await deps.ghStatus(gh, ['auth', 'status'])).code : null;
    const ghLine = !gh ? 'gh: not found · /pr needs it' : `gh: ${gh}; ${ghCode === null ? 'status unavailable' : ghCode === 0 ? 'logged in' : 'not logged in · gh auth login'}`;
    const notifier = deps.platform === 'darwin' ? deps.notifier(entry) === 'built' ? 'Notifier: built' : 'Notifier: not built · npm run build:notifier'
        : deps.platform === 'linux' ? await deps.notifySend() ? 'Notifier: notify-send' : "Notifier: none · notify-send isn't installed"
            : "Notifier: none · notifications aren't available on Windows yet";
    return [
        sandbox.dontAsk ? `Sandbox: ${SANDBOX_NAME[deps.platform] ?? 'available'}` : `Sandbox: none · ${sandbox.note ?? "AI Term couldn't check for one"}`,
        // "Credential store", not "Keychain:": the report is redacted, and a word with "key" before a colon reads as a secret.
        keychain === 'no answer' ? "Credential store: not checked · the daemon didn't answer (an older one? ai daemon stop, then ai)" : keychain === null ? `Credential store: not checked · the daemon isn't running; start ai, then run ai doctor again` : keychain.reachable ? `Credential store: ${STORE_NAME[deps.platform] ?? 'OS keychain'} reachable` : `Credential store: unavailable · ${keychain.note ?? 'no answer'}`,
        ghLine,
        notifier,
    ];
}
// The ai doctor report, line by line and redacted, each also handed to `each` as it is found (the CLI prints as it
// goes); /doctor shows the same lines in a popup.
export async function doctorLines(entry: string, each: (line: string) => void = () => {}, deps: Partial<DoctorDeps> = {}): Promise<string[]> {
    const lines: string[] = [], print = (line: string) => { const safe = redact(line); lines.push(safe); each(safe); };
    const paths = getPaths();
    print(`Node: ${process.version}`);
    let client: Connection | undefined;
    let keychain: DoctorDeps['keychain'] = async () => null;
    try {
        client = await Connection.connect(paths, { entry, autoStart: false, readOnly: true });
        print(`Daemon: running; protocol ${(await client.hello).protocol}`);
        const connection = client;
        keychain = async () => { const answer = (await connection.request({ kind: 'keys.health' })).keychain; if (!answer) throw new Error('No keychain answer'); return answer; };
    }
    catch (error) {
        if (isFsError(error, 'ENOENT') || isFsError(error, 'ECONNREFUSED'))
            print('Daemon: not running');
        else
            print(`Daemon: unavailable (${error instanceof Error ? error.message : 'connection failed'})`);
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
        const path = await findExecutable(name);
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
    // Part B: the added CLIs, found the way a session finds them; their login is their own, so none is read here.
    for (const engine of EXTRA_ENGINES) {
        const facts = EXTRA_ENGINE_FACTS[engine], status = await checkExtraEngine(engine, process.env);
        print(status.installed && status.path ? `${facts.word}: ${status.path}; version ${status.version ?? 'unknown'} · login: in the CLI` : `${facts.word}: not found · ${facts.install}`);
    }
    // The connection stays open until here: the keychain line asks this daemon.
    try {
        const env = process.env;
        for (const line of await extraLines(entry, {
            platform: process.platform, sandbox: () => agentSandbox(), keychain, gh: () => findExecutable('gh'),
            ghStatus: (file, args) => run(file, args, env),
            notifier: from => existsSync(join(notifierAppPath(from), NOTIFIER_EXECUTABLE)) ? 'built' : 'not built',
            notifySend: () => systemTool('notify-send'), ...deps,
        })) print(line);
    }
    finally {
        client?.close();
    }
    return lines;
}
