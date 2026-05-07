// ============================================================
// AgentBoard — Unix socket RPC server
// ============================================================

import * as net from 'net';
import * as fs from 'fs';
import { EventEmitter } from 'events';
import { generateId } from '../db/index.js';
import type {
  RPCRequest,
  RPCResponse,
  RPCEvent,
  RPCMethod,
  BoardSnapshot,
  DaemonStatus,
  UIStateRecord,
  CreateMissionParams,
  DeleteMissionParams,
  AddMissionTaskParams,
  SetMissionTaskDependenciesParams,
  ReleaseMissionTaskToBoardParams,
  CreateTaskParams,
  CreatePillarParams,
  MoveTaskParams,
  RenameTaskParams,
  UpdateTaskDescriptionParams,
  ReorderTaskParams,
  AssignPillarParams,
  DeletePillarParams,
  SetLabelsParams,
  MergeTaskPRParams,
  AddRepoParams,
  UpdateRepoParams,
  CreateSavedViewParams,
  SavedViewRecord,
  FilterModel,
  ResizeSessionParams,
  InspectSessionParams,
  AcknowledgeSessionAttentionParams,
  OpenSessionParams,
  SendInputParams,
  GetBufferParams,
  PrepareTaskWorkspaceParams,
  CreateTaskPRParams,
  CommentTaskPRParams,
  SchedulePostPushSyncParams,
  ChatTurnParams,
  SetDualSessionModeParams,
  SetTaskBranchParams,
} from '../types/index.js';
import type { ServiceContainer } from './index.js';
import { trackWatchedSessionTask } from './session-update-watch.js';

// --------------- Server event emitter -----------------------

/**
 * Services push events here; the server fans them out to all
 * currently subscribed socket connections.
 */
export const serverEvents = new EventEmitter();

function sessionUpdateTaskId(event: RPCEvent): string | null {
  if (event.type !== 'session_update') {
    return null;
  }

  const payload = event.payload as { taskId?: unknown } | null;
  return typeof payload?.taskId === 'string' && payload.taskId.length > 0
    ? payload.taskId
    : null;
}

export function shouldForwardEventToSubscriber(
  event: RPCEvent,
  watchedSessionTaskId: string | null,
): boolean {
  if (event.type !== 'session_update') {
    return true;
  }

  const taskId = sessionUpdateTaskId(event);
  return taskId !== null && watchedSessionTaskId !== null && taskId === watchedSessionTaskId;
}

function emitBoardPatchAsync(services: ServiceContainer): void {
  if (!services.view) {
    return;
  }

  const timer = setTimeout(() => {
    try {
      serverEvents.emit('event', {
        type: 'board_patch',
        payload: services.view.getBoardSnapshot(),
      });
    } catch {
      // Ignore async snapshot failures so the originating RPC can still succeed.
    }
  }, 0);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }
}

// --------------- Placeholder BoardSnapshot ------------------

function makePlaceholderBoard(): BoardSnapshot {
  return {
    repos: [],
    pillars: [],
    labels: [],
    tracks: [],
    tasks: [],
    missions: [],
    savedViews: [],
    uiState: {},
  };
}

// --------------- Dispatch -----------------------------------

