import type { Db } from '../db/index.js';
import type { TaskLocation } from '../types/index.js';
import type { BoardService } from './board.js';
import { GitService } from './git.js';
import type { SessionManager } from './session-manager.js';
import {
  TransportRegistry,
  TransportUnreachableError,
  type ExecTransport,
} from './transport/index.js';

interface TaskCleanupRow {
  id: string;
  location: string | null;
  /** Null for general tasks, which belong to no repo. */
  localRepoPath: string | null;
  remoteRepoPath: string | null;
  worktreePath: string | null;
  sessionId: string | null;
  secondarySessionId: string | null;
  sessionStatus: string | null;
  secondarySessionStatus: string | null;
}

interface TaskCleanupContext {
  id: string;
  location: TaskLocation;
  /** Repo checkout path on the host this task actually runs on; null for general tasks. */
  repoPath: string | null;
  worktreePath: string | null;
  sessionId: string | null;
  secondarySessionId: string | null;
  sessionStatus: string | null;
  secondarySessionStatus: string | null;
}

function blocksArchiveCleanup(...statuses: Array<string | null>): boolean {
  return statuses.some((status) => status === 'active' || status === 'idle');
}

export class TaskLifecycleService {
  private remoteGit: GitService | null = null;

  constructor(
    private db: Db,
    private board: BoardService & {
      archiveTask: (id: string) => void;
      deleteTask: (id: string) => void;
      setTaskWorktree?: (taskId: string, worktreePath: string | null) => void;
    },
    private git: GitService,
    private session: Pick<SessionManager, 'terminateSession' | 'terminateTaskSessions'>,
    private transports: TransportRegistry = new TransportRegistry(),
  ) {}

  private loadTaskCleanupContext(taskId: string): TaskCleanupContext {
    const row = this.db
      .prepare<[string], TaskCleanupRow>(
        `SELECT
           t.id,
           t.location,
           r.path AS localRepoPath,
           r.remote_path AS remoteRepoPath,
           t.worktree_path AS worktreePath,
           t.session_id AS sessionId,
           t.secondary_session_id AS secondarySessionId,
           s.status AS sessionStatus,
           s2.status AS secondarySessionStatus
         FROM tasks t
         LEFT JOIN repos r ON r.id = t.repo_id
         LEFT JOIN sessions s ON s.id = t.session_id
         LEFT JOIN sessions s2 ON s2.id = t.secondary_session_id
         WHERE t.id = ?`,
      )
      .get(taskId);

    if (!row) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const location: TaskLocation = row.location === 'remote' ? 'remote' : 'local';
    return {
      id: row.id,
      location,
      repoPath: location === 'remote' ? (row.remoteRepoPath ?? row.localRepoPath) : row.localRepoPath,
      worktreePath: row.worktreePath,
      sessionId: row.sessionId,
      secondarySessionId: row.secondarySessionId,
      sessionStatus: row.sessionStatus,
      secondarySessionStatus: row.secondarySessionStatus,
    };
  }

  private transportFor(location: TaskLocation): ExecTransport {
    return this.transports.forLocation(location);
  }

  private gitFor(location: TaskLocation): GitService {
    if (location !== 'remote') {
      return this.git;
    }
    this.remoteGit ??= new GitService(this.transports.getRemote());
    return this.remoteGit;
  }

  /**
   * Remove a task's worktree from whichever host it lives on.
   *
   * Both the existence probe and the `git worktree remove` must run on that
   * host — checking the laptop filesystem for a remote path would silently skip
   * cleanup and orphan the remote worktree.
   *
   * An unreachable host is rethrown so the caller can abort and the user can
   * retry once they are back online; deleting the card anyway would strand a
   * remote worktree and tmux session with nothing left pointing at them. A
   * genuine git failure is swallowed instead, so a corrupt worktree can never
   * make a card impossible to delete.
   */
  private async removeTaskWorktree(task: TaskCleanupContext): Promise<void> {
    if (!task.worktreePath || !task.repoPath) {
      return;
    }

    try {
      if (!(await this.transportFor(task.location).exists(task.worktreePath))) {
        return;
      }
      await this.gitFor(task.location).removeWorktreeAsync(task.repoPath, task.worktreePath);
      this.board.setTaskWorktree?.(task.id, null);
    } catch (error) {
      if (error instanceof TransportUnreachableError) {
        throw error;
      }
      // Keep the recorded path so a later archive or delete can retry it.
    }
  }

