import { describe, expect, it } from 'vitest';
import {
  buildTmuxAttachCommand,
  buildTmuxSendInputCommands,
  TmuxBackend,
  type TmuxCommandRunner,
} from '../src/services/session-backends/tmux.js';

describe('TmuxBackend', () => {
  it('builds attach commands that can be run inside another tmux pane', () => {
    expect(buildTmuxAttachCommand('ab_friday_thing_2e30_p')).toBe(
      'env -u TMUX tmux attach-session -t ab_friday_thing_2e30_p'
    );
  });

  it('creates a task tmux session with the existing session naming pattern', async () => {
    const calls: string[][] = [];
    const runner: TmuxCommandRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'has-session') {
        throw new Error('missing');
      }
      return { stdout: '', stderr: '' };
    };

    const backend = new TmuxBackend({
      runner,
      idGenerator: () => 'session-1',
      now: () => 123,
    });

    const session = await backend.create({
      taskId: '2e3019f5',
      taskTitle: 'Friday thing',
      slot: 'primary',
      repoPath: '/tmp/repo',
      branch: 'ab/friday-thing-2e30',
      agentCli: 'claude',
      cwd: '/tmp/repo',
      baseBranch: 'main',
      usesWorktree: false,
      sessionBootstrapScript: '/tmp/bootstrap.sh',
    });

    expect(session).toEqual(
      expect.objectContaining({
        id: 'session-1',
        backendType: 'tmux',
        backendSessionId: 'ab_friday_thing_2e30_p',
        attachCommand: 'env -u TMUX tmux attach-session -t ab_friday_thing_2e30_p',
        status: 'active',
        cwd: '/tmp/repo',
        branch: 'ab/friday-thing-2e30',
      })
    );
    expect(calls[0]).toEqual(['has-session', '-t', 'ab_friday_thing_2e30_p']);
    expect(calls[1]).toEqual([
      'new-session',
      '-d',
      '-s',
      'ab_friday_thing_2e30_p',
      '-c',
      '/tmp/repo',
    ]);
    expect(calls.some((args) => args[0] === 'send-keys' && args.includes('-l'))).toBe(true);
  });

  it('reuses an existing tmux session without rerunning bootstrap', async () => {
    const calls: string[][] = [];
    const runner: TmuxCommandRunner = async (args) => {
      calls.push(args);
      return { stdout: '', stderr: '' };
    };

    const backend = new TmuxBackend({
      runner,
      idGenerator: () => 'session-1',
      now: () => 123,
    });

    await backend.create({
      taskId: '2e3019f5',
      taskTitle: 'Friday thing',
      slot: 'secondary',
      repoPath: '/tmp/repo',
      branch: 'ab/friday-thing-2e30',
      agentCli: 'codex',
      sessionBootstrapScript: '/tmp/bootstrap.sh',
    });

    expect(calls).toEqual([['has-session', '-t', 'ab_friday_thing_2e30_s']]);
  });

  it('forwards text literally and sends newlines as Enter keys', () => {
    expect(buildTmuxSendInputCommands('ab_task_1234_p', 'git status\r')).toEqual([
      { args: ['send-keys', '-t', 'ab_task_1234_p', '-l', 'git status'] },
      { args: ['send-keys', '-t', 'ab_task_1234_p', 'Enter'] },
    ]);
  });
});
