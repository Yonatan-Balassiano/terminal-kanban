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
    if (method === 'redeliverInitialPrompt') return { delivered: true };
    throw new Error(`unexpected RPC: ${method}`);
  });
  const disconnect = vi.fn();
  mocks.createRPCClient.mockResolvedValue({ call, disconnect });
  return { call, disconnect };
}

function run(...args: string[]): Promise<unknown> {
  return buildCli().parseAsync(['node', 'agentboard', 'task', 'redeliver-prompt', ...args]);
}

describe('agentboard task redeliver-prompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureRunning.mockResolvedValue(undefined);
  });

  afterEach(() => {
    logSpy.mockClear();
    errorSpy.mockClear();
    exitSpy.mockClear();
  });

  it('re-delivers the stored brief into the target task session', async () => {
    // Arrange
    const { call, disconnect } = stubRpc();

    // Act
    await run('task-1');

    // Assert
    expect(call).toHaveBeenCalledWith('redeliverInitialPrompt', { taskId: 'task-1' });
    expect(logSpy).toHaveBeenCalledWith("Re-delivered task-1's brief to its live session.");
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('names the missing session, rather than guessing between causes', async () => {
    // Arrange
    stubRpc({ redeliverInitialPrompt: { delivered: false, reason: 'no-session' } });

    // Act
    await run('task-1');

    // Assert
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('has no live session'));
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('names a missing brief, and points at notify instead', async () => {
    // Arrange
    stubRpc({ redeliverInitialPrompt: { delivered: false, reason: 'no-brief' } });

    // Act
    await run('task-1');

    // Assert
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('no stored opening brief'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('task notify'));
    process.exitCode = 0;
  });

  it('says the paste was never confirmed, instead of claiming there is no session', async () => {
    // Arrange — the case the old single message reported as its own opposite:
    // the session is live and was delivered to, the paste just never verified.
    stubRpc({ redeliverInitialPrompt: { delivered: false, reason: 'not-verified' } });

    // Act
    await run('task-1');

    // Assert
    const printed = logSpy.mock.calls.map(([line]) => String(line)).join('\n');
    expect(printed).toContain('never confirmed on screen');
    expect(printed).not.toContain('no live session');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('refuses an unknown task id rather than silently no-op-ing', async () => {
    // Arrange
    stubRpc();

    // Act + Assert
    await expect(run('no-such-task')).rejects.toThrow(ExitError);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown task'));
  });
});
