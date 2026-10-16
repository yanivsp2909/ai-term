import { expect, it } from 'vitest';
import { buildArgs, buildAgentArgs } from '../src/daemon/env.js';
import { parseAgentArgs } from '../src/agent/main.js';
const bundle = '/tmp/home/addons/' + 'a'.repeat(64);
it('read-only add-ons load immutable skill folders with argv and retain Ask permissions on every engine', () => {
  const cli = { model: null, permission: 'ask' as const, firstMessage: 'audit', addon: { bundle, readOnly: true } };
  const claude = buildArgs({ ...cli, engine: 'claude-code' });
  expect(claude).toContain('--plugin-dir=' + bundle);
  expect(claude).toContain('--tools=Read,Grep,Glob');
  expect(claude).toContain('--permission-mode=default');
  const codex = buildArgs({ ...cli, engine: 'codex' });
  expect(codex).toContain('--sandbox=read-only');
  expect(codex).not.toContain('--sandbox=workspace-write');
  expect(codex).toContain('--ask-for-approval=on-request');
  const native = buildAgentArgs({ command: { node: '/usr/bin/node', entry: '/opt/ai-term/dist/cli/index.js' }, provider: 'anthropic', model: 'm1', models: ['m1'], theme: 'graphite', transcript: '/tmp/transcript.jsonl', permission: 'ask', addon: { bundle, readOnly: true } });
  expect(native.args).toContain('--addon=' + bundle); expect(native.args).toContain('--read-only');
  expect(parseAgentArgs(native.args.slice(2))).toMatchObject({ addon: bundle, readOnly: true, permission: 'ask' });
  expect(() => buildArgs({ ...cli, engine: 'claude-code', permission: 'dontAsk' })).toThrow();
});
