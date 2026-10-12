import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { UsageService } from '../src/daemon/usage-service.js';

it('B13 records with last good prices, warns once, and recovers after corrupt settings', async () => {
  const root = await mkdtemp('/tmp/ai-b13-'), paths = getPaths(root);
  await preparePaths(paths);
  const log = new Logger(paths.log), usage = new UsageService(root, log);
  const manager = new SessionManager(paths, log, undefined, undefined, undefined, undefined, usage);
  const events: unknown[] = []; manager.on('event', event => events.push(event));
  const settings = { theme: 'graphite', priceOverrides: { unknown: { input: 2, output: 4 } } };
  try {
    await writeFile(join(root, 'settings.json'), JSON.stringify(settings));
    await usage.start(); await manager.load();
    const t = usage.register({ sessionId: randomUUID(), engine: 'codex', provider: 'foundry', model: 'unknown' });
    let time = 0;
    const send = () => fetch(`http://127.0.0.1:${t.port}/v1/logs`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ai-term-session': t.credential }, body: JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ timeUnixNano: String(++time), attributes: [{ key: 'event.name', value: { stringValue: 'codex.sse_event' } }, { key: 'event.kind', value: { stringValue: 'response.completed' } }, { key: 'input_token_count', value: { intValue: '1000' } }, { key: 'output_token_count', value: { intValue: '100' } }] }] }] }] }) });
    expect((await send()).status).toBe(200);
    await writeFile(join(root, 'settings.json'), '{AITERMCANARY');
    expect((await send()).status).toBe(200); expect((await send()).status).toBe(200);
    expect(usage.summary().today.tokens).toBe(3300);
    expect(usage.summary().today.costUsd).toBeCloseTo(0.0072);
    expect(events.filter(e => (e as { kind: string }).kind === 'daemon.warning')).toHaveLength(1);
    expect(manager.warningText()).toContain('Settings could not be read; usage uses last good prices.');
    expect((await readFile(paths.log, 'utf8')).match(/Usage settings read failed/g)).toHaveLength(1);
    await writeFile(join(root, 'settings.json'), JSON.stringify({ ...settings, priceOverrides: { unknown: { input: 4, output: 8 } } }));
    expect((await send()).status).toBe(200);
    expect(usage.summary().today.costUsd).toBeCloseTo(0.012);
    expect(manager.warningText()).toBeNull();
    expect(JSON.stringify(events) + await readFile(paths.log, 'utf8')).not.toContain('AITERMCANARY');
  } finally { await manager.shutdown(); await usage.close(); await rm(root, { recursive: true, force: true }); }
});

it('B13 starts with corrupt settings and still accepts usage using bundled prices', async () => {
  const root = await mkdtemp('/tmp/ai-b13-start-');
  const log = new Logger(join(root, 'daemon.log')), usage = new UsageService(root, log);
  const warnings: boolean[] = []; usage.on('settingsWarning', on => warnings.push(on));
  try {
    await writeFile(join(root, 'settings.json'), '{AITERMCANARY');
    await usage.start();
    expect(warnings).toEqual([true]);
  } finally { await usage.close(); await rm(root, { recursive: true, force: true }); }
});
