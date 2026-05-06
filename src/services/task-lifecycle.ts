import { existsSync } from 'fs';
import type { Db } from '../db/index.js';
import type { BoardService } from './board.js';
import type { GitService } from './git.js';
import type { SessionManager } from './session-manager.js';

interface TaskCleanupContext {
  id: string;
  repoPath: string;
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
  constructor(
    private db: Db,
    private board: BoardService & {
      archiveTask: (id: string) => void;
      deleteTask: (id: string) => void;
      setTaskWorktree?: (taskId: string, worktreePath: string | null) => void;
    },
    private git: GitService,
    private session: Pick<SessionManager, 'terminateSession' | 'terminateTaskSessions'>,
  ) {}

  private loadTaskCleanupContext(taskId: string): TaskCleanupContext {
    const row = this.db
      .prepare<[string], TaskCleanupContext>(
        `SELECT
           t.id,
           r.path AS repoPath,
           t.worktree_path AS worktreePath,
           t.session_id AS sessionId,
           t.secondary_session_id AS secondarySessionId,
           s.status AS sessionStatus,
           s2.status AS secondarySessionStatus
         FROM tasks t
         JOIN repos r ON r.id = t.repo_id
         LEFT JOIN sessions s ON s.id = t.session_id
         LEFT JOIN sessions s2 ON s2.id = t.secondary_session_id
         WHERE t.id = ?`,
      )
      .get(taskId);

    if (!row) {
      throw new Error(`Task not found: ${taskId}`);
    }

    return row;
  }

  async archiveTask(taskId: string): Promise<void> {
    const task = this.loadTaskCleanupContext(taskId);
    this.board.archiveTask(taskId);

    if (
      !task.worktreePath ||
      !existsSync(task.worktreePath) ||
      blocksArchiveCleanup(task.sessionStatus, task.secondarySessionStatus)
    ) {
      return;
    }

    try {
      this.git.removeWorktree(task.repoPath, task.worktreePath);
      this.board.setTaskWorktree?.(taskId, null);
    } catch {
      // Keep the archived task pointing at the worktree so it can be cleaned up later.
    }
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

    if (task.worktreePath && existsSync(task.worktreePath)) {
      try {
        this.git.removeWorktree(task.repoPath, task.worktreePath);
        this.board.setTaskWorktree?.(taskId, null);
      } catch {
        // Keep the worktree path so it can be cleaned up later.
      }
    }
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.cleanupTaskResources(taskId);
    this.board.deleteTask(taskId);
  }
}
