import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Which pending release candidates were built from your own commits.
 *
 * Author identity comes from GitHub, not from git config or a local clone, for
 * two reasons found the hard way:
 *
 *  - Commits here are authored as `<id>+<login>@users.noreply.github.com`, so
 *    matching on `git config user.email` matches nothing at all — a silent,
 *    total false negative.
 *  - Local clones go stale (and one was never fetched), so a local scan would
 *    miss exactly the recent commits this feature exists to surface.
 */

const COMMITS_PER_PAGE = 100;
const GH_TIMEOUT_MS = 20_000;
/** Author sets are re-read at most this often; commits are append-only. */
const AUTHOR_CACHE_TTL_MS = 120_000;

/** Turns any GitHub remote form into `owner/repo`. */
export function repoSlug(repoUrl: string | undefined): string | null {
  if (!repoUrl) {
    return null;
  }
  const slug = repoUrl
    .replace(/^git@github\.com:/, '')
    .replace(/^https:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .trim();
  return /^[\w.-]+\/[\w.-]+$/.test(slug) ? slug : null;
}

export interface CommitOwnershipOptions {
  /** GitHub login whose commits count as yours. */
  login: string;
  /** Injectable for tests; defaults to the `gh` CLI. */
  listAuthoredShas?: (repo: string, login: string) => Promise<string[]>;
  now?: () => number;
}

async function ghListAuthoredShas(repo: string, login: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    'gh',
    [
      'api',
      `repos/${repo}/commits?author=${encodeURIComponent(login)}&per_page=${COMMITS_PER_PAGE}`,
      '--jq',
      '.[].sha',
    ],
    { encoding: 'utf8', timeout: GH_TIMEOUT_MS }
  );
  return String(stdout)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Resolves the signed-in GitHub login, or null when `gh` cannot answer. */
export async function resolveGithubLogin(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('gh', ['api', 'user', '--jq', '.login'], {
      encoding: 'utf8',
      timeout: GH_TIMEOUT_MS,
    });
    return String(stdout).trim() || null;
  } catch {
    return null;
  }
}

export class CommitOwnership {
  private readonly login: string;
  private readonly listAuthoredShas: (repo: string, login: string) => Promise<string[]>;
  private readonly now: () => number;
  private readonly cache = new Map<string, { shas: Set<string>; loadedAt: number }>();

  constructor(options: CommitOwnershipOptions) {
    this.login = options.login;
    this.listAuthoredShas = options.listAuthoredShas ?? ghListAuthoredShas;
    this.now = options.now ?? Date.now;
  }

  /**
   * Your commit shas in a repo. Cached briefly and shared across artifacts,
   * since several of them build from the same repo.
   *
   * Returns null when the lookup fails, so callers can tell "not yours" from
   * "could not tell" and avoid showing a confident zero.
   */
  private async authoredShas(repo: string): Promise<Set<string> | null> {
    const cached = this.cache.get(repo);
    if (cached && this.now() - cached.loadedAt <= AUTHOR_CACHE_TTL_MS) {
      return cached.shas;
    }

    try {
      const shas = new Set(await this.listAuthoredShas(repo, this.login));
      this.cache.set(repo, { shas, loadedAt: this.now() });
      return shas;
    } catch {
      // Keep serving a previous answer rather than claiming nothing is yours.
      return cached?.shas ?? null;
    }
  }

  /**
   * Counts how many of these releases you authored.
   *
   * Releases carry their own repo, which is not always the project's repo, so
   * each is matched against the author set for its own repo.
   */
  async countMine(
    releases: ReadonlyArray<{ commitHash?: string; repoUrl?: string }>
  ): Promise<number | null> {
    const repos = new Set(
      releases.map((release) => repoSlug(release.repoUrl)).filter((slug): slug is string => slug !== null)
    );
    if (repos.size === 0) {
      return null;
    }

    const authored = new Map<string, Set<string>>();
    for (const repo of repos) {
      const shas = await this.authoredShas(repo);
      if (shas) {
        authored.set(repo, shas);
      }
    }
    if (authored.size === 0) {
      return null;
    }

    let mine = 0;
    for (const release of releases) {
      const slug = repoSlug(release.repoUrl);
      if (!slug || !release.commitHash) {
        continue;
      }
      if (authored.get(slug)?.has(release.commitHash)) {
        mine += 1;
      }
    }
    return mine;
  }
}
