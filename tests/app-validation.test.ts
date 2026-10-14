import { describe, expect, it } from 'vitest';
import { MAX_WRITE_BYTES, validateSize, validateWrite, validateUrl, validateEmpty } from '../app/shared/validation.js';

describe('app preload messages are validated before use', () => {
  it('accepts only bounded integer dimensions with exact keys', () => {
    expect(validateSize({ cols: 120, rows: 40 })).toEqual({ cols: 120, rows: 40 });
    for (const value of [null, {}, { cols: 0, rows: 40 }, { cols: 501, rows: 40 }, { cols: 80, rows: Infinity }, { cols: 80, rows: 2.5 }, { cols: '80', rows: 24 }, { cols: 80, rows: 24, extra: true }]) {
      expect(() => validateSize(value)).toThrow();
    }
  });
  it('refuses oversized writes by UTF-8 byte count', () => {
    expect(validateWrite('hello\x1b[A')).toBe('hello\x1b[A');
    expect(() => validateWrite('x'.repeat(MAX_WRITE_BYTES + 1))).toThrow();
    expect(() => validateWrite('🧪'.repeat(MAX_WRITE_BYTES / 4 + 1))).toThrow();
    expect(() => validateWrite({ data: 'x' })).toThrow();
  });
  it('opens only explicit http/https URLs without credentials or controls', () => {
    expect(validateUrl('https://example.com/a?q=1')).toBe('https://example.com/a?q=1');
    for (const url of ['file:///tmp/x', 'javascript:alert(1)', 'data:text/html,x', 'ftp://example.com', ' https://example.com', 'https://u:p@example.com', 'https://example.com\n', 'https://example.com/\x00', 'example.com', 12]) {
      expect(() => validateUrl(url)).toThrow();
    }
  });
  it('refuses payloads on zero-argument operations', () => {
    expect(() => validateEmpty([])).not.toThrow();
    expect(() => validateEmpty([undefined])).toThrow();
  });
});
