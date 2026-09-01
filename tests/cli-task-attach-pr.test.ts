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
    gitState: 'unknown',
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
    repos: [
      {
        id: 'repo-1',
        label: 'Monorepo',
        path: '/repo',
        defaultBaseBranch: 'main',
        worktreeMode: 'auto',
        health: 'ok',
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'repo-2',
        label: 'Sibling repo',
        path: '/repo-2',
        defaultBaseBranch: 'main',
        worktreeMode: 'auto',
        health: 'ok',
        createdAt: 1,
        updatedAt: 1,
      },
    ],
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
    if (method === 'addTaskBranch') return board;
    throw new Error(`unexpected RPC: ${method}`);
  });
  const disconnect = vi.fn();
  mocks.createRPCClient.mockResolvedValue({ call, disconnect });
  return { call, disconnect };
}

function run(...args: string[]): Promise<unknown> {
  return buildCli().parseAsync(['node', 'agentboard', 'task', 'attach-pr', ...args]);
}

describe('agentboard task attach-pr', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureRunning.mockResolvedValue(undefined);
  });

  afterEach(() => {
    logSpy.mockClear();
    errorSpy.mockClear();
    exitSpy.mockClear();
  });

  it('defaults to the card’s own repo when --repo is omitted', async () => {
    // Arrange
    const { call, disconnect } = stubRpc();

    // Act
    await run('task-1', '99');

    // Assert
    expect(call).toHaveBeenCalledWith('addTaskBranch', { taskId: 'task-1', repoId: 'repo-1', prNumber: 99 });
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Attached PR #99 from Monorepo to task task-1.'),
    );
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('attaches a PR from a different, explicitly named repo', async () => {
    // Arrange — the cross-repo sibling PR case this command exists for.
    const { call } = stubRpc();

    // Act
    await run('task-1', '99', '--repo', 'repo-2');

    // Assert
    expect(call).toHaveBeenCalledWith('addTaskBranch', { taskId: 'task-1', repoId: 'repo-2', prNumber: 99 });
  });

  it('passes an explicit --base through', async () => {
    // Arrange
    const { call } = stubRpc();

    // Act
    await run('task-1', '99', '--base', 'develop');

    // Assert
    expect(call).toHaveBeenCalledWith('addTaskBranch', {
      taskId: 'task-1',
      repoId: 'repo-1',
      prNumber: 99,
      baseBranch: 'develop',
    });
  });

  it('refuses a non-numeric PR number', async () => {
    // Arrange
    stubRpc();

    // Act + Assert
    await expect(run('task-1', 'not-a-number')).rejects.toThrow(ExitError);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid PR number'));
  });

  it('refuses an unknown task', async () => {
    // Arrange
    stubRpc();

    // Act + Assert
    await expect(run('no-such-task', '99')).rejects.toThrow(ExitError);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown task'));
  });

  it('refuses a general card, which has no repo to attach a PR to', async () => {
    // Arrange
    const board = makeBoard({ tasks: [makeTask({ kind: 'general', repoId: undefined })] });
    stubRpc({}, board);

    // Act + Assert
    await expect(run('task-1', '99')).rejects.toThrow(ExitError);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('general card'));
  });

  it('refuses when neither --repo nor the card’s own repo resolves one', async () => {
    // Arrange — a repo-kind card whose repo was since removed from the board.
    const board = makeBoard({ tasks: [makeTask({ repoId: 'repo-ghost' })] });
    stubRpc({}, board);

    // Act + Assert
    await expect(run('task-1', '99')).rejects.toThrow(ExitError);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Pass --repo'));
  });
});
