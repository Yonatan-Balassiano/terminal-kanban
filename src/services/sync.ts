import { EventEmitter } from 'events';
import type { Db } from '../db/index.js';
import type { SyncResult, TaskRecord, TaskSyncPatch } from '../types/index.js';
import type { BoardService } from './board.js';
import { GitHubServiceError, type GitHubService, type PRInfo } from './github.js';
import type { GitService } from './git.js';
import type { MissionService } from './missions.js';

function buildAutoPRTitle(taskId: string, taskTitle: string): string {
  return `[auto|${taskId}] ${taskTitle}`;
}

function buildAutoPRBody(taskId: string): string {
  return `Created by AgentBoard for task ${taskId}.`;
}

const REMOTE_BRANCH_RETRY_ATTEMPTS = 8;
const REMOTE_BRANCH_RETRY_DELAY_MS = 400;
const DELAYED_REMOTE_BRANCH_RETRY_ATTEMPTS = 12;
const DELAYED_REMOTE_BRANCH_RETRY_INTERVAL_MS = 5000;

type SyncCause = 'startup' | 'periodic' | 'manual' | 'push' | 'ensure_pr' | 'merge';

interface ReconcileOptions {
  cause: SyncCause;
  waitForRemoteBranch?: boolean;
}

interface TaskSyncEvent {
  kind: 'status' | 'result';
  status?: 'started' | 'done';
  result?: SyncResult;
}

interface QueuedTaskJob {
  pending: boolean;
  opts: ReconcileOptions;
  waiters: Array<{ resolve: (result: SyncResult) => void; reject: (error: Error) => void }>;
}

