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
  CreateSavedViewParams,
  SavedViewRecord,
  FilterModel,
  ResizeSessionParams,
  PrepareTaskWorkspaceParams,
  CreateTaskPRParams,
} from '../types/index.js';
import type { ServiceContainer } from './index.js';

// --------------- Server event emitter -----------------------

/**
 * Services push events here; the server fans them out to all
 * currently subscribed socket connections.
 */
export const serverEvents = new EventEmitter();

// --------------- Placeholder BoardSnapshot ------------------

function makePlaceholderBoard(): BoardSnapshot {
  return {
    repos: [],
    pillars: [],
    labels: [],
    tracks: [],
    tasks: [],
    savedViews: [],
    uiState: {},
  };
}

// --------------- Dispatch -----------------------------------

export async function dispatch(
  req: RPCRequest,
  services: ServiceContainer,
  socketPath: string,
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
          (p as unknown as RenameTaskParams).title,
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
          (p as unknown as UpdateTaskDescriptionParams).description,
        );
        serverEvents.emit('event', {
          type: 'board_patch',
          payload: services.view.getBoardSnapshot(),
        });
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
          (p as unknown as ReorderTaskParams).sortKey,
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
          (p as unknown as AssignPillarParams).pillarId,
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
          (p as unknown as SetLabelsParams).labelIds,
        );
        serverEvents.emit('event', {
          type: 'board_patch',
          payload: services.view.getBoardSnapshot(),
        });
        return { id: req.id, result: null };
      }

      case 'archiveTask': {
        services.board.archiveTask(p['id'] as string);
        serverEvents.emit('event', {
          type: 'board_patch',
          payload: services.view.getBoardSnapshot(),
        });
        return { id: req.id, result: null };
      }

      case 'deleteTask': {
        services.board.deleteTask(p['id'] as string);
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
        const session = await services.session.openSession(p['taskId'] as string);
        serverEvents.emit('event', {
          type: 'board_patch',
          payload: services.view.getBoardSnapshot(),
        });
        return { id: req.id, result: session };
      }

      case 'recreateSession': {
        const session = await services.session.recreateSession(p['taskId'] as string);
        serverEvents.emit('event', {
          type: 'board_patch',
          payload: services.view.getBoardSnapshot(),
        });
        return { id: req.id, result: session };
      }

      case 'sendInput': {
        await services.session.sendInput(p['taskId'] as string, p['data'] as string);
        return { id: req.id, result: null };
      }

      case 'resizeSession': {
        const params = p as unknown as ResizeSessionParams;
        await services.session.resizeSession(params.taskId, params.cols, params.rows);
        return { id: req.id, result: null };
      }

      case 'getBuffer': {
        const buf = await services.session.getBuffer(p['taskId'] as string);
        return { id: req.id, result: buf };
      }

      case 'prepareTaskWorkspace': {
        const result = services.worktrees.prepareTaskWorkspace(
          (p as unknown as PrepareTaskWorkspaceParams).taskId,
        );
        serverEvents.emit('event', {
          type: 'board_patch',
          payload: services.view.getBoardSnapshot(),
        });
        return { id: req.id, result };
      }

      case 'createTaskPR': {
        const pr = await services.sync.createTaskPR(
          (p as unknown as CreateTaskPRParams).taskId,
        );
        serverEvents.emit('event', {
          type: 'board_patch',
          payload: services.view.getBoardSnapshot(),
        });
        return { id: req.id, result: pr };
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
        const result = await services.sync.trigger();
        return { id: req.id, result };
      }

      // ---- sync -----------------------------------------------
      case 'triggerSync': {
        const result = await services.sync.trigger();
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
          req = JSON.parse(trimmed) as RPCRequest;
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
            writeResponse(event);
          };

          serverEvents.on('event', handler);

          removeListener = () => {
            serverEvents.off('event', handler);
          };

          writeResponse({ id: req.id, result: { subscribed: true } });
          continue;
        }

        // All other requests: dispatch and reply.
        dispatch(req, services, socketPath).then(writeResponse).catch(() => {
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
