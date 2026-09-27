import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
    if (method === 'setTaskOrchestrator') return null;
    throw new Error(`unexpected RPC: ${method}`);
  });
  const disconnect = vi.fn();
  mocks.createRPCClient.mockResolvedValue({ call, disconnect });
  return { call, disconnect };
}

function run(...args: string[]): Promise<unknown> {
  return buildCli().parseAsync(['node', 'agentboard', 'task', 'orchestrator', ...args]);
}

describe('agentboard task orchestrator', () => {
  const savedTaskIdEnv = process.env['AGENTBOARD_TASK_ID'];
  let emptyDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureRunning.mockResolvedValue(undefined);
    delete process.env['AGENTBOARD_TASK_ID'];
    // No .agentboard/task-id marker anywhere above this directory, so the
    // worktree fallback finds nothing unless a test puts one there.
    emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-orch-'));
    vi.spyOn(process, 'cwd').mockReturnValue(emptyDir);
  });

  afterEach(() => {
    if (savedTaskIdEnv === undefined) {
      delete process.env['AGENTBOARD_TASK_ID'];
    } else {
      process.env['AGENTBOARD_TASK_ID'] = savedTaskIdEnv;
    }
    fs.rmSync(emptyDir, { recursive: true, force: true });
    logSpy.mockClear();
    errorSpy.mockClear();
    exitSpy.mockClear();
  });

  it('marks the named card as an orchestrator', async () => {
    // Arrange
    const { call, disconnect } = stubRpc();

    // Act
    await run('task-1');

    // Assert
    expect(call).toHaveBeenCalledWith('setTaskOrchestrator', { taskId: 'task-1', orchestrator: true });
    expect(logSpy.mock.calls.flat().join('\n')).toContain('task-1');
    expect(disconnect).toHaveBeenCalled();
  });

  it('unmarks the card with --off', async () => {
    // Arrange
    const { call } = stubRpc();

    // Act
    await run('task-1', '--off');

    // Assert
    expect(call).toHaveBeenCalledWith('setTaskOrchestrator', { taskId: 'task-1', orchestrator: false });
  });

  it("defaults to the calling session's own card via AGENTBOARD_TASK_ID", async () => {
    // Arrange — the agent marking itself, with no id to hand.
    process.env['AGENTBOARD_TASK_ID'] = 'task-1';
    const { call } = stubRpc();

    // Act
    await run();

    // Assert
    expect(call).toHaveBeenCalledWith('setTaskOrchestrator', { taskId: 'task-1', orchestrator: true });
  });

  it('falls back to the worktree marker when the env var did not arrive', async () => {
    // Arrange — a sandboxed Bash call that dropped the env but kept the cwd.
    fs.mkdirSync(path.join(emptyDir, '.agentboard'));
    fs.writeFileSync(path.join(emptyDir, '.agentboard', 'task-id'), 'task-1\n');
    const { call } = stubRpc();

    // Act
    await run();

    // Assert
    expect(call).toHaveBeenCalledWith('setTaskOrchestrator', { taskId: 'task-1', orchestrator: true });
  });

  it('fails clearly when no card is named and none can be detected', async () => {
    // Arrange
    const { call } = stubRpc();

    // Act + Assert
    await expect(run()).rejects.toThrow(ExitError);
    expect(errorSpy.mock.calls.flat().join('\n')).toMatch(/no task id/i);
    expect(call).not.toHaveBeenCalledWith('setTaskOrchestrator', expect.anything());
  });

  it('rejects an unknown card without touching the board', async () => {
    // Arrange
    const { call } = stubRpc();

    // Act + Assert
    await expect(run('nope')).rejects.toThrow(ExitError);
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('Unknown task "nope"');
    expect(call).not.toHaveBeenCalledWith('setTaskOrchestrator', expect.anything());
  });
});
