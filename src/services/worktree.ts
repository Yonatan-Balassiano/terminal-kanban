import { existsSync, mkdirSync } from 'fs';
import { basename, dirname, join } from 'path';
import type { Db } from '../db/index.js';
import type { BoardService } from './board.js';
import type { GitService } from './git.js';
import { resolveTaskBranchName } from './branch-name.js';

interface TaskWorkspaceRow {
  id: string;
  title: string;
  repo_id: string;
  branch_name: string | null;
  worktree_path: string | null;
  last_session_cwd: string | null;
}

interface RepoWorkspaceRow {
  id: string;
  label: string;
  path: string;
  default_base_branch: string | null;
  worktree_mode: string | null;
  worktree_root: string | null;
}

export interface TaskWorkspaceInfo {
  taskId: string;
  path: string;
  repoPath: string;
  usedWorktree: boolean;
}

function sanitizeWorktreeDir(branch: string): string {
  return branch.replace(/[\\/:\s]+/g, '--');
}

function isPathInside(parent: string, child: string | null): boolean {
  return child != null && (child === parent || child.startsWith(`${parent}/`));
}

export class WorktreeService {
  constructor(
    private db: Db,
    private board: BoardService & {
      setTaskWorktree?: (taskId: string, worktreePath: string | null) => void;
      setTaskBranch?: (taskId: string, branchName: string) => void;
      setTaskLastSessionCwd?: (taskId: string, cwd: string | null) => void;
    },
    private git: GitService,
  ) {}

  private defaultWorktreeRoot(repoPath: string): string {
    return join(dirname(repoPath), `.${basename(repoPath)}-worktrees`);
  }

  private shouldUseWorktree(taskId: string, repo: RepoWorkspaceRow, currentPath: string | null): boolean {
    if (repo.worktree_mode === 'always') {
      return true;
    }
    if (repo.worktree_mode === 'off') {
      return currentPath != null;
    }
    if (currentPath != null) {
      return true;
    }

    const activeSiblingCount = this.db
      .prepare<[string, string], { count: number }>(
        `SELECT COUNT(*) AS count
         FROM tasks
         WHERE repo_id = ?
           AND archived_at IS NULL
           AND (session_id IS NOT NULL OR secondary_session_id IS NOT NULL)
           AND id <> ?`,
      )
      .get(repo.id, taskId)?.count ?? 0;

    return activeSiblingCount > 0;
  }

  prepareTaskWorkspace(taskId: string): TaskWorkspaceInfo {
    const task = this.db
      .prepare<[string], TaskWorkspaceRow>(
        `SELECT id, title, repo_id, branch_name, worktree_path, last_session_cwd
         FROM tasks
         WHERE id = ?`,
      )
      .get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const repo = this.db
      .prepare<[string], RepoWorkspaceRow>(
        `SELECT id, label, path, default_base_branch, worktree_mode, worktree_root
         FROM repos
         WHERE id = ?`,
      )
      .get(task.repo_id);
    if (!repo) {
      throw new Error(`Repo not found for task ${taskId}`);
    }

    const branch = resolveTaskBranchName(task.title, task.id, task.branch_name ?? undefined);
    if (branch !== task.branch_name) {
      this.board.setTaskBranch?.(taskId, branch);
    }

    const useWorktree = this.shouldUseWorktree(taskId, repo, task.worktree_path);
    if (!useWorktree) {
      const cwd =
        isPathInside(repo.path, task.last_session_cwd) && existsSync(task.last_session_cwd!)
          ? task.last_session_cwd!
          : repo.path;
      this.board.setTaskWorktree?.(taskId, null);
      this.board.setTaskLastSessionCwd?.(taskId, cwd);
      return {
        taskId,
        path: cwd,
        repoPath: repo.path,
        usedWorktree: false,
      };
    }

    const worktreeRoot = repo.worktree_root ?? this.defaultWorktreeRoot(repo.path);
    const worktreePath = task.worktree_path ?? join(worktreeRoot, sanitizeWorktreeDir(branch));
    mkdirSync(dirname(worktreePath), { recursive: true });

    if (!existsSync(worktreePath)) {
      this.git.createWorktree(
        repo.path,
        worktreePath,
        branch,
        repo.default_base_branch ?? 'main',
      );
    }

    const cwd =
      isPathInside(worktreePath, task.last_session_cwd) && existsSync(task.last_session_cwd!)
        ? task.last_session_cwd!
        : worktreePath;

    this.board.setTaskWorktree?.(taskId, worktreePath);
    this.board.setTaskLastSessionCwd?.(taskId, cwd);

    return {
      taskId,
      path: cwd,
      repoPath: repo.path,
      usedWorktree: true,
    };
  }
}
