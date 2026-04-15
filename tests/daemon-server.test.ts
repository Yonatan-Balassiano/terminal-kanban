import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatch, serverEvents } from '../src/daemon/server.js';
import type { RepoRecord, TaskRecord } from '../src/types/index.js';

function makeTask(patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1',
    title: 'My task',
    repoId: 'repo-1',
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
