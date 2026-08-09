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
  ReconnectSessionParams,
  SendInputParams,
  GetBufferParams,
  PrepareTaskWorkspaceParams,
  CreateTaskPRParams,
  CommentTaskPRParams,
  SchedulePostPushSyncParams,
  ChatTurnParams,
  SetDualSessionModeParams,
  SetTaskBranchParams,
  TaskBranchRecord,
  TaskRecord,
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

// --------------- Branch-scoped actions ----------------------

/**
 * Params for the branch-scoped RPCs.
 *
 * Declared here rather than in the shared contract because only this dispatch
 * reads them; the Go TUI sends them positionally as JSON.
 */
interface AddTaskBranchParams {
  taskId: string;
  repoId: string;
  /** Defaults to the branch name the card already works under. */
  branchName?: string;
  baseBranch?: string;
}

interface TaskBranchActionParams {
  taskId: string;
  branchId: string;
}

interface CommentTaskBranchPRParams extends TaskBranchActionParams {
  body: string;
}

/**
 * Loads a branch, and checks it belongs to the named card when one is given.
 *
 * A branch id already identifies a branch on its own, so `taskId` is an
 * optional cross-check rather than part of the lookup: requiring it would break
 * every caller that legitimately has only the branch in hand, which is the
 * normal case when acting on a row the user just selected.
 */
function requireTaskBranch(
  services: ServiceContainer,
  taskId: string | undefined,
  branchId: string,
): TaskBranchRecord {
  if (!branchId) {
    throw new Error('A branch id is required');
  }

  const branch = services.board.getTaskBranch(branchId);
  if (!branch) {
    throw new Error(`Branch not found: ${branchId}`);
  }
  // Only when the caller claimed a card, so a stale id from a TUI that has
  // since moved on still cannot act on another card's pull request.
  if (taskId !== undefined && branch.taskId !== taskId) {
    throw new Error(`Branch ${branchId} does not belong to task ${taskId}`);
  }
  return branch;
}

/**
 * The one pull request a card-scoped action can honestly mean.
 *
 * `tasks.pr_number` is null the moment a card carries more than one branch, so
 * the legacy card-scoped handlers have to resolve it themselves — and refuse
 * when there is a choice to make, rather than acting on an arbitrary branch.
 */
