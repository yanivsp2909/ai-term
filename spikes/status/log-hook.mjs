#!/usr/bin/env node
// Claude Code command hook: appends the hook's stdin JSON as one line to /tmp/aiterm-spike/<name>.jsonl.
// Logs only the payload Claude sends; never the environment.
import { appendFileSync, mkdirSync } from 'node:fs';
const name = /^[a-z0-9-]{1,40}$/.test(process.argv[2] ?? '') ? process.argv[2] : 'claude-hooks';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  let payload;
  try { payload = JSON.parse(input); } catch (error) { payload = { unparsed: input.slice(0, 2000), error: String(error) }; }
  mkdirSync('/tmp/aiterm-spike', { recursive: true });
  appendFileSync(`/tmp/aiterm-spike/${name}.jsonl`, JSON.stringify({ at: new Date().toISOString(), payload }) + '\n');
});
