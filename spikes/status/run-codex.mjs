#!/usr/bin/env node
// Spike runner (argv arrays only): one tiny `codex exec` with notify, a -c Stop hook (no trust bypass),
// and an OTLP/HTTP JSON log exporter pointed at receiver.mjs. Read-only sandbox; approval flags left at defaults.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const spike = '/tmp/aiterm-spike', work = join(spike, 'codex');
mkdirSync(work, { recursive: true });
rmSync(join(spike, 'port'), { force: true });
const receiver = spawn(process.execPath, [join(here, 'receiver.mjs'), '0'], { stdio: 'ignore' });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
for (let i = 0; i < 50 && !existsSync(join(spike, 'port')); i++) await wait(50);
const port = readFileSync(join(spike, 'port'), 'utf8');
const hook = `node ${join(here, 'log-hook.mjs')} codex-hooks`;
const args = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--json',
  '-c', `notify=["node","${join(here, 'log-notify.mjs')}"]`,
  '-c', `hooks.Stop=[{hooks=[{type="command",command="${hook}"}]}]`,
  '-c', `hooks.UserPromptSubmit=[{hooks=[{type="command",command="${hook}"}]}]`,
  '-c', 'otel.log_user_prompt=false',
  '-c', `otel.exporter={otlp-http={endpoint="http://127.0.0.1:${port}/v1/logs",protocol="json"}}`,
  'reply with ok'];
const started = Date.now();
const child = spawn('codex', args, { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '', err = '';
child.stdout.on('data', chunk => { out += chunk; });
child.stderr.on('data', chunk => { err += chunk; });
child.on('close', async code => {
  writeFileSync(join(spike, 'codex-exec.jsonl'), out);
  writeFileSync(join(spike, 'codex-exec.stderr.txt'), err);
  console.log(JSON.stringify({ exit: code, ms: Date.now() - started }));
  await wait(3000); // let the OTel batch exporter flush
  receiver.kill('SIGTERM');
});