function resolveSoleBranchWithPR(
  services: ServiceContainer,
  taskId: string,
): { task: TaskRecord; branch: TaskBranchRecord } {
  const task = services.board.getTask(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const withPR = (task.branches ?? []).filter((branch) => branch.prNumber !== undefined);
  if (withPR.length === 0) {
    throw new Error(`Task ${taskId} has no PR number`);
  }
  if (withPR.length > 1) {
    const choices = withPR.map((branch) => `#${branch.prNumber} (${branch.branchName})`).join(', ');
    throw new Error(`This card has ${withPR.length} pull requests — choose one: ${choices}`);
  }

  return { task, branch: withPR[0]! };
}

function requireGitHubRepo(
  services: ServiceContainer,
  branch: TaskBranchRecord,
): { path: string; githubRepo: string } {
  const repo = services.workspace.getRepo(branch.repoId);
  if (!repo) {
    throw new Error(`Repo not found for branch ${branch.branchName}`);
  }
  if (!repo.githubOwner || !repo.githubRepo) {
    throw new Error(`Repo ${repo.id} is missing GitHub identity`);
  }
  return { path: repo.path, githubRepo: `${repo.githubOwner}/${repo.githubRepo}` };
}

/**
 * Merges one branch's pull request.
 *
 * Deliberately does not touch the card's track: the rollup decides what the
 * card looks like, and a card with other branches still open is not done.
 */
async function mergeBranchPR(
  services: ServiceContainer,
  branch: TaskBranchRecord,
): Promise<void> {
  if (branch.prNumber === undefined) {
    throw new Error(`Branch ${branch.branchName} has no PR number`);
  }
  if (branch.prState !== 'open') {
    throw new Error(`Branch ${branch.branchName} does not have an open PR`);
  }
  if (branch.ciState !== 'passed') {
    throw new Error(`Branch ${branch.branchName} build has not passed`);
  }
  if (branch.reviewState !== 'approved') {
    throw new Error(`Branch ${branch.branchName} is not approved`);
  }

  const repo = requireGitHubRepo(services, branch);
  await services.github.mergePR(repo.path, {
    githubRepo: repo.githubRepo,
    prNumber: branch.prNumber,
  });

  // The card's pr/ci/review columns follow from this, via recomputeTaskRollup.
  services.board.updateTaskBranchSync(branch.id, {
    prState: 'merged',
    prDraft: false,
  });
}

async function commentBranchPR(
  services: ServiceContainer,
  branch: TaskBranchRecord,
  body: string,
): Promise<void> {
  if (branch.prNumber === undefined) {
    throw new Error(`Branch ${branch.branchName} has no PR number`);
  }
  if (branch.prState !== 'open' && branch.prState !== 'draft') {
    throw new Error(`Branch ${branch.branchName} does not have an open or draft PR`);
  }
  if (!body.trim()) {
    throw new Error('PR comment body cannot be empty');
  }

  const repo = requireGitHubRepo(services, branch);
  await services.github.commentPR(repo.path, {
    githubRepo: repo.githubRepo,
    prNumber: branch.prNumber,
    body,
  });
}

/**
 * Releases a branch's worktree before its row is dropped.
 *
 * Delegates to the lifecycle service rather than removing it here, because that
 * is the only path that runs the probe and the removal on the card's own host —
 * doing it locally silently leaks every remote worktree.
 *
 * Reports whether the directory is actually gone, so the caller can refuse to
 * drop the row that records where it was when it is not.
 */
async function removeBranchWorktree(
  services: ServiceContainer,
  branch: TaskBranchRecord,
): Promise<boolean> {
  if (!branch.worktreePath) {
    return true;
  }

  return services.taskLifecycle.removeBranchWorktree(branch.id);
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
        const moveParams = p as unknown as MoveTaskParams;
        services.board.moveTask(moveParams);
        // Closing a card (moving it to the Done track) releases its worktree,
        // mirroring the automatic cleanup that runs when a PR is merged/closed.
        if (moveParams.trackId === 'done') {
          await services.taskLifecycle.cleanupTaskResources(moveParams.id);
        }
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

      case 'reconnectSession': {
        const params = p as unknown as ReconnectSessionParams;
        const result = await services.session.reconnectSession(params.taskId, params.slot);
        serverEvents.emit('event', {
          type: 'board_patch',
          payload: services.view.getBoardSnapshot(),
        });
        return { id: req.id, result };
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
        const result = await services.worktrees.prepareTaskWorkspace(
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
        // Card-scoped shim kept for the Go TUI, which migrates to
        // 'commentTaskBranchPR' separately. It refuses rather than guessing when
        // the card carries more than one pull request.
        const params = p as unknown as CommentTaskPRParams;
        const { branch } = resolveSoleBranchWithPR(services, params.taskId);
        await commentBranchPR(services, branch, params.body);
        return { id: req.id, result: { commented: true } };
      }

      case 'schedulePostPushSync': {
        const result = services.sync.schedulePostPushSync(
          (p as unknown as SchedulePostPushSyncParams).taskId
        );
        return { id: req.id, result };
      }

      case 'mergeTaskPR': {
        // Card-scoped shim kept for the Go TUI, which migrates to
        // 'mergeTaskBranchPR' separately.
        const taskId = (p as unknown as MergeTaskPRParams).taskId;
        const { task, branch } = resolveSoleBranchWithPR(services, taskId);
        await mergeBranchPR(services, branch);

        // Only a card that had nothing else in it is finished by this merge.
        // Refusing a *second pull request* is not enough: a card whose other
        // branch is still being written has no PR on it yet, and closing the
        // card here would abandon that work. Anything else is left to the sync
        // loop, which decides from every branch at once.
        if (task.branches.length === 1) {
          if (task.trackId !== 'done') {
            services.board.moveTask({ id: taskId, trackId: 'done' });
          }
          services.missions?.reconcileTaskCompletion(taskId);
        }

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

      case 'getArtifacts': {
        // Never blocks: serves the last snapshot, whose own flags say whether
        // it is stale or needs a login.
        return {
          id: req.id,
          result: services.artifacts?.getSnapshot() ?? {
            artifacts: [],
            refreshedAt: 0,
            stale: false,
          },
        };
      }

      case 'rolloutArtifact': {
        // Deploys to production. The TUI gates this behind a typed confirmation;
        // the service re-checks the artifact is configured and uses the exact
        // version the caller confirmed.
        if (!services.artifacts) {
          return {
            id: req.id,
            result: { ok: false, message: 'No artifacts configured' },
          };
        }
        const result = await services.artifacts.rollout(
          p as unknown as import('../types/index.js').RolloutArtifactParams
        );
        return { id: req.id, result };
      }

      case 'setTrackedArtifacts': {
        // Persisted as well as applied, or the change would last only until the
        // next daemon start and quietly revert.
        if (!services.artifacts) {
          throw new Error('No artifacts configured');
        }

        const names = (p['names'] as string[] | undefined) ?? [];
        const cleaned = [
          ...new Set(names.map((name) => name.trim()).filter((name) => name.length > 0)),
        ];

        const { saveArtifactList } = await import('../config/index.js');
        saveArtifactList(cleaned);
        services.artifacts.setArtifactNames(cleaned);

        return { id: req.id, result: { names: cleaned } };
      }

      case 'refreshArtifacts': {
        const snapshot = services.artifacts
          ? await services.artifacts.refresh()
          : { artifacts: [], refreshedAt: 0, stale: false };
        return { id: req.id, result: snapshot };
      }

      case 'getReleaseStatus': {
        // Per-artifact detail for one card, served from what was last resolved
        // so opening the pane never waits on devex.
        const taskId = p['taskId'] as string;
        return {
          id: req.id,
          result: { statuses: services.release?.getStatuses(taskId) ?? [] },
        };
      }

      case 'refreshReleaseStatus': {
        if (!services.release) {
          return { id: req.id, result: { statuses: [] } };
        }
        const taskId = p['taskId'] as string;
        const statuses = await services.release.refreshTask(taskId);
        return { id: req.id, result: { statuses } };
      }

      // ---- branch-scoped actions ------------------------------
      case 'addTaskBranch': {
        const params = p as unknown as AddTaskBranchParams;
        const task = services.board.getTask(params.taskId);
        if (!task) {
          throw new Error(`Task not found: ${params.taskId}`);
        }
        // A general card owns no repo, so workspace planning skips it entirely
        // — a branch added here could never get a checkout, but would start
        // writing pull-request state onto a card that has none.
        if (task.kind === 'general') {
          throw new Error('General cards have no repo, so they cannot carry a branch');
        }
        if (!services.workspace.getRepo(params.repoId)) {
          throw new Error(`Repo not found: ${params.repoId}`);
        }

        // A card spanning several repos normally carries the same branch name in
        // each, so default to the one it already works under instead of
        // inventing a second name the user would have to reconcile by hand.
        const branchName = params.branchName?.trim() || task.branchName;
        if (!branchName) {
          throw new Error(
            `Task ${params.taskId} has no branch name to default from — pass branchName`,
          );
        }

        services.board.addTaskBranch({
          taskId: params.taskId,
          repoId: params.repoId,
          branchName,
          ...(params.baseBranch ? { baseBranch: params.baseBranch } : {}),
        });

        const snapshot = services.view.getBoardSnapshot();
        serverEvents.emit('event', { type: 'board_patch', payload: snapshot });
        // The new branch has no GitHub state yet; let sync discover its PR.
        void services.sync.trigger().catch(() => {});
        return { id: req.id, result: snapshot };
      }

      case 'removeTaskBranch': {
        const params = p as unknown as TaskBranchActionParams;
        const branch = requireTaskBranch(services, params.taskId, params.branchId);
        // Dropping merged work would leave the card reading as complete while
        // part of what it shipped is no longer tracked anywhere.
        if (branch.prState === 'merged') {
          throw new Error(
            `Branch ${branch.branchName} has a merged pull request and cannot be removed`,
          );
        }

        // A card with no branches has nothing to derive its state from, so its
        // pull-request and check columns would freeze on whatever the removed
        // branch last reported — the board would keep painting a PR that is no
        // longer tracked. Deleting the card is the way to remove its last branch.
        if (services.board.getTaskBranches(branch.taskId).length <= 1) {
          throw new Error(
            `Branch ${branch.branchName} is this card's only branch — delete the card instead`,
          );
        }

        // The row is what records where the worktree is, so it only goes once
        // the directory is actually gone — otherwise the checkout is orphaned
        // with nothing left pointing at it.
        if (!(await removeBranchWorktree(services, branch))) {
          throw new Error(
            `Could not remove the worktree at ${branch.worktreePath} — resolve it and try again`,
          );
        }
        services.board.removeTaskBranch(branch.id);

        const snapshot = services.view.getBoardSnapshot();
        serverEvents.emit('event', { type: 'board_patch', payload: snapshot });
        return { id: req.id, result: snapshot };
      }

      case 'setActiveTaskBranch': {
        const params = p as unknown as TaskBranchActionParams;
        const branch = requireTaskBranch(services, params.taskId, params.branchId);
        // The board mirrors the branch's repo, name and worktree onto the card
        // in one write — splitting them here is how the card ended up pairing
        // one repository's id with another's branch.
        services.board.setActiveTaskBranch(branch.taskId, branch.id);

        const snapshot = services.view.getBoardSnapshot();
        serverEvents.emit('event', { type: 'board_patch', payload: snapshot });
        return { id: req.id, result: snapshot };
      }

      case 'mergeTaskBranchPR': {
        const params = p as unknown as TaskBranchActionParams;
        const branch = requireTaskBranch(services, params.taskId, params.branchId);
        await mergeBranchPR(services, branch);

        serverEvents.emit('event', {
          type: 'board_patch',
          payload: services.view.getBoardSnapshot(),
        });
        void services.sync.trigger().catch(() => {});
        return { id: req.id, result: { merged: true } };
      }

      case 'commentTaskBranchPR': {
        const params = p as unknown as CommentTaskBranchPRParams;
        const branch = requireTaskBranch(services, params.taskId, params.branchId);
        await commentBranchPR(services, branch, params.body);
        return { id: req.id, result: { commented: true } };
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
