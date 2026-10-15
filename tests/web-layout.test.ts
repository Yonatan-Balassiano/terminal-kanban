import { describe, expect, it } from 'vitest';
import { focusSessionInWebLayout, type TmuxRunner } from '../src/daemon/web-layout.js';

/**
 * A scripted tmux: answers the queries this module makes and records every
 * command, so a test can assert the order of pane moves.
 */
function fakeTmux(state: {
  webWindow?: boolean;
  visible: Array<[string, string, string?]>;
  all: Array<[string, string, string?]>;
  holdingExists?: boolean;
}) {
  const calls: string[][] = [];
  const runner: TmuxRunner = {
    async run(args) {
      calls.push(args);
      const [cmd] = args;
      if (cmd === 'list-windows') {
        return state.webWindow === false ? '@1\t\n' : '@1\t\n@2\t1\n';
      }
      if (cmd === 'list-panes' && args[1] === '-a') {
        return state.all.map(([id, tag, ph]) => `${id}\t${tag}\t${ph ?? ''}`).join('\n') + '\n';
      }
      if (cmd === 'list-panes') {
        return state.visible.map(([id, tag, ph]) => `${id}\t${tag}\t${ph ?? ''}`).join('\n') + '\n';
      }
      if (cmd === 'has-session' && !state.holdingExists) {
        throw new Error('no session');
      }
      return '';
    },
  };
  return { runner, calls };
}

const commands = (calls: string[][]) => calls.map((args) => args.join(' '));

describe('focusSessionInWebLayout', () => {
  it('replaces the placeholder with the task pane, joining before killing', async () => {
    const { runner, calls } = fakeTmux({
      visible: [['%1', '', '1']],
      all: [
        ['%1', '', '1'],
        ['%9', 'ab_task'],
      ],
    });
    const pane = await focusSessionInWebLayout(runner, 'ab_task');
    expect(pane).toBe('%9');
    const log = commands(calls);
    const join = log.indexOf('join-pane -h -s %9 -t %1');
    const kill = log.indexOf('kill-pane -t %1');
    expect(join).toBeGreaterThan(-1);
    expect(kill).toBeGreaterThan(join);
    expect(log).toContain('select-window -t @2');
    expect(log.at(-1)).toBe('wait-for -U agentboard_attach_layout');
  });

  it("leaves the user's own panes in the window alone", async () => {
    const { runner, calls } = fakeTmux({
      visible: [
        ['%0', ''],
        ['%1', '', '1'],
      ],
      all: [['%9', 'ab_task']],
    });
    await focusSessionInWebLayout(runner, 'ab_task');
    const log = commands(calls);
    expect(log).toContain('kill-pane -t %1');
    expect(log).not.toContain('kill-pane -t %0');
  });

  it('finishes a half-done swap: card shown next to the placeholder', async () => {
    const { runner, calls } = fakeTmux({
      visible: [
        ['%1', '', '1'],
        ['%9', 'ab_task'],
      ],
      all: [['%9', 'ab_task']],
    });
    expect(await focusSessionInWebLayout(runner, 'ab_task')).toBe('%9');
    const log = commands(calls);
    expect(log).toContain('kill-pane -t %1');
    expect(log.some((line) => line.startsWith('join-pane') || line.includes('break-pane'))).toBe(false);
  });

  it('parks the previous session in the holding session instead of killing it', async () => {
    const { runner, calls } = fakeTmux({
      visible: [['%3', 'ab_old']],
      all: [
        ['%3', 'ab_old'],
        ['%9', 'ab_new'],
      ],
    });
    await focusSessionInWebLayout(runner, 'ab_new');
    const log = commands(calls);
    expect(log).toContain('break-pane -d -s %3 -t =agentboard-task-panes:');
    expect(log).not.toContain('kill-pane -t %3');
    expect(log).toContain('new-session -d -s agentboard-task-panes sh -lc \'while :; do sleep 3600; done\'');
  });

  it('only selects when the session is already showing', async () => {
    const { runner, calls } = fakeTmux({ visible: [['%9', 'ab_task']], all: [['%9', 'ab_task']] });
    await focusSessionInWebLayout(runner, 'ab_task');
    const log = commands(calls);
    expect(log).toContain('select-pane -t %9');
    expect(log.some((line) => line.startsWith('join-pane'))).toBe(false);
  });

  it('fails clearly when the web layout is not running', async () => {
    const { runner } = fakeTmux({ webWindow: false, visible: [], all: [] });
    await expect(focusSessionInWebLayout(runner, 'ab_task')).rejects.toThrow(
      /agentboard --ui web/,
    );
  });

  it('releases the layout lock when the pane is missing', async () => {
    const { runner, calls } = fakeTmux({ visible: [['%1', '']], all: [['%1', '']] });
    runner.run = (
      (original) =>
      async (args: string[]) => {
        if (args[0] === 'display-message') throw new Error('no such session');
        return original(args);
      }
    )(runner.run.bind(runner));
    await expect(focusSessionInWebLayout(runner, 'ab_gone')).rejects.toThrow(/not found/);
    expect(commands(calls).at(-1)).toBe('wait-for -U agentboard_attach_layout');
  });
});
