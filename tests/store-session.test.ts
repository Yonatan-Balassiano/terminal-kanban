import { describe, expect, it } from 'vitest';
import { initialState, reducer } from '../src/store/index.js';

describe('store session state', () => {
  it('stores the active session branch when a session opens', () => {
    const next = reducer(initialState, {
      type: 'SESSION_OPENED',
      payload: {
        taskId: 'task-1',
        session: {
          id: 'session-1',
          taskId: 'task-1',
          backendType: 'tmux',
          backendSessionId: 'ab_task-1',
          attachCommand: 'tmux attach -t ab_task-1',
          status: 'active',
          branch: 'ab/task-1',
          createdAt: 1,
          updatedAt: 1,
        },
      },
    });

    expect(next.activeTaskId).toBe('task-1');
    expect(next.activeSessionBranch).toBe('ab/task-1');
    expect(next.activeSessionBackendType).toBe('tmux');
    expect(next.terminalPaneVisible).toBe(true);
    expect(next.terminalFullscreen).toBe(false);
    expect(next.terminalScrollOffset).toBe(0);
  });

  it('does not create new state when terminal scroll is already reset', () => {
    const next = reducer(initialState, { type: 'TERMINAL_SCROLL_RESET' });
    expect(next).toBe(initialState);
  });

  it('does not create new state when sync is already idle', () => {
    const next = reducer(initialState, {
      type: 'SYNC_DONE',
      payload: { tasksUpdated: 0, errors: [] },
    });
    expect(next).toBe(initialState);
  });
});
