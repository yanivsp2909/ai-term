#!/usr/bin/env node
// Codex notify program: Codex passes one JSON argument; append it to /tmp/aiterm-spike/codex-notify.jsonl.
import { appendFileSync, mkdirSync } from 'node:fs';
const raw = process.argv[process.argv.length - 1] ?? '';
let payload;
try { payload = JSON.parse(raw); } catch (error) { payload = { unparsed: raw.slice(0, 2000), error: String(error) }; }
mkdirSync('/tmp/aiterm-spike', { recursive: true });
appendFileSync('/tmp/aiterm-spike/codex-notify.jsonl', JSON.stringify({ at: new Date().toISOString(), argc: process.argv.length - 2, payload }) + '\n');
