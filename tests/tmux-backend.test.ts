import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
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
      // Resolves which pane was just tagged so any stale duplicate can be cleared.
      ['display-message', '-p', '-t', 'ab_friday_thing_2e30_s', '#{pane_id}'],
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
      // Resolves which pane was just tagged so any stale duplicate can be cleared.
      ['display-message', '-p', '-t', 'ab_friday_thing_2e30_p', '#{pane_id}'],
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

describe('TmuxBackend brief handling', () => {
  /** Every literal the backend typed into the pane, joined, plus every call made. */
  async function createWithBrief(initialPrompt: string): Promise<{
    typed: string;
    longestLiteral: number;
    calls: string[][];
  }> {
    const literals: string[] = [];
    const calls: string[][] = [];
    const runner: TmuxCommandRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'has-session') {
        throw new Error('missing');
      }
      if (args[0] === 'send-keys' && args[3] === '-l') {
        literals.push(args[4] ?? '');
      }
      return { stdout: '', stderr: '' };
    };

    const backend = new TmuxBackend({
      runner,
      idGenerator: () => 'session-1',
      now: () => 123,
      // A stable-empty capture-pane mock settles on the first re-check —
      // no need to wait out the real interval in a test.
      paneIdleOptions: { timeoutMs: 1000, intervalMs: 0, stableChecks: 1, postPasteDelayMs: 0 },
    });

    await backend.create({
      taskId: 'brieftask',
      taskTitle: 'Long brief',
      slot: 'primary',
      repoPath: '/tmp/repo',
      branch: 'ab/long-brief-0001',
      agentCli: 'claude',
      cwd: '/tmp/repo',
      baseBranch: 'main',
      usesWorktree: false,
      sessionBootstrapScript: '/tmp/bootstrap.sh',
      initialPrompt,
    });

    return {
      typed: literals.join(''),
      longestLiteral: literals.reduce((max, literal) => Math.max(max, literal.length), 0),
      calls,
    };
  }

  it('never types the brief into the pane, however long it is', async () => {
    // Arrange — a brief far past the roughly 4 KB a pane accepts. Sending it
    // inline truncates the command mid-quote, and the shell then waits forever
    // for the closing quote instead of ever launching the agent.
    const brief = `Rework the variant matcher.\n\n${'context line\n'.repeat(600)}`;
    expect(brief.length).toBeGreaterThan(4096);

    // Act
    const { typed, longestLiteral } = await createWithBrief(brief);

    // Assert — the pane sees a path, and a command line nowhere near the limit.
    expect(typed).not.toContain('Rework the variant matcher');
    expect(typed).toContain('AGENTBOARD_INITIAL_PROMPT_FILE=');
    expect(longestLiteral).toBeLessThan(2048);
  });

  it('parks the brief where the bootstrap script will find it', async () => {
    // Arrange
    const brief = 'Cap the API at 100 rps.';

    // Act
    const { typed } = await createWithBrief(brief);

    // Assert — the path it named holds exactly the brief.
    const match = typed.match(/AGENTBOARD_INITIAL_PROMPT_FILE="([^"]+)"/);
    expect(match).not.toBeNull();
    expect(readFileSync(match![1]!, 'utf8')).toBe(brief);
  });

  it('names no brief file for a card that has none', async () => {
    // Act
    const { typed, calls } = await createWithBrief('');

    // Assert
    expect(typed).toContain('AGENTBOARD_INITIAL_PROMPT_FILE=""');
    // Nothing to deliver, so no pane-idle poll or paste ever runs.
    expect(calls.some((args) => args[0] === 'capture-pane')).toBe(false);
  });

  it('delivers the brief by pasting it in once the pane settles, not by typing it', async () => {
    // Arrange
    const brief = 'Fix $HOME "now"\nsecond line';

    // Act
    const { calls } = await createWithBrief(brief);

    // Assert — capture-pane runs before the paste, and the paste comes from a
    // loaded buffer (never `send-keys -l`, which would submit after line one).
    const captureIndex = calls.findIndex((args) => args[0] === 'capture-pane');
    const loadIndex = calls.findIndex((args) => args[0] === 'load-buffer');
    const pasteIndex = calls.findIndex((args) => args[0] === 'paste-buffer');
    // The bootstrap command's own submit also sends an Enter, earlier on —
    // the one that matters here is the last one, after the paste.
    const enterIndex = calls
      .map((args, index) => ({ args, index }))
      .filter(({ args }) => args[0] === 'send-keys' && args.includes('Enter'))
      .map(({ index }) => index)
      .pop();

    expect(captureIndex).toBeGreaterThanOrEqual(0);
    expect(loadIndex).toBeGreaterThan(captureIndex);
    expect(pasteIndex).toBeGreaterThan(loadIndex);
    expect(enterIndex).toBeGreaterThan(pasteIndex);

    // ['load-buffer', '-b', bufferName, filePath]
    const briefFile = calls[loadIndex]![3];
    expect(readFileSync(briefFile!, 'utf8')).toBe(brief);
  });
});
