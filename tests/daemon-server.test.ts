import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatch, serverEvents, shouldForwardEventToSubscriber } from '../src/daemon/server.js';
import { saveArtifactList } from '../src/config/index.js';
import type { RepoRecord, TaskBranchRecord, TaskRecord } from '../src/types/index.js';

// Only the writer is replaced: the rest of the module is left alone so no other
// handler in this file starts reading a stubbed config.
vi.mock('../src/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config/index.js')>()),
  saveArtifactList: vi.fn(),
}));

/**
 * A branch that is ready to merge: open PR, green build, approved.
 *
 * Tests that care about a guard override exactly the field under test, so a
 * failure names the guard rather than a missing fixture field.
 */
function makeBranch(patch: Partial<TaskBranchRecord> = {}): TaskBranchRecord {
  return {
    id: 'branch-1',
    taskId: 'task-1',
    repoId: 'repo-1',
    branchName: 'ab/task-1',
    sortKey: 0,
    prNumber: 42,
    prState: 'open',
    prDraft: false,
    ciState: 'passed',
    ciRequiredTotal: 1,
    ciRequiredPassed: 1,
    ciRequiredFailed: 0,
    ciRequiredPending: 0,
    reviewState: 'approved',
    unresolvedThreadCount: 0,
    gitState: 'clean',
    gitAheadCount: 0,
    gitBehindCount: 0,
    hasUntracked: false,
    hasConflicts: false,
    githubSyncStatus: 'ok',
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

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
    branchName: 'ab/task-1',
    sortKey: 1000,
    prNumber: 42,
    prState: 'open',
    prDraft: false,
    ciState: 'passed',
    ciRequiredTotal: 1,
    ciRequiredPassed: 1,
    ciRequiredFailed: 0,
    ciRequiredPending: 0,
    gitState: 'clean',
    gitAheadCount: 0,
    gitBehindCount: 0,
    hasUntracked: false,
    hasConflicts: false,
    githubSyncStatus: 'ok',
    sessionAttentionNeeded: false,
    reviewState: 'approved',
    unresolvedThreadCount: 0,
    // A card always has at least the branch createTask seeded it with; the
    // card-scoped handlers resolve their pull request out of this list.
    branches: [makeBranch()],
    activeBranchId: 'branch-1',
    prCount: 1,
    prOpenCount: 1,
    prMergedCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

function makeRepo(patch: Partial<RepoRecord> = {}): RepoRecord {
  return {
    id: 'repo-1',
    label: 'Repo',
    path: '/repo',
    defaultBaseBranch: 'main',
    worktreeMode: 'auto',
    health: 'ok',
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

afterEach(() => {
  serverEvents.removeAllListeners();
});

describe('daemon session_update subscriptions', () => {
  it('only forwards session updates for the watched task', () => {
    expect(
      shouldForwardEventToSubscriber(
        {
          type: 'session_update',
          payload: {
            taskId: 'task-1',
            lines: ['hidden'],
            ansiLines: ['hidden'],
            cursorX: 0,
            cursorY: 0,
          },
        },
        'task-2',
      ),
    ).toBe(false);

    expect(
      shouldForwardEventToSubscriber(
        {
          type: 'session_update',
          payload: {
            taskId: 'task-2',
            lines: ['visible'],
            ansiLines: ['visible'],
            cursorX: 0,
            cursorY: 0,
          },
        },
        'task-2',
      ),
    ).toBe(true);

    expect(
      shouldForwardEventToSubscriber(
        {
          type: 'board_patch',
          payload: { tasks: [] },
        },
        null,
      ),
    ).toBe(true);
  });
});

describe('daemon createTask dispatch', () => {
  it('passes agent selection through and emits a board patch', async () => {
    const task = makeTask({ agentCli: 'codex', trackId: 'backlog', prNumber: undefined, prState: 'none', ciState: 'none', reviewState: 'none' });
    const createTask = vi.fn().mockReturnValue(task);
    const getBoardSnapshot = vi.fn().mockReturnValue({ tasks: [task] });

    const boardPatchEvent = new Promise<unknown>((resolve) => {
      serverEvents.once('event', resolve);
    });

    const response = await dispatch(
      {
        id: 'req-create',
        method: 'createTask',
        params: {
          title: 'Use codex',
          repoId: 'repo-1',
          agentCli: 'codex',
        },
      },
      {
        board: { createTask },
        view: { getBoardSnapshot },
      } as never,
      '/tmp/agentboard.sock'
    );

    expect(createTask).toHaveBeenCalledWith({
      title: 'Use codex',
      repoId: 'repo-1',
      agentCli: 'codex',
    });
    expect(response).toEqual({
      id: 'req-create',
      result: task,
    });
    await expect(boardPatchEvent).resolves.toEqual({
      type: 'board_patch',
      payload: { tasks: [task] },
    });
  });
});

describe('daemon createMission dispatch', () => {
  it('returns the mission without waiting on the board patch snapshot', async () => {
    vi.useFakeTimers();
    try {
      const mission = {
        id: 'mission-1',
        title: 'Cross-repo rollout',
        sortKey: 1000,
        createdAt: 1,
        updatedAt: 1,
      };
      const createMission = vi.fn().mockReturnValue(mission);
      const getBoardSnapshot = vi.fn().mockReturnValue({ missions: [mission] });

      const boardPatchEvent = new Promise<unknown>((resolve) => {
        serverEvents.once('event', resolve);
      });

      const response = await dispatch(
        {
          id: 'req-mission',
          method: 'createMission',
          params: {
            title: 'Cross-repo rollout',
          },
        },
        {
          missions: { createMission },
          view: { getBoardSnapshot },
        } as never,
        '/tmp/agentboard.sock',
      );

      expect(createMission).toHaveBeenCalledWith({
        title: 'Cross-repo rollout',
      });
      expect(response).toEqual({
        id: 'req-mission',
        result: mission,
      });
      expect(getBoardSnapshot).not.toHaveBeenCalled();

      await vi.runAllTimersAsync();

      expect(getBoardSnapshot).toHaveBeenCalledTimes(1);
      await expect(boardPatchEvent).resolves.toEqual({
        type: 'board_patch',
        payload: { missions: [mission] },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('daemon deleteMission dispatch', () => {
  it('deletes mission tasks through the lifecycle service and emits a board patch asynchronously', async () => {
    vi.useFakeTimers();
    try {
      const deleteTask = vi.fn().mockResolvedValue(undefined);
      const deleteMission = vi.fn().mockImplementation(async (_missionId, taskDeleter) => {
        await taskDeleter('task-1');
        await taskDeleter('task-2');
      });
      const getBoardSnapshot = vi.fn().mockReturnValue({ missions: [] });

      const boardPatchEvent = new Promise<unknown>((resolve) => {
        serverEvents.once('event', resolve);
      });

      const response = await dispatch(
        {
          id: 'req-delete-mission',
          method: 'deleteMission',
          params: {
            missionId: 'mission-1',
          },
        },
        {
          missions: { deleteMission },
          taskLifecycle: { deleteTask },
          view: { getBoardSnapshot },
        } as never,
        '/tmp/agentboard.sock',
      );

      expect(deleteMission).toHaveBeenCalledWith('mission-1', expect.any(Function));
      expect(deleteTask).toHaveBeenCalledTimes(2);
      expect(deleteTask).toHaveBeenNthCalledWith(1, 'task-1');
      expect(deleteTask).toHaveBeenNthCalledWith(2, 'task-2');
      expect(response).toEqual({
        id: 'req-delete-mission',
        result: null,
      });
      expect(getBoardSnapshot).not.toHaveBeenCalled();

      await vi.runAllTimersAsync();

      expect(getBoardSnapshot).toHaveBeenCalledTimes(1);
      await expect(boardPatchEvent).resolves.toEqual({
        type: 'board_patch',
        payload: { missions: [] },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('daemon moveTask dispatch', () => {
  it('cleans up the worktree when a card is closed (moved to the done track)', async () => {
    const moveTask = vi.fn();
    const cleanupTaskResources = vi.fn().mockResolvedValue(undefined);
    const getBoardSnapshot = vi.fn().mockReturnValue({ tasks: [] });

    const response = await dispatch(
      {
        id: 'req-move-done',
        method: 'moveTask',
        params: { id: 'task-1', trackId: 'done' },
      },
      {
        board: { moveTask },
        taskLifecycle: { cleanupTaskResources },
        view: { getBoardSnapshot },
      } as never,
      '/tmp/agentboard.sock',
    );

    expect(moveTask).toHaveBeenCalledWith({ id: 'task-1', trackId: 'done' });
    expect(cleanupTaskResources).toHaveBeenCalledWith('task-1');
    expect(response).toEqual({ id: 'req-move-done', result: null });
  });

  it('does not clean up the worktree when moving to a non-done track', async () => {
    const moveTask = vi.fn();
    const cleanupTaskResources = vi.fn().mockResolvedValue(undefined);
    const getBoardSnapshot = vi.fn().mockReturnValue({ tasks: [] });

    const response = await dispatch(
      {
        id: 'req-move-pr',
        method: 'moveTask',
        params: { id: 'task-1', trackId: 'pr' },
      },
      {
        board: { moveTask },
        taskLifecycle: { cleanupTaskResources },
        view: { getBoardSnapshot },
      } as never,
      '/tmp/agentboard.sock',
    );

    expect(moveTask).toHaveBeenCalledWith({ id: 'task-1', trackId: 'pr' });
    expect(cleanupTaskResources).not.toHaveBeenCalled();
    expect(response).toEqual({ id: 'req-move-pr', result: null });
  });
});

describe('daemon mergeTaskPR dispatch', () => {
  it('updates the board immediately and does not await the follow-up sync', async () => {
    let resolveTrigger: (() => void) | null = null;
    const triggerPromise = new Promise<void>((resolve) => {
      resolveTrigger = resolve;
    });

    const updateTaskBranchSync = vi.fn();
    const moveTask = vi.fn();
    const getBoardSnapshot = vi.fn().mockReturnValue({ tasks: [] });
    const mergePR = vi.fn().mockResolvedValue(undefined);
    const trigger = vi.fn().mockReturnValue(triggerPromise);

    const boardPatchEvent = new Promise<unknown>((resolve) => {
      serverEvents.once('event', resolve);
    });

    const response = await dispatch(
      {
        id: 'req-1',
        method: 'mergeTaskPR',
        params: { taskId: 'task-1' },
      },
      {
        board: {
          getTask: vi.fn().mockReturnValue(makeTask()),
          updateTaskBranchSync,
          moveTask,
        },
        workspace: {
          getRepo: vi.fn().mockReturnValue({
            id: 'repo-1',
            path: '/repo',
            githubOwner: 'org',
            githubRepo: 'proj',
          }),
        },
        github: { mergePR },
        sync: { trigger },
        view: { getBoardSnapshot },
      } as never,
      '/tmp/agentboard.sock'
    );

    expect(response).toEqual({
      id: 'req-1',
      result: { merged: true },
    });
    expect(mergePR).toHaveBeenCalledWith('/repo', {
      githubRepo: 'org/proj',
      prNumber: 42,
    });
    expect(updateTaskBranchSync).toHaveBeenCalledWith('branch-1', {
      prState: 'merged',
      prDraft: false,
    });
    expect(moveTask).toHaveBeenCalledWith({
      id: 'task-1',
      trackId: 'done',
    });
    expect(trigger).toHaveBeenCalledTimes(1);

    await expect(boardPatchEvent).resolves.toEqual({
      type: 'board_patch',
      payload: { tasks: [] },
    });

    resolveTrigger?.();
  });
});

describe('daemon chatTurn dispatch', () => {
  it('returns the AI chat result and emits a board patch asynchronously', async () => {
    vi.useFakeTimers();
    try {
      const result = {
        assistantMessage: {
          role: 'assistant',
          content: 'Created task.',
          createdAt: 1,
        },
        transcript: [],
        executions: [],
      };
      const chatTurn = vi.fn().mockResolvedValue(result);
      const getBoardSnapshot = vi.fn().mockReturnValue({ tasks: [] });

      const boardPatchEvent = new Promise<unknown>((resolve) => {
        serverEvents.once('event', resolve);
      });

      const response = await dispatch(
        {
          id: 'req-chat',
          method: 'chatTurn',
          params: {
            prompt: 'create a task',
            transcript: [],
            context: { activeRepoId: 'repo-1' },
          },
        },
        {
          aiChat: { chatTurn },
          view: { getBoardSnapshot },
        } as never,
        '/tmp/agentboard.sock',
      );

      expect(chatTurn).toHaveBeenCalledWith({
        prompt: 'create a task',
        transcript: [],
        context: { activeRepoId: 'repo-1' },
      });
      expect(response).toEqual({
        id: 'req-chat',
        result,
      });

      await vi.runAllTimersAsync();

      await expect(boardPatchEvent).resolves.toEqual({
        type: 'board_patch',
        payload: { tasks: [] },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs chatTurn failures before returning the RPC error', async () => {
    const error = new Error('Ollama request failed with 500: model requires more system memory');
    const chatTurn = vi.fn().mockRejectedValue(error);
    const logError = vi.fn();

    const response = await dispatch(
      {
        id: 'req-chat-fail',
        method: 'chatTurn',
        params: {
          prompt: 'hello',
          transcript: [],
          context: { activeRepoId: 'repo-1' },
        },
      },
      {
        aiChat: { chatTurn },
        logError,
      } as never,
      '/tmp/agentboard.sock',
    );

    expect(logError).toHaveBeenCalledWith('RPC chatTurn failed (id=req-chat-fail)', error);
    expect(response).toEqual({
      id: 'req-chat-fail',
      error: {
        code: -32000,
        message: 'Ollama request failed with 500: model requires more system memory',
      },
    });
  });
});

describe('daemon schedulePostPushSync dispatch', () => {
  it('arms the background post-push follow-up without blocking on it', async () => {
    const schedulePostPushSync = vi.fn().mockReturnValue({ scheduled: true });

    const response = await dispatch(
      {
        id: 'req-2',
        method: 'schedulePostPushSync',
        params: { taskId: 'task-1' },
      },
      {
        sync: { schedulePostPushSync },
      } as never,
      '/tmp/agentboard.sock'
    );

    expect(schedulePostPushSync).toHaveBeenCalledWith('task-1');
    expect(response).toEqual({
      id: 'req-2',
      result: { scheduled: true },
    });
  });
});

describe('daemon shutdownManagedOllama dispatch', () => {
  it('stops the managed Ollama process when requested', async () => {
    const shutdown = vi.fn().mockResolvedValue({ stopped: true, managed: true });

    const response = await dispatch(
      {
        id: 'req-ollama-stop',
        method: 'shutdownManagedOllama',
      },
      {
        ollama: { shutdown },
      } as never,
      '/tmp/agentboard.sock',
    );

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(response).toEqual({
      id: 'req-ollama-stop',
      result: { stopped: true, managed: true },
    });
  });
});

describe('daemon commentTaskPR dispatch', () => {
  it('posts a PR comment through the GitHub service', async () => {
    const commentPR = vi.fn().mockResolvedValue(undefined);

    const response = await dispatch(
      {
        id: 'req-comment',
        method: 'commentTaskPR',
        params: { taskId: 'task-1', body: 'Looks good to me' },
      },
      {
        board: {
          getTask: vi.fn().mockReturnValue(makeTask()),
        },
        workspace: {
          getRepo: vi.fn().mockReturnValue({
            id: 'repo-1',
            path: '/repo',
            githubOwner: 'org',
            githubRepo: 'proj',
          }),
        },
        github: { commentPR },
      } as never,
      '/tmp/agentboard.sock'
    );

    expect(commentPR).toHaveBeenCalledWith('/repo', {
      githubRepo: 'org/proj',
      prNumber: 42,
      body: 'Looks good to me',
    });
    expect(response).toEqual({
      id: 'req-comment',
      result: { commented: true },
    });
  });
});

describe('daemon updateRepo dispatch', () => {
  it('updates the repo and emits a board patch', async () => {
    const repo = makeRepo({ defaultBaseBranch: 'master' });
    const updateRepo = vi.fn().mockReturnValue(repo);
    const getBoardSnapshot = vi.fn().mockReturnValue({ repos: [repo] });

    const boardPatchEvent = new Promise<unknown>((resolve) => {
      serverEvents.once('event', resolve);
    });

    const response = await dispatch(
      {
        id: 'req-3',
        method: 'updateRepo',
        params: {
          id: 'repo-1',
          defaultBaseBranch: 'master',
        },
      },
      {
        workspace: { updateRepo },
        view: { getBoardSnapshot },
      } as never,
      '/tmp/agentboard.sock'
    );

    expect(updateRepo).toHaveBeenCalledWith('repo-1', {
      defaultBaseBranch: 'master',
    });
    expect(response).toEqual({
      id: 'req-3',
      result: repo,
    });
    await expect(boardPatchEvent).resolves.toEqual({
      type: 'board_patch',
      payload: { repos: [repo] },
    });
  });
});

describe('daemon acknowledgeSessionAttention dispatch', () => {
  it('clears session attention and emits a board patch', async () => {
    const acknowledgeSessionAttention = vi.fn().mockReturnValue(true);
    const getBoardSnapshot = vi.fn().mockReturnValue({
      tasks: [{ id: 'task-1', sessionAttentionNeeded: false }],
    });

    const boardPatchEvent = new Promise<unknown>((resolve) => {
      serverEvents.once('event', resolve);
    });

    const response = await dispatch(
      {
        id: 'req-4',
        method: 'acknowledgeSessionAttention',
        params: { taskId: 'task-1' },
      },
      {
        session: { acknowledgeSessionAttention },
        view: { getBoardSnapshot },
      } as never,
      '/tmp/agentboard.sock'
    );

    expect(acknowledgeSessionAttention).toHaveBeenCalledWith('task-1');
    expect(response).toEqual({
      id: 'req-4',
      result: null,
    });
    await expect(boardPatchEvent).resolves.toEqual({
      type: 'board_patch',
      payload: { tasks: [{ id: 'task-1', sessionAttentionNeeded: false }] },
    });
  });
});

describe('daemon addTaskBranch dispatch', () => {
  it('defaults the branch name to the one the card already works under', async () => {
    // Arrange
    const addTaskBranch = vi.fn().mockReturnValue(makeBranch({ id: 'branch-2', repoId: 'repo-2' }));
    const getBoardSnapshot = vi.fn().mockReturnValue({ tasks: [] });
    const trigger = vi.fn().mockResolvedValue(undefined);

    // Act
    const response = await dispatch(
      {
        id: 'req-add-branch',
        method: 'addTaskBranch',
        params: { taskId: 'task-1', repoId: 'repo-2' },
      },
      {
        board: { getTask: vi.fn().mockReturnValue(makeTask()), addTaskBranch },
        workspace: { getRepo: vi.fn().mockReturnValue(makeRepo({ id: 'repo-2' })) },
        view: { getBoardSnapshot },
        sync: { trigger },
      } as never,
      '/tmp/agentboard.sock',
    );

    // Assert
    expect(addTaskBranch).toHaveBeenCalledWith({
      taskId: 'task-1',
      repoId: 'repo-2',
      branchName: 'ab/task-1',
    });
    expect(response).toEqual({ id: 'req-add-branch', result: { tasks: [] } });
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it('refuses a repo the workspace does not know', async () => {
    // Arrange
    const addTaskBranch = vi.fn();

    // Act
    const response = await dispatch(
      {
        id: 'req-add-unknown-repo',
        method: 'addTaskBranch',
        params: { taskId: 'task-1', repoId: 'repo-ghost' },
      },
      {
        board: { getTask: vi.fn().mockReturnValue(makeTask()), addTaskBranch },
        workspace: { getRepo: vi.fn().mockReturnValue(undefined) },
      } as never,
      '/tmp/agentboard.sock',
    );

    // Assert
    expect(addTaskBranch).not.toHaveBeenCalled();
    expect(response.error?.message).toBe('Repo not found: repo-ghost');
  });
});

describe('daemon removeTaskBranch dispatch', () => {
  it('refuses to remove a branch whose PR is merged, so the card cannot look complete while losing shipped work', async () => {
    // Arrange
    const merged = makeBranch({ id: 'branch-2', prState: 'merged', worktreePath: '/wt/2' });
    const removeTaskBranch = vi.fn();
    const removeWorktreeAsync = vi.fn();

    // Act
    const response = await dispatch(
      {
        id: 'req-remove-merged',
        method: 'removeTaskBranch',
        params: { taskId: 'task-1', branchId: 'branch-2' },
      },
      {
        board: { getTaskBranch: vi.fn().mockReturnValue(merged), removeTaskBranch },
        workspace: { getRepo: vi.fn().mockReturnValue(makeRepo()) },
        git: { removeWorktreeAsync },
      } as never,
      '/tmp/agentboard.sock',
    );

    // Assert
    expect(removeTaskBranch).not.toHaveBeenCalled();
    expect(removeWorktreeAsync).not.toHaveBeenCalled();
    expect(response.error?.message).toBe(
      'Branch ab/task-1 has a merged pull request and cannot be removed',
    );
  });

  it('releases the worktree before dropping an unmerged branch', async () => {
    // Arrange
    const branch = makeBranch({ id: 'branch-2', prState: 'open', worktreePath: '/wt/2' });
    const removeTaskBranch = vi.fn();
    // Removal goes through the lifecycle service because only that path runs on
    // the card's own host; doing it locally would leak every remote worktree.
    const removeBranchWorktree = vi.fn().mockResolvedValue(true);
    const getBoardSnapshot = vi.fn().mockReturnValue({ tasks: [] });

    // Act
    const response = await dispatch(
      {
        id: 'req-remove-branch',
        method: 'removeTaskBranch',
        params: { taskId: 'task-1', branchId: 'branch-2' },
      },
      {
        board: {
          getTaskBranch: vi.fn().mockReturnValue(branch),
          getTaskBranches: vi.fn().mockReturnValue([makeBranch(), branch]),
          removeTaskBranch,
        },
        workspace: { getRepo: vi.fn().mockReturnValue(makeRepo()) },
        taskLifecycle: { removeBranchWorktree },
        view: { getBoardSnapshot },
      } as never,
      '/tmp/agentboard.sock',
    );

    // Assert
    expect(removeBranchWorktree).toHaveBeenCalledWith('branch-2');
    expect(removeTaskBranch).toHaveBeenCalledWith('branch-2');
    expect(response).toEqual({ id: 'req-remove-branch', result: { tasks: [] } });
  });

  it('refuses to remove a card\u2019s only branch, which would freeze its state', async () => {
    // Arrange — with no branches left there is nothing to derive the card from,
    // so its PR and check columns would keep painting work that is gone.
    const branch = makeBranch({ id: 'branch-1', prState: 'open', worktreePath: '/wt/1' });
    const removeTaskBranch = vi.fn();

    // Act
    const response = await dispatch(
      {
        id: 'req-remove-last',
        method: 'removeTaskBranch',
        params: { taskId: 'task-1', branchId: 'branch-1' },
      },
      {
        board: {
          getTaskBranch: vi.fn().mockReturnValue(branch),
          getTaskBranches: vi.fn().mockReturnValue([branch]),
          removeTaskBranch,
        },
      } as never,
      '/tmp/agentboard.sock',
    );

    // Assert
    expect(removeTaskBranch).not.toHaveBeenCalled();
    expect(response.error?.message).toContain('only branch');
  });

  it('keeps the branch when its worktree could not be removed, rather than orphaning it', async () => {
    // Arrange — the row is the only record of where the worktree is. Dropping
    // it after a failed removal leaves a directory nobody can find again, and
    // reports that as success.
    const branch = makeBranch({ id: 'branch-2', prState: 'open', worktreePath: '/wt/2' });
    const removeTaskBranch = vi.fn();
    const removeBranchWorktree = vi.fn().mockResolvedValue(false);

    // Act
    const response = await dispatch(
      {
        id: 'req-remove-broken',
        method: 'removeTaskBranch',
        params: { taskId: 'task-1', branchId: 'branch-2' },
      },
      {
        board: {
          getTaskBranch: vi.fn().mockReturnValue(branch),
          getTaskBranches: vi.fn().mockReturnValue([makeBranch(), branch]),
          removeTaskBranch,
        },
        taskLifecycle: { removeBranchWorktree },
        view: { getBoardSnapshot: vi.fn().mockReturnValue({ tasks: [] }) },
      } as never,
      '/tmp/agentboard.sock',
    );

    // Assert
    expect(removeTaskBranch).not.toHaveBeenCalled();
    expect(response.error?.message).toContain('/wt/2');
  });

  it('refuses a branch id belonging to another card', async () => {
    // Arrange
    const foreign = makeBranch({ id: 'branch-9', taskId: 'task-other' });
    const removeTaskBranch = vi.fn();

    // Act
    const response = await dispatch(
      {
        id: 'req-remove-foreign',
        method: 'removeTaskBranch',
        params: { taskId: 'task-1', branchId: 'branch-9' },
      },
      {
        board: { getTaskBranch: vi.fn().mockReturnValue(foreign), removeTaskBranch },
      } as never,
      '/tmp/agentboard.sock',
    );

    // Assert
    expect(removeTaskBranch).not.toHaveBeenCalled();
    expect(response.error?.message).toBe('Branch branch-9 does not belong to task task-1');
  });
});

describe('daemon setActiveTaskBranch dispatch', () => {
  it('hands the mirroring to the board so the card cannot pair one repo with another\u2019s branch', async () => {
    // Arrange — repo, branch name and worktree have to move together. Writing
    // them separately is how a cross-repo card ended up with repo-1's id and
    // repo-2's branch, and a session built from the wrong base branch.
    const branch = makeBranch({
      id: 'branch-2',
      branchName: 'ab/task-1-api',
      worktreePath: '/wt/api',
    });
    const setActiveTaskBranch = vi.fn();
    const setTaskBranch = vi.fn();
    const getBoardSnapshot = vi.fn().mockReturnValue({ tasks: [] });

    // Act
    const response = await dispatch(
      {
        id: 'req-set-active',
        method: 'setActiveTaskBranch',
        params: { taskId: 'task-1', branchId: 'branch-2' },
      },
      {
        board: {
          getTaskBranch: vi.fn().mockReturnValue(branch),
          setActiveTaskBranch,
          setTaskBranch,
        },
        view: { getBoardSnapshot },
      } as never,
      '/tmp/agentboard.sock',
    );

    // Assert
    expect(setActiveTaskBranch).toHaveBeenCalledWith('task-1', 'branch-2');
    expect(setTaskBranch).not.toHaveBeenCalled();
    expect(response).toEqual({ id: 'req-set-active', result: { tasks: [] } });
  });

  it('works from a branch id alone, which is all the caller has', async () => {
    // Arrange — a branch id identifies a branch on its own. Requiring taskId
    // made every branch-scoped action fail against the real client, which sends
    // only the branch it acted on; the tests missed it by always passing both.
    const branch = makeBranch({ id: 'branch-2', branchName: 'ab/task-1-api' });
    const setActiveTaskBranch = vi.fn();

    // Act
    const response = await dispatch(
      {
        id: 'req-set-active-no-task',
        method: 'setActiveTaskBranch',
        params: { branchId: 'branch-2' },
      },
      {
        board: {
          getTaskBranch: vi.fn().mockReturnValue(branch),
          setActiveTaskBranch,
        },
        view: { getBoardSnapshot: vi.fn().mockReturnValue({ tasks: [] }) },
      } as never,
      '/tmp/agentboard.sock',
    );

    // Assert
    expect(response.error).toBeUndefined();
    expect(setActiveTaskBranch).toHaveBeenCalledWith('task-1', 'branch-2');
  });
});

describe('daemon mergeTaskBranchPR dispatch', () => {
  it('merges only the named branch of a three-branch card and leaves the card off the done track', async () => {
    // Arrange
    const branches = [
      makeBranch({ id: 'branch-1', branchName: 'ab/api', prNumber: 1 }),
      makeBranch({ id: 'branch-2', branchName: 'ab/web', prNumber: 2, repoId: 'repo-2' }),
      makeBranch({ id: 'branch-3', branchName: 'ab/docs', prNumber: 3, repoId: 'repo-3' }),
    ];
    const task = makeTask({ branches, prCount: 3, prOpenCount: 3 });
    const updateTaskBranchSync = vi.fn();
    const updateTaskSync = vi.fn();
    const moveTask = vi.fn();
    const mergePR = vi.fn().mockResolvedValue(undefined);
    const reconcileTaskCompletion = vi.fn();

    // Act
    const response = await dispatch(
      {
        id: 'req-merge-branch',
        method: 'mergeTaskBranchPR',
        params: { taskId: 'task-1', branchId: 'branch-2' },
      },
      {
        board: {
          getTask: vi.fn().mockReturnValue(task),
          getTaskBranch: vi.fn().mockReturnValue(branches[1]),
          updateTaskBranchSync,
          updateTaskSync,
          moveTask,
        },
        workspace: {
          getRepo: vi.fn().mockReturnValue(
            makeRepo({ id: 'repo-2', path: '/repo2', githubOwner: 'org', githubRepo: 'web' }),
          ),
        },
        github: { mergePR },
        missions: { reconcileTaskCompletion },
        sync: { trigger: vi.fn().mockResolvedValue(undefined) },
        view: { getBoardSnapshot: vi.fn().mockReturnValue({ tasks: [task] }) },
      } as never,
      '/tmp/agentboard.sock',
    );

    // Assert
    expect(response).toEqual({ id: 'req-merge-branch', result: { merged: true } });
    expect(mergePR).toHaveBeenCalledWith('/repo2', { githubRepo: 'org/web', prNumber: 2 });
    expect(updateTaskBranchSync).toHaveBeenCalledWith('branch-2', {
      prState: 'merged',
      prDraft: false,
    });
    // The card still has two open pull requests, so it is not done.
    expect(moveTask).not.toHaveBeenCalled();
    expect(updateTaskSync).not.toHaveBeenCalled();
    expect(reconcileTaskCompletion).not.toHaveBeenCalled();
  });

  it('reads the merge guards from the branch, not the card rollup', async () => {
    // Arrange — the card rolls up as green, but this branch's build is failing.
    const failing = makeBranch({ id: 'branch-2', branchName: 'ab/web', ciState: 'failed' });
    const mergePR = vi.fn();

    // Act
    const response = await dispatch(
      {
        id: 'req-merge-red-branch',
        method: 'mergeTaskBranchPR',
        params: { taskId: 'task-1', branchId: 'branch-2' },
      },
      {
        board: {
          getTask: vi.fn().mockReturnValue(makeTask()),
          getTaskBranch: vi.fn().mockReturnValue(failing),
        },
        workspace: { getRepo: vi.fn().mockReturnValue(makeRepo()) },
        github: { mergePR },
      } as never,
      '/tmp/agentboard.sock',
    );

    // Assert
    expect(mergePR).not.toHaveBeenCalled();
    expect(response.error?.message).toBe('Branch ab/web build has not passed');
  });
});

describe('daemon commentTaskBranchPR dispatch', () => {
  it('comments on the named branch of a multi-branch card', async () => {
    // Arrange
    const branch = makeBranch({ id: 'branch-2', branchName: 'ab/web', prNumber: 2, repoId: 'repo-2' });
    const commentPR = vi.fn().mockResolvedValue(undefined);

    // Act
    const response = await dispatch(
      {
        id: 'req-comment-branch',
        method: 'commentTaskBranchPR',
        params: { taskId: 'task-1', branchId: 'branch-2', body: 'ship it' },
      },
      {
        board: { getTaskBranch: vi.fn().mockReturnValue(branch) },
        workspace: {
          getRepo: vi.fn().mockReturnValue(
            makeRepo({ id: 'repo-2', path: '/repo2', githubOwner: 'org', githubRepo: 'web' }),
          ),
        },
        github: { commentPR },
      } as never,
      '/tmp/agentboard.sock',
    );

    // Assert
    expect(commentPR).toHaveBeenCalledWith('/repo2', {
      githubRepo: 'org/web',
      prNumber: 2,
      body: 'ship it',
    });
    expect(response).toEqual({ id: 'req-comment-branch', result: { commented: true } });
  });

  it('rejects an empty comment body', async () => {
    // Arrange
    const commentPR = vi.fn();

    // Act
    const response = await dispatch(
      {
        id: 'req-comment-empty',
        method: 'commentTaskBranchPR',
        params: { taskId: 'task-1', branchId: 'branch-1', body: '   ' },
      },
      {
        board: { getTaskBranch: vi.fn().mockReturnValue(makeBranch()) },
        workspace: { getRepo: vi.fn().mockReturnValue(makeRepo()) },
        github: { commentPR },
      } as never,
      '/tmp/agentboard.sock',
    );

    // Assert
    expect(commentPR).not.toHaveBeenCalled();
    expect(response.error?.message).toBe('PR comment body cannot be empty');
  });
});

describe('legacy card-scoped PR shims', () => {
  it('mergeTaskPR refuses a multi-branch card instead of merging an arbitrary PR', async () => {
    // Arrange
    const task = makeTask({
      branches: [
        makeBranch({ id: 'branch-1', branchName: 'ab/api', prNumber: 1 }),
        makeBranch({ id: 'branch-2', branchName: 'ab/web', prNumber: 2 }),
      ],
      // Mirrors the real rollup: no honest single PR once there are several.
      prNumber: undefined,
      prCount: 2,
      prOpenCount: 2,
    });
    const mergePR = vi.fn();
    const moveTask = vi.fn();

    // Act
    const response = await dispatch(
      {
        id: 'req-merge-ambiguous',
        method: 'mergeTaskPR',
        params: { taskId: 'task-1' },
      },
      {
        board: { getTask: vi.fn().mockReturnValue(task), moveTask },
        workspace: { getRepo: vi.fn().mockReturnValue(makeRepo()) },
        github: { mergePR },
      } as never,
      '/tmp/agentboard.sock',
    );

    // Assert
    expect(mergePR).not.toHaveBeenCalled();
    expect(moveTask).not.toHaveBeenCalled();
    expect(response.error?.message).toBe(
      'This card has 2 pull requests — choose one: #1 (ab/api), #2 (ab/web)',
    );
  });

  it('commentTaskPR refuses a multi-branch card instead of commenting on an arbitrary PR', async () => {
    // Arrange
    const task = makeTask({
      branches: [
        makeBranch({ id: 'branch-1', branchName: 'ab/api', prNumber: 1 }),
        makeBranch({ id: 'branch-2', branchName: 'ab/web', prNumber: 2 }),
      ],
      prNumber: undefined,
      prCount: 2,
    });
    const commentPR = vi.fn();

    // Act
    const response = await dispatch(
      {
        id: 'req-comment-ambiguous',
        method: 'commentTaskPR',
        params: { taskId: 'task-1', body: 'which one?' },
      },
      {
        board: { getTask: vi.fn().mockReturnValue(task) },
        workspace: { getRepo: vi.fn().mockReturnValue(makeRepo()) },
        github: { commentPR },
      } as never,
      '/tmp/agentboard.sock',
    );

    // Assert
    expect(commentPR).not.toHaveBeenCalled();
    expect(response.error?.message).toBe(
      'This card has 2 pull requests — choose one: #1 (ab/api), #2 (ab/web)',
    );
  });

  it('mergeTaskPR still closes a single-branch card', async () => {
    // Arrange
    const updateTaskBranchSync = vi.fn();
    const moveTask = vi.fn();
    const reconcileTaskCompletion = vi.fn();
    const mergePR = vi.fn().mockResolvedValue(undefined);

    // Act
    const response = await dispatch(
      {
        id: 'req-merge-single',
        method: 'mergeTaskPR',
        params: { taskId: 'task-1' },
      },
      {
        board: {
          getTask: vi.fn().mockReturnValue(makeTask()),
          updateTaskBranchSync,
          moveTask,
        },
        workspace: {
          getRepo: vi.fn().mockReturnValue(
            makeRepo({ githubOwner: 'org', githubRepo: 'proj' }),
          ),
        },
        github: { mergePR },
        missions: { reconcileTaskCompletion },
        sync: { trigger: vi.fn().mockResolvedValue(undefined) },
        view: { getBoardSnapshot: vi.fn().mockReturnValue({ tasks: [] }) },
      } as never,
      '/tmp/agentboard.sock',
    );

    // Assert
    expect(response).toEqual({ id: 'req-merge-single', result: { merged: true } });
    expect(mergePR).toHaveBeenCalledWith('/repo', { githubRepo: 'org/proj', prNumber: 42 });
    expect(updateTaskBranchSync).toHaveBeenCalledWith('branch-1', {
      prState: 'merged',
      prDraft: false,
    });
    expect(moveTask).toHaveBeenCalledWith({ id: 'task-1', trackId: 'done' });
    expect(reconcileTaskCompletion).toHaveBeenCalledWith('task-1');
  });

  it('mergeTaskPR merges the only PR on a card whose other branches carry none', async () => {
    // Arrange — extra branches without pull requests leave "the card's PR"
    // unambiguous, so the shim must not refuse.
    const task = makeTask({
      branches: [
        makeBranch({ id: 'branch-1', branchName: 'ab/api', prNumber: 7 }),
        makeBranch({ id: 'branch-2', branchName: 'ab/web', prNumber: undefined, prState: 'none' }),
      ],
      prNumber: undefined,
      prCount: 1,
    });
    const mergePR = vi.fn().mockResolvedValue(undefined);

    // Act
    const response = await dispatch(
      {
        id: 'req-merge-one-pr',
        method: 'mergeTaskPR',
        params: { taskId: 'task-1' },
      },
      {
        board: {
          getTask: vi.fn().mockReturnValue(task),
          updateTaskBranchSync: vi.fn(),
          moveTask: vi.fn(),
        },
        workspace: {
          getRepo: vi.fn().mockReturnValue(makeRepo({ githubOwner: 'org', githubRepo: 'proj' })),
        },
        github: { mergePR },
        missions: { reconcileTaskCompletion: vi.fn() },
        sync: { trigger: vi.fn().mockResolvedValue(undefined) },
        view: { getBoardSnapshot: vi.fn().mockReturnValue({ tasks: [] }) },
      } as never,
      '/tmp/agentboard.sock',
    );

    // Assert
    expect(mergePR).toHaveBeenCalledWith('/repo', { githubRepo: 'org/proj', prNumber: 7 });
    expect(response).toEqual({ id: 'req-merge-one-pr', result: { merged: true } });
  });
});

describe('daemon setTrackedArtifacts dispatch', () => {
  afterEach(() => {
    vi.mocked(saveArtifactList).mockClear();
  });

  it('adds the first artifact when no rail is running', async () => {
    // The rail is only built for a non-empty list, so this is the one edit that
    // can never find one already up. Rejecting it left the list empty forever.
    const enableArtifacts = vi.fn().mockResolvedValue(undefined);

    const response = await dispatch(
      {
        id: 'req-first-artifact',
        method: 'setTrackedArtifacts',
        params: { names: ['com.wixpress.enterprise.web5.prompt-catalog'] },
      },
      { enableArtifacts } as never,
      '/tmp/agentboard.sock',
    );

    expect(saveArtifactList).toHaveBeenCalledWith([
      'com.wixpress.enterprise.web5.prompt-catalog',
    ]);
    expect(enableArtifacts).toHaveBeenCalledWith([
      'com.wixpress.enterprise.web5.prompt-catalog',
    ]);
    expect(response).toEqual({
      id: 'req-first-artifact',
      result: { names: ['com.wixpress.enterprise.web5.prompt-catalog'] },
    });
  });

  it('applies to the running rail rather than building a second one', async () => {
    const setArtifactNames = vi.fn();
    const enableArtifacts = vi.fn().mockResolvedValue(undefined);

    await dispatch(
      {
        id: 'req-existing-rail',
        method: 'setTrackedArtifacts',
        params: { names: ['com.wixpress.a', 'com.wixpress.b'] },
      },
      { artifacts: { setArtifactNames }, enableArtifacts } as never,
      '/tmp/agentboard.sock',
    );

    expect(setArtifactNames).toHaveBeenCalledWith(['com.wixpress.a', 'com.wixpress.b']);
    expect(enableArtifacts).not.toHaveBeenCalled();
  });

  it('persists exactly what it applies, trimmed and de-duplicated', async () => {
    // A list that reached config.json differing from the one handed to the rail
    // would come back changed on the next restart.
    const setArtifactNames = vi.fn();

    const response = await dispatch(
      {
        id: 'req-messy-names',
        method: 'setTrackedArtifacts',
        params: { names: ['  com.wixpress.a  ', 'com.wixpress.a', '', '   ', 'com.wixpress.b'] },
      },
      { artifacts: { setArtifactNames } } as never,
      '/tmp/agentboard.sock',
    );

    const cleaned = ['com.wixpress.a', 'com.wixpress.b'];
    expect(saveArtifactList).toHaveBeenCalledWith(cleaned);
    expect(setArtifactNames).toHaveBeenCalledWith(cleaned);
    expect(response).toEqual({ id: 'req-messy-names', result: { names: cleaned } });
  });

  it('serves the configured list, including artifacts the rail could not resolve', async () => {
    // The editor opens on this, not on the rail's rows. An artifact devex is
    // down for is still tracked, and omitting it here is what let the next save
    // delete it from the config.
    const configured = ['com.wixpress.resolved', 'com.wixpress.unreachable'];

    const response = await dispatch(
      { id: 'req-tracked', method: 'getTrackedArtifacts', params: {} },
      {
        artifacts: {
          getArtifactNames: vi.fn().mockReturnValue(configured),
          // Only one of the two resolved; the snapshot is the shorter list.
          getSnapshot: vi.fn().mockReturnValue({ artifacts: [{ name: 'com.wixpress.resolved' }] }),
        },
      } as never,
      '/tmp/agentboard.sock',
    );

    expect(response).toEqual({ id: 'req-tracked', result: { names: configured } });
  });

  it('reports an empty tracked list when no rail is running', async () => {
    const response = await dispatch(
      { id: 'req-tracked-none', method: 'getTrackedArtifacts', params: {} },
      {} as never,
      '/tmp/agentboard.sock',
    );

    expect(response).toEqual({ id: 'req-tracked-none', result: { names: [] } });
  });

  it('persists an emptied list even with nothing to apply it to', async () => {
    // Removing the last artifact must still reach disk, or it returns on restart.
    const response = await dispatch(
      { id: 'req-empty', method: 'setTrackedArtifacts', params: { names: [] } },
      {} as never,
      '/tmp/agentboard.sock',
    );

    expect(saveArtifactList).toHaveBeenCalledWith([]);
    expect(response).toEqual({ id: 'req-empty', result: { names: [] } });
  });
});