interface TaskReconcileResult extends SyncResult {
  prInfo?: PRInfo | null;
  requestDelayedRetry?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function emptySyncResult(): SyncResult {
  return { tasksUpdated: 0, errors: [] };
}

function mergeSyncResults(results: SyncResult[]): SyncResult {
  return results.reduce<SyncResult>(
    (acc, result) => ({
      tasksUpdated: acc.tasksUpdated + result.tasksUpdated,
      errors: [...acc.errors, ...result.errors],
    }),
    emptySyncResult(),
  );
}

function sameValue(left: unknown, right: unknown): boolean {
  return left === right;
}

function normalizeBaseBranch(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

export class SyncService {
  private board: BoardService;
  private missions?: Pick<MissionService, 'reconcileTaskCompletion'>;
  private github: GitHubService;
  private git: GitService;
  private db: Db;
  private wait: typeof sleep;
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeTimer: ReturnType<typeof setInterval> | null = null;
  private readonly queuedJobs = new Map<string, QueuedTaskJob>();
  private readonly delayedRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly delayedRetryBudgetByTaskId = new Map<string, number>();
  private activeJobCount = 0;
  readonly syncEvent = new EventEmitter();

  constructor(
    board: BoardService,
    missionsOrGithub: MissionService | GitHubService,
    githubOrGit: GitHubService | GitService,
    gitOrDb: GitService | Db,
    dbOrWait?: Db | typeof sleep,
    maybeWait = sleep,
  ) {
    this.board = board;

    if (this.isMissionService(missionsOrGithub)) {
      this.missions = missionsOrGithub;
      this.github = githubOrGit as GitHubService;
      this.git = gitOrDb as GitService;
      this.db = dbOrWait as Db;
      this.wait = maybeWait;
      return;
    }

    this.github = missionsOrGithub as GitHubService;
    this.git = githubOrGit as GitService;
    this.db = gitOrDb as Db;
    this.wait = (dbOrWait as typeof sleep | undefined) ?? sleep;
  }

  private isMissionService(value: MissionService | GitHubService): value is MissionService {
    return typeof (value as MissionService).reconcileTaskCompletion === 'function';
  }

  start(intervalMs: number, activeIntervalMs = 15_000): void {
    if (this.timer !== null) {
      return;
    }

    this.timer = setInterval(() => {
      void this.enqueueAll({ cause: 'periodic' });
    }, intervalMs);
    if (this.timer.unref) {
      this.timer.unref();
    }

    const effectiveActiveMs = Math.min(activeIntervalMs, intervalMs);
    this.activeTimer = setInterval(() => {
      void this.enqueueActiveTasks({ cause: 'periodic' });
    }, effectiveActiveMs);
    if (this.activeTimer.unref) {
      this.activeTimer.unref();
    }

    void this.enqueueAll({ cause: 'startup' });
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.activeTimer !== null) {
      clearInterval(this.activeTimer);
      this.activeTimer = null;
    }

    for (const timer of this.delayedRetryTimers.values()) {
      clearTimeout(timer);
    }
    this.delayedRetryTimers.clear();
    this.delayedRetryBudgetByTaskId.clear();
  }

  async trigger(): Promise<SyncResult> {
    return this.enqueueAll({ cause: 'manual', waitForRemoteBranch: true });
  }

  schedulePostPushSync(taskId: string): { scheduled: true } {
    this.bumpDelayedRetryBudget(taskId);
    void this.enqueueTask(taskId, { cause: 'push', waitForRemoteBranch: true });
    return { scheduled: true };
  }

  async createTaskPR(taskId: string): Promise<PRInfo> {
    this.bumpDelayedRetryBudget(taskId);
    const result = await this.enqueueTask(taskId, { cause: 'ensure_pr', waitForRemoteBranch: true });
    const task = this.board.getTask(taskId);

    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (task.prNumber == null || (task.prState !== 'draft' && task.prState !== 'open')) {
      const errorMessage =
        task.githubSyncError ??
        result.errors[0] ??
        `Task branch ${task.branchName ?? taskId} is not ready for pull request creation`;
      throw new Error(errorMessage);
    }

    return this.taskPRInfo(task);
  }

  private emitSyncEvent(event: TaskSyncEvent): void {
    this.syncEvent.emit('sync', event);
  }

  private beginJob(): void {
    this.activeJobCount += 1;
    if (this.activeJobCount === 1) {
      this.emitSyncEvent({ kind: 'status', status: 'started' });
    }
  }

  private endJob(): void {
    this.activeJobCount = Math.max(0, this.activeJobCount - 1);
    if (this.activeJobCount === 0) {
      this.emitSyncEvent({ kind: 'status', status: 'done' });
    }
  }

  private taskPRInfo(task: TaskRecord): PRInfo {
    if (task.prNumber == null) {
      throw new Error(`Task ${task.id} has no pull request`);
    }

    return {
      number: task.prNumber,
      title: task.title,
      url: task.prUrl ?? '',
      prState: task.prState,
      ciState: task.ciState,
      ciSummary: task.ciSummary,
      failingCheckName: task.failingCheckName,
      ciRequiredTotal: task.ciRequiredTotal,
      ciRequiredPassed: task.ciRequiredPassed,
      ciRequiredFailed: task.ciRequiredFailed,
      ciRequiredPending: task.ciRequiredPending,
      reviewState: task.reviewState,
      reviewSummary: task.reviewSummary,
      unresolvedThreadCount: task.unresolvedThreadCount,
    };
  }

  private loadRepoRow(repoId: string): Record<string, unknown> | undefined {
    return this.db
      .prepare<[string], Record<string, unknown>>('SELECT * FROM repos WHERE id = ?')
      .get(repoId);
  }

  private bumpDelayedRetryBudget(taskId: string): void {
    const current = this.delayedRetryBudgetByTaskId.get(taskId) ?? 0;
    this.delayedRetryBudgetByTaskId.set(
      taskId,
      Math.max(current, DELAYED_REMOTE_BRANCH_RETRY_ATTEMPTS),
    );
  }

  private clearDelayedRetry(taskId: string): void {
    const timer = this.delayedRetryTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.delayedRetryTimers.delete(taskId);
    }
    this.delayedRetryBudgetByTaskId.delete(taskId);
  }

  private scheduleDelayedRetry(taskId: string): void {
    if (this.delayedRetryTimers.has(taskId)) {
      return;
    }

    const remaining = this.delayedRetryBudgetByTaskId.get(taskId) ?? 0;
    if (remaining <= 0) {
      return;
    }

    this.delayedRetryBudgetByTaskId.set(taskId, remaining - 1);
    const timer = setTimeout(() => {
      this.delayedRetryTimers.delete(taskId);
      void this.enqueueTask(taskId, { cause: 'push' });
    }, DELAYED_REMOTE_BRANCH_RETRY_INTERVAL_MS);

    if (timer.unref) {
      timer.unref();
    }

    this.delayedRetryTimers.set(taskId, timer);
  }

