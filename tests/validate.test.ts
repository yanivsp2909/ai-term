import { describe, expect, it } from 'vitest';
import { isValidModelId } from '../src/shared/validate.js';

describe('isValidModelId (architecture §7.2)', () => {
  it.each(['-x', '--model', 'a b', '', 'a'.repeat(81), 'foo;rm', 'mödél'])('rejects %j', (id) => {
    expect(isValidModelId(id)).toBe(false);
  });
  it.each(['opus-5.5', 'gpt-6.1-sol', 'kimi-k3', 'claude-opus-5-5[1m]', 'models/deepseek-v3', 'a'.repeat(80)])('accepts %j', (id) => {
    expect(isValidModelId(id)).toBe(true);
  });
});
