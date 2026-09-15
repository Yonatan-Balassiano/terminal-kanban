import { describe, it, expect, vi } from 'vitest';
import { SshTmuxBackend } from '../src/services/session-backends/ssh.js';
import type { TmuxCommandResult } from '../src/services/session-backends/tmux.js';
import { TransportUnreachableError } from '../src/services/transport/types.js';
import type { CreateSessionOpts } from '../src/types/index.js';

const SESSION_NAME = 'ab_remote_task_1234_p';

interface Harness {
  backend: SshTmuxBackend;
  remoteCalls: string[][];
  localCalls: string[][];
}

interface HarnessOptions {
  /** Remote tmux responses keyed by the first argument (the tmux subcommand). */
  remote?: (args: string[]) => TmuxCommandResult;
  local?: (args: string[]) => TmuxCommandResult;
  writeFileIfChanged?: () => Promise<boolean>;
}

function fail(message = 'no such session'): never {
  throw new Error(message);
}

function ok(stdout = ''): TmuxCommandResult {
  return { stdout, stderr: '' };
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const remoteCalls: string[][] = [];
  const localCalls: string[][] = [];

  const transport = {
    host: 'test.host',
    id: 'ssh:test.host',
    isRemote: true,
    exec: vi.fn(async () => ({ stdout: '/home/coder', stderr: '', exitCode: 0 })),
    exists: vi.fn(async () => true),
    mkdirp: vi.fn(async () => undefined),
    removeDir: vi.fn(async () => undefined),
    writeFileIfChanged: vi.fn(options.writeFileIfChanged ?? (async () => true)),
    reachability: vi.fn(async () => 'ok' as const),
  };

  const backend = new SshTmuxBackend({
    transport: transport as never,
    host: 'test.host',
    remoteRunner: async (args) => {
      remoteCalls.push(args);
      return options.remote ? options.remote(args) : ok();
    },
    localRunner: async (args) => {
      localCalls.push(args);
      return options.local ? options.local(args) : ok();
    },
    idGenerator: () => 'session-id',
    now: () => 1_000,
  });

  return { backend, remoteCalls, localCalls };
}

function createOpts(): CreateSessionOpts {
  return {
    taskId: '1234abcd',
    taskTitle: 'remote task',
    slot: 'primary',
    repoPath: '/home/coder/project/monorepo',
    branch: 'ab/remote-task-0001',
    agentCli: 'claude',
    cwd: '/home/coder/project/.monorepo-worktrees/ab--remote-task-0001',
    baseBranch: 'master',
    usesWorktree: true,
    sessionBootstrapScript: 'scripts/session-bootstrap.sh',
  };
}

describe('SshTmuxBackend.inspect', () => {
  it('reads liveness and pane info in a single remote round trip', async () => {
    // Arrange — the TUI polls every 2.5s and each SSH hop costs ~400ms.
    const { backend, remoteCalls } = makeHarness({ remote: () => ok('4242 claude\n') });

    // Act
    const info = await backend.inspect(SESSION_NAME);

    // Assert
    expect(remoteCalls.length).toBe(1);
    expect(info).toMatchObject({ backendSessionId: SESSION_NAME, status: 'active', shellPid: 4242 });
  });

  it('returns null when the remote session is genuinely gone', async () => {
    // Arrange
    const { backend } = makeHarness({ remote: () => fail() });

    // Act + Assert
    expect(await backend.inspect(SESSION_NAME)).toBeNull();
  });

  it('throws rather than reporting the session dead when the host is unreachable', async () => {
    // Arrange — reporting null here would make SessionManager destroy and
    // recreate a remote session that is still running the agent.
    const { backend } = makeHarness({
      remote: () => {
        throw new TransportUnreachableError('vpn down');
      },
    });

    // Act + Assert
    await expect(backend.inspect(SESSION_NAME)).rejects.toBeInstanceOf(TransportUnreachableError);
  });

  it('caches within its window so a poll storm costs one round trip', async () => {
    // Arrange
    const { backend, remoteCalls } = makeHarness({ remote: () => ok('4242 claude\n') });

    // Act
    await backend.inspect(SESSION_NAME);
    await backend.inspect(SESSION_NAME);
    await backend.inspect(SESSION_NAME);

    // Assert
    expect(remoteCalls.length).toBe(1);
  });
});

