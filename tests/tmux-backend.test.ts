import { describe, expect, it } from 'vitest';
import {
  buildTmuxAttachCommand,
  buildTmuxSendInputCommands,
  TmuxBackend,
  type TmuxCommandRunner,
} from '../src/services/session-backends/tmux.js';

describe('TmuxBackend', () => {
  it('builds fallback attach commands', () => {
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
      'list-panes',
      '-a',
      '-F',
      '#{pane_id}\t#{@agentboard_backend_session_id}',
    ]);
    expect(calls[2]).toEqual([
      'new-session',
      '-d',
      '-s',
      'ab_friday_thing_2e30_p',
      '-c',
      '/tmp/repo',
      ';',
      'set-option',
      '-q',
      '-t',
      'ab_friday_thing_2e30_p',
      'destroy-unattached',
      'off',
    ]);
    expect(calls[3]).toEqual([
      'set-option',
      '-p',
      '-q',
      '-t',
      'ab_friday_thing_2e30_p',
      '@agentboard_backend_session_id',
      'ab_friday_thing_2e30_p',
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

    expect(calls).toEqual([
      ['has-session', '-t', 'ab_friday_thing_2e30_s'],
      ['set-option', '-q', '-t', 'ab_friday_thing_2e30_s', 'destroy-unattached', 'off'],
      [
        'set-option',
        '-p',
        '-q',
        '-t',
        'ab_friday_thing_2e30_s',
        '@agentboard_backend_session_id',
        'ab_friday_thing_2e30_s',
      ],
    ]);
  });

  it('marks inspected tmux sessions to survive detach', async () => {
    const calls: string[][] = [];
    const runner: TmuxCommandRunner = async (args) => {
      calls.push(args);
      return { stdout: '', stderr: '' };
    };

    const backend = new TmuxBackend({ runner });

    await expect(backend.inspect('ab_friday_thing_2e30_p')).resolves.toEqual({
      backendSessionId: 'ab_friday_thing_2e30_p',
      status: 'active',
    });

    expect(calls).toEqual([
      ['has-session', '-t', 'ab_friday_thing_2e30_p'],
      ['set-option', '-q', '-t', 'ab_friday_thing_2e30_p', 'destroy-unattached', 'off'],
      [
        'set-option',
        '-p',
        '-q',
        '-t',
        'ab_friday_thing_2e30_p',
        '@agentboard_backend_session_id',
        'ab_friday_thing_2e30_p',
      ],
    ]);
  });

  it('finds inspected sessions after their panes move into the board layout', async () => {
    const calls: string[][] = [];
    const runner: TmuxCommandRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'has-session') {
        throw new Error('session moved');
      }
      if (args[0] === 'list-panes') {
        return {
          stdout: '%42\tab_friday_thing_2e30_p\n',
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    };

    const backend = new TmuxBackend({ runner });

    await expect(backend.inspect('ab_friday_thing_2e30_p')).resolves.toEqual({
      backendSessionId: 'ab_friday_thing_2e30_p',
      status: 'active',
    });

    expect(calls).toEqual([
      ['has-session', '-t', 'ab_friday_thing_2e30_p'],
      ['list-panes', '-a', '-F', '#{pane_id}\t#{@agentboard_backend_session_id}'],
    ]);
  });

  it('terminates every pane for a moved task pane group', async () => {
    const calls: string[][] = [];
    const runner: TmuxCommandRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'list-panes') {
        return {
          stdout: '%42\tab_friday_thing_2e30_p\n%43\tab_friday_thing_2e30_p\n',
          stderr: '',
        };
      }
      if (args[0] === 'kill-session') {
        throw new Error('session moved');
      }
      return { stdout: '', stderr: '' };
    };

    const backend = new TmuxBackend({ runner });

    await backend.terminate('ab_friday_thing_2e30_p');

    expect(calls).toEqual([
      ['list-panes', '-a', '-F', '#{pane_id}\t#{@agentboard_backend_session_id}'],
      ['kill-session', '-t', 'ab_friday_thing_2e30_p'],
      ['kill-pane', '-t', '%42'],
      ['kill-pane', '-t', '%43'],
    ]);
  });

  it('forwards text literally and sends newlines as Enter keys', () => {
    expect(buildTmuxSendInputCommands('ab_task_1234_p', 'git status\r')).toEqual([
      { args: ['send-keys', '-t', 'ab_task_1234_p', '-l', 'git status'] },
      { args: ['send-keys', '-t', 'ab_task_1234_p', 'Enter'] },
    ]);
  });
});
