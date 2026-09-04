import { execFile, execSync, spawnSync, type ExecFileException } from 'child_process';
import type { PRState, CIState, ReviewState } from '../types/index.js';

export interface PRInfo {
  number: number;
  title: string;
  url: string;
  prState: PRState;
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
}

export interface RequiredCheckSummary {
  ciState: CIState;
  ciSummary?: string;
  failingCheckName?: string;
  ciRequiredTotal: number;
  ciRequiredPassed: number;
  ciRequiredFailed: number;
  ciRequiredPending: number;
}

/**
 * The immutable half of a pull request.
 *
 * Deliberately separate from {@link PRInfo}: once a PR is merged these fields
 * never change, so they are fetched once and cached forever, while PRInfo's
 * CI and review fields churn on every sync. Folding `files` into the snapshot
 * would refetch the whole changed-file list every fifteen seconds.
 */
export interface PRMergeInfo {
  number: number;
  merged: boolean;
  mergeCommitSha?: string;
  /**
   * Verbatim from `gh`, e.g. `2026-07-29T10:02:52Z`. Never reformat it — the
   * devex release query filters on this string, and round-tripping through
   * `Date#toISOString` injects a `.000` that changes the filter.
   */
  mergedAt?: string;
  files: string[];
}

/** How two commits relate. `null` means the comparison could not be made. */
export interface CommitComparison {
  status: 'ahead' | 'behind' | 'identical' | 'diverged';
  aheadBy: number;
}

/** One pull request discovered by a cross-repo branch search. */
export interface DiscoveredPR {
  number: number;
  repoSlug: string;
  prState: PRState;
  url: string;
  mergedAt?: string;
}

export type GitHubServiceErrorKind =
  | 'not_found'
  | 'auth'
  | 'repo_config'
  | 'rate_limit'
  | 'closed_unmerged_pr_exists'
  | 'transport';

export class GitHubServiceError extends Error {
  constructor(
    readonly kind: GitHubServiceErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'GitHubServiceError';
  }
}

interface GhReview {
  state: string;
  author?: { login: string };
}

interface GhBranchPRJson {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  reviewDecision?: string | null;
  headRefName: string;
  updatedAt?: string | null;
}

interface GhPRViewJson {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  reviewDecision?: string | null;
  reviews?: GhReview[];
}

interface GhPRCheck {
  bucket?: string | null;
  name?: string | null;
  state?: string | null;
  workflow?: string | null;
}

interface GhPRMergeJson {
  number: number;
  state: string;
  mergedAt?: string | null;
  mergeCommit?: { oid?: string | null } | null;
  files?: Array<{ path?: string | null }> | null;
}

interface GhCompareJson {
  status?: string | null;
  ahead_by?: number | null;
}

interface GhSearchIssuesJson {
  items?: Array<{
    number?: number | null;
    html_url?: string | null;
    state?: string | null;
    draft?: boolean | null;
    repository_url?: string | null;
    pull_request?: { merged_at?: string | null } | null;
  }> | null;
}

/** `https://api.github.com/repos/wix-private/web5` -> `wix-private/web5`. */
function slugFromRepositoryUrl(url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }

  const parts = url.split('/').filter((part) => part.length > 0);
  if (parts.length < 2) {
    return null;
  }

  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

function normalizeCheckField(value: string | null | undefined): string {
  return value?.toUpperCase() ?? '';
}

function normalizePRState(state: string | null | undefined, isDraft: boolean): PRState {
  if (isDraft) {
    return 'draft';
  }

  switch (normalizeCheckField(state)) {
    case 'OPEN':
      return 'open';
    case 'MERGED':
      return 'merged';
    case 'CLOSED':
      return 'closed';
    default:
      return 'none';
  }
}