describe('SshTmuxBackend.create', () => {
  it('creates the remote session and the local wrapper on a cold start', async () => {
    // Arrange — nothing exists on either side yet.
    const { backend, remoteCalls, localCalls } = makeHarness({
      remote: (args) => (args[0] === 'has-session' ? fail() : ok()),
      local: (args) => (args[0] === 'has-session' ? fail() : ok()),
    });

    // Act
    const session = await backend.create(createOpts());

    // Assert
    expect(session.backendType).toBe('ssh');
    expect(remoteCalls.some((c) => c[0] === 'new-session')).toBe(true);
    expect(localCalls.some((c) => c[0] === 'new-session')).toBe(true);
  });

  it('adopts a live remote session without re-running bootstrap', async () => {
    // Arrange — the remote session survived; only the wrapper is missing.
    const { backend, remoteCalls } = makeHarness({
      remote: () => ok('4242 claude\n'),
      local: (args) => (args[0] === 'has-session' ? fail() : ok()),
    });

    // Act
    await backend.create(createOpts());

    // Assert — no new remote session, and no bootstrap typed into the pane.
    expect(remoteCalls.some((c) => c[0] === 'new-session')).toBe(false);
    expect(remoteCalls.some((c) => c[0] === 'send-keys')).toBe(false);
  });

  it('rebuilds a missing wrapper for a surviving remote session', async () => {
    // Arrange — this is the revival case after a dropped VPN.
    const { backend, localCalls } = makeHarness({
      remote: () => ok('4242 claude\n'),
      local: (args) => (args[0] === 'has-session' ? fail() : ok()),
    });

    // Act
    await backend.create(createOpts());

    // Assert
    expect(localCalls.some((c) => c[0] === 'new-session')).toBe(true);
  });
});

describe('SshTmuxBackend.attachMetadata', () => {
  it('rebuilds the wrapper before handing back an attach command', async () => {
    // Arrange
    const { backend, localCalls } = makeHarness({
      local: (args) => (args[0] === 'has-session' ? fail() : ok()),
    });

    // Act
    const metadata = await backend.attachMetadata(SESSION_NAME);

    // Assert
    expect(localCalls.some((c) => c[0] === 'new-session')).toBe(true);
    expect(metadata.command).toContain(SESSION_NAME);
  });

  it('does not create a second wrapper when the pane was joined into the board', async () => {
    // Arrange — the layout engine destroys the ab_* session but keeps the tagged
    // pane alive. A second wrapper would mean two SSH clients on one remote
    // session, which makes tmux shrink it to the smaller client.
    const { backend, localCalls } = makeHarness({
      local: (args) => {
        if (args[0] === 'has-session') fail();
        if (args[0] === 'list-panes') return ok(`%7\t${SESSION_NAME}\n`);
        return ok();
      },
    });

    // Act
    await backend.attachMetadata(SESSION_NAME);

    // Assert
    expect(localCalls.some((c) => c[0] === 'new-session')).toBe(false);
  });
});

describe('SshTmuxBackend.terminate', () => {
  it('kills both the local wrapper and the remote session', async () => {
    // Arrange
    const { backend, remoteCalls, localCalls } = makeHarness();

    // Act
    await backend.terminate(SESSION_NAME);

    // Assert
    expect(localCalls.some((c) => c[0] === 'kill-session')).toBe(true);
    expect(remoteCalls.some((c) => c[0] === 'kill-session')).toBe(true);
  });

  it('still kills the remote session when the local wrapper is already gone', async () => {
    // Arrange
    const { backend, remoteCalls } = makeHarness({ local: () => fail('no server') });

    // Act
    await backend.terminate(SESSION_NAME);

    // Assert
    expect(remoteCalls.some((c) => c[0] === 'kill-session')).toBe(true);
  });
});

