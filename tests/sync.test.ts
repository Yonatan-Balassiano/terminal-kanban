import { describe, expect, it, vi } from 'vitest';
import { SyncService } from '../src/services/sync.js';
import type { PRInfo } from '../src/services/github.js';
import type {
  TaskBranchRecord,
  TaskBranchSyncPatch,
  TaskRecord,
  TaskSyncPatch,
} from '../src/types/index.js';
import { rollupBranches } from '../src/services/task-branches.js';

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
    ciRequiredTotal: 0,
    ciRequiredPassed: 0,
    ciRequiredFailed: 0,
    ciRequiredPending: 0,
    gitState: 'clean',
    gitAheadCount: 0,
    gitBehindCount: 0,
    hasUntracked: false,
    hasConflicts: false,
    sessionAttentionNeeded: false,
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

/**
 * An in-memory stand-in for BoardService.
 *
 * It runs the real rollup rather than faking one, so these tests exercise the
 * actual rule that decides what a card looks like once it carries several
 * branches — a hand-written stub would let the rule drift unnoticed.
 */
function makeBoard(taskPatch: Partial<TaskRecord> = {}, extraBranches: string[] = []) {
  let task = makeTask(taskPatch);
  let branches: TaskBranchRecord[] = [];

  const makeBranch = (repoId: string, branchName: string, index: number): TaskBranchRecord => ({
    id: `branch-${index}`,
    taskId: task.id,
    repoId,
    branchName,
    sortKey: index,
    prState: 'none',
    prDraft: false,
    ciState: 'none',
    ciRequiredTotal: 0,
    ciRequiredPassed: 0,
    ciRequiredFailed: 0,
    ciRequiredPending: 0,
    reviewState: 'none',
    unresolvedThreadCount: 0,
    gitState: 'unknown',
    gitAheadCount: 0,
    gitBehindCount: 0,
    hasUntracked: false,
    hasConflicts: false,
    githubSyncStatus: 'idle',
    createdAt: 1,
    updatedAt: 1,
  });

  const applyRollup = (): void => {
    if (branches.length === 0) {
      return;
    }
    const rollup = rollupBranches(branches);
    task = { ...task, ...rollup, branches: [...branches] };
  };

  if (task.repoId && task.branchName) {
    branches = [makeBranch(task.repoId, task.branchName, 0)];
    extraBranches.forEach((repoId, index) => {
      branches.push(makeBranch(repoId, task.branchName!, index + 1));
    });
    task = { ...task, activeBranchId: branches[0]!.id };
    applyRollup();
    // The rollup derives PR state from branches, but a fixture may assert on a
    // task that already has one; keep whatever the caller asked for.
    task = { ...task, ...taskPatch, branches: [...branches] };
  }

  const board = {
    getTask: vi.fn().mockImplementation((id: string) => (id === task.id ? task : null)),
    getTasks: vi.fn().mockImplementation(() => [task]),
    getTaskBranches: vi.fn().mockImplementation(() => [...branches]),
    getTaskBranch: vi
      .fn()
      .mockImplementation((id: string) => branches.find((branch) => branch.id === id) ?? null),
    addTaskBranch: vi
      .fn()
      .mockImplementation((params: { repoId: string; branchName: string }) => {
        const found = branches.find(
          (branch) => branch.repoId === params.repoId && branch.branchName === params.branchName,
        );
        if (found) {
          return found;
        }
        const created = makeBranch(params.repoId, params.branchName, branches.length);
        branches = [...branches, created];
        applyRollup();
        return created;
      }),
    updateTaskSync: vi.fn().mockImplementation((_id: string, patch: TaskSyncPatch) => {
      const normalized = Object.fromEntries(
        Object.entries(patch).map(([key, value]) => [key, value ?? undefined]),
      );
      task = { ...task, ...normalized };
    }),
    updateTaskBranchSync: vi
      .fn()
      .mockImplementation((branchId: string, patch: TaskBranchSyncPatch) => {
        const normalized = Object.fromEntries(
          Object.entries(patch).map(([key, value]) => [key, value ?? undefined]),
        );
        branches = branches.map((branch) =>
          branch.id === branchId ? { ...branch, ...normalized } : branch,
        );
        applyRollup();
      }),
    recomputeTaskRollup: vi.fn().mockImplementation(applyRollup),
    moveTask: vi.fn().mockImplementation(({ trackId }: { trackId: string }) => {
      task = { ...task, trackId };
    }),
  };

  return { board, getTask: () => task, getBranches: () => branches };
}

