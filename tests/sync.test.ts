import { describe, expect, it, vi } from 'vitest';
import { SyncService } from '../src/services/sync.js';
import type { PRInfo } from '../src/services/github.js';
import type { TaskRecord, TaskSyncPatch } from '../src/types/index.js';

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
    ciRequiredTotal: 0,
    ciRequiredPassed: 0,
    ciRequiredFailed: 0,
    ciRequiredPending: 0,
    gitState: 'clean',
    gitAheadCount: 0,
    gitBehindCount: 0,
    hasUntracked: false,
    hasConflicts: false,
    reviewState: 'none',
    unresolvedThreadCount: 0,
    githubSyncStatus: 'idle',
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

function makeRepoRow(overrides: Record<string, unknown> = {}) {
  return {
    path: '/repo',
    github_owner: 'org',
    github_repo: 'proj',
    default_base_branch: 'main',
    ...overrides,
  };
}

function makePrInfo(patch: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 42,
    title: 'My task',
    url: 'https://example.test/pr/42',
    prState: 'open',
    ciState: 'none',
    ciRequiredTotal: 0,
    ciRequiredPassed: 0,
    ciRequiredFailed: 0,
    ciRequiredPending: 0,
    reviewState: 'none',
    unresolvedThreadCount: 0,
    ...patch,
  };
}

function makeBoard(taskPatch: Partial<TaskRecord> = {}) {
  let task = makeTask(taskPatch);

  const board = {
    getTask: vi.fn().mockImplementation((id: string) => (id === task.id ? task : null)),
    getTasks: vi.fn().mockImplementation(() => [task]),
    updateTaskSync: vi.fn().mockImplementation((_id: string, patch: TaskSyncPatch) => {
      const normalized = Object.fromEntries(
        Object.entries(patch).map(([key, value]) => [key, value ?? undefined]),
      );
      task = { ...task, ...normalized };
    }),
    moveTask: vi.fn().mockImplementation(({ trackId }: { trackId: string }) => {
      task = { ...task, trackId };
    }),
  };

  return { board, getTask: () => task };
}