describe('SshTmuxBackend.healthCheck', () => {
  it('reports unavailable without probing tmux when the host is unreachable', async () => {
    // Arrange
    const remoteCalls: string[][] = [];
    const backend = new SshTmuxBackend({
      transport: {
        host: 'test.host',
        reachability: async () => 'unreachable' as const,
      } as never,
      host: 'test.host',
      remoteRunner: async (args) => {
        remoteCalls.push(args);
        return ok();
      },
      localRunner: async () => ok(),
    });

    // Act
    const health = await backend.healthCheck();

    // Assert — no point spending a round trip on a host we cannot reach.
    expect(health.available).toBe(false);
    expect(remoteCalls.length).toBe(0);
  });

  it('reports available when the host answers and remote tmux runs', async () => {
    // Arrange
    const { backend } = makeHarness({ remote: () => ok('tmux 3.2a') });

    // Act
    const health = await backend.healthCheck();

    // Assert
    expect(health).toMatchObject({ available: true, version: 'tmux 3.2a' });
  });
});

describe('duplicate pane tags', () => {
  it('clears the tag from a stale pane so the layout joins only one', async () => {
    // Arrange — a previous pane for this task is still parked and tagged. The
    // layout engine joins every tagged pane it finds, so a leftover would be
    // dragged in beside the live one.
    const localCalls: string[][] = [];
    const backend = new SshTmuxBackend({
      transport: {
        host: 'test.host',
        reachability: async () => 'ok' as const,
      } as never,
      host: 'test.host',
      remoteRunner: async () => ok(),
      localRunner: async (args) => {
        localCalls.push(args);
        if (args[0] === 'display-message') return ok('%9\n');
        if (args[0] === 'list-panes') return ok(`%5\t${SESSION_NAME}\n%9\t${SESSION_NAME}\n`);
        return ok();
      },
    });

    // Act
    await backend.attachMetadata(SESSION_NAME);

    // Assert — the stale pane is untagged, the fresh one is left alone.
    const untagged = localCalls.filter((c) => c[0] === 'set-option' && c.includes('-u'));
    expect(untagged.length).toBe(1);
    expect(untagged[0]).toContain('%5');
    expect(untagged.flat()).not.toContain('%9');
  });

  it('leaves tags alone when the session pane cannot be resolved', async () => {
    // Arrange — the wrapper session is gone but its pane is parked and tagged.
    // Clearing that tag would make the session unfindable and unrevivable.
    const localCalls: string[][] = [];
    const backend = new SshTmuxBackend({
      transport: {
        host: 'test.host',
        reachability: async () => 'ok' as const,
      } as never,
      host: 'test.host',
      remoteRunner: async () => ok(),
      localRunner: async (args) => {
        localCalls.push(args);
        if (args[0] === 'display-message') fail('no such session');
        if (args[0] === 'list-panes') return ok(`%5\t${SESSION_NAME}\n`);
        return ok();
      },
    });

    // Act
    await backend.attachMetadata(SESSION_NAME);

    // Assert
    expect(localCalls.filter((c) => c[0] === 'set-option' && c.includes('-u')).length).toBe(0);
  });
});

