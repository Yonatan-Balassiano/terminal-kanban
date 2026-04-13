import { describe, expect, it, vi } from 'vitest';
import { AppController } from '../src/controller/index.js';
import type { AppAction, GetBufferResult, RPCEvent, SessionRecord } from '../src/types/index.js';

describe('AppController', () => {
  it('opens a session and immediately loads the terminal buffer', async () => {
    const dispatch = vi.fn<(action: AppAction) => void>();
    const session: SessionRecord = {
      id: 'sess-1',
      taskId: 'task-1',
      backendType: 'tmux',
      backendSessionId: 'ab_task-1',
      attachCommand: 'tmux attach -t ab_task-1',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    };
    const buffer: GetBufferResult = {
      lines: ['prompt'],
      ansiLines: ['prompt'],
      cursorX: 6,
      cursorY: 0,
    };

    const rpc = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      subscribe: vi.fn(),
      call: vi
        .fn()
        .mockResolvedValueOnce(session)
        .mockResolvedValueOnce(buffer),
    };

    const controller = new AppController(
      rpc as unknown as ConstructorParameters<typeof AppController>[0],
      dispatch,
    );

    await controller.openSession('task-1');

    expect(rpc.call).toHaveBeenNthCalledWith(1, 'openSession', { taskId: 'task-1' });
    expect(rpc.call).toHaveBeenNthCalledWith(2, 'getBuffer', { taskId: 'task-1' });
    expect(dispatch).toHaveBeenNthCalledWith(1, {
      type: 'SESSION_OPENED',
      payload: { taskId: 'task-1', session },
    });
    expect(dispatch).toHaveBeenNthCalledWith(2, { type: 'TERMINAL_PANE_SHOW' });
    expect(dispatch).toHaveBeenNthCalledWith(3, {
      type: 'BUFFER_UPDATE',
      payload: buffer,
    });
  });

  it('starts only once even if called repeatedly', async () => {
    const dispatch = vi.fn<(action: AppAction) => void>();
    const rpc = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      subscribe: vi.fn().mockReturnValue(() => {}),
      call: vi.fn().mockResolvedValue({
        repos: [],
        pillars: [],
        labels: [],
        tracks: [],
        tasks: [],
        savedViews: [],
        uiState: {},
      }),
    };

    const controller = new AppController(
      rpc as unknown as ConstructorParameters<typeof AppController>[0],
      dispatch,
    );

    await Promise.all([controller.start(), controller.start()]);

    expect(rpc.connect).toHaveBeenCalledTimes(1);
    expect(rpc.subscribe).toHaveBeenCalledTimes(1);
    expect(rpc.call).toHaveBeenCalledTimes(1);
    expect(rpc.call).toHaveBeenCalledWith('getBoard');
  });

  it('updates task description and refreshes the board', async () => {
    const dispatch = vi.fn<(action: AppAction) => void>();
    const board = {
      repos: [],
      pillars: [],
      labels: [],
      tracks: [],
      tasks: [],
      savedViews: [],
      uiState: {},
    };
    const rpc = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      subscribe: vi.fn(),
      call: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(board),
    };

    const controller = new AppController(
      rpc as unknown as ConstructorParameters<typeof AppController>[0],
      dispatch,
    );

    await controller.updateTaskDescription({ id: 'task-1', description: 'Short summary' });

    expect(rpc.call).toHaveBeenNthCalledWith(1, 'updateTaskDescription', {
      id: 'task-1',
      description: 'Short summary',
    });
    expect(rpc.call).toHaveBeenNthCalledWith(2, 'getBoard');
  });

  it('creates a pillar and refreshes the board', async () => {
    const dispatch = vi.fn<(action: AppAction) => void>();
    const board = {
      repos: [],
      pillars: [],
      labels: [],
      tracks: [],
      tasks: [],
      savedViews: [],
      uiState: {},
    };
    const pillar = { id: 'pillar-1', label: 'Platform' };
    const rpc = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      subscribe: vi.fn(),
      call: vi.fn().mockResolvedValueOnce(pillar).mockResolvedValueOnce(board),
    };

    const controller = new AppController(
      rpc as unknown as ConstructorParameters<typeof AppController>[0],
      dispatch,
    );

    await expect(controller.createPillar({ label: 'Platform' })).resolves.toEqual(pillar);

    expect(rpc.call).toHaveBeenNthCalledWith(1, 'createPillar', {
      label: 'Platform',
    });
    expect(rpc.call).toHaveBeenNthCalledWith(2, 'getBoard');
  });

  it('persists ui state changes and refreshes the board', async () => {
    const dispatch = vi.fn<(action: AppAction) => void>();
    const board = {
      repos: [],
      pillars: [],
      labels: [],
      tracks: [],
      tasks: [],
      savedViews: [],
      uiState: { activeRepoId: 'repo-2' },
    };
    const rpc = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      subscribe: vi.fn(),
      call: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(board),
    };

    const controller = new AppController(
      rpc as unknown as ConstructorParameters<typeof AppController>[0],
      dispatch,
    );

    await controller.setUIState({ activeRepoId: 'repo-2' });

    expect(rpc.call).toHaveBeenNthCalledWith(1, 'setUIState', {
      activeRepoId: 'repo-2',
    });
    expect(rpc.call).toHaveBeenNthCalledWith(2, 'getBoard');
  });

  it('applies pushed session buffer updates only for the active task', async () => {
    const dispatch = vi.fn<(action: AppAction) => void>();
    const session: SessionRecord = {
      id: 'sess-1',
      taskId: 'task-1',
      backendType: 'pty',
      backendSessionId: 'task-1',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    };
    const rpc = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      subscribe: vi.fn(),
      call: vi
        .fn()
        .mockResolvedValueOnce(session)
        .mockResolvedValueOnce({ lines: [], ansiLines: [], cursorX: 0, cursorY: 0 }),
    };

    const controller = new AppController(
      rpc as unknown as ConstructorParameters<typeof AppController>[0],
      dispatch,
    );

    await controller.openSession('task-1');
    dispatch.mockClear();

    const controllerWithPrivate = controller as unknown as {
      handleEvent: (event: RPCEvent) => void;
    };

    controllerWithPrivate.handleEvent({
      type: 'session_update',
      payload: { taskId: 'task-2', lines: ['wrong'], ansiLines: ['wrong'], cursorX: 0, cursorY: 0 },
    });
    controllerWithPrivate.handleEvent({
      type: 'session_update',
      payload: { taskId: 'task-1', lines: ['right'], ansiLines: ['\u001b[31mright\u001b[0m'], cursorX: 1, cursorY: 0 },
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      type: 'BUFFER_UPDATE',
      payload: {
        lines: ['right'],
        ansiLines: ['\u001b[31mright\u001b[0m'],
        cursorX: 1,
        cursorY: 0,
      },
    });
  });

  it('stores inspected session activity in app state through dispatch', async () => {
    const dispatch = vi.fn<(action: AppAction) => void>();
    const activity = {
      taskId: 'task-1',
      sessionId: 'session-1',
      sessionStatus: 'active',
      isBusy: true,
      kind: 'agent',
      command: 'claude',
      label: 'Claude',
      pid: 123,
      updatedAt: 1,
    } as const;
    const rpc = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      subscribe: vi.fn(),
      call: vi.fn().mockResolvedValue(activity),
    };

    const controller = new AppController(
      rpc as unknown as ConstructorParameters<typeof AppController>[0],
      dispatch,
    );

    await expect(controller.inspectSession('task-1')).resolves.toEqual(activity);

    expect(rpc.call).toHaveBeenCalledWith('inspectSession', { taskId: 'task-1' });
    expect(dispatch).toHaveBeenCalledWith({
      type: 'SESSION_ACTIVITY_UPDATED',
      payload: { taskId: 'task-1', activity },
    });
  });

  it('surfaces a restart warning when the daemon does not support session inspection', async () => {
    const dispatch = vi.fn<(action: AppAction) => void>();
    const rpc = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      subscribe: vi.fn(),
      call: vi.fn().mockRejectedValue(new Error('Not implemented')),
    };

    const controller = new AppController(
      rpc as unknown as ConstructorParameters<typeof AppController>[0],
      dispatch,
    );

    await expect(controller.inspectSession('task-1')).resolves.toBeNull();
    await expect(controller.inspectSession('task-1')).resolves.toBeNull();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      type: 'STATUS_MESSAGE',
      payload: 'Restart daemon to enable session activity indicators.',
    });
  });

  it('ignores pushed board snapshots when the content is unchanged', async () => {
    const dispatch = vi.fn<(action: AppAction) => void>();
    const board = {
      repos: [],
      pillars: [],
      labels: [],
      tracks: [],
      tasks: [],
      savedViews: [],
      uiState: {},
    };
    const rpc = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      subscribe: vi.fn().mockReturnValue(() => {}),
      call: vi.fn().mockResolvedValue(board),
    };

    const controller = new AppController(
      rpc as unknown as ConstructorParameters<typeof AppController>[0],
      dispatch,
    );

    await controller.start();
    dispatch.mockClear();

    const controllerWithPrivate = controller as unknown as {
      handleEvent: (event: RPCEvent) => void;
    };

    controllerWithPrivate.handleEvent({
      type: 'board_patch',
      payload: board,
    });

    expect(dispatch).not.toHaveBeenCalled();
  });
});
