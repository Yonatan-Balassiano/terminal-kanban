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
  reviewState: ReviewState;
  reviewSummary?: string;
  unresolvedThreadCount: number;
}

// --------------- Internal shape of gh pr view JSON output ---

interface GhReview {
  state: string;
  author?: { login: string };
}

interface GhStatusCheck {
  conclusion?: string | null;
  status?: string | null;
  state?: string | null;
  name?: string | null;
  context?: string | null;
}

interface GhPRJson {
  number: number;
  title: string;
  url: string;
  state: string;
  headRefName: string;
  isDraft: boolean;
  reviews: GhReview[];
  statusCheckRollup: GhStatusCheck[];
}

function normalizeCheckField(value: string | null | undefined): string {
  return value?.toUpperCase() ?? '';
}

export function deriveCIState(checks: GhStatusCheck[]): CIState {
  if (checks.length === 0) {
    return 'none';
  }

  const normalized = checks.map((check) => ({
    conclusion: normalizeCheckField(check.conclusion),
    status: normalizeCheckField(check.status),
    state: normalizeCheckField(check.state),
  }));

  const hasFailure = normalized.some(
    ({ conclusion, status, state }) =>
      ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE', 'ACTION_REQUIRED']
        .includes(conclusion) ||
      ['FAILURE', 'ERROR'].includes(status) ||
      ['FAILURE', 'ERROR'].includes(state),
  );
  if (hasFailure) {
    return 'failed';
  }

  const hasPending = normalized.some(
    ({ conclusion, status, state }) =>
      ['PENDING', 'IN_PROGRESS', 'QUEUED', 'WAITING', 'EXPECTED', 'REQUESTED']
        .includes(conclusion) ||
      ['PENDING', 'IN_PROGRESS', 'QUEUED', 'WAITING', 'EXPECTED', 'REQUESTED']
        .includes(status) ||
      ['PENDING', 'IN_PROGRESS', 'QUEUED', 'WAITING', 'EXPECTED', 'REQUESTED']
        .includes(state),
  );
  if (hasPending) {
    return 'pending';
  }

  const allSuccessful = normalized.every(
    ({ conclusion, status, state }) =>
      ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(conclusion) ||
      ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(state) ||
      (conclusion === '' && state === '' && ['COMPLETED', 'SUCCESS'].includes(status)),
  );
  if (allSuccessful) {
    return 'passed';
  }

  return 'none';
}

function checkLabel(check: GhStatusCheck): string {
  return check.name ?? check.context ?? 'check';
}

function summarizeChecks(checks: GhStatusCheck[]): {
  ciSummary?: string;
  failingCheckName?: string;
} {
  if (checks.length === 0) {
    return {};
  }

  const failed = checks.find((check) => {
    const conclusion = normalizeCheckField(check.conclusion);
    const status = normalizeCheckField(check.status);
    const state = normalizeCheckField(check.state);
    return (
      ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE', 'ACTION_REQUIRED']
        .includes(conclusion) ||
      ['FAILURE', 'ERROR'].includes(status) ||
      ['FAILURE', 'ERROR'].includes(state)
    );
  });

  if (failed) {
    const failingCheckName = checkLabel(failed);
    return {
      ciSummary: `${failingCheckName} fail`,
      failingCheckName,
    };
  }

  const pendingCount = checks.filter((check) => {
    const conclusion = normalizeCheckField(check.conclusion);
    const status = normalizeCheckField(check.status);
    const state = normalizeCheckField(check.state);
    return (
      ['PENDING', 'IN_PROGRESS', 'QUEUED', 'WAITING', 'EXPECTED', 'REQUESTED']
        .includes(conclusion) ||
      ['PENDING', 'IN_PROGRESS', 'QUEUED', 'WAITING', 'EXPECTED', 'REQUESTED']
        .includes(status) ||
      ['PENDING', 'IN_PROGRESS', 'QUEUED', 'WAITING', 'EXPECTED', 'REQUESTED']
        .includes(state)
    );
  }).length;

  if (pendingCount > 0) {
    return {
      ciSummary: `checks ${checks.length - pendingCount}/${checks.length}`,
    };
  }

  return {
    ciSummary: `checks ${checks.length}/${checks.length}`,
  };
}