describe('SyncService', () => {
  it('creates a PR after the branch is pushed and moves the task into pr', async () => {
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
    expect(board.updateTaskBranchSync).toHaveBeenCalledWith(
      'branch-0',
      expect.objectContaining({
        prNumber: 42,
        prState: 'open',
        prUrl: 'https://example.test/pr/42',
        githubSyncStatus: 'ok',
      }),
    );
    expect(board.moveTask).toHaveBeenCalledWith({
      id: 'task-1',
      trackId: 'pr',
    });
  });

  it('uses the stored repo default base branch without overwriting it during sync', async () => {
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
    const statement = {
      get: vi.fn().mockReturnValue(makeRepoRow({ default_base_branch: 'master' })),
      run: vi.fn(),
    };
    const db = {
      prepare: vi.fn().mockReturnValue(statement),
    };

    const sync = new SyncService(board as never, github as never, git as never, db as never);
    await sync.trigger();

    expect(git.defaultBranch).not.toHaveBeenCalled();
    expect(statement.run).not.toHaveBeenCalled();
    expect(github.createPR).toHaveBeenCalledWith('/repo', {
      githubRepo: 'org/proj',
      branch: 'ab/task-1',
      baseBranch: 'master',
      title: '[auto|task-1] My task',
      body: 'Created by AgentBoard for task task-1.',
    });
  });

  it('backfills the repo default base branch from git only when the DB value is missing', async () => {
    const { board } = makeBoard();
    const prInfo = makePrInfo();
    const github = {
      findBranchPR: vi.fn().mockResolvedValue(null),
      getPR: vi.fn(),
      createPR: vi.fn().mockResolvedValue(prInfo),
    };
    const git = {
      defaultBranch: vi.fn().mockResolvedValue('master'),
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
    const statement = {
      get: vi.fn().mockReturnValue(makeRepoRow({ default_base_branch: null })),
      run: vi.fn(),
    };
    const db = {
      prepare: vi.fn().mockReturnValue(statement),
    };

    const sync = new SyncService(board as never, github as never, git as never, db as never);
    await sync.trigger();

    expect(git.defaultBranch).toHaveBeenCalledWith('/repo');
    expect(statement.run).toHaveBeenCalledWith('master', expect.any(Number), 'repo-1');
    expect(github.createPR).toHaveBeenCalledWith('/repo', {
      githubRepo: 'org/proj',
      branch: 'ab/task-1',
      baseBranch: 'master',
      title: '[auto|task-1] My task',
      body: 'Created by AgentBoard for task task-1.',
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

  it('moves an existing open PR task into pr without creating a duplicate PR', async () => {
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
      trackId: 'pr',
    });
  });

  it('moves an in-progress task into pr when its PR is open', async () => {
    const { board } = makeBoard({ trackId: 'in-progress' });
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

    await sync.trigger();

    expect(github.createPR).not.toHaveBeenCalled();
    expect(board.moveTask).toHaveBeenCalledWith({
      id: 'task-1',
      trackId: 'pr',
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
    expect(board.updateTaskBranchSync).toHaveBeenCalledWith(
      'branch-0',
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
    expect(board.updateTaskBranchSync).toHaveBeenCalledWith(
      'branch-0',
      expect.objectContaining({
        githubSyncStatus: 'error',
        githubSyncError: 'gh pr create failed',
      }),
    );
    expect(result.errors).toEqual(['Task task-1 (ab/task-1): gh pr create failed']);
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
      trackId: 'pr',
    });
  });

  it('moves a closed unmerged PR task to done', async () => {
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
    expect(result.errors).toEqual([]);
    expect(getTask().prState).toBe('closed');
    expect(board.moveTask).toHaveBeenCalledWith({
      id: 'task-1',
      trackId: 'done',
    });
  });
  it('keeps a card in review while one of its pull requests is still open', async () => {
    // Arrange — the regression that matters most: under the old one-PR model the
    // first merge closed the card and deleted the worktrees the rest of the
    // feature was still being written in.
    const { board, getBranches } = makeBoard({ trackId: 'pr' }, ['repo-2']);
    const prByBranch: Record<string, PRInfo> = {
      '/repo-a': makePrInfo({ number: 10, prState: 'merged' }),
      '/repo-b': makePrInfo({ number: 11, prState: 'open' }),
    };
    const github = {
      findBranchPR: vi.fn().mockResolvedValue({ number: 1 }),
      getPR: vi.fn().mockImplementation((repoPath: string) => prByBranch[repoPath]),
      createPR: vi.fn(),
      findPRsByHeadBranch: vi.fn().mockResolvedValue([]),
      getMergeInfo: vi.fn().mockResolvedValue(null),
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
      prepare: vi.fn().mockImplementation(() => ({
        get: vi.fn().mockImplementation((repoId: string) =>
          makeRepoRow({ path: repoId === 'repo-2' ? '/repo-b' : '/repo-a' }),
        ),
        all: vi.fn().mockReturnValue([]),
        run: vi.fn(),
      })),
    };
    const onMerged = vi.fn().mockResolvedValue(undefined);

    const sync = new SyncService(board as never, github as never, git as never, db as never);
    sync.onTaskMergedOrClosed = onMerged;

    // Act
    await sync.trigger();

    // Assert
    expect(getBranches()[0]?.prState).toBe('merged');
    expect(getBranches()[1]?.prState).toBe('open');
    expect(board.moveTask).not.toHaveBeenCalledWith({ id: 'task-1', trackId: 'done' });
    expect(board.moveTask).not.toHaveBeenCalledWith({ id: 'task-1', trackId: 'shipping' });
    // Nothing may be cleaned up while work is still in flight.
    expect(onMerged).not.toHaveBeenCalled();
  });

  it('parks a fully merged card in shipping until its change has shipped', async () => {
    // Arrange
    const { board } = makeBoard({ trackId: 'pr' });
    const github = {
      findBranchPR: vi.fn().mockResolvedValue({ number: 42 }),
      getPR: vi.fn().mockResolvedValue(makePrInfo({ prState: 'merged' })),
      createPR: vi.fn(),
      findPRsByHeadBranch: vi.fn().mockResolvedValue([]),
      getMergeInfo: vi.fn().mockResolvedValue(null),
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
        all: vi.fn().mockReturnValue([]),
        run: vi.fn(),
      }),
    };
    const onMerged = vi.fn().mockResolvedValue(undefined);

    const sync = new SyncService(board as never, github as never, git as never, db as never);
    sync.onTaskMergedOrClosed = onMerged;
    sync.isFullyReleased = () => false;

    // Act
    await sync.trigger();

    // Assert — merged is not shipped, and its worktrees must survive.
    expect(board.moveTask).toHaveBeenCalledWith({ id: 'task-1', trackId: 'shipping' });
    expect(onMerged).not.toHaveBeenCalled();
  });

  it('goes straight to done when release tracking cannot be asked', async () => {
    // Arrange — the gate is opt-in: without artifact tracking the board must
    // behave exactly as it always did.
    const { board } = makeBoard({ trackId: 'pr' });
    const github = {
      findBranchPR: vi.fn().mockResolvedValue({ number: 42 }),
      getPR: vi.fn().mockResolvedValue(makePrInfo({ prState: 'merged' })),
      createPR: vi.fn(),
      findPRsByHeadBranch: vi.fn().mockResolvedValue([]),
      getMergeInfo: vi.fn().mockResolvedValue(null),
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
        all: vi.fn().mockReturnValue([]),
        run: vi.fn(),
      }),
    };
    const onMerged = vi.fn().mockResolvedValue(undefined);

    const sync = new SyncService(board as never, github as never, git as never, db as never);
    sync.onTaskMergedOrClosed = onMerged;

    // Act
    await sync.trigger();

    // Assert
    expect(board.moveTask).toHaveBeenCalledWith({ id: 'task-1', trackId: 'done' });
    expect(onMerged).toHaveBeenCalledWith('task-1');
  });

  it('adopts a sibling pull request opened on the same branch in another repo', async () => {
    // Arrange
    const { board, getBranches } = makeBoard({ trackId: 'pr' });
    const github = {
      findBranchPR: vi.fn().mockResolvedValue(null),
      getPR: vi.fn(),
      createPR: vi.fn().mockResolvedValue(null),
      getMergeInfo: vi.fn().mockResolvedValue(null),
      findPRsByHeadBranch: vi.fn().mockResolvedValue([
        { number: 7, repoSlug: 'org/other', prState: 'open', url: 'u' },
      ]),
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
        all: vi.fn().mockReturnValue([
          { id: 'repo-1', github_owner: 'org', github_repo: 'proj' },
          { id: 'repo-9', github_owner: 'org', github_repo: 'other' },
        ]),
        run: vi.fn(),
      }),
    };

    const sync = new SyncService(board as never, github as never, git as never, db as never);

    // Act
    await sync.trigger();

    // Assert
    expect(getBranches().map((branch) => branch.repoId)).toEqual(['repo-1', 'repo-9']);
  });

  it('syncs the branches it knows about when discovery fails', async () => {
    // Arrange — a rate-limited search must never stop the rest of the sync.
    const { board } = makeBoard({ trackId: 'pr' });
    const github = {
      findBranchPR: vi.fn().mockResolvedValue({ number: 42 }),
      getPR: vi.fn().mockResolvedValue(makePrInfo()),
      createPR: vi.fn(),
      getMergeInfo: vi.fn().mockResolvedValue(null),
      findPRsByHeadBranch: vi.fn().mockRejectedValue(new Error('API rate limit exceeded')),
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
        all: vi.fn().mockReturnValue([{ id: 'repo-1', github_owner: 'org', github_repo: 'proj' }]),
        run: vi.fn(),
      }),
    };

    const sync = new SyncService(board as never, github as never, git as never, db as never);

    // Act
    const result = await sync.trigger();

    // Assert
    expect(result.errors).toEqual([]);
    expect(board.updateTaskBranchSync).toHaveBeenCalledWith(
      'branch-0',
      expect.objectContaining({ prNumber: 42, githubSyncStatus: 'ok' }),
    );
  });
  it('pulls a shipping card back into review when new work opens on it', async () => {
    // Arrange — a card waiting on a rollout that gains another pull request is
    // no longer "everything has merged", so it belongs back in review.
    const { board } = makeBoard({ trackId: 'shipping' });
    const github = {
      findBranchPR: vi.fn().mockResolvedValue({ number: 43 }),
      getPR: vi.fn().mockResolvedValue(makePrInfo({ number: 43, prState: 'open' })),
      createPR: vi.fn(),
      findPRsByHeadBranch: vi.fn().mockResolvedValue([]),
      getMergeInfo: vi.fn().mockResolvedValue(null),
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
        all: vi.fn().mockReturnValue([]),
        run: vi.fn(),
      }),
    };

    const sync = new SyncService(board as never, github as never, git as never, db as never);

    // Act
    await sync.trigger();

    // Assert
    expect(board.moveTask).toHaveBeenCalledWith({ id: 'task-1', trackId: 'pr' });
  });

  it('leaves a card that is already done alone', async () => {
    // Arrange — done is a decision, and re-syncing must never undo it.
    const { board } = makeBoard({ trackId: 'done' });
    const github = {
      findBranchPR: vi.fn().mockResolvedValue({ number: 42 }),
      getPR: vi.fn().mockResolvedValue(makePrInfo({ prState: 'open' })),
      createPR: vi.fn(),
      findPRsByHeadBranch: vi.fn().mockResolvedValue([]),
      getMergeInfo: vi.fn().mockResolvedValue(null),
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
        all: vi.fn().mockReturnValue([]),
        run: vi.fn(),
      }),
    };

    const sync = new SyncService(board as never, github as never, git as never, db as never);

    // Act
    await sync.trigger();

    // Assert
    expect(board.moveTask).not.toHaveBeenCalled();
  });
});
