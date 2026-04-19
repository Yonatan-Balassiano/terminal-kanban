import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatch, serverEvents, shouldForwardEventToSubscriber } from '../src/daemon/server.js';
import type { RepoRecord, TaskRecord } from '../src/types/index.js';

function makeTask(patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1',
    title: 'My task',
    repoId: 'repo-1',
    agentCli: 'claude',
    trackId: 'in-progress',
    labels: [],
    branchName: 'ab/task-1',
    sortKey: 1000,
    prNumber: 42,
    prState: 'open',
    prDraft: false,
    ciState: 'passed',
    gitState: 'clean',
    gitAheadCount: 0,
    gitBehindCount: 0,
    hasUntracked: false,
    hasConflicts: false,
    sessionAttentionNeeded: false,
    reviewState: 'approved',
    unresolvedThreadCount: 0,
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

describe('daemon mergeTaskPR dispatch', () => {
  it('updates the board immediately and does not await the follow-up sync', async () => {
    let resolveTrigger: (() => void) | null = null;
    const triggerPromise = new Promise<void>((resolve) => {
      resolveTrigger = resolve;
    });

    const updateTaskSync = vi.fn();
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
          updateTaskSync,
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
    expect(updateTaskSync).toHaveBeenCalledWith('task-1', {
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