  /**
   * Remove every worktree a card owns, across every repo it touched.
   *
   * All of them are attempted before any unreachable host is reported, so one
   * dead remote cannot strand the local worktrees alongside it.
   */
  private async removeAllTaskWorktrees(task: TaskCleanupContext): Promise<void> {
    const branches = this.board.getTaskBranches?.(task.id) ?? [];
    let unreachable: unknown;

    for (const branch of branches) {
      if (!branch.worktreePath) {
        continue;
      }

      const repoPath = this.repoPathForBranch(branch.repoId, task.location);
      if (!repoPath) {
        continue;
      }

      try {
        if (!(await this.transportFor(task.location).exists(branch.worktreePath))) {
          continue;
        }
        await this.gitFor(task.location).removeWorktreeAsync(repoPath, branch.worktreePath);
        this.board.setTaskBranchWorktree?.(branch.id, null);
      } catch (error) {
        if (error instanceof TransportUnreachableError) {
          unreachable ??= error;
          continue;
        }
        // A corrupt worktree must never make a card impossible to delete.
      }
    }

    // The card's own recorded path mirrors the active branch; clear it too so a
    // card that predates branches is still cleaned up.
    await this.removeTaskWorktree(task);

    if (unreachable) {
      throw unreachable;
    }
  }

  /**
   * Release one branch's worktree, on whichever host the card lives on.
   *
   * Exposed so branch-scoped callers do not reimplement it against the local
   * transport — doing that silently leaks every remote worktree, because the
   * probe and the removal both have to run on the card's own host.
   *
   * Returns whether the worktree is gone, so a caller can decide whether it is
   * safe to forget where it was.
   */
  async removeBranchWorktree(branchId: string): Promise<boolean> {
    const branch = this.board.getTaskBranch(branchId);
    if (!branch?.worktreePath) {
      return true;
    }

    const task = this.loadTaskCleanupContext(branch.taskId);
    const repoPath = this.repoPathForBranch(branch.repoId, task.location);
    if (!repoPath) {
      return false;
    }

    try {
      if (!(await this.transportFor(task.location).exists(branch.worktreePath))) {
        return true;
      }
      await this.gitFor(task.location).removeWorktreeAsync(repoPath, branch.worktreePath);
      this.board.setTaskBranchWorktree?.(branchId, null);
      return true;
    } catch (error) {
      if (error instanceof TransportUnreachableError) {
        throw error;
      }
      // A corrupt worktree must not make the branch impossible to remove, but
      // the caller has to know the directory is still there.
      return false;
    }
  }

  private repoPathForBranch(repoId: string, location: TaskLocation): string | undefined {
    const row = this.db
      .prepare<[string], { path: string; remote_path: string | null }>(
        'SELECT path, remote_path FROM repos WHERE id = ?',
      )
      .get(repoId);
    if (!row) {
      return undefined;
    }
    return location === 'remote' ? (row.remote_path ?? row.path) : row.path;
  }

  async archiveTask(taskId: string): Promise<void> {
    const task = this.loadTaskCleanupContext(taskId);
    this.board.archiveTask(taskId);

    if (blocksArchiveCleanup(task.sessionStatus, task.secondarySessionStatus)) {
      return;
    }

    await this.removeAllTaskWorktrees(task);
  }

  async cleanupTaskResources(taskId: string): Promise<void> {
    const task = this.loadTaskCleanupContext(taskId);

    if (this.session.terminateTaskSessions) {
      await this.session.terminateTaskSessions(taskId);
    } else {
      if (task.sessionId) {
        await this.session.terminateSession(task.sessionId);
      }
      if (task.secondarySessionId) {
        await this.session.terminateSession(task.secondarySessionId);
      }
    }

    await this.removeAllTaskWorktrees(task);
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.cleanupTaskResources(taskId);
    this.board.deleteTask(taskId);
  }
}
