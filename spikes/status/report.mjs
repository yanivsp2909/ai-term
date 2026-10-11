#!/usr/bin/env node
// Summarises /tmp/aiterm-spike logs for the Tests for Yaniv list, prints no prompts or replies,
// and stops the background receiver. Usage: node report.mjs
import { readFileSync, existsSync } from 'node:fs';
const spike = '/tmp/aiterm-spike';
const lines = name => existsSync(`${spike}/${name}`) ? readFileSync(`${spike}/${name}`, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const time = at => at.slice(11, 19);
console.log('== Claude command hooks (time, event, notification_type / tool / reason / error)');
for (const { at, payload: p } of lines('claude-hooks.jsonl')) console.log(time(at), p.hook_event_name, p.notification_type ?? p.tool_name ?? p.reason ?? p.error ?? '');
console.log('== Claude http hooks received:', lines('http-hooks.jsonl').filter(r => r.url?.startsWith('/claude/')).map(r => r.url.slice(8)).join(', ') || 'none');
console.log('== Claude statusLine context (time, used%, remaining%, window)');
for (const { at, payload: p } of lines('statusline.jsonl')) console.log(time(at), p.context_window?.used_percentage ?? '-', p.context_window?.remaining_percentage ?? '-', p.context_window?.context_window_size ?? '-');
console.log('== Codex notify (time, type, client)');
for (const { at, payload: p } of lines('codex-notify.jsonl')) console.log(time(at), p.type, p.client ?? '');
if (existsSync(`${spike}/codex-tty.raw`)) {
  const raw = readFileSync(`${spike}/codex-tty.raw`, 'latin1');
  // eslint-disable-next-line no-control-regex
  const osc = [...raw.matchAll(/\x1b\](\d+);([^\x07\x1b]*)(?:\x07|\x1b\\)/g)];
  console.log('== Codex terminal: OSC 9 messages:', osc.filter(m => m[1] === '9').map(m => JSON.stringify(m[2].slice(0, 60))).join(' | ') || 'none');
  console.log('== Codex terminal: OSC 777:', osc.filter(m => m[1] === '777').length);
  console.log('== Codex terminal: distinct titles:', [...new Set(osc.filter(m => m[1] === '0' || m[1] === '2').map(m => m[2]))].slice(0, 12).map(t => JSON.stringify(t.slice(0, 60))).join(' | ') || 'none');
  // eslint-disable-next-line no-control-regex
  console.log('== Codex terminal: bare BEL outside OSC:', (raw.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').match(/\x07/g) ?? []).length);
}
if (existsSync(`${spike}/receiver.pid`)) { try { process.kill(Number(readFileSync(`${spike}/receiver.pid`, 'utf8')), 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
