#!/usr/bin/env node
// For Yaniv's interactive tests: archives old logs, starts receiver.mjs in the background (pid in
// /tmp/aiterm-spike/receiver.pid) and, for `claude`, writes /tmp/aiterm-spike/claude-settings-tui.json.
// Usage: node tui-setup.mjs claude|codex
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const spike = '/tmp/aiterm-spike', mode = process.argv[2] === 'codex' ? 'codex' : 'claude';
mkdirSync(join(spike, 'proj'), { recursive: true }); mkdirSync(join(spike, 'codex'), { recursive: true });
const old = join(spike, `old-${Date.now()}`); mkdirSync(old);
for (const name of readdirSync(spike)) if (/\.(jsonl|raw)$/.test(name)) renameSync(join(spike, name), join(old, name));
const pidFile = join(spike, 'receiver.pid');
if (existsSync(pidFile)) { try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
rmSync(join(spike, 'port'), { force: true });
const receiver = spawn(process.execPath, [join(here, 'receiver.mjs'), '0'], { detached: true, stdio: 'ignore' });
receiver.unref(); writeFileSync(pidFile, String(receiver.pid));
for (let i = 0; i < 50 && !existsSync(join(spike, 'port')); i++) await new Promise(resolve => setTimeout(resolve, 50));
const port = readFileSync(join(spike, 'port'), 'utf8');
if (mode === 'claude') {
  const log = { type: 'command', command: `node ${join(here, 'log-hook.mjs')} claude-hooks` };
  const http = event => ({ type: 'http', url: `http://127.0.0.1:${port}/claude/${event}`, headers: { 'x-ai-term-session': '$AITERM_SPIKE_TOKEN' }, allowedEnvVars: ['AITERM_SPIKE_TOKEN'], timeout: 2 });
  const events = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'PermissionRequest', 'Stop', 'StopFailure', 'SessionEnd'];
  const hooks = Object.fromEntries(events.map(event => [event, [{ hooks: [log, http(event)] }]]));
  hooks.SessionStart = [{ hooks: [log] }]; // SessionStart accepts only command (and mcp_tool) hooks
  writeFileSync(join(spike, 'claude-settings-tui.json'), JSON.stringify({ hooks, statusLine: { type: 'command', command: `node ${join(here, 'log-hook.mjs')} statusline` } }, null, 2));
}
console.log(`receiver on 127.0.0.1:${port} (pid ${receiver.pid}); old logs moved to ${old}`);
