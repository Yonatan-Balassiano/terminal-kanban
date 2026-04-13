import { describe, expect, it } from 'vitest';
import { tmuxKeyName } from '../src/services/session-backends/tmux.js';

describe('tmuxKeyName', () => {
  it('maps escape to the tmux key name', () => {
    expect(tmuxKeyName('\x1b')).toBe('Escape');
  });

  it('maps backspace to the tmux key name', () => {
    expect(tmuxKeyName('\x7f')).toBe('BSpace');
  });

  it('maps enter and arrows to tmux key names', () => {
    expect(tmuxKeyName('\r')).toBe('Enter');
    expect(tmuxKeyName('\t')).toBe('Tab');
    expect(tmuxKeyName('\x1b[A')).toBe('Up');
    expect(tmuxKeyName('\x1b[B')).toBe('Down');
    expect(tmuxKeyName('\x1b[D')).toBe('Left');
    expect(tmuxKeyName('\x1b[C')).toBe('Right');
  });
});