export async function dispatch(
  req: RPCRequest,
  services: ServiceContainer,
  socketPath: string
): Promise<RPCResponse> {
  const notImpl: RPCResponse = {
    id: req.id,
    error: { code: -32601, message: 'Not implemented' },
  };

  const p = (req.params ?? {}) as Record<string, unknown>;

  try {
    switch (req.method as RPCMethod) {
      // ---- daemon meta ----------------------------------------
      case 'daemonStatus': {
        const result: DaemonStatus = {
          version: '0.1.0',
          pid: process.pid,
          uptime: process.uptime() * 1000,
          dbPath: services.dbPath,
          socketPath,
        };
        return { id: req.id, result };
      }

      case 'shutdownManagedOllama': {
        const result = services.ollama
          ? await services.ollama.shutdown()
          : { stopped: false, managed: false };
        return { id: req.id, result };
      }

      // ---- board read -----------------------------------------
      case 'getBoard': {
        if (!services.view) return { id: req.id, result: makePlaceholderBoard() };
        const repoId = p['repoId'] as string | undefined;
        const filter = p['filter'] as FilterModel | undefined;
        const snapshot = services.view.getBoardSnapshot(repoId, filter);
        return { id: req.id, result: snapshot };
      }

      case 'setUIState': {
        services.board.setUIState(p as Partial<UIStateRecord>);
        serverEvents.emit('event', {
          type: 'board_patch',
          payload: services.view.getBoardSnapshot(),
        });
        return { id: req.id, result: null };
      }

      // ---- mission mutations ----------------------------------
      case 'createMission': {
        const mission = services.missions.createMission(p as unknown as CreateMissionParams);
        emitBoardPatchAsync(services);
        return { id: req.id, result: mission };
      }

      case 'deleteMission': {
        await services.missions.deleteMission(
          (p as unknown as DeleteMissionParams).missionId,
          async (taskId) => {
            await services.taskLifecycle.deleteTask(taskId);
          },
        );
        emitBoardPatchAsync(services);
        return { id: req.id, result: null };
      }

      case 'addMissionTask': {
        const missionTask = services.missions.addMissionTask(p as unknown as AddMissionTaskParams);
        emitBoardPatchAsync(services);
        return { id: req.id, result: missionTask };
      }

      case 'setMissionTaskDependencies': {
        services.missions.setMissionTaskDependencies(
          p as unknown as SetMissionTaskDependenciesParams,
        );
        emitBoardPatchAsync(services);
        return { id: req.id, result: null };
      }

      case 'releaseMissionTaskToBoard': {
        services.missions.releaseMissionTaskToBoard(
          (p as unknown as ReleaseMissionTaskToBoardParams).taskId,
        );
        emitBoardPatchAsync(services);
        return { id: req.id, result: null };
      }

      // ---- task mutations -------------------------------------
      case 'createTask': {
        const task = services.board.createTask(p as unknown as CreateTaskParams);
        serverEvents.emit('event', {
          type: 'board_patch',
          payload: services.view.getBoardSnapshot(),
        });
        return { id: req.id, result: task };
      }

      case 'renameTask': {
        services.board.renameTask(
          (p as unknown as RenameTaskParams).id,
          (p as unknown as RenameTaskParams).title
        );
        serverEvents.emit('event', {
          type: 'board_patch',
          payload: services.view.getBoardSnapshot(),
        });
        return { id: req.id, result: null };
      }

      case 'updateTaskDescription': {
        services.board.setTaskDescription(
          (p as unknown as UpdateTaskDescriptionParams).id,
          (p as unknown as UpdateTaskDescriptionParams).description
        );
        serverEvents.emit('event', {
          type: 'board_patch',
          payload: services.view.getBoardSnapshot(),
        });
        return { id: req.id, result: null };
      }

      case 'setTaskBranch': {
        const sbp = p as unknown as SetTaskBranchParams;
        services.board.setTaskBranch(sbp.id, sbp.branchName);
        services.board.updateTaskSync(sbp.id, {
          prNumber: null,
          prUrl: null,
          prState: 'none',
          prDraft: false,
          ciState: 'none',
          ciSummary: null,
          reviewState: 'none',
          reviewSummary: null,
          unresolvedThreadCount: 0,
          githubSyncStatus: 'idle',
          githubSyncError: null,
        });
        serverEvents.emit('event', {
          type: 'board_patch',
          payload: services.view.getBoardSnapshot(),
        });
        void services.sync.trigger().catch(() => {});
        return { id: req.id, result: null };
      }

      case 'moveTask': {
        services.board.moveTask(p as unknown as MoveTaskParams);
        serverEvents.emit('event', {
          type: 'board_patch',
          payload: services.view.getBoardSnapshot(),
        });
        return { id: req.id, result: null };
      }

      case 'reorderTask': {
        services.board.reorderTask(
          (p as unknown as ReorderTaskParams).id,
          (p as unknown as ReorderTaskParams).sortKey
        );
        serverEvents.emit('event', {
          type: 'board_patch',
          payload: services.view.getBoardSnapshot(),
        });
        return { id: req.id, result: null };
      }

      case 'createPillar': {
        const pillar = services.board.createPillar(p as unknown as CreatePillarParams);
        serverEvents.emit('event', {
          type: 'board_patch',
          payload: services.view.getBoardSnapshot(),
        });
        return { id: req.id, result: pillar };
      }

      case 'deletePillar': {
        services.board.deletePillar((p as unknown as DeletePillarParams).id);
        serverEvents.emit('event', {
          type: 'board_patch',
          payload: services.view.getBoardSnapshot(),
        });
        return { id: req.id, result: null };
      }

      case 'assignPillar': {
        services.board.assignPillar(
          (p as unknown as AssignPillarParams).id,
          (p as unknown as AssignPillarParams).pillarId
        );
        serverEvents.emit('event', {
          type: 'board_patch',
          payload: services.view.getBoardSnapshot(),
        });
        return { id: req.id, result: null };
      }

      case 'setLabels': {
        services.board.setLabels(
          (p as unknown as SetLabelsParams).id,
          (p as unknown as SetLabelsParams).labelIds
        );
        serverEvents.emit('event', {
          type: 'board_patch',
          payload: services.view.getBoardSnapshot(),
        });
        return { id: req.id, result: null };
      }

      case 'archiveTask': {
        await services.taskLifecycle.archiveTask(p['id'] as string);
        serverEvents.emit('event', {
          type: 'board_patch',
          payload: services.view.getBoardSnapshot(),
        });
        return { id: req.id, result: null };
      }

      case 'deleteTask': {
        await services.taskLifecycle.deleteTask(p['id'] as string);
        serverEvents.emit('event', {
          type: 'board_patch',
          payload: services.view.getBoardSnapshot(),
        });
        return { id: req.id, result: null };
      }

      // ---- repo management ------------------------------------
      case 'addRepo': {
        const repo = services.workspace.addRepo(p as unknown as AddRepoParams);
        return { id: req.id, result: repo };
      }

      case 'updateRepo': {
        const { id, ...patch } = p as unknown as UpdateRepoParams;
        const repo = services.workspace.updateRepo(id, patch);
        serverEvents.emit('event', {
          type: 'board_patch',
          payload: services.view.getBoardSnapshot(),
        });
        return { id: req.id, result: repo };
      }

      case 'listRepos': {
        const repos = services.workspace.listRepos();
        return { id: req.id, result: repos };
      }

      case 'removeRepo': {
        services.workspace.removeRepo(p['id'] as string);
        return { id: req.id, result: null };
      }

      // ---- saved views ----------------------------------------
      case 'listSavedViews': {
        const views = services.board.getSavedViews();
        return { id: req.id, result: views };
      }

      case 'createSavedView': {
        const params = p as unknown as CreateSavedViewParams;
        const view: SavedViewRecord = {
          id: generateId(),
          label: params.label,
          filters: params.filters,
          isSystem: false,
          createdAt: Date.now(),
        };
        services.board.upsertSavedView(view);
        return { id: req.id, result: view };
      }

      case 'deleteSavedView': {
        services.board.deleteSavedView(p['id'] as string);
        return { id: req.id, result: null };
      }

      // ---- sessions -------------------------------------------
      case 'openSession': {
        const params = p as unknown as OpenSessionParams;
        const session = await services.session.openSession(params.taskId, params.slot);
        serverEvents.emit('event', {
          type: 'board_patch',
          payload: services.view.getBoardSnapshot(),
        });
        return { id: req.id, result: session };
      }

      case 'recreateSession': {
        const params = p as unknown as OpenSessionParams;
        const session = await services.session.recreateSession(params.taskId, params.slot);
        serverEvents.emit('event', {
          type: 'board_patch',
          payload: services.view.getBoardSnapshot(),
        });
        return { id: req.id, result: session };
      }

      case 'setDualSessionMode': {
        const params = p as unknown as SetDualSessionModeParams;
        await services.session.setDualSessionMode(params.taskId, params.enabled);
        serverEvents.emit('event', {
          type: 'board_patch',
          payload: services.view.getBoardSnapshot(),
        });
        return { id: req.id, result: null };
      }

      case 'acknowledgeSessionAttention': {
        const attentionChanged = services.session.acknowledgeSessionAttention(
          (p as unknown as AcknowledgeSessionAttentionParams).taskId
        );
        if (attentionChanged) {
          serverEvents.emit('event', {
            type: 'board_patch',
            payload: services.view.getBoardSnapshot(),
          });
        }
        return { id: req.id, result: null };
      }

      case 'sendInput': {
        const params = p as unknown as SendInputParams;
        const attentionChanged = await services.session.sendInput(
          params.taskId,
          params.data,
          params.slot,
        );
        if (attentionChanged) {
          serverEvents.emit('event', {
            type: 'board_patch',
            payload: services.view.getBoardSnapshot(),
          });
        }
        return { id: req.id, result: null };
      }

      case 'watchSessionUpdates':
        // Handled at connection level so each client can watch a different task.
        return { id: req.id, result: { watchingTaskId: p['taskId'] ?? null } };

      case 'resizeSession': {
        const params = p as unknown as ResizeSessionParams;
        await services.session.resizeSession(params.taskId, params.cols, params.rows, params.slot);
        return { id: req.id, result: null };
      }

      case 'getBuffer': {
        const params = p as unknown as GetBufferParams;
        const buf = await services.session.getBuffer(params.taskId, params.slot);
        return { id: req.id, result: buf };
      }

      case 'inspectSession': {
        const params = p as unknown as InspectSessionParams;
        const { activity, attentionChanged } = await services.session.inspectSessionState(
          params.taskId,
          params.slot,
        );
        if (attentionChanged) {
          serverEvents.emit('event', {
            type: 'board_patch',
            payload: services.view.getBoardSnapshot(),
          });
        }
        return { id: req.id, result: activity };
      }

      case 'prepareTaskWorkspace': {
        const result = services.worktrees.prepareTaskWorkspace(
          (p as unknown as PrepareTaskWorkspaceParams).taskId
        );
        serverEvents.emit('event', {
          type: 'board_patch',
          payload: services.view.getBoardSnapshot(),
        });
        return { id: req.id, result };
      }

      case 'createTaskPR': {
        const pr = await services.sync.createTaskPR((p as unknown as CreateTaskPRParams).taskId);
        serverEvents.emit('event', {
          type: 'board_patch',
          payload: services.view.getBoardSnapshot(),
        });
        return { id: req.id, result: pr };
      }

      case 'commentTaskPR': {
        const params = p as unknown as CommentTaskPRParams;
        const task = services.board.getTask(params.taskId);
        if (!task) {
          throw new Error(`Task not found: ${params.taskId}`);
        }
        if (task.prNumber === undefined) {
          throw new Error(`Task ${params.taskId} has no PR number`);
        }
        if (task.prState !== 'open' && task.prState !== 'draft') {
          throw new Error(`Task ${params.taskId} does not have an open or draft PR`);
        }
        if (!params.body.trim()) {
          throw new Error('PR comment body cannot be empty');
        }

        const repo = services.workspace.getRepo(task.repoId);
        if (!repo) {
          throw new Error(`Repo not found for task ${params.taskId}`);
        }
        if (!repo.githubOwner || !repo.githubRepo) {
          throw new Error(`Repo ${repo.id} is missing GitHub identity`);
        }

        await services.github.commentPR(repo.path, {
          githubRepo: `${repo.githubOwner}/${repo.githubRepo}`,
          prNumber: task.prNumber,
          body: params.body,
        });

        return { id: req.id, result: { commented: true } };
      }

      case 'schedulePostPushSync': {
        const result = services.sync.schedulePostPushSync(
          (p as unknown as SchedulePostPushSyncParams).taskId
        );
        return { id: req.id, result };
      }

      case 'mergeTaskPR': {
        const taskId = (p as unknown as MergeTaskPRParams).taskId;
        const task = services.board.getTask(taskId);
        if (!task) {
          throw new Error(`Task not found: ${taskId}`);
        }
        if (task.prNumber === undefined) {
          throw new Error(`Task ${taskId} has no PR number`);
        }
        if (task.prState !== 'open') {
          throw new Error(`Task ${taskId} does not have an open PR`);
        }
        if (task.ciState !== 'passed') {
          throw new Error(`Task ${taskId} build has not passed`);
        }
        if (task.reviewState !== 'approved') {
          throw new Error(`Task ${taskId} is not approved`);
        }

        const repo = services.workspace.getRepo(task.repoId);
        if (!repo) {
          throw new Error(`Repo not found for task ${taskId}`);
        }
        if (!repo.githubOwner || !repo.githubRepo) {
          throw new Error(`Repo ${repo.id} is missing GitHub identity`);
        }

        await services.github.mergePR(repo.path, {
          githubRepo: `${repo.githubOwner}/${repo.githubRepo}`,
          prNumber: task.prNumber,
        });

        services.board.updateTaskSync(task.id, {
          prState: 'merged',
          prDraft: false,
        });
        if (task.trackId !== 'done') {
          services.board.moveTask({ id: task.id, trackId: 'done' });
        }
        services.missions?.reconcileTaskCompletion(task.id);
        serverEvents.emit('event', {
          type: 'board_patch',
          payload: services.view.getBoardSnapshot(),
        });

        void services.sync.trigger().catch(() => {});
        return { id: req.id, result: { merged: true } };
      }

      // ---- sync -----------------------------------------------
      case 'triggerSync': {
        const result = await services.sync.trigger();
        return { id: req.id, result };
      }

      case 'chatTurn': {
        const result = await services.aiChat.chatTurn(p as unknown as ChatTurnParams);
        emitBoardPatchAsync(services);
        return { id: req.id, result };
      }

      // ---- doctor ---------------------------------------------
      case 'doctor': {
        const results = await services.doctor.run();
        return { id: req.id, result: results };
      }

      case 'subscribe':
        // Handled at connection level.
        return { id: req.id, result: { subscribed: true } };

      default: {
        return notImpl;
      }
    }
  } catch (err: unknown) {
    services.logError?.(`RPC ${req.method} failed (id=${req.id})`, err);
    const message = err instanceof Error ? err.message : String(err);
    return { id: req.id, error: { code: -32000, message } };
  }
}

