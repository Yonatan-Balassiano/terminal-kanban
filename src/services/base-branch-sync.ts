import { existsSync } from 'fs';
import type { Db } from '../db/index.js';
import type { FastForwardOutcome, GitService } from './git.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// Off the startup path: a daemon start already fans out board, session and
// GitHub work, and a fetch of every repo has no reason to compete with it.
const STARTUP_DELAY_MS = 2 * 60 * 1000;

export interface BaseBranchSyncResult {
  label: string;
  path: string;
  branch: string;
  outcome: FastForwardOutcome;
}

interface RepoRow {
  label: string;
  path: string;
  default_base_branch: string;
}

/**
 * Keeps every registered repo's local base branch level with origin, once a day.
 *
 * New cards already branch from a freshly fetched `origin/<base>`, so this is
 * not what keeps them current — it is for the user's own main checkout, which
 * otherwise drifts hundreds of commits behind. Fast-forward only, via
 * `GitService.fastForwardLocalBranchAsync`: a repo where that is not safe is
 * skipped and logged, never rebased.
 */
export class BaseBranchSyncService {
  private timer?: ReturnType<typeof setTimeout>;
  private running: Promise<BaseBranchSyncResult[]> | null = null;

  constructor(
    private readonly db: Db,
    private readonly git: GitService,
    private readonly log: (message: string) => void,
    private readonly intervalMs = DAY_MS,
    private readonly startupDelayMs = STARTUP_DELAY_MS,
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }
    const schedule = (delayMs: number) => {
      this.timer = setTimeout(() => {
        void this.runOnce().finally(() => {
          if (this.timer) {
            schedule(this.intervalMs);
          }
        });
      }, delayMs);
      this.timer.unref?.();
    };
    schedule(this.startupDelayMs);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** One pass over every repo; a call made during a pass gets that pass's result. */
  runOnce(): Promise<BaseBranchSyncResult[]> {
    this.running ??= this.syncAll().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async syncAll(): Promise<BaseBranchSyncResult[]> {
    const repos = this.db
      .prepare<[], RepoRow>('SELECT label, path, default_base_branch FROM repos ORDER BY label')
      .all();
    const results: BaseBranchSyncResult[] = [];
    // One repo at a time: a monorepo fetch is heavy, and nothing waits on this.
    for (const repo of repos) {
      if (!existsSync(repo.path)) {
        continue;
      }
      const outcome = await this.syncRepo(repo);
      results.push({ label: repo.label, path: repo.path, branch: repo.default_base_branch, outcome });
      this.log(describe(repo, outcome));
    }
    return results;
  }

  private async syncRepo(repo: RepoRow): Promise<FastForwardOutcome> {
    try {
      return await this.git.fastForwardLocalBranchAsync(repo.path, repo.default_base_branch);
    } catch (error: unknown) {
      return { status: 'skipped', reason: error instanceof Error ? error.message : String(error) };
    }
  }
}

function describe(repo: RepoRow, outcome: FastForwardOutcome): string {
  const prefix = `[base-sync] ${repo.label} ${repo.default_base_branch}:`;
  switch (outcome.status) {
    case 'updated':
      return `${prefix} fast-forwarded ${outcome.from.slice(0, 8)}..${outcome.to.slice(0, 8)}`;
    case 'up-to-date':
      return `${prefix} up to date`;
    case 'skipped':
      return `${prefix} skipped (${outcome.reason})`;
  }
}