function classifyGhError(message: string): GitHubServiceErrorKind {
  const normalized = message.toLowerCase();

  if (
    normalized.includes('authentication') ||
    normalized.includes('not logged into any hosts') ||
    normalized.includes('gh auth login') ||
    normalized.includes('requires authentication')
  ) {
    return 'auth';
  }

  if (
    normalized.includes('could not resolve to a repository') ||
    normalized.includes('repository not found') ||
    normalized.includes('no git remotes found') ||
    normalized.includes('missing github identity')
  ) {
    return 'repo_config';
  }

  if (normalized.includes('rate limit')) {
    return 'rate_limit';
  }

  if (
    normalized.includes('pull request not found') ||
    normalized.includes('could not find pull request') ||
    normalized.includes('no pull requests found')
  ) {
    return 'not_found';
  }

  return 'transport';
}

function createGitHubServiceError(message: string): GitHubServiceError {
  return new GitHubServiceError(classifyGhError(message), message);
}

function checkLabel(check: GhPRCheck): string {
  return check.name ?? check.workflow ?? 'check';
}

export function deriveReviewState(reviews: GhReview[]): {
  reviewState: ReviewState;
  reviewSummary?: string;
} {
  if (reviews.length === 0) {
    return { reviewState: 'none' };
  }

  const latestByReviewer = new Map<string, string>();
  for (const review of reviews) {
    const login = review.author?.login ?? 'unknown';
    latestByReviewer.set(login, review.state);
  }

  const states = Array.from(latestByReviewer.values());
  if (states.some((state) => state === 'CHANGES_REQUESTED')) {
    return {
      reviewState: 'changes_requested',
      reviewSummary: 'changes requested',
    };
  }

  const approvedCount = states.filter((state) => state === 'APPROVED').length;
  if (approvedCount > 0) {
    return {
      reviewState: 'approved',
      reviewSummary: `approved by ${approvedCount}`,
    };
  }

  if (states.some((state) => state === 'COMMENTED')) {
    return {
      reviewState: 'commented',
      reviewSummary: 'comments only',
    };
  }

  return { reviewState: 'none' };
}

function deriveReviewStateFromDecision(
  reviewDecision: string | null | undefined,
  reviews: GhReview[],
): {
  reviewState: ReviewState;
  reviewSummary?: string;
} {
  switch (normalizeCheckField(reviewDecision)) {
    case 'APPROVED':
      return deriveReviewState(reviews).reviewState === 'approved'
        ? deriveReviewState(reviews)
        : { reviewState: 'approved', reviewSummary: 'approved' };
    case 'CHANGES_REQUESTED':
      return {
        reviewState: 'changes_requested',
        reviewSummary: 'changes requested',
      };
    case 'REVIEW_REQUIRED': {
      const derived = deriveReviewState(reviews);
      if (derived.reviewState === 'commented') {
        return derived;
      }
      return { reviewState: 'none' };
    }
    default:
      return deriveReviewState(reviews);
  }
}

export function deriveCheckSummary(checks: GhPRCheck[]): RequiredCheckSummary {
  if (checks.length === 0) {
    return {
      ciState: 'none',
      ciRequiredTotal: 0,
      ciRequiredPassed: 0,
      ciRequiredFailed: 0,
      ciRequiredPending: 0,
    };
  }

  let passed = 0;
  let failed = 0;
  let pending = 0;
  let failingCheckName: string | undefined;
  let total = 0;

  for (const check of checks) {
    const bucket = normalizeCheckField(check.bucket);
    const state = normalizeCheckField(check.state);

    switch (bucket) {
      case 'PASS':
        passed += 1;
        total += 1;
        break;
      case 'FAIL':
      case 'CANCEL':
        failed += 1;
        total += 1;
        failingCheckName ??= checkLabel(check);
        break;
      case 'PENDING':
        pending += 1;
        total += 1;
        break;
      case 'SKIPPING':
        break;
      default:
        if (['SUCCESS', 'COMPLETED'].includes(state)) {
          passed += 1;
          total += 1;
        } else if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED'].includes(state)) {
          failed += 1;
          total += 1;
          failingCheckName ??= checkLabel(check);
        } else if (state === 'SKIPPED') {
          break;
        } else {
          pending += 1;
          total += 1;
        }
        break;
    }
  }

  const ciState: CIState =
    failed > 0 ? 'failed' : pending > 0 ? 'pending' : total > 0 ? 'passed' : 'none';

  let ciSummary: string | undefined;
  if (total > 0) {
    if (failed > 0 && failingCheckName) {
      ciSummary = `${failingCheckName} fail`;
    } else {
      ciSummary = `checks ${passed}/${total}`;
    }
  }

  return {
    ciState,
    ciSummary,
    failingCheckName,
    ciRequiredTotal: total,
    ciRequiredPassed: passed,
    ciRequiredFailed: failed,
    ciRequiredPending: pending,
  };
}

