import { expect, it } from 'vitest';
import { validateQueueRequest } from '../src/shared/queue.js';

it('B30 review: queue normalization retains explicit on and off brain choices', () => {
  const base = { engine: 'codex', model: null, auth: { kind: 'account' }, cwd: '/tmp', permission: 'ask', effort: null };
  expect(validateQueueRequest({ ...base, brain: true }).brain).toBe(true);
  expect(validateQueueRequest({ ...base, brain: false }).brain).toBe(false);
});
