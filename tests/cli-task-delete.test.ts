import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

import { buildCli } from '../src/cli/index.js';

const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

class ExitError extends Error {}
const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
  throw new ExitError(`exit ${code}`);
}) as never);

function makeTask(patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1',
    title: 'My task',
    kind: 'repo',
    repoId: 'repo-1',
    agentCli: 'claude',
    location: 'local',
    trackId: 'in-progress',
    labels: [],
    sortKey: 1000,
    prState: 'none',
    prDraft: false,
    ciState: 'none',
    ciRequiredTotal: 0,
    ciRequiredPassed: 0,
    ciRequiredFailed: 0,
    ciRequiredPending: 0,
    reviewState: 'none',
    unresolvedThreadCount: 0,
    githubSyncStatus: 'idle',
    gitState: 'clean',
    gitAheadCount: 0,
    gitBehindCount: 0,
    hasUntracked: false,
    hasConflicts: false,
    sessionAttentionNeeded: false,
    branches: [],
    prCount: 0,
    prOpenCount: 0,
    prMergedCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

function makeBoard(patch: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return {
    repos: [],
    pillars: [],
    labels: [],
    tracks: [{ id: 'in-progress', label: 'In Progress', sortOrder: 0 }],
    tasks: [makeTask()],
    savedViews: [],
    uiState: {},
    ...patch,
  };
}

function stubRpc(handlers: Record<string, unknown> = {}, boardOverride?: BoardSnapshot) {
  const board = boardOverride ?? makeBoard();
  const call = vi.fn(async (method: string) => {
    if (method in handlers) {
      return handlers[method];
    }
    if (method === 'getBoard') return board;
    if (method === 'deleteTask')
      return { archivedShas: [], archiveRef: 'refs/agentboard/archive/task-1' };
    throw new Error(`unexpected RPC: ${method}`);
  });
  const disconnect = vi.fn();
  mocks.createRPCClient.mockResolvedValue({ call, disconnect });
  return { call, disconnect };
}

function run(...args: string[]): Promise<unknown> {
  return buildCli().parseAsync(['node', 'agentboard', 'task', 'delete', ...args]);
}

describe('agentboard task delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureRunning.mockResolvedValue(undefined);
  });

  afterEach(() => {
    logSpy.mockClear();
    errorSpy.mockClear();
    exitSpy.mockClear();
    process.exitCode = 0;
  });

  it('refuses to delete without --force, and calls nothing destructive', async () => {
    // Arrange
    const { call } = stubRpc();

    // Act
    await run('task-1');

    // Assert
    expect(call).not.toHaveBeenCalledWith('deleteTask', expect.anything());
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('About to delete task task-1'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Re-run with --force'));
    expect(process.exitCode).toBe(1);
  });

  it('warns about uncommitted changes it would discard', async () => {
    // Arrange
    const board = makeBoard({ tasks: [makeTask({ hasUntracked: true })] });
    stubRpc({}, board);

    // Act
    await run('task-1');

    // Assert
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('uncommitted changes'));
  });

  it('names the worktree that would be removed', async () => {
    // Arrange
    const board = makeBoard({ tasks: [makeTask({ worktreePath: '/repo/.worktrees/task-1' })] });
    stubRpc({}, board);

    // Act
    await run('task-1');

    // Assert
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('/repo/.worktrees/task-1'));
  });

  it('deletes immediately with --force', async () => {
    // Arrange
    const { call, disconnect } = stubRpc();

    // Act
    await run('task-1', '--force');

    // Assert
    expect(call).toHaveBeenCalledWith('deleteTask', { id: 'task-1', purge: false });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Deleted task task-1'));
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('says where the agent\'s uncommitted work was kept', async () => {
    // Arrange — agents write their findings into the worktree they work in, so
    // a delete that says only "Deleted" leaves people assuming it is gone.
    const { call } = stubRpc({
      deleteTask: { archivedShas: ['abc1234'], archiveRef: 'refs/agentboard/archive/task-1' },
    });

    // Act
    await run('task-1', '--force');

    // Assert
    expect(call).toHaveBeenCalledWith('deleteTask', { id: 'task-1', purge: false });
    const printed = logSpy.mock.calls.map(([line]) => String(line)).join('\n');
    expect(printed).toContain('abc1234');
    expect(printed).toContain('refs/agentboard/archive/task-1');
    expect(printed).toContain('git log -p');
  });

  it('destroys uncommitted work only when --purge is given', async () => {
    // Arrange — --force skips the confirmation; --purge is the separate,
    // explicit decision to throw the work away.
    const { call } = stubRpc({
      deleteTask: { archivedShas: [], archiveRef: 'refs/agentboard/archive/task-1' },
    });

    // Act
    await run('task-1', '--force', '--purge');

    // Assert
    expect(call).toHaveBeenCalledWith('deleteTask', { id: 'task-1', purge: true });
  });

  it('refuses an unknown task rather than calling deleteTask blind', async () => {
    // Arrange
    const { call } = stubRpc();

    // Act + Assert
    await expect(run('no-such-task', '--force')).rejects.toThrow(ExitError);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown task'));
    expect(call).not.toHaveBeenCalledWith('deleteTask', expect.anything());
  });
});
