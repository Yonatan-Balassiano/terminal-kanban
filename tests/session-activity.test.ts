import { describe, expect, it } from 'vitest';
import {
  deriveSessionActivity,
  hasMeaningfulTerminalOutput,
} from '../src/services/session-activity.js';

describe('deriveSessionActivity', () => {
  it('ignores control-only output when tracking session activity', () => {
    expect(hasMeaningfulTerminalOutput('\u001b]7;file:///tmp\u0007')).toBe(false);
    expect(hasMeaningfulTerminalOutput('\u001b[2K\u001b[1G')).toBe(false);
  });

  it('treats visible text and spinner glyphs as meaningful output', () => {
    expect(hasMeaningfulTerminalOutput('Claude is thinking')).toBe(true);
    expect(hasMeaningfulTerminalOutput('⠋ thinking')).toBe(true);
  });

  it('marks the session idle when the shell has no live child processes', () => {
    const activity = deriveSessionActivity(
      'task-1',
      'session-1',
      'active',
      [
        {
          pid: 100,
          ppid: 1,
          stat: 'Ss',
          command: '/bin/zsh',
          args: '-zsh',
        },
      ],
      100,
      undefined,
      'zsh',
    );

    expect(activity.isBusy).toBe(false);
    expect(activity.label).toBeUndefined();
  });

  it('does not mark agent CLIs as busy when they are merely open', () => {
    const activity = deriveSessionActivity(
      'task-1',
      'session-1',
      'active',
      [
        {
          pid: 100,
          ppid: 1,
          stat: 'Ss',
          command: '/bin/zsh',
          args: '-zsh',
        },
        {
          pid: 200,
          ppid: 100,
          stat: 'S+',
          command: 'claude',
          args: 'claude',
        },
      ],
      100,
      undefined,
      'zsh',
    );

    expect(activity.isBusy).toBe(false);
    expect(activity.kind).toBe('agent');
    expect(activity.command).toBe('claude');
    expect(activity.label).toBe('Claude');
    expect(activity.pid).toBe(200);
  });

  it('marks agent CLIs as busy once they produced recent output', () => {
    const activity = deriveSessionActivity(
      'task-1',
      'session-1',
      'active',
      [
        {
          pid: 100,
          ppid: 1,
          stat: 'Ss',
          command: '/bin/zsh',
          args: '-zsh',
        },
        {
          pid: 200,
          ppid: 100,
          stat: 'S+',
          command: 'claude',
          args: 'claude',
        },
      ],
      100,
      Date.now(),
      'zsh',
    );

    expect(activity.isBusy).toBe(true);
    expect(activity.kind).toBe('agent');
    expect(activity.command).toBe('claude');
    expect(activity.label).toBe('Claude');
    expect(activity.pid).toBe(200);
  });

  it('falls back to the current pane command when the process table misses descendants', () => {
    const activity = deriveSessionActivity(
      'task-1',
      'session-1',
      'active',
      [],
      100,
      undefined,
      'codex',
    );

    expect(activity.isBusy).toBe(false);
    expect(activity.kind).toBe('agent');
    expect(activity.command).toBe('codex');
    expect(activity.label).toBe('Codex');
  });

  it('keeps non-agent commands busy even if they are quiet', () => {
    const activity = deriveSessionActivity(
      'task-1',
      'session-1',
      'active',
      [
        {
          pid: 100,
          ppid: 1,
          stat: 'Ss',
          command: '/bin/zsh',
          args: '-zsh',
        },
        {
          pid: 200,
          ppid: 100,
          stat: 'S+',
          command: 'npm',
          args: 'npm test',
        },
      ],
      100,
      undefined,
      'zsh',
    );

    expect(activity.isBusy).toBe(true);
    expect(activity.kind).toBe('process');
    expect(activity.command).toBe('npm');
    expect(activity.label).toBe('npm');
  });
});
