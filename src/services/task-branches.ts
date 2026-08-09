import type {
  CIState,
  GitHubSyncStatus,
  GitState,
  PRState,
  ReviewState,
  TaskBranchRecord,
} from '../types/index.js';

/**
 * How a card's branches collapse into the single state the board shows.
 *
 * The rule throughout is that bad news wins by ANY and good news requires ALL.
 * A card whose three pull requests are green, green and failing is a failing
 * card; one that is merged, merged and open is still open. Getting that
 * backwards would paint a card as finished while part of it is still broken.
 */

export interface TaskRollup {
  prState: PRState;
  prDraft: boolean;
  ciState: CIState;
  ciSummary?: string;
  failingCheckName?: string;
  ciRequiredTotal: number;
  ciRequiredPassed: number;
  ciRequiredFailed: number;
  ciRequiredPending: number;
  reviewState: ReviewState;
  reviewSummary?: string;
  unresolvedThreadCount: number;
  gitState: GitState;
  gitAheadCount: number;
  gitBehindCount: number;
  hasUntracked: boolean;
  hasConflicts: boolean;
  githubSyncStatus: GitHubSyncStatus;
  githubSyncError?: string;
  githubLastSyncedAt?: number;
  /**
   * Only set when the card has exactly one branch.
   *
   * There is no honest "the card's pull request" once there are several, and
   * inventing one would let a merge button act on whichever branch the rollup
   * happened to pick. Leaving it undefined makes those callers fail loudly.
   */
  prNumber?: number;
  prUrl?: string;
  prCount: number;
  prOpenCount: number;
  prMergedCount: number;
}

function rollupPRState(branches: readonly TaskBranchRecord[]): PRState {
  const withPR = branches.filter((branch) => branch.prState !== 'none');
  if (withPR.length === 0) {
    return 'none';
  }
  if (withPR.some((branch) => branch.prState === 'open')) {
    return 'open';
  }
  if (withPR.some((branch) => branch.prState === 'draft')) {
    return 'draft';
  }
  if (withPR.every((branch) => branch.prState === 'merged')) {
    return 'merged';
  }
  // Everything has finished, but at least one closed without merging — that is
  // unfinished business and must not read as merged.
  return 'closed';
}

function rollupCIState(branches: readonly TaskBranchRecord[]): CIState {
  if (branches.some((branch) => branch.ciState === 'failed')) {
    return 'failed';
  }
  if (branches.some((branch) => branch.ciState === 'pending')) {
    return 'pending';
  }
  if (branches.some((branch) => branch.ciState === 'passed')) {
    return 'passed';
  }
  return 'none';
}

function rollupReviewState(branches: readonly TaskBranchRecord[]): ReviewState {
  if (branches.some((branch) => branch.reviewState === 'changes_requested')) {
    return 'changes_requested';
  }

  const open = branches.filter(
    (branch) => branch.prState === 'open' || branch.prState === 'draft',
  );
  if (open.length > 0 && open.every((branch) => branch.reviewState === 'approved')) {
    return 'approved';
  }
  if (branches.some((branch) => branch.reviewState === 'commented')) {
    return 'commented';
  }
  // An approval that covers only some of the open work is not an approval.
  return open.length > 0 ? 'none' : rollupClosedReviewState(branches);
}

function rollupClosedReviewState(branches: readonly TaskBranchRecord[]): ReviewState {
  return branches.some((branch) => branch.reviewState === 'approved') ? 'approved' : 'none';
}

const GIT_STATE_SEVERITY: Record<GitState, number> = {
  unknown: 0,
  clean: 1,
  detached: 2,
  untracked: 3,
  dirty: 4,
  conflicted: 5,
};

function rollupGitState(branches: readonly TaskBranchRecord[]): GitState {
  return branches.reduce<GitState>(
    (worst, branch) =>
      GIT_STATE_SEVERITY[branch.gitState] > GIT_STATE_SEVERITY[worst] ? branch.gitState : worst,
    'unknown',
  );
}

function rollupSyncStatus(branches: readonly TaskBranchRecord[]): {
  githubSyncStatus: GitHubSyncStatus;
  githubSyncError?: string;
} {
  const failed = branches.find((branch) => branch.githubSyncStatus === 'error');
  if (failed) {
    return {
      githubSyncStatus: 'error',
      // Named, because on a multi-repo card "sync failed" alone leaves the user
      // with no idea which repository to look at.
      ...(failed.githubSyncError
        ? { githubSyncError: `${failed.branchName}: ${failed.githubSyncError}` }
        : {}),
    };
  }
  if (branches.some((branch) => branch.githubSyncStatus === 'syncing')) {
    return { githubSyncStatus: 'syncing' };
  }
  if (branches.some((branch) => branch.githubSyncStatus === 'ok')) {
    return { githubSyncStatus: 'ok' };
  }
  return { githubSyncStatus: 'idle' };
}

function sum(branches: readonly TaskBranchRecord[], pick: (b: TaskBranchRecord) => number): number {
  return branches.reduce((total, branch) => total + pick(branch), 0);
}

