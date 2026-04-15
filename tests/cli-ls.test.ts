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

  it('lists only archived tasks when --archived is passed', async () => {
    const call = vi.fn().mockResolvedValue(
      makeBoard([
        makeTask({ id: 'active-1', title: 'Active task' }),
        makeTask({
          id: 'archived-1',
          title: 'Archived task',
          archivedAt: 1_710_000_000_000,
        }),
      ]),
    );
    const disconnect = vi.fn();
    mocks.createRPCClient.mockResolvedValue({ call, disconnect });

    await buildCli().parseAsync(['node', 'agentboard', 'ls', '--archived']);

    expect(call).toHaveBeenCalledWith('getBoard', {
      filter: { includeArchived: true },
    });
    expect(disconnect).toHaveBeenCalledTimes(1);

    const output = logSpy.mock.calls.map((callArgs) => callArgs.join(' ')).join('\n');
    expect(output).toContain('Archived task');
    expect(output).not.toContain('Active task');
  });

  it('shows an archived-specific empty message when no archived tasks exist', async () => {
    const call = vi.fn().mockResolvedValue(
      makeBoard([
        makeTask({ id: 'active-1', title: 'Active task' }),
      ]),
    );
    const disconnect = vi.fn();
    mocks.createRPCClient.mockResolvedValue({ call, disconnect });

    await buildCli().parseAsync(['node', 'agentboard', 'ls', '--archived']);

    expect(logSpy).toHaveBeenCalledWith('No archived tasks found.');
  });
});