describe('SshTmuxBackend.resetAttachment', () => {
  it('kills the tagged panes and the wrapper session so the next attach rebuilds', async () => {
    // Arrange — the state a card gets stuck in: a pane still carrying the tag
    // but no longer running the attach loop. ensureWrapper reads that tag as a
    // living wrapper and never rebuilds.
    const localCalls: string[][] = [];
    const remoteCalls: string[][] = [];
    const backend = new SshTmuxBackend({
      transport: { host: 'test.host', reachability: async () => 'ok' as const } as never,
      host: 'test.host',
      remoteRunner: async (args) => {
        remoteCalls.push(args);
        return ok();
      },
      localRunner: async (args) => {
        localCalls.push(args);
        if (args[0] === 'list-panes') return ok(`%5\t${SESSION_NAME}\n%9\t${SESSION_NAME}\n`);
        return ok();
      },
    });

    // Act
    await backend.resetAttachment(SESSION_NAME);

    // Assert — both tagged panes go, along with any surviving wrapper session.
    const killedPanes = localCalls.filter((c) => c[0] === 'kill-pane').flat();
    expect(killedPanes).toContain('%5');
    expect(killedPanes).toContain('%9');
    expect(localCalls.some((c) => c[0] === 'kill-session' && c.includes(SESSION_NAME))).toBe(true);

    // The remote session holds the agent and must not be touched.
    expect(remoteCalls).toEqual([]);
  });

  it('succeeds when there is no local plumbing left to remove', async () => {
    const backend = new SshTmuxBackend({
      transport: { host: 'test.host', reachability: async () => 'ok' as const } as never,
      host: 'test.host',
      remoteRunner: async () => ok(),
      localRunner: async () => fail('no server running'),
    });

    await expect(backend.resetAttachment(SESSION_NAME)).resolves.toBeUndefined();
  });

  it('rebuilds a fresh wrapper on the attach that follows', async () => {
    // Arrange — after the reset there are no tagged panes and no wrapper session.
    const localCalls: string[][] = [];
    const backend = new SshTmuxBackend({
      transport: { host: 'test.host', reachability: async () => 'ok' as const } as never,
      host: 'test.host',
      remoteRunner: async () => ok(),
      localRunner: async (args) => {
        localCalls.push(args);
        if (args[0] === 'has-session') fail('no such session');
        if (args[0] === 'list-panes') return ok('');
        if (args[0] === 'display-message') return ok('%1\n');
        return ok();
      },
    });

    // Act
    await backend.attachMetadata(SESSION_NAME);

    // Assert
    const created = localCalls.find((c) => c[0] === 'new-session');
    expect(created).toBeDefined();
    expect(created).toContain(SESSION_NAME);
    expect(created?.join(' ')).toContain('remote-attach.sh');
  });
});

