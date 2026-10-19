// B21: credential and routing variables named in the current official docs (code.claude.com/docs/en/env-vars,
// learn.chatgpt.com/docs/config-file/environment-variables, 2026-10-13) are removed for their own CLI only.
import { expect, it } from 'vitest';
import { buildSpawnEnv } from '../src/daemon/env.js';
const CLAUDE_NEW = ['CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_SKIP_BEDROCK_AUTH', 'CLAUDE_CODE_SKIP_VERTEX_AUTH', 'CLAUDE_CODE_SKIP_FOUNDRY_AUTH', 'CLAUDE_CODE_SKIP_MANTLE_AUTH', 'CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'CLAUDE_CODE_CLIENT_CERT', 'CLAUDE_CODE_CLIENT_KEY', 'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
  // Already covered by the documented prefixes; listed so a prefix change can't drop them silently.
  'ANTHROPIC_AWS_API_KEY', 'ANTHROPIC_AWS_WORKSPACE_ID', 'ANTHROPIC_AWS_BASE_URL', 'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_AUTH_TOKEN', 'ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_FOUNDRY_RESOURCE', 'ANTHROPIC_BEDROCK_MANTLE_BASE_URL', 'ANTHROPIC_VERTEX_PROJECT_ID'];
const CODEX_NEW = ['CODEX_ACCESS_TOKEN', 'OPENAI_FEDERATION_RULE_ID', 'OPENAI_IDENTITY_TOKEN_FILE'];
const base = Object.fromEntries([...CLAUDE_NEW, ...CODEX_NEW, 'PATH'].map(name => [name, `AITERMCANARY-${name}`]));
it('Claude sessions drop every documented Claude credential and routing variable; Codex ones pass through', () => {
  for (const auth of [{ kind: 'account' as const }, { kind: 'key' as const, secret: 'AITERM' + 'CANARYSECRET0000' }]) {
    const env = buildSpawnEnv('claude-code', auth, base);
    for (const name of CLAUDE_NEW) expect(env[name], name).toBeUndefined();
    for (const name of CODEX_NEW) expect(env[name], name).toBe(`AITERMCANARY-${name}`);
  }
});
it('Codex sessions drop every documented Codex credential variable; Claude ones pass through', () => {
  for (const auth of [{ kind: 'account' as const }, { kind: 'key' as const, secret: 'AITERM' + 'CANARYSECRET0000', provider: 'openai' as const }, { kind: 'key' as const, secret: 'AITERM' + 'CANARYSECRET0000' }]) {
    const env = buildSpawnEnv('codex', auth, base);
    for (const name of CODEX_NEW) expect(env[name], name).toBeUndefined();
    for (const name of CLAUDE_NEW) expect(env[name], name).toBe(`AITERMCANARY-${name}`);
  }
});
