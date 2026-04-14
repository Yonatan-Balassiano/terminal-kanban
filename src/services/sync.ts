import { EventEmitter } from 'events';
import type { Db } from '../db/index.js';
import type { SyncResult, TaskRecord } from '../types/index.js';
import type { BoardService } from './board.js';
import type { GitHubService, PRInfo } from './github.js';
import type { GitService } from './git.js';

function buildAutoPRTitle(taskId: string, taskTitle: string): string {
  return `[auto|${taskId}] ${taskTitle}`;
}

function buildAutoPRBody(taskId: string): string {
  return `Created by AgentBoard for task ${taskId}.`;
}

const MANUAL_REMOTE_BRANCH_RETRY_ATTEMPTS = 8;
const MANUAL_REMOTE_BRANCH_RETRY_DELAY_MS = 400;
const POST_PUSH_PR_RETRY_ATTEMPTS = 24;
const POST_PUSH_PR_RETRY_INTERVAL_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class SyncService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private postPushAttemptsRemainingByTaskId = new Map<string, number>();
  private postPushLoopActiveByTaskId = new Set<string>();
  readonly syncEvent = new EventEmitter();

  constructor(
    private board: BoardService,
    private github: GitHubService,
    private git: GitService,
    private db: Db,
    private wait = sleep
  ) {}

  start(intervalMs: number): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.runSync();
    }, intervalMs);
    // Allow Node to exit even if the timer is still running
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async trigger(): Promise<SyncResult> {
    return this.runSync({ retryPendingRemoteBranches: true });
  }

  schedulePostPushSync(taskId: string): { scheduled: true } {
    this.postPushAttemptsRemainingByTaskId.set(taskId, POST_PUSH_PR_RETRY_ATTEMPTS);

    if (this.postPushLoopActiveByTaskId.has(taskId)) {
      return { scheduled: true };
    }

    this.postPushLoopActiveByTaskId.add(taskId);
    void this.runPostPushLoop(taskId);
    return { scheduled: true };
  }

  async createTaskPR(taskId: string): Promise<PRInfo> {
    const task = this.board.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    if (!task.branchName) {
      throw new Error(`Task ${taskId} has no branch name`);
    }

    const repoRow = this.db
      .prepare<[string], Record<string, unknown>>('SELECT * FROM repos WHERE id = ?')
      .get(task.repoId);
    if (!repoRow) {
      throw new Error(`Repo not found for task ${taskId}`);
    }

    const githubOwner = (repoRow['github_owner'] as string | null) ?? undefined;
    const githubRepo = (repoRow['github_repo'] as string | null) ?? undefined;
    if (!githubOwner || !githubRepo) {
      throw new Error(`Repo for task ${taskId} is missing GitHub identity`);
    }

    const repoPath = repoRow['path'] as string;
    const storedBaseBranch = (repoRow['default_base_branch'] as string | null) ?? 'main';
    const detectedBaseBranch = await this.git.defaultBranch(repoPath);
    const baseBranch = detectedBaseBranch || storedBaseBranch;
    const fullRepo = `${githubOwner}/${githubRepo}`;
    const existing = await this.github.getPR(repoPath, task.branchName, fullRepo);
    if (existing) {
      this.applyTaskSyncPatch(task, existing);
      return existing;
    }

    const remoteBranchPresent = await this.waitForRemoteBranch(repoPath, task.branchName, true);
    if (!remoteBranchPresent) {
      throw new Error(`Task branch ${task.branchName} is not pushed to origin`);
    }

    const prInfo = await this.github.createPR(repoPath, {
      githubRepo: fullRepo,
      branch: task.branchName,
      baseBranch,
      title: buildAutoPRTitle(task.id, task.title),
      body: buildAutoPRBody(task.id),
    });
    this.applyTaskSyncPatch(task, prInfo);
    if (task.trackId === 'backlog') {
      this.board.moveTask({ id: task.id, trackId: 'in-progress' });
    }
    return prInfo;
  }

  private applyTaskSyncPatch(
    task: TaskRecord,
    prInfo?: PRInfo,
    gitStatus?: Awaited<ReturnType<GitService['getWorkspaceStatus']>> | null
  ): boolean {
    const patch: Parameters<BoardService['updateTaskSync']>[1] = {};

    if (prInfo) {
      if (task.prNumber !== prInfo.number) patch.prNumber = prInfo.number;
      if (task.prState !== prInfo.prState) patch.prState = prInfo.prState;
      const prDraft = prInfo.prState === 'draft';
      if (task.prDraft !== prDraft) patch.prDraft = prDraft;
      if (task.prUrl !== prInfo.url) patch.prUrl = prInfo.url;
      if (task.ciState !== prInfo.ciState) patch.ciState = prInfo.ciState;
      if (task.ciSummary !== prInfo.ciSummary) patch.ciSummary = prInfo.ciSummary;
      if (task.failingCheckName !== prInfo.failingCheckName) {
        patch.failingCheckName = prInfo.failingCheckName;
      }
      if (task.reviewState !== prInfo.reviewState) patch.reviewState = prInfo.reviewState;
      if (task.reviewSummary !== prInfo.reviewSummary) patch.reviewSummary = prInfo.reviewSummary;
      if (task.unresolvedThreadCount !== prInfo.unresolvedThreadCount) {
        patch.unresolvedThreadCount = prInfo.unresolvedThreadCount;
      }
    }

    if (gitStatus) {
      if (task.gitState !== gitStatus.gitState) patch.gitState = gitStatus.gitState;
      if (task.gitAheadCount !== gitStatus.aheadCount) patch.gitAheadCount = gitStatus.aheadCount;
      if (task.gitBehindCount !== gitStatus.behindCount)
        patch.gitBehindCount = gitStatus.behindCount;
      if (task.hasUntracked !== gitStatus.hasUntracked) patch.hasUntracked = gitStatus.hasUntracked;
      if (task.hasConflicts !== gitStatus.hasConflicts) patch.hasConflicts = gitStatus.hasConflicts;
    }

    if (Object.keys(patch).length === 0) {
      return false;
    }

    this.board.updateTaskSync(task.id, patch);
    return true;
  }

  private async waitForRemoteBranch(
    repoPath: string,
    branch: string,
    retryPendingRemoteBranches: boolean
  ): Promise<boolean> {
    const attempts = retryPendingRemoteBranches ? MANUAL_REMOTE_BRANCH_RETRY_ATTEMPTS : 1;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await this.git.remoteBranchExists(repoPath, branch)) {
        return true;
      }

      if (attempt < attempts - 1) {
        await this.wait(MANUAL_REMOTE_BRANCH_RETRY_DELAY_MS);
      }
    }

    return false;
  }

  private shouldStopPostPushLoop(task: TaskRecord | null): boolean {
    if (!task || task.archivedAt != null || !task.branchName) {
      return true;
    }

    return task.prState !== 'none' || task.prNumber != null;
  }

  private async runPostPushLoop(taskId: string): Promise<void> {
    try {
      while ((this.postPushAttemptsRemainingByTaskId.get(taskId) ?? 0) > 0) {
        this.postPushAttemptsRemainingByTaskId.set(
          taskId,
          (this.postPushAttemptsRemainingByTaskId.get(taskId) ?? 1) - 1
        );

        await this.runSync({
          retryPendingRemoteBranches: false,
          taskIds: [taskId],
        });

        if (this.shouldStopPostPushLoop(this.board.getTask(taskId))) {
          return;
        }

        if ((this.postPushAttemptsRemainingByTaskId.get(taskId) ?? 0) <= 0) {
          return;
        }

        await this.wait(POST_PUSH_PR_RETRY_INTERVAL_MS);
      }
    } finally {
      this.postPushAttemptsRemainingByTaskId.delete(taskId);
      this.postPushLoopActiveByTaskId.delete(taskId);
    }
  }

  private loadRepoRow(repoId: string): Record<string, unknown> | undefined {
    return this.db
      .prepare<[string], Record<string, unknown>>('SELECT * FROM repos WHERE id = ?')
      .get(repoId);
  }

  private async syncTask(
    task: TaskRecord,
    opts: { retryPendingRemoteBranches?: boolean } | undefined,
    result: SyncResult
  ): Promise<void> {
    if (!task.branchName) {
      return;
    }

    const repoRow = this.loadRepoRow(task.repoId);
    if (!repoRow) {
      return;
    }

    const githubOwner = (repoRow['github_owner'] as string | null) ?? undefined;
    const githubRepo = (repoRow['github_repo'] as string | null) ?? undefined;
    const repoPath = repoRow['path'] as string;
    const storedBaseBranch = (repoRow['default_base_branch'] as string | null) ?? 'main';
    const detectedBaseBranch = await this.git.defaultBranch(repoPath);
    const baseBranch = detectedBaseBranch || storedBaseBranch;

    if (baseBranch !== storedBaseBranch) {
      this.db
        .prepare<
          [string, number, string],
          void
        >('UPDATE repos SET default_base_branch = ?, updated_at = ? WHERE id = ?')
        .run(baseBranch, Date.now(), task.repoId);
    }

    if (!githubOwner || !githubRepo) {
      return;
    }

    const fullRepo = `${githubOwner}/${githubRepo}`;
    let taskChanged = false;

    try {
      let prInfo = await this.github.getPR(repoPath, task.branchName, fullRepo);
      let remoteBranchPresent = false;

      if (!prInfo) {
        remoteBranchPresent = await this.waitForRemoteBranch(
          repoPath,
          task.branchName,
          opts?.retryPendingRemoteBranches === true
        );

        if (remoteBranchPresent && task.trackId === 'backlog') {
          this.board.moveTask({ id: task.id, trackId: 'in-progress' });
          taskChanged = true;
        }

        if (remoteBranchPresent) {
          prInfo = await this.github.createPR(repoPath, {
            githubRepo: fullRepo,
            branch: task.branchName,
            baseBranch,
            title: buildAutoPRTitle(task.id, task.title),
            body: buildAutoPRBody(task.id),
          });
        }
      }

      const gitStatus = await this.git
        .getWorkspaceStatus(task.worktreePath ?? repoPath)
        .catch(() => null);

      if (this.applyTaskSyncPatch(task, prInfo ?? undefined, gitStatus)) {
        taskChanged = true;

        if (prInfo && task.trackId !== 'done' && prInfo.prState === 'merged') {
          this.board.moveTask({ id: task.id, trackId: 'done' });
          taskChanged = true;
        }

        // A pushed branch with a PR means active work, so move backlog into progress.
        if (
          prInfo &&
          task.trackId === 'backlog' &&
          (prInfo.prState === 'draft' || prInfo.prState === 'open')
        ) {
          this.board.moveTask({ id: task.id, trackId: 'in-progress' });
          taskChanged = true;
        }
      }

      if (taskChanged) {
        result.tasksUpdated++;
      }
    } catch (err: unknown) {
      if (taskChanged) {
        result.tasksUpdated++;
      }
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Task ${task.id}: ${msg}`);
    }
  }

  private async runSync(opts?: {
    retryPendingRemoteBranches?: boolean;
    taskIds?: string[];
  }): Promise<SyncResult> {
    if (this.running) {
      return { tasksUpdated: 0, errors: [] };
    }

    this.running = true;
    const result: SyncResult = { tasksUpdated: 0, errors: [] };

    try {
      const tasks =
        opts?.taskIds
          ?.map((taskId) => this.board.getTask(taskId))
          .filter((task): task is TaskRecord => task != null && task.archivedAt == null) ??
        this.board.getTasks({ includeArchived: false });

      for (const task of tasks) {
        await this.syncTask(task, opts, result);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Sync error: ${msg}`);
    } finally {
      this.running = false;
    }

    this.syncEvent.emit('sync', result);
    return result;
  }
}
