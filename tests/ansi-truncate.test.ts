import { describe, expect, it } from 'vitest';
import { truncateAnsi, truncatePlain } from '../src/ui/ansi-truncate.js';

describe('ansi truncate', () => {
  it('truncates plain text by visible width', () => {
    expect(truncatePlain('abcdef', 4)).toBe('abcd');
  });

  it('truncates styled text and closes ANSI state', () => {
    const line = '\u001b[48;5;7mabcdef\u001b[0m';
    expect(truncateAnsi(line, 3)).toMatch(/^\u001b\[48;5;7mabc\u001b\[[0-9;]*m$/);
  });

  it('keeps short styled text intact', () => {
    const line = '\u001b[38;5;2mok\u001b[0m';
    expect(truncateAnsi(line, 10)).toBe(line);
  });

  it('counts wide prompt glyphs by terminal cell width', () => {
    expect(truncatePlain('📁abc', 4)).toBe('📁ab');
  });
});
