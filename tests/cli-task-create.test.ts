import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { BoardSnapshot, TaskRecord } from '../src/types/index.js';

const mocks = vi.hoisted(() => ({
  ensureRunning: vi.fn(),
  isDaemonRunning: vi.fn(),
  stopDaemon: vi.fn(),
  readPidFile: vi.fn(),
  createRPCClient: vi.fn(),
  openDb: vi.fn(),
  WorkspaceService: vi.fn(),
  GitService: vi.fn(),
}));

vi.mock('../src/daemon/index.js', () => ({
  ensureRunning: mocks.ensureRunning,
  isDaemonRunning: mocks.isDaemonRunning,
  stopDaemon: mocks.stopDaemon,
  readPidFile: mocks.readPidFile,
}));

vi.mock('../src/cli/rpc.js', () => ({
  createRPCClient: mocks.createRPCClient,
}));

vi.mock('../src/db/index.js', () => ({
  openDb: mocks.openDb,
}));

vi.mock('../src/services/workspace.js', () => ({
  WorkspaceService: mocks.WorkspaceService,
}));

vi.mock('../src/services/git.js', () => ({
  GitService: mocks.GitService,
}));

import { buildCli, composeTaskBrief } from '../src/cli/index.js';

const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

/** process.exit would take the test runner with it, so it throws instead. */
class ExitError extends Error {}
const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
  throw new ExitError(`exit ${code}`);
}) as never);