  private mergeReconcileOptions(current: ReconcileOptions, next: ReconcileOptions): ReconcileOptions {
    return {
      cause: next.cause,
      waitForRemoteBranch: current.waitForRemoteBranch || next.waitForRemoteBranch,
    };
  }

  private enqueueTask(taskId: string, opts: ReconcileOptions): Promise<SyncResult> {
    const existing = this.queuedJobs.get(taskId);
    if (existing) {
      existing.pending = true;
      existing.opts = this.mergeReconcileOptions(existing.opts, opts);
      return new Promise<SyncResult>((resolve, reject) => {
        existing.waiters.push({ resolve, reject });
      });
    }

    const job: QueuedTaskJob = {
      pending: false,
      opts,
      waiters: [],
    };
    this.queuedJobs.set(taskId, job);

    const promise = new Promise<SyncResult>((resolve, reject) => {
      job.waiters.push({ resolve, reject });
    });

    void this.runQueuedTask(taskId, job);
    return promise;
  }

  private async enqueueAll(opts: ReconcileOptions): Promise<SyncResult> {
    const taskIds = this.board
      .getTasks({ includeArchived: false })
      .map((task) => task.id);

    if (taskIds.length === 0) {
      return emptySyncResult();
    }

    const results = await Promise.all(taskIds.map((taskId) => this.enqueueTask(taskId, opts)));
    return mergeSyncResults(results);
  }

  private async enqueueActiveTasks(opts: ReconcileOptions): Promise<SyncResult> {
    const taskIds = this.board
      .getTasks({ includeArchived: false })
      .filter((task) => task.sessionId != null || task.secondarySessionId != null)
      .map((task) => task.id);

    if (taskIds.length === 0) {
      return emptySyncResult();
    }

    const results = await Promise.all(taskIds.map((taskId) => this.enqueueTask(taskId, opts)));
    return mergeSyncResults(results);
  }

  private async runQueuedTask(taskId: string, job: QueuedTaskJob): Promise<void> {
    const aggregate = emptySyncResult();
    this.beginJob();

    try {
      while (true) {
        const opts = job.opts;
        job.opts = { cause: 'periodic' };
        job.pending = false;

        const result = await this.reconcileTaskById(taskId, opts);
        aggregate.tasksUpdated += result.tasksUpdated;
        aggregate.errors.push(...result.errors);

        if (result.tasksUpdated > 0 || result.errors.length > 0) {
          this.emitSyncEvent({ kind: 'result', result });
        }

        if (result.requestDelayedRetry) {
          this.scheduleDelayedRetry(taskId);
        }

        if (!job.pending) {
          break;
        }
      }

      for (const waiter of job.waiters.splice(0)) {
        waiter.resolve(aggregate);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error : new Error(String(error));
      for (const waiter of job.waiters.splice(0)) {
        waiter.reject(message);
      }
    } finally {
      this.queuedJobs.delete(taskId);
      this.endJob();
    }
  }

  private applyTaskSyncPatch(task: TaskRecord, patch: TaskSyncPatch): boolean {
    const nextPatch: TaskSyncPatch = {};
    let changed = false;

    const maybeAssign = <K extends keyof TaskSyncPatch>(key: K): void => {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) {
        return;
      }

      const nextValue = patch[key];
      const normalizedNext = nextValue === null ? undefined : nextValue;
      const currentValue = (task as unknown as Record<string, unknown>)[key as string];

      if (sameValue(currentValue, normalizedNext)) {
        return;
      }

      changed = true;
      (nextPatch as Record<string, unknown>)[key as string] = nextValue as unknown;
      (task as unknown as Record<string, unknown>)[key as string] = normalizedNext as unknown;
    };

    maybeAssign('prNumber');
    maybeAssign('prState');
    maybeAssign('prDraft');
    maybeAssign('prUrl');
    maybeAssign('ciState');
    maybeAssign('ciSummary');
    maybeAssign('failingCheckName');
    maybeAssign('ciRequiredTotal');
    maybeAssign('ciRequiredPassed');
    maybeAssign('ciRequiredFailed');
    maybeAssign('ciRequiredPending');
    maybeAssign('reviewState');
    maybeAssign('reviewSummary');
    maybeAssign('unresolvedThreadCount');
    maybeAssign('githubSyncStatus');
    maybeAssign('githubSyncError');
    maybeAssign('githubLastSyncedAt');
    maybeAssign('gitState');
    maybeAssign('gitAheadCount');
    maybeAssign('gitBehindCount');
    maybeAssign('hasUntracked');
    maybeAssign('hasConflicts');

    if (!changed) {
      return false;
    }

    this.board.updateTaskSync(task.id, nextPatch);
    return true;
  }

