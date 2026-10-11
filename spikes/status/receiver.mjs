#!/usr/bin/env node
// Throwaway status receiver for the spike: 127.0.0.1 only, random port written to /tmp/aiterm-spike/port,
// every request appended to /tmp/aiterm-spike/http-hooks.jsonl, answered 204 with an empty body (S12 shape).
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('/tmp/aiterm-spike', { recursive: true });
const delayMs = Number(process.argv[2] ?? 0);
const server = createServer((request, response) => {
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    let payload; try { payload = JSON.parse(body); } catch { payload = { unparsed: body.slice(0, 2000) }; }
    const { host, origin, 'content-type': type, 'x-ai-term-session': session } = request.headers;
    appendFileSync('/tmp/aiterm-spike/http-hooks.jsonl', JSON.stringify({ at: new Date().toISOString(), method: request.method, url: request.url, host, origin: origin ?? null, type, sessionHeader: session ?? null, payload }) + '\n');
    setTimeout(() => { response.writeHead(204); response.end(); }, delayMs);
  });
});
server.listen(0, '127.0.0.1', () => { const address = server.address(); if (address && typeof address === 'object') writeFileSync('/tmp/aiterm-spike/port', String(address.port)); });
