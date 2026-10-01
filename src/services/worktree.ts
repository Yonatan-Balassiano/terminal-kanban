import { homedir } from 'os';
import { basename, dirname, join } from 'path';
import type { Db } from '../db/index.js';
import type { TaskKind, TaskLocation } from '../types/index.js';
import type { BoardService } from './board.js';
import { GitService, type SyncWorktreeIntoMainResult } from './git.js';
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
  active_branch_id: string | null;
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

/**
 * A task_branches row already joined to its own repo.
 *
 * The join is per row rather than per card: two branches of the same card can
 * live in different repos, and worktree_root / default_base_branch / remote_path
 * are all repo-scoped.
 */
interface TaskBranchWorkspaceRow extends RepoWorkspaceRow {
  branch_id: string;
  branch_name: string;
  base_branch: string | null;
  branch_worktree_path: string | null;
}

/** One branch of a card, resolved against the repo that branch lives in. */
export interface BranchWorkspacePlan {
  /** Null only for a legacy card that has no task_branches row yet. */
  branchId: string | null;
  repoId: string;
  repoLabel: string;
  repoPath: string;
  branch: string;
  baseBranch: string;
  /** Null when this branch works directly in the repo checkout. */
  worktreePath: string | null;
}

/** A branch's plan once its checkout has been ensured on disk. */
interface BranchCheckout {
  plan: BranchWorkspacePlan;
  /**
   * The branch was already checked out somewhere the card does not own, so the
   * session works there and nothing records it as the card's worktree.
   */
  borrowed: boolean;
}

