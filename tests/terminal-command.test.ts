import { describe, expect, it } from 'vitest';
import {
  appendTerminalInput,
  shouldFlushTerminalInputImmediately,
  shouldTriggerTerminalPushSync,
} from '../src/ui/terminal-command.js';

describe('terminal command tracking', () => {
  it('tracks printable command input independently of wrapped terminal output', () => {
    let command = '';
    for (const ch of 'git push origin ab/factor-design-7241') {
      command = appendTerminalInput(command, ch, {});
    }

    expect(command).toBe('git push origin ab/factor-design-7241');
    expect(shouldTriggerTerminalPushSync(command, { return: true })).toBe(true);
  });

  it('handles backspace while tracking the typed command', () => {
    let command = '';
    for (const ch of 'git pusx') {
      command = appendTerminalInput(command, ch, {});
    }
    command = appendTerminalInput(command, '', { backspace: true });
    command = appendTerminalInput(command, 'h', {});

    expect(command).toBe('git push');
  });

  it('resets the tracked command after enter', () => {
    const next = appendTerminalInput('git push', '', { return: true });
    expect(next).toBe('');
  });

  it('only flushes special terminal keys immediately', () => {
    expect(shouldFlushTerminalInputImmediately('a', {})).toBe(false);
    expect(shouldFlushTerminalInputImmediately('', { backspace: true })).toBe(false);
    expect(shouldFlushTerminalInputImmediately('', { return: true })).toBe(true);
    expect(shouldFlushTerminalInputImmediately('', { upArrow: true })).toBe(true);
    expect(shouldFlushTerminalInputImmediately('c', { ctrl: true })).toBe(true);
  });
});
