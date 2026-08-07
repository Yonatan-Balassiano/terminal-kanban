import { homedir } from 'os';
import { basename, dirname, join } from 'path';
import type { Db } from '../db/index.js';
import type { TaskKind, TaskLocation } from '../types/index.js';
import type { BoardService } from './board.js';
import { GitService } from './git.js';
import { TransportRegistry, type ExecTransport } from './transport/index.js';
import { resolveTaskBranchName } from './branch-name.js';

interface TaskWorkspaceRow {
  id: string;
  title: string;
  kind: string | null;
  repo_id: string | null;
  branch_name: string | null;
  worktree_path: string | null;
  last_session_cwd: string | null;
  location: string;
}

interface RepoWorkspaceRow {
  id: string;
  label: string;
  path: string;
  remote_path: string | null;
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

/** Everything the workspace needs, resolved from the database before any I/O. */
interface WorkspacePlan {
  taskId: string;
  kind: TaskKind;
  location: TaskLocation;
  /** The home directory for general tasks, which have no checkout. */
  repoPath: string;
  branch: string;
  baseBranch: string;
  /** Null when the task works directly in the repo checkout. */
  worktreePath: string | null;
  lastSessionCwd: string | null;
}

function sanitizeWorktreeDir(branch: string): string {
  return branch.replace(/[\\/:\s]+/g, '--');
}

function isPathInside(parent: string, child: string | null): boolean {
  return child != null && (child === parent || child.startsWith(`${parent}/`));
}

function toTaskLocation(value: string | null): TaskLocation {
  return value === 'remote' ? 'remote' : 'local';
}

export class WorktreeService {
  private remoteGit: GitService | null = null;

  constructor(
    private db: Db,
    private board: BoardService & {
      setTaskWorktree?: (taskId: string, worktreePath: string | null) => void;
      setTaskBranch?: (taskId: string, branchName: string) => void;
      setTaskLastSessionCwd?: (taskId: string, cwd: string | null) => void;
    },
    private git: GitService,
    private transports: TransportRegistry = new TransportRegistry(),
  ) {}

  private defaultWorktreeRoot(repoPath: string): string {
    return join(dirname(repoPath), `.${basename(repoPath)}-worktrees`);
  }

  private shouldUseWorktree(
    taskId: string,
    repo: RepoWorkspaceRow,
    location: TaskLocation,
    currentPath: string | null,
  ): boolean {
    // The remote host has a single checkout that every agent would otherwise
    // fight over, so remote tasks are always isolated in their own worktree.
    if (location === 'remote') {
      return true;
    }
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

  private resolveRepoPath(repo: RepoWorkspaceRow, location: TaskLocation): string {
    if (location === 'local') {
      return repo.path;
    }
    const remotePath = repo.remote_path?.trim();
    if (!remotePath) {
      throw new Error(
        `Repo "${repo.label}" has no remote path. Set its remote checkout path (repos.remote_path) before running remote tasks.`,
      );
    }
    return remotePath;
  }

  private gitFor(location: TaskLocation): GitService {
    if (location === 'local') {
      return this.git;
    }
    if (!this.remoteGit) {
      this.remoteGit = new GitService(this.transports.getRemote());
    }
    return this.remoteGit;
  }

  private resolvePlan(taskId: string): WorkspacePlan {
    const task = this.db
      .prepare<[string], TaskWorkspaceRow>(
        `SELECT id, title, kind, repo_id, branch_name, worktree_path, last_session_cwd, location
         FROM tasks
         WHERE id = ?`,
      )
      .get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    // A general task has no repo, so there is nothing to resolve: it runs in the
    // home directory with no branch and no worktree.
    if (task.kind === 'general') {
      return {
        taskId,
        kind: 'general',
        location: 'local',
        repoPath: homedir(),
        branch: '',
        baseBranch: '',
        worktreePath: null,
        lastSessionCwd: task.last_session_cwd,
      };
    }

    const repo = this.db
      .prepare<[string], RepoWorkspaceRow>(
        `SELECT id, label, path, remote_path, default_base_branch, worktree_mode, worktree_root
         FROM repos
         WHERE id = ?`,
      )
      .get(task.repo_id ?? '');
    if (!repo) {
      throw new Error(`Repo not found for task ${taskId}`);
    }

    const location = toTaskLocation(task.location);
    const repoPath = this.resolveRepoPath(repo, location);

    const branch = resolveTaskBranchName(task.title, task.id, task.branch_name ?? undefined);
    if (branch !== task.branch_name) {
      this.board.setTaskBranch?.(taskId, branch);
    }

    const useWorktree = this.shouldUseWorktree(taskId, repo, location, task.worktree_path);
    // A configured worktree_root is a path on this laptop, so it cannot apply to
    // the remote host; remote worktrees always mirror the default layout there.
    const worktreeRoot =
      location === 'remote'
        ? this.defaultWorktreeRoot(repoPath)
        : (repo.worktree_root ?? this.defaultWorktreeRoot(repoPath));

    return {
      taskId,
      kind: 'repo',
      location,
      repoPath,
      branch,
      baseBranch: repo.default_base_branch ?? 'main',
      worktreePath: useWorktree
        ? (task.worktree_path ?? join(worktreeRoot, sanitizeWorktreeDir(branch)))
        : null,
      lastSessionCwd: task.last_session_cwd,
    };
  }

  private commit(plan: WorkspacePlan, worktreePath: string | null, cwd: string): TaskWorkspaceInfo {
    this.board.setTaskWorktree?.(plan.taskId, worktreePath);
    this.board.setTaskLastSessionCwd?.(plan.taskId, cwd);
    return {
      taskId: plan.taskId,
      path: cwd,
      repoPath: plan.repoPath,
      usedWorktree: worktreePath !== null,
    };
  }

  /** Prepares the workspace on whichever host the task lives on. */
  async prepareTaskWorkspace(taskId: string): Promise<TaskWorkspaceInfo> {
    const plan = this.resolvePlan(taskId);
    const transport = this.transports.forLocation(plan.location);

    if (!plan.worktreePath) {
      const cwd = await this.reuseCwd(transport, plan.repoPath, plan.lastSessionCwd);
      return this.commit(plan, null, cwd);
    }

    // mkdirp only when the worktree is actually missing: on a remote host every
    // call is an SSH round trip, and an existing worktree implies its parent.
    if (!(await transport.exists(plan.worktreePath))) {
      await transport.mkdirp(dirname(plan.worktreePath));
      await this.gitFor(plan.location).createWorktreeAsync(
        plan.repoPath,
        plan.worktreePath,
        plan.branch,
        plan.baseBranch,
      );
    }

    const cwd = await this.reuseCwd(transport, plan.worktreePath, plan.lastSessionCwd);
    return this.commit(plan, plan.worktreePath, cwd);
  }

  private async reuseCwd(
    transport: ExecTransport,
    root: string,
    lastSessionCwd: string | null,
  ): Promise<string> {
    if (!isPathInside(root, lastSessionCwd)) {
      return root;
    }
    return (await transport.exists(lastSessionCwd!)) ? lastSessionCwd! : root;
  }
}
