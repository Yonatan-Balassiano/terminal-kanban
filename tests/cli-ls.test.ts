import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardSnapshot, TaskRecord } from '../src/types/index.js';

const mocks = vi.hoisted(() => ({
  ensureRunning: vi.fn(),
  createRPCClient: vi.fn(),
  readPidFile: vi.fn(),
}));

vi.mock('../src/daemon/index.js', () => ({
  ensureRunning: mocks.ensureRunning,
  readPidFile: mocks.readPidFile,
}));

vi.mock('../src/cli/rpc.js', () => ({
  createRPCClient: mocks.createRPCClient,
}));

import { buildCli } from '../src/cli/index.js';

function makeTask(patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1',
    title: 'My task',
    repoId: 'repo-1',
    agentCli: 'claude',
    trackId: 'backlog',
    labels: [],
    branchName: 'ab/task-1',
    sortKey: 1000,
    prState: 'none',
    prDraft: false,
    ciState: 'none',
    gitState: 'clean',
    gitAheadCount: 0,
    gitBehindCount: 0,
    hasUntracked: false,
    hasConflicts: false,
    sessionAttentionNeeded: false,
    reviewState: 'none',
    unresolvedThreadCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

function makeBoard(tasks: TaskRecord[]): BoardSnapshot {
  return {
    repos: [],
    pillars: [],
    labels: [],
    tracks: [],
    tasks,
    savedViews: [],
    uiState: {},
  };
}

describe('agentboard ls', () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureRunning.mockResolvedValue(undefined);
  });

  afterEach(() => {
    logSpy.mockClear();
  });

  it('lists every task on the board', async () => {
    const call = vi.fn().mockResolvedValue(
      makeBoard([
        makeTask({ id: 'active-1', title: 'Active task' }),
        makeTask({ id: 'done-1', title: 'Finished task', trackId: 'done' }),
      ]),
    );
    const disconnect = vi.fn();
    mocks.createRPCClient.mockResolvedValue({ call, disconnect });

    await buildCli().parseAsync(['node', 'agentboard', 'ls']);

    expect(call).toHaveBeenCalledWith('getBoard', {});
    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Active task');
    expect(output).toContain('Finished task');
  });

  it('shows an empty message when the board has no tasks', async () => {
    const call = vi.fn().mockResolvedValue(makeBoard([]));
    const disconnect = vi.fn();
    mocks.createRPCClient.mockResolvedValue({ call, disconnect });

    await buildCli().parseAsync(['node', 'agentboard', 'ls']);

    expect(logSpy).toHaveBeenCalledWith('No tasks found.');
  });
});
