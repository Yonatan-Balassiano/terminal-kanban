// ============================================================
// AgentBoard — AppController
// Wires RPCClient to the TUI dispatch pipeline.
// ============================================================

import type { Dispatch } from 'react';
import { RPCClient } from '../cli/rpc.js';
import type {
  AppAction,
  BoardSnapshot,
  CreateTaskParams,
  CreatePillarParams,
  CreatePillarResult,
  MoveTaskParams,
  RenameTaskParams,
  UpdateTaskDescriptionParams,
  AssignPillarParams,
  DeletePillarParams,
  ResizeSessionParams,
  UIStateRecord,
  RPCEvent,
  GetBufferResult,
  SessionRecord,
  SessionActivitySnapshot,
  TaskWorkspaceResult,
} from '../types/index.js';

// --------------- AppController -------------------------------

export class AppController {
  /**
   * Holds the latest dispatch reference so subscription callbacks always
   * call the current dispatch without needing to re-register on every render.
   */
  private dispatchRef: { current: Dispatch<AppAction> };

  /** Unsubscribe function returned by rpc.subscribe(). */
  private unsubscribe: (() => void) | null = null;
  private started = false;
  private startPromise: Promise<void> | null = null;
  private bufferRefreshInFlight = new Map<string, Promise<void>>();
  private bufferRefreshQueued = new Set<string>();
  private activeSessionTaskId: string | null = null;
  private lastBoardSnapshotKey: string | null = null;
  private sessionInspectionAvailable = true;
  private sessionInspectionWarningShown = false;

  constructor(
    private rpc: RPCClient,
    dispatch: Dispatch<AppAction>,
  ) {
    this.dispatchRef = { current: dispatch };
  }

  // --------------- start / stop ----------------------------

  async start(): Promise<void> {
    if (this.started) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = (async () => {
      try {
        await this.rpc.connect();
        this.dispatchRef.current({ type: 'DAEMON_CONNECTED' });

        await this.refreshBoard();

        this.unsubscribe = this.rpc.subscribe((event: RPCEvent) => {
          this.handleEvent(event);
        });
        this.started = true;
      } catch (err) {
        this.dispatchRef.current({ type: 'DAEMON_DISCONNECTED' });
        const message =
          err instanceof Error ? err.message : 'Failed to connect to daemon';
        this.dispatchRef.current({ type: 'STATUS_MESSAGE', payload: message });
      } finally {
        if (!this.started) {
          this.startPromise = null;
        }
      }
    })();

    return this.startPromise;
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.started = false;
    this.startPromise = null;
    this.bufferRefreshInFlight.clear();
    this.bufferRefreshQueued.clear();
    this.activeSessionTaskId = null;
    this.lastBoardSnapshotKey = null;
    this.rpc.disconnect();
    this.dispatchRef.current({ type: 'DAEMON_DISCONNECTED' });
  }

  // --------------- event handling --------------------------

  private handleEvent(event: RPCEvent): void {
    switch (event.type) {
      case 'board_patch': {
        this.applyBoardSnapshot(event.payload as BoardSnapshot);
        break;
      }

      case 'session_update': {
        const payload = event.payload as Partial<GetBufferResult> & {
          taskId?: string;
        };
        if (
          payload.lines !== undefined &&
          payload.taskId !== undefined &&
          payload.taskId === this.activeSessionTaskId
        ) {
          this.dispatchRef.current({
            type: 'BUFFER_UPDATE',
            payload: {
              lines: payload.lines,
              ansiLines: payload.ansiLines ?? payload.lines,
              cursorX: payload.cursorX ?? 0,
              cursorY: payload.cursorY ?? 0,
            },
          });
        }
        break;
      }

      case 'sync_status': {
        const payload = event.payload as { status: string };
        if (payload.status === 'started') {
          this.dispatchRef.current({ type: 'SYNC_START' });
        } else {
          this.dispatchRef.current({
            type: 'SYNC_DONE',
            payload: { tasksUpdated: 0, errors: [] },
          });
        }
        break;
      }

      default:
        // daemon_health and unknown events are silently ignored
        break;
    }
  }

  // --------------- task mutations --------------------------

  async createTask(params: CreateTaskParams): Promise<void> {
    await this.rpc.call('createTask', params);
    await this.refreshBoard();
  }

  async setUIState(patch: Partial<UIStateRecord>): Promise<void> {
    await this.rpc.call('setUIState', patch);
    await this.refreshBoard();
  }

  async moveTask(params: MoveTaskParams): Promise<void> {
    await this.rpc.call('moveTask', params);
    await this.refreshBoard();
  }

  async renameTask(params: RenameTaskParams): Promise<void> {
    await this.rpc.call('renameTask', params);
    await this.refreshBoard();
  }

  async updateTaskDescription(params: UpdateTaskDescriptionParams): Promise<void> {
    await this.rpc.call('updateTaskDescription', params);
    await this.refreshBoard();
  }

  async createPillar(params: CreatePillarParams): Promise<CreatePillarResult> {
    const pillar = await this.rpc.call<CreatePillarResult>('createPillar', params);
    await this.refreshBoard();
    return pillar;
  }

  async deletePillar(params: DeletePillarParams): Promise<void> {
    await this.rpc.call('deletePillar', params);
    await this.refreshBoard();
  }

