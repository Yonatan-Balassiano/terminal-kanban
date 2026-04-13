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

export class SyncService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  readonly syncEvent = new EventEmitter();

  constructor(
    private board: BoardService,
    private github: GitHubService,
    private git: GitService,
    private db: Db,
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
    return this.runSync();
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
    const storedBaseBranch =
      (repoRow['default_base_branch'] as string | null) ?? 'main';
    const detectedBaseBranch = await this.git.defaultBranch(repoPath);
    const baseBranch = detectedBaseBranch || storedBaseBranch;
    const fullRepo = `${githubOwner}/${githubRepo}`;
    const existing = await this.github.getPR(repoPath, task.branchName, fullRepo);
    if (existing) {
      this.applyTaskSyncPatch(task, existing);
      return existing;
    }

    const remoteBranchPresent = await this.git.remoteBranchExists(repoPath, task.branchName);
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
    gitStatus?: Awaited<ReturnType<GitService['getWorkspaceStatus']>> | null,
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
      if (task.gitBehindCount !== gitStatus.behindCount) patch.gitBehindCount = gitStatus.behindCount;
      if (task.hasUntracked !== gitStatus.hasUntracked) patch.hasUntracked = gitStatus.hasUntracked;
      if (task.hasConflicts !== gitStatus.hasConflicts) patch.hasConflicts = gitStatus.hasConflicts;
    }

    if (Object.keys(patch).length === 0) {
      return false;
    }

    this.board.updateTaskSync(task.id, patch);
    return true;
  }

  private async runSync(): Promise<SyncResult> {
    if (this.running) {
      return { tasksUpdated: 0, errors: [] };
    }

    this.running = true;
    const result: SyncResult = { tasksUpdated: 0, errors: [] };

    try {
      // Load all non-archived tasks that have a branch name
      const tasks = this.board.getTasks({ includeArchived: false });

      for (const task of tasks) {
        if (!task.branchName) continue;

        // Load repo
        const repoRow = this.db
          .prepare<[string], Record<string, unknown>>('SELECT * FROM repos WHERE id = ?')
          .get(task.repoId);

        if (!repoRow) continue;

        const githubOwner = (repoRow['github_owner'] as string | null) ?? undefined;
        const githubRepo = (repoRow['github_repo'] as string | null) ?? undefined;
        const repoPath = repoRow['path'] as string;
        const storedBaseBranch =
          (repoRow['default_base_branch'] as string | null) ?? 'main';
        const detectedBaseBranch = await this.git.defaultBranch(repoPath);
        const baseBranch = detectedBaseBranch || storedBaseBranch;

        if (baseBranch !== storedBaseBranch) {
          this.db
            .prepare<[string, number, string], void>(
              'UPDATE repos SET default_base_branch = ?, updated_at = ? WHERE id = ?',
            )
            .run(baseBranch, Date.now(), task.repoId);
        }

        if (!githubOwner || !githubRepo) continue;

        const fullRepo = `${githubOwner}/${githubRepo}`;

        let taskChanged = false;
        try {
          let prInfo = await this.github.getPR(repoPath, task.branchName, fullRepo);
          let remoteBranchPresent = false;

          if (!prInfo) {
            remoteBranchPresent = await this.git.remoteBranchExists(repoPath, task.branchName);

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