function makeBoard(patch: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return {
    repos: [
      {
        id: 'repo-1',
        label: 'Monorepo',
        path: '/repo',
        defaultBaseBranch: 'main',
        defaultPillarId: 'pillar-default',
        worktreeMode: 'auto',
        health: 'ok',
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    pillars: [
      { id: 'pillar-default', label: 'Platform' },
      { id: 'pillar-growth', label: 'Growth' },
    ],
    labels: [],
    tracks: [
      { id: 'backlog', label: 'Backlog', sortOrder: 0 },
      { id: 'in-progress', label: 'In Progress', sortOrder: 1 },
    ],
    tasks: [],
    savedViews: [],
    uiState: {},
    ...patch,
  };
}

function makeTask(patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1',
    title: 'Add rate limiting',
    kind: 'repo',
    repoId: 'repo-1',
    agentCli: 'claude',
    location: 'local',
    trackId: 'backlog',
    labels: [],
    branchName: 'ab/add-rate-limiting-1a2b',
    sortKey: 1000,
    prState: 'none',
    prDraft: false,
    ciState: 'none',
    reviewState: 'none',
    unresolvedThreadCount: 0,
    githubSyncStatus: 'idle',
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  } as TaskRecord;
}

/** An RPC client whose responses are keyed by method. */
function stubRpc(handlers: Record<string, unknown> = {}, boardOverride?: BoardSnapshot) {
  const board = boardOverride ?? makeBoard();
  const call = vi.fn(async (method: string) => {
    if (method in handlers) {
      return handlers[method];
    }
    if (method === 'getBoard') return board;
    if (method === 'createTask') return makeTask();
    throw new Error(`unexpected RPC: ${method}`);
  });
  const disconnect = vi.fn();
  mocks.createRPCClient.mockResolvedValue({ call, disconnect });
  return { call, disconnect };
}

function run(...args: string[]): Promise<unknown> {
  return buildCli().parseAsync(['node', 'agentboard', 'task', 'create', ...args]);
}

describe('agentboard task create', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureRunning.mockResolvedValue(undefined);
  });

  afterEach(() => {
    logSpy.mockClear();
    errorSpy.mockClear();
    exitSpy.mockClear();
    delete process.env['AGENTBOARD_TASK_ID'];
  });

  it('creates a repo task with the defaults the board already implies', async () => {
    // Arrange
    const { call, disconnect } = stubRpc();

    // Act
    await run('Add rate limiting');

    // Assert — pillar comes from the repo, and nothing is started.
    expect(call).toHaveBeenCalledWith('createTask', {
      title: 'Add rate limiting',
      kind: 'repo',
      repoId: 'repo-1',
      pillarId: 'pillar-default',
      agentCli: 'claude',
      location: 'local',
      trackId: 'backlog',
      description: undefined,
      initialPrompt: undefined,
    });
    expect(call).not.toHaveBeenCalledWith('openSession', expect.anything());
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('resolves repo and pillar by the label shown on the board', async () => {
    // Arrange
    const { call } = stubRpc();

    // Act
    await run('Add rate limiting', '--repo', 'monorepo', '--pillar', 'Growth');

    // Assert
    expect(call).toHaveBeenCalledWith(
      'createTask',
      expect.objectContaining({ repoId: 'repo-1', pillarId: 'pillar-growth' }),
    );
  });

  it('stores the context as both the card brief and the agent prompt', async () => {
    // Arrange
    const { call } = stubRpc();

    // Act
    await run('Add rate limiting', '--description', 'Cap the API at 100 rps.');

    // Assert
    expect(call).toHaveBeenCalledWith(
      'createTask',
      expect.objectContaining({
        description: 'Cap the API at 100 rps.',
        initialPrompt: 'Cap the API at 100 rps.',
      }),
    );
  });

  it('starts the agent on the brief when asked to', async () => {
    // Arrange
    const { call } = stubRpc({
      openSession: { id: 'session-1', attachCommand: 'tmux attach -t ab_task_1' },
    });

    // Act
    await run('Add rate limiting', '--description', 'Cap the API.', '--start');

    // Assert — the card is created first, then its session opened.
    expect(call).toHaveBeenCalledWith('openSession', { taskId: 'task-1' });
    expect(logSpy).toHaveBeenCalledWith(
      'Session started. Attach with: tmux attach -t ab_task_1',
    );
  });

  it('creates a general task with no repo', async () => {
    // Arrange
    const { call } = stubRpc({
      createTask: makeTask({ kind: 'general', repoId: undefined, branchName: undefined }),
    });

    // Act
    await run('Read the weekly digest', '--general');

    // Assert
    expect(call).toHaveBeenCalledWith(
      'createTask',
      expect.objectContaining({ kind: 'general', repoId: undefined, pillarId: undefined }),
    );
  });

  it('marks a card as a subtask when --parent is given', async () => {
    // Arrange
    const board = makeBoard({ tasks: [makeTask({ id: 'parent-1' })] });
    const { call } = stubRpc({}, board);

    // Act
    await run('Add rate limiting', '--parent', 'parent-1');

    // Assert
    expect(call).toHaveBeenCalledWith(
      'createTask',
      expect.objectContaining({ parentTaskId: 'parent-1' }),
    );
  });

  it('auto-detects the parent from the session it is run inside', async () => {
    // Arrange — set by the session bootstrap script, not passed by the user.
    process.env['AGENTBOARD_TASK_ID'] = 'parent-1';
    const board = makeBoard({ tasks: [makeTask({ id: 'parent-1' })] });
    const { call } = stubRpc({}, board);

    // Act
    await run('Add rate limiting');

    // Assert
    expect(call).toHaveBeenCalledWith(
      'createTask',
      expect.objectContaining({ parentTaskId: 'parent-1' }),
    );
  });

  it('an explicit --parent wins over the session it is run inside', async () => {
    // Arrange
    process.env['AGENTBOARD_TASK_ID'] = 'parent-1';
    const board = makeBoard({
      tasks: [makeTask({ id: 'parent-1' }), makeTask({ id: 'parent-2' })],
    });
    const { call } = stubRpc({}, board);

    // Act
    await run('Add rate limiting', '--parent', 'parent-2');

    // Assert
    expect(call).toHaveBeenCalledWith(
      'createTask',
      expect.objectContaining({ parentTaskId: 'parent-2' }),
    );
  });

  it('refuses an unknown --parent rather than creating an orphaned reference', async () => {
    // Arrange
    stubRpc();

    // Act + Assert
    await expect(run('Add rate limiting', '--parent', 'no-such-task')).rejects.toThrow(ExitError);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown --parent'));
  });

  describe('falling back to the worktree marker file', () => {
    // session-bootstrap.sh drops .agentboard/task-id in the worktree; the CLI
    // reads it when AGENTBOARD_TASK_ID never made it into this process's own
    // environment — e.g. a Bash tool call running through a sandbox that does
    // not forward the parent shell's env vars, but still runs with the right cwd.
    let originalCwd: string;
    let dir: string;

    beforeEach(() => {
      originalCwd = process.cwd();
      dir = mkdtempSync(join(tmpdir(), 'agentboard-marker-'));
    });

    afterEach(() => {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    });

    it('finds the marker by walking up from a nested cwd when the env var is absent', async () => {
      // Arrange
      delete process.env['AGENTBOARD_TASK_ID'];
      mkdirSync(join(dir, '.agentboard'), { recursive: true });
      writeFileSync(join(dir, '.agentboard', 'task-id'), 'parent-1', 'utf8');
      const nested = join(dir, 'src', 'deep');
      mkdirSync(nested, { recursive: true });
      process.chdir(nested);
      const board = makeBoard({ tasks: [makeTask({ id: 'parent-1' })] });
      const { call } = stubRpc({}, board);

      // Act
      await run('Add rate limiting');

      // Assert
      expect(call).toHaveBeenCalledWith(
        'createTask',
        expect.objectContaining({ parentTaskId: 'parent-1' }),
      );
    });

    it('prefers the env var over the marker file when both are present', async () => {
      // Arrange
      process.env['AGENTBOARD_TASK_ID'] = 'parent-1';
      mkdirSync(join(dir, '.agentboard'), { recursive: true });
      writeFileSync(join(dir, '.agentboard', 'task-id'), 'parent-2', 'utf8');
      process.chdir(dir);
      const board = makeBoard({
        tasks: [makeTask({ id: 'parent-1' }), makeTask({ id: 'parent-2' })],
      });
      const { call } = stubRpc({}, board);

      // Act
      await run('Add rate limiting');

      // Assert
      expect(call).toHaveBeenCalledWith(
        'createTask',
        expect.objectContaining({ parentTaskId: 'parent-1' }),
      );
    });

    it('drops a stale auto-detected parent instead of refusing to create the card', async () => {
      // Arrange — the marker names a card that no longer exists (e.g. deleted).
      delete process.env['AGENTBOARD_TASK_ID'];
      mkdirSync(join(dir, '.agentboard'), { recursive: true });
      writeFileSync(join(dir, '.agentboard', 'task-id'), 'long-gone', 'utf8');
      process.chdir(dir);
      const { call } = stubRpc();

      // Act
      await run('Add rate limiting');

      // Assert — creation succeeds, just without a parent link.
      expect(call).toHaveBeenCalledWith(
        'createTask',
        expect.objectContaining({ parentTaskId: undefined }),
      );
    });
  });

  it('refuses a remote task on a repo that has no remote path', async () => {
    // Arrange
    stubRpc();

    // Act + Assert — caught before the card exists, not once the agent fails to start.
    await expect(run('Add rate limiting', '--location', 'remote')).rejects.toThrow(ExitError);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('no remotePath'));
  });

  it('refuses an unknown repo rather than guessing one', async () => {
    // Arrange
    stubRpc();

    // Act + Assert
    await expect(run('Add rate limiting', '--repo', 'nope')).rejects.toThrow(ExitError);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown repo "nope"'));
  });

  it('asks which repo when the board has more than one and none was named', async () => {
    // Arrange
    const board = makeBoard();
    board.repos.push({ ...board.repos[0]!, id: 'repo-2', label: 'SDK' });
    stubRpc({ getBoard: board });

    // Act + Assert
    await expect(run('Add rate limiting')).rejects.toThrow(ExitError);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Pass --repo'));
  });

  it('refuses a track the board does not have', async () => {
    // Arrange
    stubRpc();

    // Act + Assert
    await expect(run('Add rate limiting', '--track', 'someday')).rejects.toThrow(ExitError);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown --track "someday"'));
  });

  it('rejects --general combined with --repo', async () => {
    // Arrange
    stubRpc();

    // Act + Assert — the daemon is never contacted for a request that cannot mean anything.
    await expect(run('Anything', '--general', '--repo', 'repo-1')).rejects.toThrow(ExitError);
    expect(mocks.createRPCClient).not.toHaveBeenCalled();
  });
});