  private async waitForRemoteBranch(
    repoPath: string,
    branch: string,
    shouldWait: boolean,
  ): Promise<boolean> {
    const attempts = shouldWait ? REMOTE_BRANCH_RETRY_ATTEMPTS : 1;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await this.git.remoteBranchExists(repoPath, branch)) {
        return true;
      }

      if (attempt < attempts - 1) {
        await this.wait(REMOTE_BRANCH_RETRY_DELAY_MS);
      }
    }

    return false;
  }

  private async syncGitStatus(task: TaskRecord, repoPath: string): Promise<TaskSyncPatch | null> {
    try {
      const gitStatus = await this.git.getWorkspaceStatus(task.worktreePath ?? repoPath);
      return {
        gitState: gitStatus.gitState,
        gitAheadCount: gitStatus.aheadCount,
        gitBehindCount: gitStatus.behindCount,
        hasUntracked: gitStatus.hasUntracked,
        hasConflicts: gitStatus.hasConflicts,
      };
    } catch {
      return null;
    }
  }

  private async reconcileTaskById(taskId: string, opts: ReconcileOptions): Promise<TaskReconcileResult> {
    const result: TaskReconcileResult = emptySyncResult();
    const task = this.board.getTask(taskId);

    if (!task || task.archivedAt != null || !task.branchName) {
      this.clearDelayedRetry(taskId);
      return result;
    }

    const repoRow = this.loadRepoRow(task.repoId);
    if (!repoRow) {
      if (
        this.applyTaskSyncPatch(task, {
          githubSyncStatus: 'error',
          githubSyncError: `Repo not found for task ${task.id}`,
          githubLastSyncedAt: Date.now(),
        })
      ) {
        result.tasksUpdated += 1;
        result.errors.push(`Task ${task.id}: Repo not found for task ${task.id}`);
      }
      return result;
    }

    if (task.githubSyncStatus !== 'syncing') {
      this.applyTaskSyncPatch(task, { githubSyncStatus: 'syncing' });
    }

    const repoPath = repoRow['path'] as string;
    const githubOwner = (repoRow['github_owner'] as string | null) ?? undefined;
    const githubRepo = (repoRow['github_repo'] as string | null) ?? undefined;
    const storedBaseBranch = normalizeBaseBranch(repoRow['default_base_branch'] as string | null);
    let baseBranch = storedBaseBranch;

    if (!baseBranch) {
      baseBranch = normalizeBaseBranch(await this.git.defaultBranch(repoPath)) ?? 'main';
      this.db
        .prepare<[string, number, string], void>(
          'UPDATE repos SET default_base_branch = ?, updated_at = ? WHERE id = ?',
        )
        .run(baseBranch, Date.now(), task.repoId);
    }

    const gitPatch = await this.syncGitStatus(task, repoPath);

    if (!githubOwner || !githubRepo) {
      const patch: TaskSyncPatch = {
        githubSyncStatus: 'error',
        githubSyncError: `Repo for task ${task.id} is missing GitHub identity`,
        githubLastSyncedAt: Date.now(),
      };
      if (gitPatch) {
        Object.assign(patch, gitPatch);
      }
      if (this.applyTaskSyncPatch(task, patch)) {
        result.tasksUpdated += 1;
      }
      result.errors.push(`Task ${task.id}: Repo for task ${task.id} is missing GitHub identity`);
      return result;
    }

    const fullRepo = `${githubOwner}/${githubRepo}`;

    try {
      let prInfo: PRInfo | null = null;
      const existing = await this.github.findBranchPR(repoPath, task.branchName, fullRepo);

      if (existing) {
        prInfo = await this.github.getPR(repoPath, task.branchName, fullRepo);
        if (!prInfo) {
          throw new GitHubServiceError(
            'not_found',
            `Pull request for branch ${task.branchName} disappeared during sync`,
          );
        }
      } else {
        const remoteBranchPresent = await this.waitForRemoteBranch(
          repoPath,
          task.branchName,
          opts.waitForRemoteBranch === true,
        );

        if (remoteBranchPresent) {
          prInfo = await this.github.createPR(repoPath, {
            githubRepo: fullRepo,
            branch: task.branchName,
            baseBranch,
            title: buildAutoPRTitle(task.id, task.title),
            body: buildAutoPRBody(task.id),
          });
        } else if (opts.cause === 'push' || opts.cause === 'ensure_pr' || opts.cause === 'manual') {
          result.requestDelayedRetry = true;
        }
      }

      const patch: TaskSyncPatch = {
        githubSyncStatus: prInfo ? 'ok' : task.prNumber != null ? 'ok' : 'idle',
        githubSyncError: null,
        githubLastSyncedAt: Date.now(),
      };

      if (prInfo) {
        patch.prNumber = prInfo.number;
        patch.prState = prInfo.prState;
        patch.prDraft = prInfo.prState === 'draft';
        patch.prUrl = prInfo.url;
        patch.ciState = prInfo.ciState;
        patch.ciSummary = prInfo.ciSummary ?? null;
        patch.failingCheckName = prInfo.failingCheckName ?? null;
        patch.ciRequiredTotal = prInfo.ciRequiredTotal;
        patch.ciRequiredPassed = prInfo.ciRequiredPassed;
        patch.ciRequiredFailed = prInfo.ciRequiredFailed;
        patch.ciRequiredPending = prInfo.ciRequiredPending;
        patch.reviewState = prInfo.reviewState;
        patch.reviewSummary = prInfo.reviewSummary ?? null;
        patch.unresolvedThreadCount = prInfo.unresolvedThreadCount;
      }

      if (gitPatch) {
        Object.assign(patch, gitPatch);
      }

      if (this.applyTaskSyncPatch(task, patch)) {
        result.tasksUpdated += 1;
      }

      if (prInfo) {
        this.clearDelayedRetry(taskId);
      }

      if (
        prInfo &&
        task.trackId !== 'pr' &&
        task.trackId !== 'done' &&
        (prInfo.prState === 'draft' || prInfo.prState === 'open')
      ) {
        this.board.moveTask({ id: task.id, trackId: 'pr' });
        task.trackId = 'pr';
        result.tasksUpdated += 1;
      }

      if (prInfo && task.trackId !== 'done' && prInfo.prState === 'merged') {
        this.board.moveTask({ id: task.id, trackId: 'done' });
        task.trackId = 'done';
        result.tasksUpdated += 1;
      }

      if (prInfo?.prState === 'merged') {
        const releasedTaskIds = this.missions?.reconcileTaskCompletion(task.id) ?? [];
        if (releasedTaskIds.length > 0) {
          result.tasksUpdated += releasedTaskIds.length;
        }
      }

      if (prInfo?.prState === 'closed') {
        const errorMessage = `Branch ${task.branchName} already has a closed pull request; reopen it or push a new branch`;
        if (
          this.applyTaskSyncPatch(task, {
            githubSyncStatus: 'error',
            githubSyncError: errorMessage,
            githubLastSyncedAt: Date.now(),
          })
        ) {
          result.tasksUpdated += 1;
        }
        result.errors.push(`Task ${task.id}: ${errorMessage}`);
        this.clearDelayedRetry(taskId);
      }

      result.prInfo = prInfo;
      return result;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const patch: TaskSyncPatch = {
        githubSyncStatus: 'error',
        githubSyncError: message,
        githubLastSyncedAt: Date.now(),
      };

      if (gitPatch) {
        Object.assign(patch, gitPatch);
      }

      if (this.applyTaskSyncPatch(task, patch)) {
        result.tasksUpdated += 1;
      }

      result.errors.push(`Task ${task.id}: ${message}`);
      return result;
    }
  }
}
