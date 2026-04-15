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
  sessionStatus: string | null;
}

function blocksArchiveCleanup(status: string | null): boolean {
  return status === 'active' || status === 'idle';
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
    private session: Pick<SessionManager, 'terminateSession'>,
  ) {}

  private loadTaskCleanupContext(taskId: string): TaskCleanupContext {
    const row = this.db
      .prepare<[string], TaskCleanupContext>(
        `SELECT
           t.id,
           r.path AS repoPath,
           t.worktree_path AS worktreePath,
           t.session_id AS sessionId,
           s.status AS sessionStatus
         FROM tasks t
         JOIN repos r ON r.id = t.repo_id
         LEFT JOIN sessions s ON s.id = t.session_id
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

    if (!task.worktreePath || !existsSync(task.worktreePath) || blocksArchiveCleanup(task.sessionStatus)) {
      return;
    }

    try {
      this.git.removeWorktree(task.repoPath, task.worktreePath);
      this.board.setTaskWorktree?.(taskId, null);
    } catch {
      // Keep the archived task pointing at the worktree so it can be cleaned up later.
    }
  }

  async deleteTask(taskId: string): Promise<void> {
    const task = this.loadTaskCleanupContext(taskId);

    if (task.sessionId) {
      await this.session.terminateSession(task.sessionId);
    }

    if (task.worktreePath && existsSync(task.worktreePath)) {
      this.git.removeWorktree(task.repoPath, task.worktreePath);
    }

    this.board.deleteTask(taskId);
  }
}