describe('composeTaskBrief', () => {
  it('passes the description through verbatim', () => {
    expect(composeTaskBrief({ description: 'Cap the API at 100 rps.' })).toBe(
      'Cap the API at 100 rps.',
    );
  });

  it('turns a lone plan URL into an instruction the agent can act on', () => {
    // A bare URL is not a prompt; AgentBoard never fetches it, the agent does.
    expect(composeTaskBrief({ planUrl: 'https://example.com/plan' })).toBe(
      'Read the plan at https://example.com/plan and execute it.',
    );
  });

  it('appends the plan URL under the context when both are given', () => {
    expect(
      composeTaskBrief({ description: 'Cap the API.', planUrl: 'https://example.com/plan' }),
    ).toBe('Cap the API.\n\nPlan: https://example.com/plan');
  });

  it('reads the context out of a file', () => {
    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'agentboard-brief-'));
    try {
      const file = join(dir, 'plan.md');
      writeFileSync(file, '# Plan\n\nStep one.\n');

      // Act + Assert
      expect(composeTaskBrief({ contextFile: file })).toBe('# Plan\n\nStep one.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails loudly on a context file that is not there', () => {
    expect(() => composeTaskBrief({ contextFile: '/no/such/plan.md' })).toThrow(
      'Context file not found',
    );
  });

  it('leaves a card with no context carrying no brief at all', () => {
    expect(composeTaskBrief({})).toBeUndefined();
    expect(composeTaskBrief({ description: '   ' })).toBeUndefined();
  });
});