// --------------- GitHubService ------------------------------

export class GitHubService {
  constructor() {}

  // --------------- Private helper --------------------------

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
    throw new Error(`gh command failed: gh ${args.join(' ')}\n${message}`);
  }

  private ghAsync(args: string[], cwd?: string): Promise<string> {
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
            const message = (stderr || stdout || error.message).trim();
            reject(new Error(`gh command failed: gh ${args.join(' ')}\n${message}`));
            return;
          }

          resolve(stdout.trim());
        },
      );
    });
  }

  // --------------- Public API ------------------------------

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

  async getPR(repoPath: string, branch: string, githubRepo?: string): Promise<PRInfo | null> {
    const fields = 'number,state,title,headRefName,isDraft,url,reviews,statusCheckRollup';
    try {
      const raw = await this.ghAsync(
        ['pr', 'view', branch, '--json', fields, ...(githubRepo ? ['--repo', githubRepo] : [])],
        repoPath,
      );
      const data = JSON.parse(raw) as GhPRJson;

      // Derive prState
      let prState: PRState;
      if (data.isDraft) {
        prState = 'draft';
      } else {
        switch (data.state) {
          case 'OPEN':
            prState = 'open';
            break;
          case 'MERGED':
            prState = 'merged';
            break;
          case 'CLOSED':
            prState = 'closed';
            break;
          default:
            prState = 'none';
        }
      }

      // Derive ciState from statusCheckRollup
      const checks = data.statusCheckRollup ?? [];
      const ciState = deriveCIState(checks);
      const { ciSummary, failingCheckName } = summarizeChecks(checks);

      // Derive reviewState from reviews (latest per reviewer)
      let reviewState: ReviewState = 'none';
      let reviewSummary: string | undefined;
      const reviews = data.reviews ?? [];
      if (reviews.length > 0) {
        // Build latest state per reviewer
        const latestByReviewer = new Map<string, string>();
        for (const review of reviews) {
          const login = review.author?.login ?? 'unknown';
          latestByReviewer.set(login, review.state);
        }
        const states = Array.from(latestByReviewer.values());
        if (states.some((s) => s === 'CHANGES_REQUESTED')) {
          reviewState = 'changes_requested';
          reviewSummary = 'changes requested';
        } else if (states.every((s) => s === 'APPROVED')) {
          reviewState = 'approved';
          reviewSummary = `approved by ${states.length}`;
        } else if (states.some((s) => s === 'COMMENTED')) {
          reviewState = 'commented';
          reviewSummary = 'comments only';
        }
      }

      return {
        number: data.number,
        title: data.title,
        url: data.url,
        prState,
        ciState,
        ciSummary,
        failingCheckName,
        reviewState,
        reviewSummary,
        unresolvedThreadCount: 0,
      };
    } catch {
      return null;
    }
  }

  createPR(
    repoPath: string,
    params: {
      githubRepo: string;
      branch: string;
      baseBranch: string;
      title: string;
      body: string;
    },
  ): Promise<PRInfo> {
    return this.createPRAsync(repoPath, params);
  }

  private async createPRAsync(
    repoPath: string,
    params: {
      githubRepo: string;
      branch: string;
      baseBranch: string;
      title: string;
      body: string;
    },
  ): Promise<PRInfo> {
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

    const prInfo = await this.getPR(repoPath, params.branch, params.githubRepo);
    if (!prInfo) {
      throw new Error(`PR created for branch ${params.branch}, but could not read it back`);
    }

    return prInfo;
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

  getDiff(repoPath: string, prNumber: number, githubRepo: string): string {
    // Get raw diff via gh
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

    // Try to pipe through delta if available
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

    if (deltaResult.status === 0) {
      return deltaResult.stdout ?? rawDiff;
    }

    return rawDiff;
  }
}