function branchPRPriority(pr: GhBranchPRJson): number {
  const prState = normalizePRState(pr.state, pr.isDraft);
  switch (prState) {
    case 'draft':
    case 'open':
      return 3;
    case 'merged':
      return 2;
    case 'closed':
      return 1;
    default:
      return 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class GitHubService {
  private gh(args: string[], cwd?: string): string {
    const result = spawnSync('gh', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GH_PAGER: 'cat' },
    });

    if (result.status === 0) {
      return (result.stdout ?? '').trim();
    }

    const stderr = (result.stderr ?? '').trim();
    const stdout = (result.stdout ?? '').trim();
    const message = stderr || stdout || 'unknown gh error';
    throw createGitHubServiceError(`gh command failed: gh ${args.join(' ')}\n${message}`);
  }

  private ghAsync(args: string[], cwd?: string, allowedExitCodes: number[] = []): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        'gh',
        args,
        {
          cwd,
          encoding: 'utf8',
          env: { ...process.env, GH_PAGER: 'cat' },
          maxBuffer: 10 * 1024 * 1024,
        },
        (
          error: ExecFileException | null,
          stdout: string,
          stderr: string,
        ) => {
          if (error) {
            const code = typeof error.code === 'number' ? error.code : null;
            if (code !== null && allowedExitCodes.includes(code)) {
              resolve(stdout.trim());
              return;
            }

            const message = (stderr || stdout || error.message).trim();
            reject(createGitHubServiceError(`gh command failed: gh ${args.join(' ')}\n${message}`));
            return;
          }

          resolve(stdout.trim());
        },
      );
    });
  }

  private async loadPRInfo(repoPath: string, prNumber: number, githubRepo: string): Promise<PRInfo> {
    const snapshot = await this.getPRSnapshot(repoPath, prNumber, githubRepo);
    const checks = await this.getChecks(repoPath, prNumber, githubRepo);

    return {
      ...snapshot,
      ...checks,
    };
  }

  isAvailable(): boolean {
    try {
      execSync('gh --version', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    } catch {
      return false;
    }
  }

  isAuthenticated(): boolean {
    try {
      execSync('gh auth status', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    } catch {
      return false;
    }
  }

  async findBranchPR(
    repoPath: string,
    branch: string,
    githubRepo: string,
  ): Promise<{ number: number; prState: PRState; title: string; url: string } | null> {
    const fields = 'number,state,title,isDraft,url,reviewDecision,headRefName,updatedAt';
    const raw = await this.ghAsync(
      ['pr', 'list', '--repo', githubRepo, '--head', branch, '--state', 'all', '--json', fields],
      repoPath,
    );

    const data = raw.length > 0 ? (JSON.parse(raw) as GhBranchPRJson[]) : [];
    const matches = data
      .filter((candidate) => candidate.headRefName === branch)
      .sort((left, right) => {
        const priorityDelta = branchPRPriority(right) - branchPRPriority(left);
        if (priorityDelta !== 0) {
          return priorityDelta;
        }

        return Date.parse(right.updatedAt ?? '') - Date.parse(left.updatedAt ?? '');
      });

    if (matches.length === 0) {
      return null;
    }

    const match = matches[0];
    return {
      number: match.number,
      prState: normalizePRState(match.state, match.isDraft),
      title: match.title,
      url: match.url,
    };
  }

  async getPRSnapshot(repoPath: string, prNumber: number, githubRepo: string): Promise<PRInfo> {
    const fields = 'number,state,title,isDraft,url,reviewDecision,reviews';
    const raw = await this.ghAsync(
      ['pr', 'view', String(prNumber), '--repo', githubRepo, '--json', fields],
      repoPath,
    );
    const data = JSON.parse(raw) as GhPRViewJson;
    const { reviewState, reviewSummary } = deriveReviewStateFromDecision(
      data.reviewDecision,
      data.reviews ?? [],
    );

    return {
      number: data.number,
      title: data.title,
      url: data.url,
      prState: normalizePRState(data.state, data.isDraft),
      ciState: 'none',
      ciSummary: undefined,
      failingCheckName: undefined,
      ciRequiredTotal: 0,
      ciRequiredPassed: 0,
      ciRequiredFailed: 0,
      ciRequiredPending: 0,
      reviewState,
      reviewSummary,
      unresolvedThreadCount: 0,
    };
  }

  /**
   * The merge commit, merge time and changed paths of a pull request.
   *
   * Everything here is immutable once the PR is merged, so callers cache the
   * result indefinitely rather than refetching it on the sync loop.
   */
  async getMergeInfo(
    repoPath: string,
    prNumber: number,
    githubRepo: string,
  ): Promise<PRMergeInfo | null> {
    const fields = 'number,state,mergedAt,mergeCommit,files';
    let raw: string;
    try {
      raw = await this.ghAsync(
        ['pr', 'view', String(prNumber), '--repo', githubRepo, '--json', fields],
        repoPath,
      );
    } catch (error: unknown) {
      if (error instanceof GitHubServiceError && error.kind === 'not_found') {
        return null;
      }
      throw error;
    }

    const data = JSON.parse(raw) as GhPRMergeJson;
    const mergeCommitSha = data.mergeCommit?.oid ?? undefined;
    const mergedAt = data.mergedAt ?? undefined;

    return {
      number: data.number,
      merged: normalizeCheckField(data.state) === 'MERGED',
      ...(mergeCommitSha ? { mergeCommitSha } : {}),
      ...(mergedAt ? { mergedAt } : {}),
      files: (data.files ?? [])
        .map((file) => file.path ?? '')
        .filter((path) => path.length > 0),
    };
  }

  /**
   * How `head` relates to `base`.
   *
   * `ahead` or `identical` means head contains base — which is how a release
   * candidate is proven to carry a given merge commit. Returns null when the
   * comparison cannot be made (either commit unknown to this repo).
   */
  async compareCommits(
    repoPath: string,
    githubRepo: string,
    base: string,
    head: string,
  ): Promise<CommitComparison | null> {
    let raw: string;
    try {
      raw = await this.ghAsync(
        [
          'api',
          `repos/${githubRepo}/compare/${base}...${head}`,
          // The compare payload embeds up to 250 commits; only the verdict is
          // needed, and asking for it keeps the response tiny.
          '--jq',
          '{status: .status, ahead_by: .ahead_by}',
        ],
        repoPath,
      );
    } catch (error: unknown) {
      if (error instanceof GitHubServiceError && error.kind === 'not_found') {
        return null;
      }
      throw error;
    }

    if (raw.length === 0) {
      return null;
    }

    const data = JSON.parse(raw) as GhCompareJson;
    const status = data.status ?? '';
    if (
      status !== 'ahead' &&
      status !== 'behind' &&
      status !== 'identical' &&
      status !== 'diverged'
    ) {
      return null;
    }

    return { status, aheadBy: data.ahead_by ?? 0 };
  }

  /**
   * Every pull request in an org whose head branch has this name.
   *
   * One call regardless of how many repositories the org holds, which is what
   * makes discovering a feature's sibling PRs affordable on the sync loop.
   * Note `org:` and `repo:` do not compose in GitHub's search syntax — this
   * deliberately passes only `org:`.
   */
  async findPRsByHeadBranch(
    repoPath: string,
    org: string,
    branch: string,
  ): Promise<DiscoveredPR[]> {
    return this.searchPRIssues(repoPath, `type:pr org:${org} head:${branch}`);
  }

  /**
   * Every pull request in an org whose body or title names another one.
   *
   * A card's repositories do not always share a branch name — an agent
   * working a change that spans repos often names each branch after what it
   * does locally, not after the card. What they do share is GitHub's own
   * `repo#123` cross-reference shorthand, which stacked or dependent PRs use
   * to point back at the PR that started the work. Searching for that exact
   * token is precise where searching for the bare PR number is not: a bare
   * number matches any coincidental digit run (a version, a changelog line),
   * while the shorthand only matches an actual reference.
   *
   * `reference` must be the bare `repo#123` form, not `owner/repo#123` — the
   * owner-qualified form sits in a PR body as inert text; GitHub does not
   * auto-link or index it, so a search for it returns nothing even scoped
   * correctly with `org:`.
   *
   * Quoted, not bare: GitHub's search tokenizes an unquoted term on its own
   * punctuation, so `repo.name#123` unquoted searches for `repo`, `name` and
   * `123` independently, ORed together loosely enough to match almost any PR
   * that mentions the repo by name anywhere and any number anywhere else —
   * confirmed live, one task's card ended up with dozens of unrelated merged
   * PRs from across the org. Quoting forces an exact-phrase match instead.
   */
  async findPRsReferencing(repoPath: string, org: string, reference: string): Promise<DiscoveredPR[]> {
    return this.searchPRIssues(repoPath, `type:pr org:${org} "${reference}"`);
  }

  /**
   * The branch a pull request was opened from.
   *
   * Search results carry no head-branch field at all, so a PR found by
   * `findPRsReferencing` needs this follow-up call before it can be recorded
   * as a task branch.
   */
  async getPRHeadBranch(repoPath: string, prNumber: number, githubRepo: string): Promise<string | null> {
    const raw = await this.ghAsync(
      ['pr', 'view', String(prNumber), '--repo', githubRepo, '--json', 'headRefName'],
      repoPath,
    );
    if (raw.length === 0) {
      return null;
    }
    const data = JSON.parse(raw) as { headRefName?: string };
    return data.headRefName ?? null;
  }

  private async searchPRIssues(repoPath: string, query: string): Promise<DiscoveredPR[]> {
    const raw = await this.ghAsync(
      ['api', '-X', 'GET', 'search/issues', '-f', `q=${query}`, '-f', 'per_page=20'],
      repoPath,
    );

    if (raw.length === 0) {
      return [];
    }

    const data = JSON.parse(raw) as GhSearchIssuesJson;
    const found: DiscoveredPR[] = [];

    for (const item of data.items ?? []) {
      const repoSlug = slugFromRepositoryUrl(item.repository_url);
      if (repoSlug === null || typeof item.number !== 'number') {
        continue;
      }

      const mergedAt = item.pull_request?.merged_at ?? undefined;
      // Search reports merged PRs as `closed`; only merged_at separates them.
      const state = mergedAt ? 'MERGED' : (item.state ?? '');

      found.push({
        number: item.number,
        repoSlug,
        prState: normalizePRState(state, item.draft ?? false),
        url: item.html_url ?? '',
        ...(mergedAt ? { mergedAt } : {}),
      });
    }

    return found;
  }

  async getChecks(
    repoPath: string,
    prNumber: number,
    githubRepo: string,
  ): Promise<RequiredCheckSummary> {
    try {
      const raw = await this.ghAsync(
        ['pr', 'checks', String(prNumber), '--repo', githubRepo, '--json', 'bucket,name,state,workflow'],
        repoPath,
        [8],
      );

      if (raw.length === 0) {
        return {
          ciState: 'none',
          ciRequiredTotal: 0,
          ciRequiredPassed: 0,
          ciRequiredFailed: 0,
          ciRequiredPending: 0,
        };
      }

      return deriveCheckSummary(JSON.parse(raw) as GhPRCheck[]);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes('no checks')) {
        return {
          ciState: 'none',
          ciRequiredTotal: 0,
          ciRequiredPassed: 0,
          ciRequiredFailed: 0,
          ciRequiredPending: 0,
        };
      }

      throw error;
    }
  }

  async getPR(repoPath: string, branch: string, githubRepo?: string): Promise<PRInfo | null> {
    if (!githubRepo) {
      throw new GitHubServiceError('repo_config', `Repo at ${repoPath} is missing GitHub identity`);
    }

    const match = await this.findBranchPR(repoPath, branch, githubRepo);
    if (!match) {
      return null;
    }

    return this.loadPRInfo(repoPath, match.number, githubRepo);
  }

  async createPR(
    repoPath: string,
    params: {
      githubRepo: string;
      branch: string;
      baseBranch: string;
      title: string;
      body: string;
    },
  ): Promise<PRInfo> {
    try {
      await this.ghAsync(
        [
          'pr',
          'create',
          '--repo',
          params.githubRepo,
          '--head',
          params.branch,
          '--base',
          params.baseBranch,
          '--title',
          params.title,
          '--body',
          params.body,
        ],
        repoPath,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes('already exists')) {
        throw error;
      }
    }

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const match = await this.findBranchPR(repoPath, params.branch, params.githubRepo);
      if (match) {
        return this.loadPRInfo(repoPath, match.number, params.githubRepo);
      }

      if (attempt < 5) {
        await sleep(500);
      }
    }

    throw new GitHubServiceError(
      'transport',
      `PR created for branch ${params.branch}, but could not read it back`,
    );
  }

  async mergePR(
    repoPath: string,
    params: {
      githubRepo: string;
      prNumber: number;
    },
  ): Promise<void> {
    await this.ghAsync(
      [
        'pr',
        'merge',
        String(params.prNumber),
        '--repo',
        params.githubRepo,
        '-s',
      ],
      repoPath,
    );
  }

  async commentPR(
    repoPath: string,
    params: {
      githubRepo: string;
      prNumber: number;
      body: string;
    },
  ): Promise<void> {
    await this.ghAsync(
      [
        'pr',
        'comment',
        String(params.prNumber),
        '--repo',
        params.githubRepo,
        '--body',
        params.body,
      ],
      repoPath,
    );
  }

  getDiff(repoPath: string, prNumber: number, githubRepo: string): string {
    let rawDiff: string;
    try {
      const result = spawnSync('gh', ['pr', 'diff', String(prNumber), '--repo', githubRepo], {
        cwd: repoPath,
        encoding: 'utf8',
        env: { ...process.env, GH_PAGER: 'cat' },
      });
      if (result.status !== 0) {
        throw new Error(result.stderr ?? 'gh pr diff failed');
      }
      rawDiff = result.stdout ?? '';
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to get PR diff: ${msg}`);
    }

    const deltaAvailable = (() => {
      try {
        execSync('delta --version', {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return true;
      } catch {
        return false;
      }
    })();

    if (!deltaAvailable) {
      return rawDiff;
    }

    const deltaResult = spawnSync('delta', ['--no-pager'], {
      input: rawDiff,
      encoding: 'utf8',
    });

    if (deltaResult.status !== 0) {
      return rawDiff;
    }

    return deltaResult.stdout ?? rawDiff;
  }
}
