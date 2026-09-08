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
    title: 'Some card',
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
    if (method === 'recreateSession') return { id: 'session-2', taskId: 'task-1' };
    throw new Error(`unexpected RPC: ${method}`);
  });
  const disconnect = vi.fn();
  mocks.createRPCClient.mockResolvedValue({ call, disconnect });
  return { call, disconnect };
}

function run(...args: string[]): Promise<unknown> {
  return buildCli().parseAsync(['node', 'agentboard', 'task', 'restart', ...args]);
}

describe('agentboard task restart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureRunning.mockResolvedValue(undefined);
  });

  afterEach(() => {
    logSpy.mockClear();
    errorSpy.mockClear();
    exitSpy.mockClear();
  });

  it('restarts the card in place, without minting a new id', async () => {
    // Arrange — the whole point: a stuck pane used to mean delete plus
    // recreate, which changed the card id and broke every reference to it.
    const { call, disconnect } = stubRpc({
      recreateSession: { id: 'session-2', taskId: 'task-1', attachCommand: 'tmux attach -t ab_x' },
    });

    // Act
    await run('task-1');

    // Assert
    expect(call).toHaveBeenCalledWith('recreateSession', { taskId: 'task-1', slot: 'primary' });
    const printed = logSpy.mock.calls.map(([line]) => String(line)).join('\n');
    expect(printed).toContain('Restarted task-1');
    expect(printed).toContain('task    task-1');
    expect(printed).toContain('resumes the conversation it already had');
    expect(printed).toContain('tmux attach -t ab_x');
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('restarts the secondary session when asked', async () => {
    // Arrange
    const { call } = stubRpc({ recreateSession: { id: 'session-2', taskId: 'task-1' } });

    // Act
    await run('task-1', '--slot', 'secondary');

    // Assert
    expect(call).toHaveBeenCalledWith('recreateSession', { taskId: 'task-1', slot: 'secondary' });
  });

  it('refuses an unknown task id rather than starting something unrelated', async () => {
    // Arrange
    stubRpc();

    // Act + Assert
    await expect(run('no-such-task')).rejects.toThrow(ExitError);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown task'));
  });
});
