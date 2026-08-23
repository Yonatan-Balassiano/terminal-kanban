import { EventEmitter } from 'events';
import type { Db } from '../db/index.js';
import type {
  SyncResult,
  TaskBranchRecord,
  TaskBranchSyncPatch,
  TaskRecord,
} from '../types/index.js';
import type { BoardService } from './board.js';
import { allBranchesResolved } from './task-branches.js';
import { GitHubServiceError, type GitHubService, type PRInfo, type DiscoveredPR } from './github.js';
import { GitService } from './git.js';
import { TransportRegistry } from './transport/index.js';

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

/**
 * Whether a branch has anything left to learn from GitHub.
 *
 * A merged or closed pull request is finished: its state, its checks and its
 * reviews are all frozen. Re-reading them costs three GraphQL calls per branch
 * per poll and can never return anything new — which is what exhausted the
 * hourly GraphQL budget on a board whose cards were nearly all done.
 */
function isBranchSettled(branch: TaskBranchRecord): boolean {
  if (branch.prNumber === undefined) {
    return false;
  }
  if (branch.prState === 'closed') {
    return true;
  }
  // A merged branch is still worth one call until its merge commit is known,
  // because release tracking cannot resolve anything without it.
  return branch.prState === 'merged' && branch.mergeCommitSha !== undefined;
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
  onTaskMergedOrClosed?: (taskId: string) => Promise<void>;
  /**
   * Whether every merged pull request on a card has actually reached production.
   *
   * Supplied by the daemon when release tracking is configured. Absent means the
   * question cannot be asked, and a card that has merged everything then goes
   * straight to done — the gate is opt-in, so nothing changes for anyone not
   * tracking artifacts.
   */
  isFullyReleased?: (taskId: string) => boolean;
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
  private remoteGit: GitService | null = null;
  readonly syncEvent = new EventEmitter();

  /**
   * Set by the daemon so remote tasks read their git state over SSH. Defaults to
   * local-only, which keeps the several overloaded constructor forms unchanged.
   */
  transports: TransportRegistry = new TransportRegistry();

  constructor(
    board: BoardService,
    github: GitHubService,
    git: GitService,
    db: Db,
    wait: typeof sleep = sleep,
  ) {
    this.board = board;
    this.github = github;
    this.git = git;
    this.db = db;
    this.wait = wait;
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
    if (this.board.getTask(taskId)?.kind === 'general') {
      throw new Error('General tasks have no repo or branch, so they cannot have a pull request');
    }
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
      // A finished card has nothing left to ask GitHub about, and a board is
      // mostly finished cards. Polling them anyway is what ran the GraphQL
      // budget out. A manual sync still reaches them, so a reopened pull
      // request is one keypress away rather than unreachable.
      .filter((task) => opts.cause === 'manual' || !this.isTaskSettled(task))
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
      .filter((task) => !this.isTaskSettled(task))
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

  /** Git badges must be read on the host the task's worktree actually lives on. */
  private gitFor(task: TaskRecord): GitService {
    if (task.location !== 'remote') {
      return this.git;
    }
    this.remoteGit ??= new GitService(this.transports.getRemote());
    return this.remoteGit;
  }

  /**
   * Brings one card's branches in line with GitHub, then decides where it belongs.
   *
   * Each branch reconciles independently, but the track transition is evaluated
   * ONCE at the end from the whole card. Deciding per branch is what would let
   * the first merged pull request of a five-pull-request feature close the card
   * and delete the worktrees the other four are still being written in.
   */
  private async reconcileTaskById(
    taskId: string,
    opts: ReconcileOptions,
  ): Promise<TaskReconcileResult> {
    const result: TaskReconcileResult = emptySyncResult();
    const task = this.board.getTask(taskId);

    // A general task has no repo, branch, or PR — there is nothing to reconcile.
    if (!task || task.archivedAt != null || task.kind === 'general') {
      this.clearDelayedRetry(taskId);
      return result;
    }

    const branches = this.ensureTaskBranches(task);
    if (branches.length === 0) {
      this.clearDelayedRetry(taskId);
      return result;
    }

    await this.discoverSiblingBranches(task, branches);

    for (const branch of this.board.getTaskBranches(taskId)) {
      const branchResult = await this.reconcileBranch(task, branch, opts);
      result.tasksUpdated += branchResult.tasksUpdated;
      result.errors.push(...branchResult.errors);
      result.requestDelayedRetry ||= branchResult.requestDelayedRetry;
      // The active branch's pull request is what the card-level callers expect.
      if (branchResult.prInfo && (branch.id === task.activeBranchId || !result.prInfo)) {
        result.prInfo = branchResult.prInfo;
      }
    }

    result.tasksUpdated += this.evaluateTrackTransition(taskId);
    return result;
  }

  /**
   * A card written before branches existed still has its work in task columns.
   *
   * Seeding lazily here means a card the one-time backfill missed heals itself
   * on its next sync instead of silently never syncing again.
   */
  private ensureTaskBranches(task: TaskRecord): TaskBranchRecord[] {
    const existing = this.board.getTaskBranches(task.id);
    if (existing.length > 0 || !task.repoId || !task.branchName) {
      return existing;
    }

    this.board.addTaskBranch({
      taskId: task.id,
      repoId: task.repoId,
      branchName: task.branchName,
      ...(task.worktreePath ? { worktreePath: task.worktreePath } : {}),
    });
    return this.board.getTaskBranches(task.id);
  }

  /**
   * Adopts pull requests opened on this card's branch name in other repos, plus
   * any pull request elsewhere in the org that cross-references a PR this card
   * already carries.
   *
   * A feature spanning several repositories is worked on under one branch name
   * *when the same hand names both branches*, so the first search catches that
   * case cheaply — one org-wide query regardless of how many repositories are
   * configured. It misses the case where each repo's branch is named for what
   * it does locally rather than for the card, which is common when an agent
   * works each side of a cross-repo change independently. The second search
   * catches that instead, via the `repo#123` shorthand a stacked or dependent
   * PR uses to point back at the PR that started the work.
   */
  /**
   * Whether a card is done with GitHub entirely.
   *
   * Only a card already in `done` counts: one in `shipping` has landed but may
   * still gain a follow-up branch, and pulling it back into review depends on
   * noticing that.
   */
  private isTaskSettled(task: TaskRecord): boolean {
    if (task.trackId !== 'done' || task.branches.length === 0) {
      return false;
    }
    return task.branches.every((branch) => isBranchSettled(branch));
  }

  private async discoverSiblingBranches(
    task: TaskRecord,
    branches: readonly TaskBranchRecord[],
  ): Promise<void> {
    // Only a card actively being worked is worth searching for; the search API
    // is rate-limited far more tightly than the rest of GitHub.
    if (task.trackId === 'done' || !task.branchName) {
      return;
    }

    try {
      const known = new Set(branches.map((branch) => `${branch.repoId}#${branch.branchName}`));
      const reposBySlug = this.reposBySlug();
      const org = this.orgForTask(branches, reposBySlug);
      const anchor = branches[0];
      const repoPath = anchor ? this.repoPathFor(anchor.repoId) : undefined;
      if (!org || !repoPath) {
        return;
      }

      const found = await this.github.findPRsByHeadBranch(repoPath, org, task.branchName);
      for (const pr of found) {
        const repoId = reposBySlug.get(pr.repoSlug);
        if (!repoId || known.has(`${repoId}#${task.branchName}`)) {
          continue;
        }
        // No worktree: the branch is only prepared when the user opens it.
        this.board.addTaskBranch({
          taskId: task.id,
          repoId,
          branchName: task.branchName,
        });
      }

      await this.discoverReferencingBranches(task, branches, reposBySlug, org, repoPath, known);
    } catch {
      // Discovery is an enhancement. A rate limit or an unreachable search must
      // never stop the branches we already know about from syncing.
    }
  }

  /**
   * The second half of {@link discoverSiblingBranches}: finds PRs that name a
   * PR this card already carries, rather than sharing its branch name.
   *
   * Each already-known PR is searched for by itself, and adopting one updates
   * `known`/`knownPRs` in place so a reference search run later in the same
   * pass — or a second known PR pointing at the same sibling — cannot add the
   * same branch twice.
   */
  private async discoverReferencingBranches(
    task: TaskRecord,
    branches: readonly TaskBranchRecord[],
    reposBySlug: Map<string, string>,
    org: string,
    repoPath: string,
    known: Set<string>,
  ): Promise<void> {
    const slugByRepoId = new Map(Array.from(reposBySlug, ([slug, id]) => [id, slug]));
    const knownPRs = new Set(
      branches
        .filter((branch) => branch.prNumber !== undefined)
        .map((branch) => `${branch.repoId}#${branch.prNumber}`),
    );

    for (const branch of branches) {
      if (branch.prNumber === undefined) {
        continue;
      }
      const slug = slugByRepoId.get(branch.repoId);
      const repoName = slug?.split('/')[1];
      if (!repoName) {
        continue;
      }

      let referencing: DiscoveredPR[];
      try {
        // GitHub only auto-links (and indexes) the bare `repo#123` shorthand,
        // not the owner-qualified `owner/repo#123` form — a reference written
        // the second way sits in the body as inert text and a search for it
        // returns nothing, even scoped correctly with `org:`.
        referencing = await this.github.findPRsReferencing(
          repoPath,
          org,
          `${repoName}#${branch.prNumber}`,
        );
      } catch {
        // One reference search failing must not stop the others.
        continue;
      }

      for (const pr of referencing) {
        const repoId = reposBySlug.get(pr.repoSlug);
        if (!repoId || knownPRs.has(`${repoId}#${pr.number}`)) {
          continue;
        }

        const branchName = await this.github.getPRHeadBranch(repoPath, pr.number, pr.repoSlug);
        if (!branchName || known.has(`${repoId}#${branchName}`)) {
          continue;
        }

        this.board.addTaskBranch({ taskId: task.id, repoId, branchName });
        known.add(`${repoId}#${branchName}`);
        knownPRs.add(`${repoId}#${pr.number}`);
      }
    }
  }

  private reposBySlug(): Map<string, string> {
    const rows = this.db
      .prepare<[], { id: string; github_owner: string | null; github_repo: string | null }>(
        'SELECT id, github_owner, github_repo FROM repos',
      )
      .all();

    const bySlug = new Map<string, string>();
    for (const row of rows) {
      if (row.github_owner && row.github_repo) {
        bySlug.set(`${row.github_owner}/${row.github_repo}`, row.id);
      }
    }
    return bySlug;
  }

  private orgForTask(
    branches: readonly TaskBranchRecord[],
    reposBySlug: Map<string, string>,
  ): string | null {
    const repoIds = new Set(branches.map((branch) => branch.repoId));
    for (const [slug, id] of reposBySlug) {
      if (repoIds.has(id)) {
        return slug.split('/')[0] ?? null;
      }
    }
    return null;
  }

  private repoPathFor(repoId: string): string | undefined {
    const row = this.loadRepoRow(repoId);
    return row ? (row['path'] as string) : undefined;
  }

  /**
   * Where the card belongs, decided from every branch at once.
   *
   * Returns how many moves were made, so the caller can report the card as
   * updated.
   */
  private evaluateTrackTransition(taskId: string): number {
    const task = this.board.getTask(taskId);
    if (!task || task.archivedAt != null) {
      return 0;
    }

    const branches = task.branches;
    if (branches.length === 0 || task.trackId === 'done') {
      return 0;
    }

    // Any open pull request means the card is back in review — including one
    // that had reached shipping, since a newly opened branch makes "everything
    // has merged" false again.
    if (task.prOpenCount > 0) {
      if (task.trackId === 'pr') {
        return 0;
      }
      this.board.moveTask({ id: taskId, trackId: 'pr' });
      return 1;
    }

    if (!allBranchesResolved(branches)) {
      return 0;
    }

    const released = this.isFullyReleased?.(taskId) ?? true;
    const nextTrack = released ? 'done' : 'shipping';
    if (task.trackId === nextTrack) {
      return 0;
    }

    this.board.moveTask({ id: taskId, trackId: nextTrack });

    // Cleanup is deliberately tied to reaching done, not to a merge. A card in
    // shipping is still waiting on a rollout and its worktrees have to survive
    // in case the change has to be revisited.
    if (nextTrack === 'done') {
      void this.onTaskMergedOrClosed?.(taskId);
    }

    return 1;
  }

  /** Reconciles one branch: its git state, its pull request, its checks. */
  private async reconcileBranch(
    task: TaskRecord,
    branch: TaskBranchRecord,
    opts: ReconcileOptions,
  ): Promise<TaskReconcileResult> {
    const result: TaskReconcileResult = emptySyncResult();
    const repoRow = this.loadRepoRow(branch.repoId);

    if (!repoRow) {
      this.board.updateTaskBranchSync(branch.id, {
        githubSyncStatus: 'error',
        githubSyncError: `Repo not found for branch ${branch.branchName}`,
        githubLastSyncedAt: Date.now(),
      });
      result.tasksUpdated += 1;
      result.errors.push(`Task ${task.id}: repo not found for branch ${branch.branchName}`);
      return result;
    }

    if (branch.githubSyncStatus !== 'syncing') {
      this.board.updateTaskBranchSync(branch.id, { githubSyncStatus: 'syncing' });
    }

    const repoPath = repoRow['path'] as string;
    const githubOwner = (repoRow['github_owner'] as string | null) ?? undefined;
    const githubRepo = (repoRow['github_repo'] as string | null) ?? undefined;
    let baseBranch = normalizeBaseBranch(repoRow['default_base_branch'] as string | null);

    if (!baseBranch) {
      baseBranch = normalizeBaseBranch(await this.git.defaultBranch(repoPath)) ?? 'main';
      this.db
        .prepare<[string, number, string], void>(
          'UPDATE repos SET default_base_branch = ?, updated_at = ? WHERE id = ?',
        )
        .run(baseBranch, Date.now(), branch.repoId);
    }

    // GitHub work below stays on the local checkout; only the git-state read
    // follows the task to its own host.
    const gitStatusRepoPath =
      task.location === 'remote'
        ? ((repoRow['remote_path'] as string | null) ?? repoPath)
        : repoPath;
    const gitPatch = await this.syncBranchGitStatus(task, branch, gitStatusRepoPath);

    if (!githubOwner || !githubRepo) {
      this.board.updateTaskBranchSync(branch.id, {
        ...(gitPatch ?? {}),
        githubSyncStatus: 'error',
        githubSyncError: `Repo for branch ${branch.branchName} is missing GitHub identity`,
        githubLastSyncedAt: Date.now(),
      });
      result.tasksUpdated += 1;
      result.errors.push(`Task ${task.id}: repo for ${branch.branchName} is missing GitHub identity`);
      return result;
    }

    const fullRepo = `${githubOwner}/${githubRepo}`;

    // A finished pull request cannot change, so the three GraphQL calls below
    // would return exactly what is already stored. The git state is still read:
    // it is local and the worktree can still move underneath a merged branch.
    if (isBranchSettled(branch)) {
      if (gitPatch) {
        this.board.updateTaskBranchSync(branch.id, gitPatch);
        result.tasksUpdated += 1;
      }
      return result;
    }

    try {
      const prInfo = await this.resolveBranchPR(task, branch, {
        repoPath,
        fullRepo,
        baseBranch,
        opts,
        result,
      });

      const patch: TaskBranchSyncPatch = {
        ...(gitPatch ?? {}),
        githubSyncStatus: prInfo || branch.prNumber != null ? 'ok' : 'idle',
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

        // Captured once, on the transition into merged: the merge commit is what
        // release tracking resolves against, and it never changes afterwards.
        if (prInfo.prState === 'merged' && !branch.mergeCommitSha) {
          Object.assign(patch, await this.loadMergeFacts(repoPath, prInfo.number, fullRepo));
        }
      }

      this.board.updateTaskBranchSync(branch.id, patch);
      result.tasksUpdated += 1;

      if (prInfo) {
        this.clearDelayedRetry(task.id);
      }

      result.prInfo = prInfo;
      return result;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.board.updateTaskBranchSync(branch.id, {
        ...(gitPatch ?? {}),
        githubSyncStatus: 'error',
        githubSyncError: message,
        githubLastSyncedAt: Date.now(),
      });
      result.tasksUpdated += 1;
      result.errors.push(`Task ${task.id} (${branch.branchName}): ${message}`);
      return result;
    }
  }

  /** Finds this branch's pull request, opening one when the branch is pushed. */
  private async resolveBranchPR(
    task: TaskRecord,
    branch: TaskBranchRecord,
    ctx: {
      repoPath: string;
      fullRepo: string;
      baseBranch: string;
      opts: ReconcileOptions;
      result: TaskReconcileResult;
    },
  ): Promise<PRInfo | null> {
    const existing = await this.github.findBranchPR(ctx.repoPath, branch.branchName, ctx.fullRepo);

    if (existing) {
      const prInfo = await this.github.getPR(ctx.repoPath, branch.branchName, ctx.fullRepo);
      if (!prInfo) {
        throw new GitHubServiceError(
          'not_found',
          `Pull request for branch ${branch.branchName} disappeared during sync`,
        );
      }
      return prInfo;
    }

    const remoteBranchPresent = await this.waitForRemoteBranch(
      ctx.repoPath,
      branch.branchName,
      ctx.opts.waitForRemoteBranch === true,
    );

    if (remoteBranchPresent) {
      return this.github.createPR(ctx.repoPath, {
        githubRepo: ctx.fullRepo,
        branch: branch.branchName,
        baseBranch: ctx.baseBranch,
        title: buildAutoPRTitle(task.id, task.title),
        body: buildAutoPRBody(task.id),
      });
    }

    const cause = ctx.opts.cause;
    if (cause === 'push' || cause === 'ensure_pr' || cause === 'manual') {
      ctx.result.requestDelayedRetry = true;
    }
    return null;
  }

  /**
   * The merge commit and time, for release tracking to resolve against.
   *
   * Best-effort: without them a merged branch is simply not yet resolvable,
   * which is a far better outcome than failing the whole sync.
   */
  private async loadMergeFacts(
    repoPath: string,
    prNumber: number,
    fullRepo: string,
  ): Promise<TaskBranchSyncPatch> {
    try {
      const info = await this.github.getMergeInfo(repoPath, prNumber, fullRepo);
      if (!info?.mergeCommitSha) {
        return {};
      }
      return {
        mergeCommitSha: info.mergeCommitSha,
        ...(info.mergedAt ? { mergedAt: Date.parse(info.mergedAt) } : {}),
      };
    } catch {
      return {};
    }
  }

  private async syncBranchGitStatus(
    task: TaskRecord,
    branch: TaskBranchRecord,
    repoPath: string,
  ): Promise<TaskBranchSyncPatch | null> {
    try {
      const gitStatus = await this.gitFor(task).getWorkspaceStatus(branch.worktreePath ?? repoPath);
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
}
