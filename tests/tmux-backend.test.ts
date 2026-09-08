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
      // Pane process info, so activity derivation has a pid to walk from.
      ['list-panes', '-t', 'ab_friday_thing_2e30_s', '-F', '#{pane_pid} #{pane_current_command}'],
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
      // Pane process info, so activity derivation has a pid to walk from.
      ['list-panes', '-t', 'ab_friday_thing_2e30_p', '-F', '#{pane_pid} #{pane_current_command}'],
    ]);
  });

  it('reports the pane process, so a live session can read as busy', async () => {
    // Arrange — a pane running a real agent.
    const calls: string[][] = [];
    const runner: TmuxCommandRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'list-panes' && args.includes('#{pane_pid} #{pane_current_command}')) {
        return { stdout: '4242 2.1.263\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
    const backend = new TmuxBackend({ runner });

    // Act
    const info = await backend.inspect('ab_friday_thing_2e30_p');

    // Assert — without shellPid, inspectSessionState never reaches
    // deriveSessionActivity and every local tmux session reads as idle.
    expect(info).toMatchObject({ shellPid: 4242, currentCommand: '2.1.263' });
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
      // Addressed by the pane id just found, not by the session name — the
      // session name is exactly what stopped resolving when the pane moved.
      ['list-panes', '-t', '%42', '-F', '#{pane_pid} #{pane_current_command}'],
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
  /**
   * Every literal the backend typed into the pane, joined, plus every call
   * made.
   *
   * `captureResponses` lets a test script what each successive `capture-pane`
   * call after the paste sees — the fixed pane-idle wait always sees `''`, so
   * responses here apply from the post-paste capture-pane calls onward,
   * exhausted responses repeating the last one.
   */
  async function createWithBrief(
    initialPrompt: string,
    options: {
      captureResponses?: string[];
      maxSubmitRetries?: number;
      submitRetryIntervalMs?: number;
      /**
       * Also run a re-delivery afterwards, and report only what that did.
       *
       * `create()` no longer pastes anything — the brief rides the agent CLI's
       * own argv (see session-bootstrap.sh) — so every assertion about pasting,
       * verifying and submitting now belongs to the one path that still types
       * into a pane: `redeliverPrompt`, behind `task notify` and the manual
       * `redeliver-prompt` escape hatch.
       */
      redeliver?: boolean;
    } = {},
  ): Promise<{
    typed: string;
    longestLiteral: number;
    calls: string[][];
    deliveryResults: boolean[];
  }> {
    const literals: string[] = [];
    const calls: string[][] = [];
    const deliveryResults: boolean[] = [];
    let capturesSincePaste = 0;
    let pasted = false;
    // The new paste-verification step's own capture-pane call is answered
    // once, separately from `captureResponses` below — it isn't part of the
    // submit-retry sequence those arrays script, just confirmation the paste
    // itself rendered before the existing tests' submit-phase logic runs.
    let pasteVerified = false;
    const runner: TmuxCommandRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'has-session') {
        throw new Error('missing');
      }
      if (args[0] === 'paste-buffer') {
        pasted = true;
      }
      if (args[0] === 'send-keys' && args[3] === '-l') {
        literals.push(args[4] ?? '');
      }
      if (args[0] === 'capture-pane' && pasted && !pasteVerified) {
        pasteVerified = true;
        return { stdout: initialPrompt, stderr: '' };
      }
      if (args[0] === 'capture-pane' && pasted && options.captureResponses) {
        const responses = options.captureResponses;
        const stdout = responses[Math.min(capturesSincePaste, responses.length - 1)] ?? '';
        capturesSincePaste += 1;
        return { stdout, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };

    const backend = new TmuxBackend({
      runner,
      idGenerator: () => 'session-1',
      now: () => 123,
      // A stable-empty capture-pane mock settles on the first re-check —
      // no need to wait out the real interval in a test.
      paneIdleOptions: {
        timeoutMs: 1000,
        intervalMs: 0,
        stableChecks: 1,
        postPasteDelayMs: 0,
        maxSubmitRetries: options.maxSubmitRetries ?? 0,
        submitRetryIntervalMs: options.submitRetryIntervalMs ?? 0,
        // No process name to match in these mocks — skip the foreground-command gate.
        foregroundCommandTimeoutMs: 0,
        trustPromptTimeoutMs: 0,
      },
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
      onDeliveryResult: (delivered) => deliveryResults.push(delivered),
    });

    // The background trust-prompt watch is fire-and-forget — give its chain of
    // zero-delay timers a real tick to finish before asserting on the calls.
    await new Promise((resolve) => setTimeout(resolve, 50));

    if (options.redeliver) {
      const createCalls = calls.length;
      deliveryResults.push(
        await backend.redeliverPrompt(
          'brieftask',
          'primary',
          'ab_long_brief_brie_p',
          initialPrompt,
          'claude',
        ),
      );
      // Only what the re-delivery itself did, so create()'s own setup calls
      // don't have to be threaded through every assertion below.
      calls.splice(0, createCalls);
    }

    return {
      typed: literals.join(''),
      deliveryResults,
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

  it('pastes with bracketed-paste markers and without LF-to-CR replacement', async () => {
    // Arrange — a brief whose blank line is the thing at risk.
    const brief = 'First paragraph.\n\nSecond paragraph.';

    // Act
    const { calls } = await createWithBrief(brief, { redeliver: true });

    // Assert — both flags, or the agent receives a corrupted brief.
    //   -r  keeps the linefeeds. tmux's documented default rewrites every LF
    //       to CR, which reaches the model as `\r\r` where the blank line was
    //       and flattens every heading, list and fence in a markdown brief.
    //   -p  emits the bracketed-paste markers, so the CLI sees one atomic
    //       paste instead of having to infer one from arrival timing (which is
    //       what splits a brief into several `[Pasted text #N]` chunks).
    const paste = calls.find((args) => args[0] === 'paste-buffer');
    expect(paste).toBeDefined();
    expect(paste).toContain('-r');
    expect(paste).toContain('-p');
  });

  it('re-delivers by pasting once the pane settles, not by typing', async () => {
    // Arrange
    const brief = 'Fix $HOME "now"\nsecond line';

    // Act
    const { calls, deliveryResults } = await createWithBrief(brief, { redeliver: true });

    // Assert — the re-delivery reports a verified paste.
    expect(deliveryResults).toEqual([true]);

    // Assert — capture-pane runs before the paste, and the paste comes from a
    // loaded buffer (never `send-keys -l`, which would submit after line one).
    const captureIndex = calls.findIndex((args) => args[0] === 'capture-pane');
    const loadIndex = calls.findIndex((args) => args[0] === 'load-buffer');
    const pasteIndex = calls.findIndex((args) => args[0] === 'paste-buffer');
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

  /** Every `send-keys ... Enter` call, in order. */
  function enterCalls(calls: string[][]): string[][] {
    return calls.filter((args) => args[0] === 'send-keys' && args.includes('Enter'));
  }

  it('stops as soon as the pane shows the Enter took, without over-sending it', async () => {
    // Arrange — the pane changes on the very first post-submit check.
    const { calls } = await createWithBrief('Ship the thing', {
      redeliver: true,
      captureResponses: ['idle, brief sitting in the box', 'Cogitating…'],
      maxSubmitRetries: 3,
    });

    // Assert — exactly one Enter; no retries once the change was confirmed.
    expect(enterCalls(calls)).toHaveLength(1);
  });

  it('resends Enter when the pane never changes, up to the retry limit', async () => {
    // Arrange — the pane looks identical on every check: the Enter that
    // should have submitted the brief was dropped, over and over.
    const { calls } = await createWithBrief('Ship the thing', {
      redeliver: true,
      captureResponses: ['idle, brief still sitting in the box'],
      maxSubmitRetries: 3,
    });

    // Assert — the initial attempt plus 3 retries.
    expect(enterCalls(calls)).toHaveLength(4);
  });
});

describe('TmuxBackend.redeliverPrompt', () => {
  it('pastes a fresh brief file and submits it, without going through create()', async () => {
    // Arrange — the manual escape hatch: no prior create() call, just an
    // already-live session that automatic delivery failed to reach.
    const calls: string[][] = [];
    let pasted = false;
    const runner: TmuxCommandRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'paste-buffer') {
        pasted = true;
      }
      if (args[0] === 'capture-pane' && pasted) {
        // Simulate the paste rendering, for the new paste-verification step.
        return { stdout: 'Please continue where you left off.', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };

    const backend = new TmuxBackend({
      runner,
      idGenerator: () => 'session-1',
      now: () => 123,
      paneIdleOptions: {
        timeoutMs: 1000,
        intervalMs: 0,
        stableChecks: 1,
        postPasteDelayMs: 0,
        maxSubmitRetries: 0,
        submitRetryIntervalMs: 0,
        // No process name to match in these mocks — skip the foreground-command gate.
        foregroundCommandTimeoutMs: 0,
        trustPromptTimeoutMs: 0,
      },
    });

    // Act
    const delivered = await backend.redeliverPrompt(
      'brieftask',
      'primary',
      'ab_brieftask_p',
      'Please continue where you left off.',
    );

    // Assert
    expect(delivered).toBe(true);
    const loadIndex = calls.findIndex((args) => args[0] === 'load-buffer');
    const pasteIndex = calls.findIndex((args) => args[0] === 'paste-buffer');
    const enterIndex = calls.findIndex((args) => args[0] === 'send-keys' && args.includes('Enter'));
    expect(loadIndex).toBeGreaterThanOrEqual(0);
    expect(pasteIndex).toBeGreaterThan(loadIndex);
    expect(enterIndex).toBeGreaterThan(pasteIndex);

    const briefFile = calls[loadIndex]![3];
    expect(readFileSync(briefFile!, 'utf8')).toBe('Please continue where you left off.');
  });

  it('resolves false, without submitting anything, when the pasted text never renders', async () => {
    // Arrange — mirrors the create()-path "never lands" test, but through the
    // manual redeliverPrompt escape hatch: the pane stays empty no matter how
    // many times the brief is pasted.
    const calls: string[][] = [];
    const runner: TmuxCommandRunner = async (args) => {
      calls.push(args);
      return { stdout: '', stderr: '' };
    };

    const backend = new TmuxBackend({
      runner,
      idGenerator: () => 'session-1',
      now: () => 123,
      paneIdleOptions: {
        timeoutMs: 1000,
        intervalMs: 0,
        stableChecks: 1,
        postPasteDelayMs: 0,
        maxSubmitRetries: 0,
        submitRetryIntervalMs: 0,
        foregroundCommandTimeoutMs: 0,
        trustPromptTimeoutMs: 0,
        pasteVerifyTimeoutMs: 0,
        pasteVerifyIntervalMs: 0,
        maxPasteAttempts: 3,
      },
    });

    // Act
    const delivered = await backend.redeliverPrompt(
      'never-lands',
      'primary',
      'ab_never-lands_p',
      'This never renders on the pane.',
    );

    // Assert — never submitted: pasted up to the retry limit, but no Enter
    // sent for the brief itself.
    expect(delivered).toBe(false);
    expect(calls.filter((args) => args[0] === 'paste-buffer')).toHaveLength(3);
    expect(calls.filter((args) => args[0] === 'send-keys' && args.includes('Enter'))).toHaveLength(0);
  });
});

describe('TmuxBackend.redeliverPrompt is safe to repeat', () => {
  const PROMPT = 'Please continue where you left off.';
  const IDLE_OPTIONS = {
    timeoutMs: 1000,
    intervalMs: 0,
    stableChecks: 1,
    postPasteDelayMs: 0,
    maxSubmitRetries: 0,
    submitRetryIntervalMs: 0,
    foregroundCommandTimeoutMs: 0,
    trustPromptTimeoutMs: 0,
    pasteVerifyTimeoutMs: 20,
    pasteVerifyIntervalMs: 1,
  };

  const enterCalls = (calls: string[][]): string[][] =>
    calls.filter((args) => args[0] === 'send-keys' && args.includes('Enter'));

  it('does not paste a second copy when the brief is already sitting in the pane', async () => {
    // Arrange — what a user sees after a delivery that pasted but never got
    // its Enter through: the brief is on screen, unsubmitted. Running
    // redeliver-prompt again used to stack a second copy underneath it.
    const calls: string[][] = [];
    const runner: TmuxCommandRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'capture-pane') {
        return { stdout: `> ${PROMPT}`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
    const backend = new TmuxBackend({
      runner,
      idGenerator: () => 'session-1',
      now: () => 123,
      paneIdleOptions: IDLE_OPTIONS,
    });

    // Act — `skipIfAlreadyOnPane` is what `SessionManager.redeliverInitialPrompt`
    // passes, and only it: the text is the card's stored brief, so a copy on
    // screen is this same brief from an earlier run.
    const delivered = await backend.redeliverPrompt('t1', 'primary', 'ab_t1_p', PROMPT, undefined, {
      skipIfAlreadyOnPane: true,
    });

    // Assert — nothing pasted, but the Enter the earlier run never landed is
    // sent, which is the whole point of re-running the command.
    expect(delivered).toBe(true);
    expect(calls.filter((args) => args[0] === 'paste-buffer')).toHaveLength(0);
    expect(enterCalls(calls)).toHaveLength(1);
  });

  it('pastes a repeated notify even with the same text still on the pane', async () => {
    // Arrange — the notify path, which is the same backend call without
    // `skipIfAlreadyOnPane`. `agentboard task notify <id> "..."` run twice a
    // couple of minutes apart is the ordinary shape of a nudge, and the first
    // copy is usually still on the visible screen `capture-pane -p` reads.
    // Skipping the paste there drops the message and still reports `true`.
    const calls: string[][] = [];
    const runner: TmuxCommandRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'capture-pane') {
        return { stdout: `> ${PROMPT}`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
    const backend = new TmuxBackend({
      runner,
      idGenerator: () => 'session-1',
      now: () => 123,
      paneIdleOptions: IDLE_OPTIONS,
    });

    // Act — no options at all, exactly as `notifyTaskSession` calls it.
    const delivered = await backend.redeliverPrompt('t1', 'primary', 'ab_t1_p', PROMPT);

    // Assert — the message was actually pasted and submitted.
    expect(delivered).toBe(true);
    expect(calls.filter((args) => args[0] === 'paste-buffer')).toHaveLength(1);
    expect(enterCalls(calls)).toHaveLength(1);
  });

  it('never pastes again while the submit loop keeps retrying the Enter', async () => {
    // Arrange — a pane that takes the paste but never reacts to Enter, so the
    // submit loop spends its whole budget. That loop outlives the client call
    // that started it, which is when stray pastes are hardest to attribute:
    // it must only ever re-send Enter.
    const calls: string[][] = [];
    let pasted = false;
    const runner: TmuxCommandRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'paste-buffer') {
        pasted = true;
      }
      if (args[0] === 'capture-pane') {
        return { stdout: pasted ? `> ${PROMPT}` : '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
    const backend = new TmuxBackend({
      runner,
      idGenerator: () => 'session-1',
      now: () => 123,
      paneIdleOptions: { ...IDLE_OPTIONS, maxSubmitRetries: 5 },
    });

    // Act
    const delivered = await backend.redeliverPrompt('t1', 'primary', 'ab_t1_p', PROMPT);

    // Assert — one paste, six Enters (the first plus five retries).
    expect(delivered).toBe(true);
    expect(calls.filter((args) => args[0] === 'paste-buffer')).toHaveLength(1);
    expect(enterCalls(calls)).toHaveLength(6);
  });

  it('joins a delivery already in flight rather than starting a second paste', async () => {
    // Arrange — the original failure: the command looked like it had timed
    // out, so it was run again while the first was still working.
    const calls: string[][] = [];
    let releaseFirstCapture: () => void = () => undefined;
    const firstCaptureBlocked = new Promise<void>((resolve) => {
      releaseFirstCapture = resolve;
    });
    let captures = 0;
    const runner: TmuxCommandRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'capture-pane') {
        captures += 1;
        if (captures === 1) {
          await firstCaptureBlocked;
        }
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
    const backend = new TmuxBackend({
      runner,
      idGenerator: () => 'session-1',
      now: () => 123,
      paneIdleOptions: { ...IDLE_OPTIONS, maxPasteAttempts: 1 },
    });

    // Act — the second call starts while the first is stuck on its first capture.
    const first = backend.redeliverPrompt('t1', 'primary', 'ab_t1_p', PROMPT);
    const second = backend.redeliverPrompt('t1', 'primary', 'ab_t1_p', PROMPT);
    releaseFirstCapture();
    const results = await Promise.all([first, second]);

    // Assert — one delivery, one paste, and both callers get its real answer.
    expect(results).toEqual([false, false]);
    expect(calls.filter((args) => args[0] === 'paste-buffer')).toHaveLength(1);
  });
});

describe('TmuxBackend auto-trust', () => {
  it('accepts a never-trusted-folder prompt (Down, then Enter) on session start', async () => {
    // Arrange — the pane shows the real trust screen until Down is sent, then
    // settles on the CLI's normal ready screen for everything after.
    const TRUST_SCREEN = 'Quick safety check\n  No, exit\n❯ Yes, I trust this folder';
    const calls: string[][] = [];
    let trustAccepted = false;
    const runner: TmuxCommandRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'has-session') {
        throw new Error('missing');
      }
      if (args[0] === 'send-keys' && args[3] === 'Down') {
        trustAccepted = true;
      }
      if (args[0] === 'capture-pane') {
        return { stdout: trustAccepted ? '' : TRUST_SCREEN, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };

    const backend = new TmuxBackend({
      runner,
      idGenerator: () => 'session-1',
      now: () => 123,
      paneIdleOptions: {
        timeoutMs: 1000,
        intervalMs: 0,
        stableChecks: 1,
        postPasteDelayMs: 0,
        maxSubmitRetries: 0,
        submitRetryIntervalMs: 0,
        trustPromptTimeoutMs: 1000,
        trustPromptIntervalMs: 0,
      },
    });

    // Act
    await backend.create({
      taskId: 'trusttask',
      taskTitle: 'Never trusted',
      slot: 'primary',
      repoPath: '/tmp/repo',
      branch: 'ab/never-trusted-0001',
      agentCli: 'claude',
      cwd: '/tmp/repo',
      baseBranch: 'main',
      usesWorktree: false,
      sessionBootstrapScript: '/tmp/bootstrap.sh',
      initialPrompt: 'Fix the flaky test.',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Assert — Down before Enter, never a bare Enter, which would pick the
    // default-highlighted "No, exit" and quit the CLI. This is the only thing
    // the daemon types into a starting session now; the brief itself reaches
    // the agent through its own argv, so nothing is pasted here.
    const downIndex = calls.findIndex((args) => args[0] === 'send-keys' && args[3] === 'Down');
    const trustEnterIndex = calls.findIndex(
      (args, i) => args[0] === 'send-keys' && args.includes('Enter') && i > downIndex,
    );
    expect(downIndex).toBeGreaterThanOrEqual(0);
    expect(trustEnterIndex).toBeGreaterThan(downIndex);
    expect(calls.some((args) => args[0] === 'load-buffer')).toBe(false);
  });

  it('never sends Down when the trust prompt is not showing', async () => {
    // Arrange — an already-trusted directory: the pane never shows the prompt.
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
      paneIdleOptions: {
        timeoutMs: 1000,
        intervalMs: 0,
        stableChecks: 1,
        postPasteDelayMs: 0,
        maxSubmitRetries: 0,
        submitRetryIntervalMs: 0,
        // No process name to match in these mocks — skip the foreground-command gate.
        foregroundCommandTimeoutMs: 0,
        trustPromptTimeoutMs: 0,
      },
    });

    // Act
    await backend.create({
      taskId: 'trustedtask',
      taskTitle: 'Already trusted',
      slot: 'primary',
      repoPath: '/tmp/repo',
      branch: 'ab/already-trusted-0001',
      agentCli: 'claude',
      cwd: '/tmp/repo',
      baseBranch: 'main',
      usesWorktree: false,
      sessionBootstrapScript: '/tmp/bootstrap.sh',
      initialPrompt: 'Fix the flaky test.',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Assert
    expect(calls.some((args) => args[0] === 'send-keys' && args[3] === 'Down')).toBe(false);
  });

  it('catches a trust prompt that only renders after the first capture', async () => {
    // Arrange — the pane shows nothing on the very first capture, as if the
    // agent's process hasn't painted yet, and the trust screen appears only
    // afterwards. A one-shot check would miss this entirely, which is why the
    // dismissal is a bounded poll rather than a snapshot.
    const TRUST_SCREEN = 'Quick safety check\n  No, exit\n❯ Yes, I trust this folder';
    const calls: string[][] = [];
    let trustAccepted = false;
    let captures = 0;
    const runner: TmuxCommandRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'has-session') {
        throw new Error('missing');
      }
      if (args[0] === 'send-keys' && args[3] === 'Down') {
        trustAccepted = true;
      }
      if (args[0] === 'capture-pane') {
        captures += 1;
        if (trustAccepted) {
          return { stdout: '', stderr: '' };
        }
        return { stdout: captures > 1 ? TRUST_SCREEN : '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };

    const backend = new TmuxBackend({
      runner,
      idGenerator: () => 'session-1',
      now: () => 123,
      paneIdleOptions: {
        timeoutMs: 1000,
        intervalMs: 0,
        stableChecks: 1,
        postPasteDelayMs: 0,
        maxSubmitRetries: 0,
        submitRetryIntervalMs: 0,
        trustPromptTimeoutMs: 1000,
        trustPromptIntervalMs: 0,
      },
    });

    // Act
    await backend.create({
      taskId: 'latetrust',
      taskTitle: 'Trust screen renders late',
      slot: 'primary',
      repoPath: '/tmp/repo',
      branch: 'ab/late-trust-0001',
      agentCli: 'claude',
      cwd: '/tmp/repo',
      baseBranch: 'main',
      usesWorktree: false,
      sessionBootstrapScript: '/tmp/bootstrap.sh',
      initialPrompt: 'Fix the flaky test.',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Assert — the poll caught it on a later capture, and answered it with
    // Down before Enter rather than a bare Enter.
    const downIndex = calls.findIndex((args) => args[0] === 'send-keys' && args[3] === 'Down');
    expect(downIndex).toBeGreaterThanOrEqual(0);
    expect(
      calls.findIndex((args, i) => args[0] === 'send-keys' && args.includes('Enter') && i > downIndex),
    ).toBeGreaterThan(downIndex);
  });
});

describe('TmuxBackend.peekPane', () => {
  it('captures the current pane content by its resolved target', async () => {
    // Arrange
    const runner: TmuxCommandRunner = async (args) => {
      if (args[0] === 'list-panes') {
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'capture-pane') {
        return { stdout: 'whatever is on screen right now', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
    const backend = new TmuxBackend({ runner });

    // Act
    const content = await backend.peekPane('ab_task_1234_p');

    // Assert
    expect(content).toBe('whatever is on screen right now');
  });
});
