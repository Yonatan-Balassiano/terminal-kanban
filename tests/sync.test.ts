import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { SyncService } from '../src/services/sync.js';
import type { PRInfo } from '../src/services/github.js';
import type { TaskRecord } from '../src/types/index.js';

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
    reviewState: 'none',
    unresolvedThreadCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

function makeRepoRow() {
  return {
    path: '/repo',
    github_owner: 'org',
    github_repo: 'proj',
    default_base_branch: 'main',
  };
}

function makePrInfo(): PRInfo {
  return {
    number: 42,
    title: 'My task',
    url: 'https://example.test/pr/42',
    prState: 'open',
    ciState: 'none',
    reviewState: 'none',
    unresolvedThreadCount: 0,
  };
}

async function flushPromises(count = 20): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

async function waitForAssertion(assertion: () => void, attempts = 200): Promise<void> {
  let lastError: unknown;
  for (let index = 0; index < attempts; index += 1) {
    try {
      assertion();
      return;
    } catch (error: unknown) {
      lastError = error;
      await Promise.resolve();
    }
  }

  throw lastError;
}

describe('SyncService', () => {
  it('creates a PR after the branch is pushed and moves backlog to in-progress', async () => {
    const board = {
      getTasks: vi.fn().mockReturnValue([makeTask()]),
      updateTaskSync: vi.fn(),
      moveTask: vi.fn(),
    };
    const prInfo = makePrInfo();
    const github = {
      getPR: vi.fn().mockResolvedValue(null),
      createPR: vi.fn().mockResolvedValue(prInfo),
    };
    const git = {
      defaultBranch: vi.fn().mockResolvedValue('main'),
      remoteBranchExists: vi.fn().mockResolvedValue(true),
      getWorkspaceStatus: vi.fn().mockResolvedValue({
        branch: 'ab/task-1',
        gitState: 'clean',
        aheadCount: 0,
        behindCount: 0,
        hasUntracked: false,
        hasConflicts: false,
      }),
    };
    const db = {
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue(makeRepoRow()),
      }),
    };

    const sync = new SyncService(board as never, github as never, git as never, db as never);
    await sync.trigger();

    expect(git.remoteBranchExists).toHaveBeenCalledWith('/repo', 'ab/task-1');
    expect(github.createPR).toHaveBeenCalledWith('/repo', {
      githubRepo: 'org/proj',
      branch: 'ab/task-1',
      baseBranch: 'main',
      title: '[auto|task-1] My task',
      body: 'Created by AgentBoard for task task-1.',
    });
    expect(board.updateTaskSync).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        prNumber: 42,
        prState: 'open',
        prUrl: 'https://example.test/pr/42',
      })
    );
    expect(board.moveTask).toHaveBeenCalledWith({
      id: 'task-1',
      trackId: 'in-progress',
    });
  });

  it('retries remote branch detection during a manual sync before creating a PR', async () => {
    const board = {
      getTasks: vi.fn().mockReturnValue([makeTask()]),
      updateTaskSync: vi.fn(),
      moveTask: vi.fn(),
    };
    const prInfo = makePrInfo();
    const github = {
      getPR: vi.fn().mockResolvedValue(null),
      createPR: vi.fn().mockResolvedValue(prInfo),
    };
    const git = {
      defaultBranch: vi.fn().mockResolvedValue('main'),
      remoteBranchExists: vi
        .fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
      getWorkspaceStatus: vi.fn().mockResolvedValue({
        branch: 'ab/task-1',
        gitState: 'clean',
        aheadCount: 0,
        behindCount: 0,
        hasUntracked: false,
        hasConflicts: false,
      }),
    };
    const db = {
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue(makeRepoRow()),
      }),
    };
    const wait = vi.fn().mockResolvedValue(undefined);

    const sync = new SyncService(board as never, github as never, git as never, db as never, wait);

    await sync.trigger();

    expect(git.remoteBranchExists).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(github.createPR).toHaveBeenCalledWith('/repo', {
      githubRepo: 'org/proj',
      branch: 'ab/task-1',
      baseBranch: 'main',
      title: '[auto|task-1] My task',
      body: 'Created by AgentBoard for task task-1.',
    });
  });

  it('moves backlog to in-progress for an existing open PR without moving to review', async () => {
    const board = {
      getTasks: vi.fn().mockReturnValue([makeTask()]),
      updateTaskSync: vi.fn(),
      moveTask: vi.fn(),
    };
    const github = {
      getPR: vi.fn().mockResolvedValue(makePrInfo()),
      createPR: vi.fn(),
    };
    const git = {
      defaultBranch: vi.fn().mockResolvedValue('main'),
      remoteBranchExists: vi.fn(),
      getWorkspaceStatus: vi.fn().mockResolvedValue({
        branch: 'ab/task-1',
        gitState: 'clean',
        aheadCount: 0,
        behindCount: 0,
        hasUntracked: false,
        hasConflicts: false,
      }),
    };
    const db = {
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue(makeRepoRow()),
      }),
    };

    const sync = new SyncService(board as never, github as never, git as never, db as never);

    const result = await sync.trigger();

    expect(result.errors).toEqual([]);
    expect(github.createPR).not.toHaveBeenCalled();
    expect(board.moveTask).toHaveBeenCalledTimes(1);
    expect(board.moveTask).toHaveBeenCalledWith({
      id: 'task-1',
      trackId: 'in-progress',
    });
  });

  it('moves a merged PR task to done', async () => {
    const board = {
      getTasks: vi.fn().mockReturnValue([makeTask({ trackId: 'in-progress', prState: 'open' })]),
      updateTaskSync: vi.fn(),
      moveTask: vi.fn(),
    };
    const github = {
      getPR: vi.fn().mockResolvedValue({
        ...makePrInfo(),
        prState: 'merged',
        ciState: 'passed',
      }),
      createPR: vi.fn(),
    };
    const git = {
      defaultBranch: vi.fn().mockResolvedValue('main'),
      remoteBranchExists: vi.fn(),
      getWorkspaceStatus: vi.fn().mockResolvedValue({
        branch: 'ab/task-1',
        gitState: 'clean',
        aheadCount: 0,
        behindCount: 0,
        hasUntracked: false,
        hasConflicts: false,
      }),
    };
    const db = {
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue(makeRepoRow()),
      }),
    };

    const sync = new SyncService(board as never, github as never, git as never, db as never);

    const result = await sync.trigger();

    expect(result.errors).toEqual([]);
    expect(board.updateTaskSync).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        prNumber: 42,
        prState: 'merged',
        prUrl: 'https://example.test/pr/42',
        ciState: 'passed',
      })
    );
    expect(board.moveTask).toHaveBeenCalledWith({
      id: 'task-1',
      trackId: 'done',
    });
  });

  it('moves backlog to in-progress when the remote branch exists even if PR creation fails', async () => {
    const board = {
      getTasks: vi.fn().mockReturnValue([makeTask()]),
      updateTaskSync: vi.fn(),
      moveTask: vi.fn(),
    };
    const github = {
      getPR: vi.fn().mockResolvedValue(null),
      createPR: vi.fn().mockImplementation(async () => {
        throw new Error('gh pr create failed');
      }),
    };
    const git = {
      defaultBranch: vi.fn().mockResolvedValue('main'),
      remoteBranchExists: vi.fn().mockResolvedValue(true),
      getWorkspaceStatus: vi.fn().mockResolvedValue({
        branch: 'ab/task-1',
        gitState: 'clean',
        aheadCount: 0,
        behindCount: 0,
        hasUntracked: false,
        hasConflicts: false,
      }),
    };
    const db = {
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue(makeRepoRow()),
      }),
    };

    const sync = new SyncService(board as never, github as never, git as never, db as never);

    const result = await sync.trigger();

    expect(board.moveTask).toHaveBeenCalledWith({
      id: 'task-1',
      trackId: 'in-progress',
    });
    expect(board.updateTaskSync).not.toHaveBeenCalled();
    expect(result.tasksUpdated).toBe(1);
    expect(result.errors).toEqual(['Task task-1: gh pr create failed']);
  });

  it('waits for the remote branch before creating a PR from the explicit PR action', async () => {
    const task = makeTask();
    const board = {
      getTask: vi.fn().mockReturnValue(task),
      updateTaskSync: vi.fn(),
      moveTask: vi.fn(),
    };
    const prInfo = makePrInfo();
    const github = {
      getPR: vi.fn().mockResolvedValue(null),
      createPR: vi.fn().mockResolvedValue(prInfo),
    };
    const git = {
      defaultBranch: vi.fn().mockResolvedValue('main'),
      remoteBranchExists: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
    };
    const db = {
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue(makeRepoRow()),
      }),
    };
    const wait = vi.fn().mockResolvedValue(undefined);

    const sync = new SyncService(board as never, github as never, git as never, db as never, wait);

    await expect(sync.createTaskPR('task-1')).resolves.toEqual(prInfo);

    expect(git.remoteBranchExists).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(board.updateTaskSync).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        prNumber: 42,
        prState: 'open',
        prUrl: 'https://example.test/pr/42',
      })
    );
  });

  it('retries post-push PR creation in the background until the branch appears', async () => {
    let task = makeTask();
    const board = {
      getTask: vi.fn().mockImplementation(() => task),
      updateTaskSync: vi.fn().mockImplementation((_id: string, patch: Partial<TaskRecord>) => {
        task = { ...task, ...patch };
      }),
      moveTask: vi.fn().mockImplementation(({ trackId }: { trackId: string }) => {
        task = { ...task, trackId };
      }),
    };
    const prInfo = makePrInfo();
    const github = {
      getPR: vi.fn().mockResolvedValue(null),
      createPR: vi.fn().mockResolvedValue(prInfo),
    };
    const git = {
      defaultBranch: vi.fn().mockResolvedValue('main'),
      remoteBranchExists: vi
        .fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
      getWorkspaceStatus: vi.fn().mockResolvedValue({
        branch: 'ab/task-1',
        gitState: 'clean',
        aheadCount: 0,
        behindCount: 0,
        hasUntracked: false,
        hasConflicts: false,
      }),
    };
    const db = {
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue(makeRepoRow()),
      }),
    };
    const wait = vi.fn().mockResolvedValue(undefined);

    const sync = new SyncService(board as never, github as never, git as never, db as never, wait);

    expect(sync.schedulePostPushSync('task-1')).toEqual({ scheduled: true });

    await flushPromises();
    await waitForAssertion(() => {
      expect(github.createPR).toHaveBeenCalledWith('/repo', {
        githubRepo: 'org/proj',
        branch: 'ab/task-1',
        baseBranch: 'main',
        title: '[auto|task-1] My task',
        body: 'Created by AgentBoard for task task-1.',
      });
      expect(task.prState).toBe('open');
      expect(task.prNumber).toBe(42);
    });

    expect(git.remoteBranchExists).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(board.moveTask).toHaveBeenCalledWith({
      id: 'task-1',
      trackId: 'in-progress',
    });
  });
});