/** Collapses a card's branches into the flat state the board reads. */
export function rollupBranches(branches: readonly TaskBranchRecord[]): TaskRollup {
  const ordered = [...branches].sort((a, b) => a.sortKey - b.sortKey);
  const single = ordered.length === 1 ? ordered[0] : undefined;
  const failing = ordered.find((branch) => branch.ciState === 'failed');
  const lastSynced = ordered
    .map((branch) => branch.githubLastSyncedAt)
    .filter((value): value is number => value !== undefined);

  return {
    prState: rollupPRState(ordered),
    // A card is a draft only while nothing in it is ready.
    prDraft: ordered.length > 0 && ordered.every((branch) => branch.prDraft),
    ciState: rollupCIState(ordered),
    ...(failing?.ciSummary ? { ciSummary: `${failing.branchName}: ${failing.ciSummary}` } : {}),
    ...(failing?.failingCheckName ? { failingCheckName: failing.failingCheckName } : {}),
    ciRequiredTotal: sum(ordered, (b) => b.ciRequiredTotal),
    ciRequiredPassed: sum(ordered, (b) => b.ciRequiredPassed),
    ciRequiredFailed: sum(ordered, (b) => b.ciRequiredFailed),
    ciRequiredPending: sum(ordered, (b) => b.ciRequiredPending),
    reviewState: rollupReviewState(ordered),
    ...(single?.reviewSummary ? { reviewSummary: single.reviewSummary } : {}),
    unresolvedThreadCount: sum(ordered, (b) => b.unresolvedThreadCount),
    gitState: rollupGitState(ordered),
    gitAheadCount: sum(ordered, (b) => b.gitAheadCount),
    gitBehindCount: sum(ordered, (b) => b.gitBehindCount),
    hasUntracked: ordered.some((branch) => branch.hasUntracked),
    hasConflicts: ordered.some((branch) => branch.hasConflicts),
    ...rollupSyncStatus(ordered),
    ...(lastSynced.length > 0 ? { githubLastSyncedAt: Math.max(...lastSynced) } : {}),
    ...(single?.prNumber !== undefined ? { prNumber: single.prNumber } : {}),
    ...(single?.prUrl ? { prUrl: single.prUrl } : {}),
    prCount: ordered.filter((branch) => branch.prNumber !== undefined).length,
    prOpenCount: ordered.filter(
      (branch) => branch.prState === 'open' || branch.prState === 'draft',
    ).length,
    prMergedCount: ordered.filter((branch) => branch.prState === 'merged').length,
  };
}

/** True once every pull request on a card has finished, one way or another. */
export function allBranchesResolved(branches: readonly TaskBranchRecord[]): boolean {
  const withPR = branches.filter((branch) => branch.prState !== 'none');
  return (
    withPR.length > 0 &&
    withPR.every((branch) => branch.prState === 'merged' || branch.prState === 'closed')
  );
}

/** Maps a database row onto a branch record. */
export function rowToTaskBranch(row: Record<string, unknown>): TaskBranchRecord {
  return {
    id: row['id'] as string,
    taskId: row['task_id'] as string,
    repoId: row['repo_id'] as string,
    branchName: row['branch_name'] as string,
    baseBranch: (row['base_branch'] as string | null) ?? undefined,
    worktreePath: (row['worktree_path'] as string | null) ?? undefined,
    sortKey: (row['sort_key'] as number | null) ?? 0,
    prNumber: (row['pr_number'] as number | null) ?? undefined,
    prUrl: (row['pr_url'] as string | null) ?? undefined,
    prState: (row['pr_state'] as PRState | null) ?? 'none',
    prDraft: row['pr_draft'] === 1 || row['pr_draft'] === true,
    mergeCommitSha: (row['merge_commit_sha'] as string | null) ?? undefined,
    mergedAt: (row['merged_at'] as number | null) ?? undefined,
    ciState: (row['ci_state'] as CIState | null) ?? 'none',
    ciSummary: (row['ci_summary'] as string | null) ?? undefined,
    failingCheckName: (row['failing_check_name'] as string | null) ?? undefined,
    ciRequiredTotal: (row['ci_required_total'] as number | null) ?? 0,
    ciRequiredPassed: (row['ci_required_passed'] as number | null) ?? 0,
    ciRequiredFailed: (row['ci_required_failed'] as number | null) ?? 0,
    ciRequiredPending: (row['ci_required_pending'] as number | null) ?? 0,
    reviewState: (row['review_state'] as ReviewState | null) ?? 'none',
    reviewSummary: (row['review_summary'] as string | null) ?? undefined,
    unresolvedThreadCount: (row['unresolved_thread_count'] as number | null) ?? 0,
    gitState: (row['git_state'] as GitState | null) ?? 'unknown',
    gitAheadCount: (row['git_ahead_count'] as number | null) ?? 0,
    gitBehindCount: (row['git_behind_count'] as number | null) ?? 0,
    hasUntracked: row['has_untracked'] === 1 || row['has_untracked'] === true,
    hasConflicts: row['has_conflicts'] === 1 || row['has_conflicts'] === true,
    githubSyncStatus: (row['github_sync_status'] as GitHubSyncStatus | null) ?? 'idle',
    githubSyncError: (row['github_sync_error'] as string | null) ?? undefined,
    githubLastSyncedAt: (row['github_last_synced_at'] as number | null) ?? undefined,
    createdAt: row['created_at'] as number,
    updatedAt: row['updated_at'] as number,
  };
}
