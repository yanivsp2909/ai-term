import { expect, it } from 'vitest';
import { buildAgentArgs, buildAgentEnv, buildBashEnv, buildArgs, AGENT_DONT_ASK_FLAG } from '../src/daemon/env.js';

// v0.4.1: AI Term's agent gets its key only through its own env, built here; bash never sees it (architecture §12.5).
const command = { node: '/usr/local/bin/node', entry: '/opt/ai-term/dist/cli/index.js' };
const base = { provider: 'foundry' as const, model: 'gpt-6.1-sol', models: ['gpt-6.1-sol', 'gpt-6-luna'], theme: 'graphite' as const, transcript: '/home/u/.ai-term/sessions/x/transcript.jsonl' };
const key = 'AITERMCANARY-agent-0123456789abcdef';
const status = { port: 41234, credential: 'a'.repeat(64) }, usage = { port: 41234, credential: 'b'.repeat(64) };

it('Ask is explicit and the default; Don\'t ask adds exactly one flag; no secret ever reaches argv', () => {
  const ask = buildAgentArgs({ ...base, command, permission: 'ask' });
  expect(ask.executable).toBe(command.node);
  expect(ask.args).toEqual([command.entry, 'agent', '--provider=foundry', '--model=gpt-6.1-sol', '--models=gpt-6.1-sol,gpt-6-luna', '--theme=graphite', `--transcript=${base.transcript}`, '--ask']);
  const dontAsk = buildAgentArgs({ ...base, command, permission: 'dontAsk', firstMessage: '--dont-ask is text here' });
  expect(dontAsk.args.filter(a => a === AGENT_DONT_ASK_FLAG)).toHaveLength(1);
  expect(dontAsk.args.slice(-2)).toEqual(['--', '--dont-ask is text here']);
  expect(dontAsk.args.indexOf(AGENT_DONT_ASK_FLAG)).toBeLessThan(dontAsk.args.indexOf('--'));
  expect(() => buildAgentArgs({ ...base, command, permission: 'auto' })).toThrow();
  expect(() => buildAgentArgs({ ...base, command, permission: 'ask', model: '-x' })).toThrow();
  expect(() => buildAgentArgs({ ...base, command, permission: 'ask', models: ['ok', 'a,b'] })).toThrow();
  expect(() => buildAgentArgs({ ...base, command, permission: 'ask', model: 'not-in-list' })).toThrow();
  expect(() => buildAgentArgs({ ...base, command, permission: 'ask', transcript: 'relative.jsonl' })).toThrow();
  // The CLI argv builder never builds an ai-term command.
  expect(() => buildArgs({ engine: 'ai-term' as 'codex', model: null, permission: 'ask' })).toThrow();
});

it('source mode runs through the tsx loader and pins AI Term\'s own tsconfig in the env', () => {
  const source = buildAgentArgs({ ...base, command: { node: '/n/node', entry: '/repo/src/cli/index.ts', loader: '/repo/node_modules/tsx/dist/loader.mjs' }, permission: 'ask' });
  expect(source.args.slice(0, 4)).toEqual(['--import', '/repo/node_modules/tsx/dist/loader.mjs', '/repo/src/cli/index.ts', 'agent']);
  const env = buildAgentEnv({ PATH: '/bin' }, { secret: key, endpoint: 'https://r.openai.azure.com/openai/v1', status, usage, entry: '/repo/src/cli/index.ts' });
  expect(env.TSX_TSCONFIG_PATH).toBe('/repo/tsconfig.json');
});

const inherited = { PATH: '/usr/bin:/bin', HOME: '/home/u', USER: 'u', LOGNAME: 'u', SHELL: '/bin/zsh', TMPDIR: '/tmp/x', LANG: 'C.UTF-8',
  OPENAI_API_KEY: 'sk-openai', ANTHROPIC_API_KEY: 'sk-ant-x', AZURE_OPENAI_API_KEY: 'az', GITHUB_TOKEN: 'ghp', AWS_SECRET_ACCESS_KEY: 's', CLAUDE_CODE_OAUTH_TOKEN: 'o',
  AI_TERM_HOME: '/h', AITERM_STATUS_TOKEN: 'c'.repeat(64), npm_config_x: '1', NODE_OPTIONS: '--require /evil.js', MY_SETTING: 'kept-out' };

it('the agent env is an allowlist plus its own key, endpoint and credentials', () => {
  const env = buildAgentEnv(inherited, { secret: key, endpoint: 'https://r.openai.azure.com/openai/v1', status, usage, entry: command.entry });
  expect(env).toMatchObject({ PATH: inherited.PATH, HOME: '/home/u', TERM: 'xterm-256color', TERM_PROGRAM: 'AITerm', AITERM_AGENT_KEY: key, AITERM_AGENT_ENDPOINT: 'https://r.openai.azure.com/openai/v1', AITERM_STATUS_TOKEN: status.credential, AITERM_STATUS_PORT: '41234', AITERM_USAGE_TOKEN: usage.credential });
  for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AZURE_OPENAI_API_KEY', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'AI_TERM_HOME', 'npm_config_x', 'NODE_OPTIONS', 'MY_SETTING', 'TSX_TSCONFIG_PATH']) expect(env).not.toHaveProperty(name);
  expect(() => buildAgentEnv(inherited, { secret: key, endpoint: 'http://r.openai.azure.com/openai/v1', status, usage, entry: command.entry })).toThrow();
  // Anthropic and OpenAI hosts are fixed in the agent: their env carries no endpoint at all.
  const fixed = buildAgentEnv(inherited, { secret: key, endpoint: null, status, usage, entry: command.entry });
  expect(fixed.AITERM_AGENT_KEY).toBe(key); expect(fixed).not.toHaveProperty('AITERM_AGENT_ENDPOINT');
  expect(() => buildAgentArgs({ ...base, command, permission: 'ask', provider: 'gemini' as 'openai' })).toThrow();
  expect(() => buildAgentEnv(inherited, { secret: 'has space', endpoint: 'https://r.openai.azure.com/openai/v1', status, usage, entry: command.entry })).toThrow();
});

it('bash gets no key, no credential and nothing of AI Term\'s own, even from the agent\'s env', () => {
  const agentEnv = buildAgentEnv(inherited, { secret: key, endpoint: 'https://r.openai.azure.com/openai/v1', status, usage, entry: command.entry });
  const env = buildBashEnv({ ...inherited, ...agentEnv, OTEL_EXPORTER_OTLP_HEADERS: 'x', SOME_PASSWORD: 'p', TSX_TSCONFIG_PATH: '/repo/tsconfig.json' });
  expect(env).toMatchObject({ PATH: inherited.PATH, HOME: '/home/u', USER: 'u', TMPDIR: '/tmp/x', LANG: 'C.UTF-8', TERM: 'dumb' });
  expect(Object.values(env).join('\n')).not.toContain(key);
  for (const name of Object.keys(env)) expect(name).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD|AITERM|AI_TERM|OTEL|TSX|NODE_OPTIONS|npm_/i);
  expect(Object.keys(env).sort()).toEqual(['GIT_PAGER', 'GIT_TERMINAL_PROMPT', 'HOME', 'LANG', 'LOGNAME', 'PAGER', 'PATH', 'SHELL', 'TERM', 'TMPDIR', 'USER']);
});
