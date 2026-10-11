#!/usr/bin/env node
// Spike runner (argv arrays only). Starts receiver.mjs, writes a per-session --settings file in /tmp,
// runs one tiny `claude -p` and records duration + stream-json output under /tmp/aiterm-spike.
// Usage: node run-claude.mjs hooks   — command + http hooks on every status event, statusLine, project-settings merge check
//        node run-claude.mjs slow    — http hook that answers after 4 s with a 1 s timeout, plus one to a closed port
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const variant = process.argv[2] === 'slow' ? 'slow' : 'hooks';
const spike = '/tmp/aiterm-spike', project = join(spike, 'proj');
mkdirSync(join(project, '.claude'), { recursive: true });
rmSync(join(spike, 'port'), { force: true });
const receiver = spawn(process.execPath, [join(here, 'receiver.mjs'), variant === 'slow' ? '4000' : '0'], { stdio: 'ignore' });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
for (let i = 0; i < 50 && !existsSync(join(spike, 'port')); i++) await wait(50);
const port = readFileSync(join(spike, 'port'), 'utf8');
const logHook = name => ({ type: 'command', command: `node ${join(here, 'log-hook.mjs')} ${name}` });
const httpHook = (path, timeout = 5) => ({ type: 'http', url: `http://127.0.0.1:${port}${path}`, headers: { 'x-ai-term-session': '$AITERM_SPIKE_TOKEN' }, allowedEnvVars: ['AITERM_SPIKE_TOKEN'], timeout });
const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'PermissionRequest', 'Stop', 'StopFailure', 'SessionEnd'];
let settings;
if (variant === 'hooks') {
  settings = { hooks: Object.fromEntries(events.map(event => [event, [{ hooks: [logHook('claude-hooks'), httpHook(`/claude/${event}`)] }]])), statusLine: { type: 'command', command: `node ${join(here, 'log-hook.mjs')} statusline` } };
  // A project-level hook in the test folder: if it also fires, --settings hooks merge rather than replace.
  writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [logHook('project-hooks')] }], Stop: [{ hooks: [logHook('project-hooks')] }] } }, null, 2));
} else {
  rmSync(join(project, '.claude', 'settings.json'), { force: true });
  settings = { hooks: { UserPromptSubmit: [{ hooks: [httpHook('/claude/slow-UserPromptSubmit', 1), { type: 'http', url: 'http://127.0.0.1:9/closed', timeout: 2 }] }], Stop: [{ hooks: [logHook('slow-hooks')] }] } };
}
const settingsPath = join(spike, `claude-settings-${variant}.json`);
writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
const started = Date.now();
const child = spawn('claude', ['-p', 'reply with ok', '--settings', settingsPath, '--output-format', 'stream-json', '--verbose', '--include-hook-events'], { cwd: project, env: { ...process.env, AITERM_SPIKE_TOKEN: 'spike-not-a-secret' }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '', err = '';
child.stdout.on('data', chunk => { out += chunk; });
child.stderr.on('data', chunk => { err += chunk; });
child.on('close', code => {
  writeFileSync(join(spike, `claude-${variant}.stream.jsonl`), out);
  console.log(JSON.stringify({ variant, exit: code, ms: Date.now() - started, stderr: err.slice(0, 500) }));
  receiver.kill('SIGTERM');
});