// --------------- Server -------------------------------------

export function startServer(socketPath: string, services: ServiceContainer): net.Server {
  // Remove stale socket file so bind doesn't fail.
  try {
    fs.unlinkSync(socketPath);
  } catch {
    // File didn't exist — that's fine.
  }

  const server = net.createServer((socket) => {
    let subscribed = false;
    let watchedSessionTaskId: string | null = null;
    let removeListener: (() => void) | null = null;

    // Newline-delimited JSON framing.
    let buffer = '';

    const writeResponse = (obj: RPCResponse | RPCEvent): void => {
      try {
        socket.write(JSON.stringify(obj) + '\n');
      } catch {
        // Socket closed mid-write — ignore.
      }
    };

    socket.setEncoding('utf8');

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      // The last element may be an incomplete line; keep it in the buffer.
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let req: RPCRequest;
        try {
          const parsed = JSON.parse(trimmed) as Partial<RPCRequest>;
          req = {
            id: typeof parsed.id === 'string' ? parsed.id : '',
            method: parsed.method as RPCMethod,
            params: parsed.params,
          };
        } catch {
          const errResp: RPCResponse = {
            id: '',
            error: { code: -32700, message: 'Parse error' },
          };
          writeResponse(errResp);
          continue;
        }

        // Handle subscribe specially — it turns the connection into an event stream.
        if (req.method === 'subscribe') {
          subscribed = true;

          const handler = (event: RPCEvent) => {
            if (!shouldForwardEventToSubscriber(event, watchedSessionTaskId)) {
              return;
            }
            writeResponse(event);
          };

          serverEvents.on('event', handler);

          removeListener = () => {
            serverEvents.off('event', handler);
          };

          writeResponse({ id: req.id, result: { subscribed: true } });
          continue;
        }

        if (req.method === 'watchSessionUpdates') {
          const taskId =
            typeof (req.params as { taskId?: unknown } | null)?.taskId === 'string'
              ? ((req.params as { taskId?: string }).taskId ?? '').trim()
              : '';
          const nextWatch = taskId.length > 0 ? taskId : null;
          trackWatchedSessionTask(watchedSessionTaskId, nextWatch);
          watchedSessionTaskId = nextWatch;
          writeResponse({
            id: req.id,
            result: { watchingTaskId: watchedSessionTaskId },
          });
          continue;
        }

        // All other requests: dispatch and reply.
        const shouldReply = req.id.length > 0;
        dispatch(req, services, socketPath)
          .then((response) => {
            if (shouldReply) {
              writeResponse(response);
            }
          })
          .catch(() => {
            if (!shouldReply) {
              return;
            }

            const errResp: RPCResponse = {
              id: req.id,
              error: { code: -32000, message: 'Internal error' },
            };
            writeResponse(errResp);
          });
      }
    });

    socket.on('close', () => {
      subscribed = false;
      trackWatchedSessionTask(watchedSessionTaskId, null);
      watchedSessionTaskId = null;
      if (removeListener) {
        removeListener();
        removeListener = null;
      }
    });

    socket.on('error', () => {
      if (removeListener) {
        removeListener();
        removeListener = null;
      }
    });

    void subscribed;
  });

  server.listen(socketPath);

  return server;
}