export interface TaskWorkspaceInfo {
  taskId: string;
  path: string;
  repoPath: string;
  usedWorktree: boolean;
  /**
   * Every branch of the card, active one first. Empty for a general task.
   *
   * Optional because callers that stub this type out do not have to model it;
   * absent means "not resolved", not "the card owns nothing".
   */
  workspaces?: BranchWorkspacePlan[];
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
  /** Active branch first, so plan.branches[0] is the one the session sits in. */
  branches: BranchWorkspacePlan[];
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

/** Where a branch is actually worked on: its worktree, else the bare checkout. */
function branchRoot(branch: BranchWorkspacePlan): string {
  return branch.worktreePath ?? branch.repoPath;
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
    branchCount: number,
  ): boolean {
    // Two branches of the same card in the same repo have no sibling *task* to
    // count, so the heuristic below would send both to the bare checkout and let
    // them stomp each other's HEAD. A multi-branch card is always isolated.
    if (branchCount > 1) {
      return true;
    }
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

  private branchPlan(params: {
    taskId: string;
    repo: RepoWorkspaceRow;
    location: TaskLocation;
    branchId: string | null;
    branch: string;
    baseBranch: string;
    currentPath: string | null;
    branchCount: number;
  }): BranchWorkspacePlan {
    const { repo, location } = params;
    const repoPath = this.resolveRepoPath(repo, location);
    const useWorktree = this.shouldUseWorktree(
      params.taskId,
      repo,
      location,
      params.currentPath,
      params.branchCount,
    );
    // A configured worktree_root is a path on this laptop, so it cannot apply to
    // the remote host; remote worktrees always mirror the default layout there.
    const worktreeRoot =
      location === 'remote'
        ? this.defaultWorktreeRoot(repoPath)
        : (repo.worktree_root ?? this.defaultWorktreeRoot(repoPath));

    return {
      branchId: params.branchId,
      repoId: repo.id,
      repoLabel: repo.label,
      repoPath,
      branch: params.branch,
      baseBranch: params.baseBranch,
      worktreePath: useWorktree
        ? (params.currentPath ?? join(worktreeRoot, sanitizeWorktreeDir(params.branch)))
        : null,
    };
  }

  /**
   * Keeps tasks.branch_name in step with the title-derived name.
   *
   * Only meaningful while the card owns exactly one branch: once there are
   * several there is no single "the card's branch" to keep in step with.
   */
  private syncCardBranchName(task: TaskWorkspaceRow, stored: string | null): string {
    const branch = resolveTaskBranchName(task.title, task.id, stored ?? undefined);
    if (branch !== task.branch_name) {
      this.board.setTaskBranch?.(task.id, branch);
    }
    return branch;
  }

  private loadRepo(repoId: string, taskId: string): RepoWorkspaceRow {
    const repo = this.db
      .prepare<[string], RepoWorkspaceRow>(
        `SELECT id, label, path, remote_path, default_base_branch, worktree_mode, worktree_root
         FROM repos
         WHERE id = ?`,
      )
      .get(repoId);
    if (!repo) {
      throw new Error(`Repo not found for task ${taskId}`);
    }
    return repo;
  }

  private loadBranchRows(taskId: string): TaskBranchWorkspaceRow[] {
    return this.db
      .prepare<[string], TaskBranchWorkspaceRow>(
        `SELECT tb.id AS branch_id,
                tb.branch_name AS branch_name,
                tb.base_branch AS base_branch,
                tb.worktree_path AS branch_worktree_path,
                r.id AS id,
                r.label AS label,
                r.path AS path,
                r.remote_path AS remote_path,
                r.default_base_branch AS default_base_branch,
                r.worktree_mode AS worktree_mode,
                r.worktree_root AS worktree_root
         FROM task_branches tb
         JOIN repos r ON r.id = tb.repo_id
         WHERE tb.task_id = ?
         ORDER BY tb.sort_key, tb.created_at`,
      )
      .all(taskId);
  }

  private resolveBranchPlans(
    task: TaskWorkspaceRow,
    location: TaskLocation,
  ): BranchWorkspacePlan[] {
    const rows = this.loadBranchRows(task.id);

    // A card predating task_branches has no row to resolve, so the tasks row is
    // still the only description of its single branch.
    if (rows.length === 0) {
      const repo = this.loadRepo(task.repo_id ?? '', task.id);
      return [
        this.branchPlan({
          taskId: task.id,
          repo,
          location,
          branchId: null,
          branch: this.syncCardBranchName(task, task.branch_name),
          baseBranch: repo.default_base_branch ?? 'main',
          currentPath: task.worktree_path,
          branchCount: 1,
        }),
      ];
    }

    const isSingle = rows.length === 1;
    return rows.map((row) =>
      this.branchPlan({
        taskId: task.id,
        repo: row,
        location,
        branchId: row.branch_id,
        branch: isSingle ? this.syncCardBranchName(task, row.branch_name) : row.branch_name,
        baseBranch: row.base_branch ?? row.default_base_branch ?? 'main',
        // tasks.worktree_path is the pre-task_branches home of this value, so a
        // single-branch card still honours it when its own row is empty.
        currentPath: row.branch_worktree_path ?? (isSingle ? task.worktree_path : null),
        branchCount: rows.length,
      }),
    );
  }

  private resolvePlan(taskId: string): WorkspacePlan {
    const task = this.db
      .prepare<[string], TaskWorkspaceRow>(
        `SELECT id, title, kind, repo_id, branch_name, worktree_path, last_session_cwd, location,
                active_branch_id
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
        branches: [],
      };
    }

    const location = toTaskLocation(task.location);
    const resolved = this.resolveBranchPlans(task, location);
    // The session sits in the card's active branch; a card that never picked one
    // falls back to the first by sort_key.
    const active = resolved.find((plan) => plan.branchId === task.active_branch_id) ?? resolved[0]!;
    const branches = [active, ...resolved.filter((plan) => plan !== active)];

    return {
      taskId,
      kind: 'repo',
      location,
      repoPath: active.repoPath,
      branch: active.branch,
      baseBranch: active.baseBranch,
      worktreePath: active.worktreePath,
      lastSessionCwd: task.last_session_cwd,
      branches,
    };
  }

  private commit(
    plan: WorkspacePlan,
    active: BranchCheckout | undefined,
    cwd: string,
  ): TaskWorkspaceInfo {
    const worktreePath = active?.plan.worktreePath ?? null;
    // tasks.worktree_path mirrors the ACTIVE branch so reveal-workspace and
    // open-in-IDE still open something sensible on a multi-branch card — but
    // only a checkout the card owns, because cleanup removes what is recorded.
    this.board.setTaskWorktree?.(plan.taskId, active?.borrowed ? null : worktreePath);
    this.board.setTaskLastSessionCwd?.(plan.taskId, cwd);
    return {
      taskId: plan.taskId,
      path: cwd,
      repoPath: plan.repoPath,
      usedWorktree: worktreePath !== null,
      workspaces: plan.branches,
    };
  }

  /**
   * Reset the repo's main checkout to this task's branch tip and layer the worktree's
   * uncommitted (staged + unstaged) changes plus untracked files on top — so the main
   * checkout (which has node_modules, runs dev servers, etc.) mirrors the worktree.
   * Destructive to the main checkout's current state.
   */
  async syncTaskToMain(taskId: string): Promise<SyncWorktreeIntoMainResult> {
    const task = this.db
      .prepare<[string], TaskWorkspaceRow>(
        `SELECT id, title, kind, repo_id, branch_name, worktree_path, last_session_cwd,
                location, active_branch_id
         FROM tasks
         WHERE id = ?`,
      )
      .get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
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

    const branch = resolveTaskBranchName(task.title, task.id, task.branch_name ?? undefined);

    if (!task.worktree_path) {
      throw new Error(
        'Task has no worktree to sync from. Open a session so its worktree is created first.',
      );
    }
    if (task.worktree_path === repo.path) {
      throw new Error('Task runs in the main checkout already — nothing to sync.');
    }

    return this.git.syncWorktreeIntoMain({
      repoPath: repo.path,
      worktreePath: task.worktree_path,
      branch,
    });
  }

  /** Prepares the workspace on whichever host the task lives on. */
  async prepareTaskWorkspace(taskId: string): Promise<TaskWorkspaceInfo> {
    const plan = this.resolvePlan(taskId);
    const transport = this.transports.forLocation(plan.location);

    // Every branch gets its own checkout, not just the active one: an agent that
    // moves to another repo mid-card must find that worktree already there.
    const checkouts: BranchCheckout[] = [];
    for (const branch of plan.branches) {
      checkouts.push(await this.ensureBranchWorkspace(transport, plan.location, branch));
    }

    const branches = checkouts.map((checkout) => checkout.plan);
    const roots = branches.length > 0 ? branches.map(branchRoot) : [plan.repoPath];
    const cwd = await this.reuseCwd(transport, roots, plan.lastSessionCwd);
    return this.commit({ ...plan, branches }, checkouts[0], cwd);
  }

  private async ensureBranchWorkspace(
    transport: ExecTransport,
    location: TaskLocation,
    branch: BranchWorkspacePlan,
  ): Promise<BranchCheckout> {
    if (!branch.worktreePath) {
      return { plan: branch, borrowed: false };
    }

    // mkdirp only when the worktree is actually missing: on a remote host every
    // call is an SSH round trip, and an existing worktree implies its parent.
    if (!(await transport.exists(branch.worktreePath))) {
      const git = this.gitFor(location);
      // git allows one checkout per branch, so a branch the user already has
      // checked out — in the main checkout, or a worktree of their own — can
      // never get a worktree here. Failing on it used to drop the whole card
      // into a plain shell; work in that checkout instead.
      const existing = await git.findBranchCheckoutAsync(branch.repoPath, branch.branch);
      if (existing) {
        // Never written back: cleanup force-removes every recorded worktree,
        // and this one is not the card's to remove.
        return { plan: { ...branch, worktreePath: existing }, borrowed: true };
      }
      await transport.mkdirp(dirname(branch.worktreePath));
      await git.createWorktreeAsync(
        branch.repoPath,
        branch.worktreePath,
        branch.branch,
        branch.baseBranch,
      );
    }

    // Written back so the board can point at each branch's checkout directly
    // instead of every reader re-deriving the path from the branch name.
    if (branch.branchId) {
      this.board.setTaskBranchWorktree(branch.branchId, branch.worktreePath);
    }
    return { plan: branch, borrowed: false };
  }

  private async reuseCwd(
    transport: ExecTransport,
    roots: readonly string[],
    lastSessionCwd: string | null,
  ): Promise<string> {
    // roots[0] is the active branch's directory — where the session goes when
    // the last cwd tells us nothing usable.
    const fallback = roots[0]!;
    // A card owns a workspace per branch, so a session last used in repo B must
    // reopen there rather than snapping back to whichever repo is active.
    const isOwned = roots.some((root) => isPathInside(root, lastSessionCwd));
    if (!isOwned) {
      return fallback;
    }
    return (await transport.exists(lastSessionCwd!)) ? lastSessionCwd! : fallback;
  }
}