describe('SyncService', () => {
  it('creates a PR after the branch is pushed and moves backlog to in-progress', async () => {
    const { board } = makeBoard();
    const prInfo = makePrInfo();
    const github = {
      findBranchPR: vi.fn().mockResolvedValue(null),
      getPR: vi.fn(),
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
        run: vi.fn(),
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
        githubSyncStatus: 'ok',
      }),
    );
    expect(board.moveTask).toHaveBeenCalledWith({
      id: 'task-1',
      trackId: 'in-progress',
    });
  });

  it('retries remote branch detection during a manual sync before creating a PR', async () => {
    const { board } = makeBoard();
    const prInfo = makePrInfo();
    const github = {
      findBranchPR: vi.fn().mockResolvedValue(null),
      getPR: vi.fn(),
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
        run: vi.fn(),
      }),
    };
    const wait = vi.fn().mockResolvedValue(undefined);

    const sync = new SyncService(board as never, github as never, git as never, db as never, wait);

    await sync.trigger();

    expect(git.remoteBranchExists).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(github.createPR).toHaveBeenCalledTimes(1);
  });

  it('moves backlog to in-progress for an existing open PR without creating a duplicate PR', async () => {
    const { board } = makeBoard();
    const prInfo = makePrInfo();
    const github = {
      findBranchPR: vi.fn().mockResolvedValue({
        number: prInfo.number,
        prState: 'open',
        title: prInfo.title,
        url: prInfo.url,
      }),
      getPR: vi.fn().mockResolvedValue(prInfo),
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
        run: vi.fn(),
      }),
    };

    const sync = new SyncService(board as never, github as never, git as never, db as never);

    const result = await sync.trigger();

    expect(result.errors).toEqual([]);
    expect(github.createPR).not.toHaveBeenCalled();
    expect(board.moveTask).toHaveBeenCalledWith({
      id: 'task-1',
      trackId: 'in-progress',
    });
  });

  it('moves a merged PR task to done', async () => {
    const { board } = makeBoard({ trackId: 'in-progress', prState: 'open' });
    const github = {
      findBranchPR: vi.fn().mockResolvedValue({
        number: 42,
        prState: 'merged',
        title: 'My task',
        url: 'https://example.test/pr/42',
      }),
      getPR: vi.fn().mockResolvedValue(
        makePrInfo({
          prState: 'merged',
          ciState: 'passed',
          ciRequiredTotal: 5,
          ciRequiredPassed: 5,
        }),
      ),
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
        run: vi.fn(),
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
        ciState: 'passed',
        ciRequiredTotal: 5,
        ciRequiredPassed: 5,
      }),
    );
    expect(board.moveTask).toHaveBeenCalledWith({
      id: 'task-1',
      trackId: 'done',
    });
  });

  it('surfaces a sync error when PR creation fails before a PR is confirmed', async () => {
    const { board } = makeBoard();
    const github = {
      findBranchPR: vi.fn().mockResolvedValue(null),
      getPR: vi.fn(),
      createPR: vi.fn().mockRejectedValue(new Error('gh pr create failed')),
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
        run: vi.fn(),
      }),
    };

    const sync = new SyncService(board as never, github as never, git as never, db as never);

    const result = await sync.trigger();

    expect(board.moveTask).not.toHaveBeenCalled();
    expect(board.updateTaskSync).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        githubSyncStatus: 'error',
        githubSyncError: 'gh pr create failed',
      }),
    );
    expect(result.errors).toEqual(['Task task-1: gh pr create failed']);
  });

  it('waits for the remote branch before creating a PR from the explicit PR action', async () => {
    const { board } = makeBoard();
    const prInfo = makePrInfo();
    const github = {
      findBranchPR: vi.fn().mockResolvedValue(null),
      getPR: vi.fn(),
      createPR: vi.fn().mockResolvedValue(prInfo),
    };
    const git = {
      defaultBranch: vi.fn().mockResolvedValue('main'),
      remoteBranchExists: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
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
        run: vi.fn(),
      }),
    };
    const wait = vi.fn().mockResolvedValue(undefined);

    const sync = new SyncService(board as never, github as never, git as never, db as never, wait);

    await expect(sync.createTaskPR('task-1')).resolves.toEqual(
      expect.objectContaining({
        number: 42,
        prState: 'open',
        url: 'https://example.test/pr/42',
      }),
    );

    expect(git.remoteBranchExists).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it('tries PR creation immediately after a pushed branch becomes visible', async () => {
    const { board, getTask } = makeBoard();
    const prInfo = makePrInfo();
    const github = {
      findBranchPR: vi.fn().mockResolvedValue(null),
      getPR: vi.fn(),
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
        run: vi.fn(),
      }),
    };
    const wait = vi.fn().mockResolvedValue(undefined);

    const sync = new SyncService(board as never, github as never, git as never, db as never, wait);

    expect(sync.schedulePostPushSync('task-1')).toEqual({ scheduled: true });

    await vi.waitFor(() => {
      expect(github.createPR).toHaveBeenCalledTimes(1);
    });

    expect(git.remoteBranchExists).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(getTask().prNumber).toBe(42);
    expect(board.moveTask).toHaveBeenCalledWith({
      id: 'task-1',
      trackId: 'in-progress',
    });
  });

  it('surfaces a closed unmerged PR instead of auto-creating a replacement', async () => {
    const { board, getTask } = makeBoard({ trackId: 'in-progress' });
    const github = {
      findBranchPR: vi.fn().mockResolvedValue({
        number: 42,
        prState: 'closed',
        title: 'My task',
        url: 'https://example.test/pr/42',
      }),
      getPR: vi.fn().mockResolvedValue(
        makePrInfo({
          prState: 'closed',
        }),
      ),
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
        run: vi.fn(),
      }),
    };

    const sync = new SyncService(board as never, github as never, git as never, db as never);

    const result = await sync.trigger();

    expect(github.createPR).not.toHaveBeenCalled();
    expect(result.errors).toEqual([
      'Task task-1: Branch ab/task-1 already has a closed pull request; reopen it or push a new branch',
    ]);
    expect(getTask().githubSyncStatus).toBe('error');
    expect(getTask().prState).toBe('closed');
  });
});