  async archiveTask(id: string): Promise<void> {
    await this.rpc.call('archiveTask', { id });
    await this.refreshBoard();
  }

  async deleteTask(id: string): Promise<void> {
    await this.rpc.call('deleteTask', { id });
    await this.refreshBoard();
  }

  async assignPillar(params: AssignPillarParams): Promise<void> {
    await this.rpc.call('assignPillar', params);
    await this.refreshBoard();
  }

  // --------------- session ---------------------------------

  async openSession(taskId: string): Promise<SessionRecord> {
    const session = await this.rpc.call<SessionRecord>('openSession', { taskId });
    this.activeSessionTaskId = taskId;
    this.dispatchRef.current({
      type: 'SESSION_OPENED',
      payload: { taskId, session },
    });
    this.dispatchRef.current({ type: 'TERMINAL_PANE_SHOW' });
    await this.refreshBuffer(taskId);
    await this.inspectSession(taskId);
    return session;
  }

  async recreateSession(taskId: string): Promise<SessionRecord> {
    const session = await this.rpc.call<SessionRecord>('recreateSession', { taskId });
    this.activeSessionTaskId = taskId;
    this.dispatchRef.current({
      type: 'SESSION_OPENED',
      payload: { taskId, session },
    });
    this.dispatchRef.current({ type: 'TERMINAL_PANE_SHOW' });
    await this.refreshBuffer(taskId);
    await this.inspectSession(taskId);
    return session;
  }

  async sendInput(taskId: string, data: string): Promise<void> {
    this.rpc.notify('sendInput', { taskId, data });
  }

  async resizeSession(params: ResizeSessionParams): Promise<void> {
    await this.rpc.call('resizeSession', params);
  }

  async inspectSession(taskId: string): Promise<SessionActivitySnapshot | null> {
    if (!this.sessionInspectionAvailable) {
      return null;
    }

    try {
      const activity = await this.rpc.call<SessionActivitySnapshot | null>('inspectSession', {
        taskId,
      });
      this.dispatchRef.current({
        type: 'SESSION_ACTIVITY_UPDATED',
        payload: { taskId, activity },
      });
      return activity;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'Not implemented') {
        this.sessionInspectionAvailable = false;
        if (!this.sessionInspectionWarningShown) {
          this.sessionInspectionWarningShown = true;
          this.dispatchRef.current({
            type: 'STATUS_MESSAGE',
            payload: 'Restart daemon to enable session activity indicators.',
          });
        }
        return null;
      }

      throw err;
    }
  }

  async prepareTaskWorkspace(taskId: string): Promise<TaskWorkspaceResult> {
    const result = await this.rpc.call<TaskWorkspaceResult>('prepareTaskWorkspace', { taskId });
    await this.refreshBoard();
    return result;
  }

  async createTaskPR(taskId: string): Promise<void> {
    this.dispatchRef.current({ type: 'SYNC_START' });
    try {
      await this.rpc.call('createTaskPR', { taskId });
      await this.refreshBoard();
    } finally {
      this.dispatchRef.current({
        type: 'SYNC_DONE',
        payload: { tasksUpdated: 0, errors: [] },
      });
    }
  }

  async mergeTaskPR(taskId: string): Promise<void> {
    this.dispatchRef.current({ type: 'SYNC_START' });
    try {
      await this.rpc.call('mergeTaskPR', { taskId });
    } finally {
      this.dispatchRef.current({
        type: 'SYNC_DONE',
        payload: { tasksUpdated: 0, errors: [] },
      });
    }
  }

  async refreshBuffer(taskId: string): Promise<void> {
    const existing = this.bufferRefreshInFlight.get(taskId);
    if (existing) {
      this.bufferRefreshQueued.add(taskId);
      await existing;
      return;
    }

    const run = (async () => {
      do {
        this.bufferRefreshQueued.delete(taskId);
        const buffer = await this.rpc.call<GetBufferResult>('getBuffer', { taskId });
        this.dispatchRef.current({
          type: 'BUFFER_UPDATE',
          payload: {
            ...buffer,
            ansiLines: buffer.ansiLines ?? buffer.lines,
          },
        });
      } while (this.bufferRefreshQueued.has(taskId));
    })();

    this.bufferRefreshInFlight.set(taskId, run);

    try {
      await run;
    } finally {
      this.bufferRefreshInFlight.delete(taskId);
    }
  }

  // --------------- sync ------------------------------------

  async triggerSync(): Promise<void> {
    this.dispatchRef.current({ type: 'SYNC_START' });
    try {
      await this.rpc.call('triggerSync');
    } finally {
      this.dispatchRef.current({
        type: 'SYNC_DONE',
        payload: { tasksUpdated: 0, errors: [] },
      });
    }
  }

  // --------------- private helpers -------------------------

  private async refreshBoard(): Promise<void> {
    const board = await this.rpc.call<BoardSnapshot>('getBoard');
    this.applyBoardSnapshot(board);
  }

  private applyBoardSnapshot(board: BoardSnapshot): void {
    const nextKey = JSON.stringify(board);
    if (this.lastBoardSnapshotKey === nextKey) {
      return;
    }

    this.lastBoardSnapshotKey = nextKey;
    this.dispatchRef.current({ type: 'BOARD_LOADED', payload: board });
  }
}