describe('SshTmuxBackend.redeliverPrompt', () => {
  it('parks a fresh brief on the remote host, pastes it, and submits it', async () => {
    // Arrange — the manual escape hatch: no prior create() call, just an
    // already-live remote session that automatic delivery failed to reach.
    const writtenBriefs: Record<string, string> = {};
    const transport = {
      host: 'test.host',
      id: 'ssh:test.host',
      isRemote: true,
      exec: vi.fn(async () => ({ stdout: '/home/coder', stderr: '', exitCode: 0 })),
      exists: vi.fn(async () => true),
      mkdirp: vi.fn(async () => undefined),
      removeDir: vi.fn(async () => undefined),
      writeFileIfChanged: vi.fn(async (path: string, content: string) => {
        writtenBriefs[path] = content;
        return true;
      }),
      reachability: vi.fn(async () => 'ok' as const),
    };

    const remoteCalls: string[][] = [];
    let pasted = false;
    const backend = new SshTmuxBackend({
      transport: transport as never,
      host: 'test.host',
      remoteRunner: async (args) => {
        remoteCalls.push(args);
        if (args[0] === 'paste-buffer') {
          pasted = true;
        }
        if (args[0] === 'capture-pane' && pasted) {
          // Simulate the paste rendering, for the new paste-verification step.
          return ok('Please continue where you left off.');
        }
        return ok();
      },
      localRunner: async () => ok(),
      idGenerator: () => 'session-id',
      now: () => 1_000,
      paneIdleOptions: {
        timeoutMs: 1000,
        intervalMs: 0,
        stableChecks: 1,
        postPasteDelayMs: 0,
        maxSubmitRetries: 0,
        submitRetryIntervalMs: 0,
        trustPromptTimeoutMs: 0,
      },
    });

    // Act
    const delivered = await backend.redeliverPrompt(
      SESSION_NAME,
      'primary',
      SESSION_NAME,
      'Please continue where you left off.',
    );

    // Assert
    expect(delivered).toBe('delivered');
    const loadIndex = remoteCalls.findIndex((args) => args[0] === 'load-buffer');
    const pasteIndex = remoteCalls.findIndex((args) => args[0] === 'paste-buffer');
    const enterIndex = remoteCalls.findIndex((args) => args[0] === 'send-keys' && args.includes('Enter'));
    expect(loadIndex).toBeGreaterThanOrEqual(0);
    expect(pasteIndex).toBeGreaterThan(loadIndex);
    expect(enterIndex).toBeGreaterThan(pasteIndex);

    const remoteBriefFile = remoteCalls[loadIndex]![3]!;
    expect(writtenBriefs[remoteBriefFile]).toBe('Please continue where you left off.');
  });

  it('does not paste a second copy when the brief is already sitting in the remote pane', async () => {
    // Arrange — the duplicate-run case, mirroring TmuxBackend's. Re-running
    // the command used to stack another copy underneath the first.
    const PROMPT = 'Please continue where you left off.';
    const transport = {
      host: 'test.host',
      id: 'ssh:test.host',
      isRemote: true,
      exec: vi.fn(async () => ({ stdout: '/home/coder', stderr: '', exitCode: 0 })),
      exists: vi.fn(async () => true),
      mkdirp: vi.fn(async () => undefined),
      removeDir: vi.fn(async () => undefined),
      writeFileIfChanged: vi.fn(async () => true),
      reachability: vi.fn(async () => 'ok' as const),
    };

    const remoteCalls: string[][] = [];
    const backend = new SshTmuxBackend({
      transport: transport as never,
      host: 'test.host',
      remoteRunner: async (args) => {
        remoteCalls.push(args);
        if (args[0] === 'capture-pane') {
          return ok(`> ${PROMPT}`);
        }
        return ok();
      },
      localRunner: async () => ok(),
      idGenerator: () => 'session-id',
      now: () => 1_000,
      paneIdleOptions: {
        timeoutMs: 1000,
        intervalMs: 0,
        stableChecks: 1,
        postPasteDelayMs: 0,
        maxSubmitRetries: 0,
        submitRetryIntervalMs: 0,
        trustPromptTimeoutMs: 0,
        pasteVerifyTimeoutMs: 20,
        pasteVerifyIntervalMs: 1,
      },
    });

    // Act — `skipIfAlreadyOnPane` is `SessionManager.redeliverInitialPrompt`'s
    // alone; without it this same call pastes (see the notify test below).
    const delivered = await backend.redeliverPrompt(
      SESSION_NAME,
      'primary',
      SESSION_NAME,
      PROMPT,
      undefined,
      { skipIfAlreadyOnPane: true },
    );

    // Assert — nothing re-pasted, but the missing Enter is still sent.
    expect(delivered).toBe('delivered');
    expect(remoteCalls.filter((args) => args[0] === 'paste-buffer')).toHaveLength(0);
    expect(
      remoteCalls.filter((args) => args[0] === 'send-keys' && args.includes('Enter')),
    ).toHaveLength(1);
  });

  it('pastes a repeated notify even with the same text still on the remote pane', async () => {
    // Arrange — the notify path, mirroring TmuxBackend's: same call, no
    // `skipIfAlreadyOnPane`. The text is a new message, not a re-send, so a
    // marker match must not stop it reaching the agent.
    const PROMPT = 'Please check SEC-1 progress.';
    const transport = {
      host: 'test.host',
      id: 'ssh:test.host',
      isRemote: true,
      exec: vi.fn(async () => ({ stdout: '/home/coder', stderr: '', exitCode: 0 })),
      exists: vi.fn(async () => true),
      mkdirp: vi.fn(async () => undefined),
      removeDir: vi.fn(async () => undefined),
      writeFileIfChanged: vi.fn(async () => true),
      reachability: vi.fn(async () => 'ok' as const),
    };

    const remoteCalls: string[][] = [];
    const backend = new SshTmuxBackend({
      transport: transport as never,
      host: 'test.host',
      remoteRunner: async (args) => {
        remoteCalls.push(args);
        if (args[0] === 'capture-pane') {
          return ok(`> ${PROMPT}`);
        }
        return ok();
      },
      localRunner: async () => ok(),
      idGenerator: () => 'session-id',
      now: () => 1_000,
      paneIdleOptions: {
        timeoutMs: 1000,
        intervalMs: 0,
        stableChecks: 1,
        postPasteDelayMs: 0,
        maxSubmitRetries: 0,
        submitRetryIntervalMs: 0,
        trustPromptTimeoutMs: 0,
        pasteVerifyTimeoutMs: 20,
        pasteVerifyIntervalMs: 1,
      },
    });

    // Act — exactly how `notifyTaskSession` calls it.
    const delivered = await backend.redeliverPrompt(SESSION_NAME, 'primary', SESSION_NAME, PROMPT);

    // Assert — pasted and submitted, not silently skipped.
    expect(delivered).toBe('delivered');
    expect(remoteCalls.filter((args) => args[0] === 'paste-buffer')).toHaveLength(1);
    expect(
      remoteCalls.filter((args) => args[0] === 'send-keys' && args.includes('Enter')),
    ).toHaveLength(1);
  });

  it('resolves false, without submitting anything, when the pasted text never renders', async () => {
    // Arrange — the remote pane stays empty no matter how many times the
    // brief is pasted, mirroring TmuxBackend's never-lands case.
    const transport = {
      host: 'test.host',
      id: 'ssh:test.host',
      isRemote: true,
      exec: vi.fn(async () => ({ stdout: '/home/coder', stderr: '', exitCode: 0 })),
      exists: vi.fn(async () => true),
      mkdirp: vi.fn(async () => undefined),
      removeDir: vi.fn(async () => undefined),
      writeFileIfChanged: vi.fn(async () => true),
      reachability: vi.fn(async () => 'ok' as const),
    };

    const remoteCalls: string[][] = [];
    const backend = new SshTmuxBackend({
      transport: transport as never,
      host: 'test.host',
      remoteRunner: async (args) => {
        remoteCalls.push(args);
        return ok();
      },
      localRunner: async () => ok(),
      idGenerator: () => 'session-id',
      now: () => 1_000,
      paneIdleOptions: {
        timeoutMs: 1000,
        intervalMs: 0,
        stableChecks: 1,
        postPasteDelayMs: 0,
        maxSubmitRetries: 0,
        submitRetryIntervalMs: 0,
        trustPromptTimeoutMs: 0,
        pasteVerifyTimeoutMs: 0,
        pasteVerifyIntervalMs: 0,
        maxPasteAttempts: 3,
      },
    });

    // Act
    const delivered = await backend.redeliverPrompt(
      SESSION_NAME,
      'primary',
      SESSION_NAME,
      'This never renders on the pane.',
    );

    // Assert — never submitted: pasted up to the retry limit, but no Enter
    // sent for the brief itself.
    expect(delivered).toBe('not-delivered');
    expect(remoteCalls.filter((args) => args[0] === 'paste-buffer')).toHaveLength(3);
    expect(remoteCalls.filter((args) => args[0] === 'send-keys' && args.includes('Enter'))).toHaveLength(0);
  });
});

describe('SshTmuxBackend.create initial brief', () => {
  it('never pastes the brief into the pane — it rides the agent CLI argv', async () => {
    // Arrange — the remote session-bootstrap.sh reads the brief file and hands
    // its contents to the agent as an argument, so there is nothing for the
    // daemon to type, wait for, or verify. Everything the old paste pipeline
    // guessed at (is the CLI up, is it listening, did the text arrive intact,
    // did Enter submit it) simply stops being a question.
    const remoteCalls: string[][] = [];
    const backend = new SshTmuxBackend({
      transport: {
        host: 'test.host',
        id: 'ssh:test.host',
        isRemote: true,
        exec: vi.fn(async () => ({ stdout: '/home/coder', stderr: '', exitCode: 0 })),
        exists: vi.fn(async () => true),
        mkdirp: vi.fn(async () => undefined),
        removeDir: vi.fn(async () => undefined),
        writeFileIfChanged: vi.fn(async () => true),
        reachability: vi.fn(async () => 'ok' as const),
      } as never,
      host: 'test.host',
      remoteRunner: async (args) => {
        remoteCalls.push(args);
        if (args[0] === 'has-session') {
          throw new Error('missing');
        }
        return ok();
      },
      localRunner: async (args) => {
        if (args[0] === 'has-session') {
          throw new Error('missing');
        }
        return ok();
      },
      idGenerator: () => 'session-id',
      now: () => 1_000,
      paneIdleOptions: {
        timeoutMs: 1000,
        intervalMs: 0,
        stableChecks: 1,
        postPasteDelayMs: 0,
        maxSubmitRetries: 0,
        submitRetryIntervalMs: 0,
        trustPromptTimeoutMs: 0,
      },
    });

    // Act
    await backend.create({ ...createOpts(), initialPrompt: 'Ship the thing.' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Assert
    expect(remoteCalls.filter((args) => args[0] === 'load-buffer')).toHaveLength(0);
    expect(remoteCalls.filter((args) => args[0] === 'paste-buffer')).toHaveLength(0);
  });

  it('writes its settings to the remote host and types only their path', async () => {
    // Arrange — a worktree-failure notice alone used to push the typed line past
    // the 1024 bytes a starting shell keeps, cutting off the Enter with it.
    const remoteCalls: string[][] = [];
    const writeFileIfChanged = vi.fn(
      async (_path: string, _contents: string, _mode?: number) => true,
    );
    const backend = new SshTmuxBackend({
      transport: {
        host: 'test.host',
        id: 'ssh:test.host',
        isRemote: true,
        exec: vi.fn(async () => ({ stdout: '/home/coder', stderr: '', exitCode: 0 })),
        exists: vi.fn(async () => true),
        mkdirp: vi.fn(async () => undefined),
        removeDir: vi.fn(async () => undefined),
        writeFileIfChanged,
        reachability: vi.fn(async () => 'ok' as const),
      } as never,
      host: 'test.host',
      remoteRunner: async (args) => {
        remoteCalls.push(args);
        if (args[0] === 'has-session') {
          throw new Error('missing');
        }
        return ok();
      },
      localRunner: async (args) => {
        if (args[0] === 'has-session') {
          throw new Error('missing');
        }
        return ok();
      },
      idGenerator: () => 'session-id',
      now: () => 1_000,
      paneIdleOptions: {
        timeoutMs: 1000,
        intervalMs: 0,
        stableChecks: 1,
        postPasteDelayMs: 0,
        maxSubmitRetries: 0,
        submitRetryIntervalMs: 0,
        trustPromptTimeoutMs: 0,
      },
    });
    const notice = `Git command failed: git worktree add\n${'fatal: already used\n'.repeat(100)}`;

    // Act
    await backend.create({ ...createOpts(), bootstrapNotice: notice });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Assert
    const settingsPath = '/home/coder/.agentboard/briefs/1234abcd-primary-env.sh';
    const settings = writeFileIfChanged.mock.calls.find(([path]) => path === settingsPath);
    expect(settings?.[1]).toContain(notice);
    const typed = remoteCalls
      .filter((args) => args[0] === 'send-keys' && args[3] === '-l')
      .map((args) => args[4])
      .join('');
    expect(typed).toContain(`AGENTBOARD_BOOTSTRAP_ENV_FILE=${settingsPath}`);
    expect(typed).not.toContain('Git command failed');
    expect(Buffer.byteLength(typed)).toBeLessThan(1024);
  });
});

describe('SshTmuxBackend auto-trust', () => {
  it('accepts a never-trusted-folder prompt (Down, then Enter) on session start', async () => {
    // Arrange — the remote pane shows the real trust screen until Down is
    // sent, then settles on the CLI's normal ready screen for everything
    // after — mirrors TmuxBackend's equivalent test.
    const TRUST_SCREEN = 'Quick safety check\n  No, exit\n❯ Yes, I trust this folder';
    let trustAccepted = false;
    const remoteCalls: string[][] = [];
    const transport = {
      host: 'test.host',
      id: 'ssh:test.host',
      isRemote: true,
      exec: vi.fn(async () => ({ stdout: '/home/coder', stderr: '', exitCode: 0 })),
      exists: vi.fn(async () => true),
      mkdirp: vi.fn(async () => undefined),
      removeDir: vi.fn(async () => undefined),
      writeFileIfChanged: vi.fn(async () => true),
      reachability: vi.fn(async () => 'ok' as const),
    };

    const backend = new SshTmuxBackend({
      transport: transport as never,
      host: 'test.host',
      remoteRunner: async (args) => {
        remoteCalls.push(args);
        if (args[0] === 'has-session') fail();
        if (args[0] === 'send-keys' && args[3] === 'Down') {
          trustAccepted = true;
        }
        if (args[0] === 'capture-pane') {
          return ok(trustAccepted ? '' : TRUST_SCREEN);
        }
        return ok();
      },
      localRunner: async () => ok(),
      idGenerator: () => 'session-id',
      now: () => 1_000,
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
    await backend.create({ ...createOpts(), initialPrompt: 'Fix the flaky test.' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Assert — Down before Enter, never a bare Enter, which would pick the
    // default-highlighted "No, exit" and quit the CLI.
    const downIndex = remoteCalls.findIndex((args) => args[0] === 'send-keys' && args[3] === 'Down');
    const trustEnterIndex = remoteCalls.findIndex(
      (args, i) => args[0] === 'send-keys' && args.includes('Enter') && i > downIndex,
    );
    expect(downIndex).toBeGreaterThanOrEqual(0);
    expect(trustEnterIndex).toBeGreaterThan(downIndex);
    // Nothing is pasted on a session start any more — the brief reaches the
    // agent through its own argv.
    expect(remoteCalls.some((args) => args[0] === 'load-buffer')).toBe(false);
  });

  it('catches a trust prompt that only renders after the first capture', async () => {
    // Arrange — mirrors TmuxBackend's equivalent test: nothing on the very
    // first capture, as if claude's process hasn't started yet; the trust
    // screen only appears once waitForForegroundCommand confirms it's
    // foreground.
    const TRUST_SCREEN = 'Quick safety check\n  No, exit\n❯ Yes, I trust this folder';
    let trustAccepted = false;
    let captures = 0;
    const remoteCalls: string[][] = [];
    const transport = {
      host: 'test.host',
      id: 'ssh:test.host',
      isRemote: true,
      exec: vi.fn(async () => ({ stdout: '/home/coder', stderr: '', exitCode: 0 })),
      exists: vi.fn(async () => true),
      mkdirp: vi.fn(async () => undefined),
      removeDir: vi.fn(async () => undefined),
      writeFileIfChanged: vi.fn(async () => true),
      reachability: vi.fn(async () => 'ok' as const),
    };

    const backend = new SshTmuxBackend({
      transport: transport as never,
      host: 'test.host',
      remoteRunner: async (args) => {
        remoteCalls.push(args);
        if (args[0] === 'has-session') fail();
        if (args[0] === 'list-panes' && args.includes('#{pane_pid} #{pane_current_command}')) {
          captures += 0;
          return ok('1 claude');
        }
        if (args[0] === 'send-keys' && args[3] === 'Down') {
          trustAccepted = true;
        }
        if (args[0] === 'capture-pane') {
          if (trustAccepted) {
            return ok('');
          }
          captures += 1;
          return ok(captures > 1 ? TRUST_SCREEN : '');
        }
        return ok();
      },
      localRunner: async () => ok(),
      idGenerator: () => 'session-id',
      now: () => 1_000,
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
    await backend.create({ ...createOpts(), initialPrompt: 'Fix the flaky test.' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Assert — the second check caught it: Down was sent after the
    // foreground process was confirmed, and the brief was still delivered.
    const foregroundIndex = remoteCalls.findIndex(
      (args) => args[0] === 'list-panes' && args.includes('#{pane_pid} #{pane_current_command}'),
    );
    const downIndex = remoteCalls.findIndex((args) => args[0] === 'send-keys' && args[3] === 'Down');
    expect(downIndex).toBeGreaterThanOrEqual(0);
    expect(
      remoteCalls.findIndex(
        (args, i) => args[0] === 'send-keys' && args.includes('Enter') && i > downIndex,
      ),
    ).toBeGreaterThan(downIndex);
  });
});

describe('SshTmuxBackend.peekPane', () => {
  it('captures the remote pane content directly by backend session id', async () => {
    // Arrange
    const { backend } = makeHarness({
      remote: (args) => (args[0] === 'capture-pane' ? ok('whatever is on screen right now') : ok()),
    });

    // Act
    const content = await backend.peekPane(SESSION_NAME);

    // Assert
    expect(content).toBe('whatever is on screen right now');
  });
});
