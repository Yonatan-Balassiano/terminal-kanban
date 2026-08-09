import type { Db } from '../db/index.js';
import type { PRReleaseStatus, TaskReleaseSummary } from '../types/index.js';
import { MAX_CONCURRENT_LOOKUPS, mapWithLimit } from './concurrency.js';
import { summarizeRelease } from './release-matching.js';
import { ReleaseStatusStore, MAX_PAIRS_PER_POLL } from './release-status-store.js';
import type { PRRef, ReleaseStatusService } from './release-status.js';

/**
 * Keeps the board's view of "has it shipped?" current.
 *
 * Sits between the resolver, which knows how to answer the question once, and
 * the board, which needs the answer for every card without ever waiting on the
 * network. Answers are served from the store; refreshing happens on a timer and
 * is bounded, so a board full of finished cards costs a predictable amount.
 */

const DEFAULT_POLL_INTERVAL_MS = 60_000;

/**
 * The pull requests a card owns.
 *
 * Injected rather than read directly so this works against today's one-PR cards
 * and against the multi-PR model without changing anything here.
 */
export type ListTaskPRs = (taskId: string) => PRRef[];

export interface ReleaseTrackerOptions {
  db: Db;
  resolver: ReleaseStatusService;
  listTaskPRs: ListTaskPRs;
  /** Cards worth tracking — merged work only. */
  listTrackedTaskIds: () => string[];
  pollIntervalMs?: number;
  now?: () => number;
  onTaskReleased?: (taskId: string) => void;
}

export class ReleaseTracker {
  private readonly store: ReleaseStatusStore;
  private readonly resolver: ReleaseStatusService;
  private readonly listTaskPRs: ListTaskPRs;
  private readonly listTrackedTaskIds: () => string[];
  private readonly pollIntervalMs: number;
  private readonly onTaskReleased?: (taskId: string) => void;

  private timer?: ReturnType<typeof setInterval>;
  private pollInFlight: Promise<void> | null = null;

  constructor(options: ReleaseTrackerOptions) {
    this.store = new ReleaseStatusStore(options.db, options.now);
    this.resolver = options.resolver;
    this.listTaskPRs = options.listTaskPRs;
    this.listTrackedTaskIds = options.listTrackedTaskIds;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (options.onTaskReleased) {
      this.onTaskReleased = options.onTaskReleased;
    }
  }

  /** Everything known about one card. Reads the store; never blocks. */
  getStatuses(taskId: string): PRReleaseStatus[] {
    return this.store.loadTask(taskId);
  }

  /**
   * Whether every merged pull request on a card has reached production.
   *
   * Gates the move to done, and the distinction that matters is between "not
   * shipped yet" and "could not tell". Only the former holds a card back:
   * an expired login or an untracked repository would otherwise strand every
   * card in shipping indefinitely, which is a worse outcome than the board it
   * replaced. A card not yet looked at is held, because that resolves itself on
   * the next poll.
   */
  isFullyReleased(taskId: string): boolean {
    const merged = this.listTaskPRs(taskId).filter((pr) => pr.prState === 'merged');
    if (merged.length === 0) {
      // Nothing merged has any artifact to wait on — a card that only ever had
      // closed pull requests is finished the moment they close.
      return true;
    }

    const statuses = this.store.loadTask(taskId);
    const byPR = new Map(statuses.map((status) => [`${status.repoSlug}#${status.prNumber}`, status]));

    return merged.every((pr) => {
      const status = byPR.get(`${pr.repoSlug}#${pr.prNumber}`);
      if (!status) {
        return false;
      }

      switch (status.stage) {
        case 'ga':
        case 'no-artifact':
          return true;
        case 'unknown':
          // Unreadable, not unshipped.
          return true;
        default:
          return false;
      }
    });
  }

  /** The one line a card can show, or null when nothing has been resolved yet. */
  getSummary(taskId: string): TaskReleaseSummary | null {
    return summarizeRelease(this.store.loadTask(taskId));
  }

  /** Re-resolves one card now, for when the user asks. */
  async refreshTask(taskId: string): Promise<PRReleaseStatus[]> {
    const prs = this.listTaskPRs(taskId).filter((pr) => pr.prState === 'merged');
    const statuses = await mapWithLimit(prs, MAX_CONCURRENT_LOOKUPS, (pr) =>
      this.resolver.resolve(pr),
    );

    for (const status of statuses) {
      this.store.save(taskId, status);
    }

    this.notifyIfReleased(taskId, statuses);
    return statuses;
  }

  start(): void {
    void this.poll();
    this.timer ??= setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One refresh pass. Concurrent callers share it, as the rail's does. */
  async poll(): Promise<void> {
    this.pollInFlight ??= this.pollInner().finally(() => {
      this.pollInFlight = null;
    });
    return this.pollInFlight;
  }

  private async pollInner(): Promise<void> {
    const budget = MAX_PAIRS_PER_POLL;
    const work = new Map<string, PRRef[]>();

    // Cards whose merged work has never been looked at come first: an
    // unexamined pull request is the one the user is actually waiting on.
    for (const taskId of this.listTrackedTaskIds()) {
      const known = new Set(
        this.store.loadTask(taskId).map((status) => `${status.repoSlug}#${status.prNumber}`),
      );
      const fresh = this.listTaskPRs(taskId).filter(
        (pr) => pr.prState === 'merged' && !known.has(`${pr.repoSlug}#${pr.prNumber}`),
      );
      if (fresh.length > 0) {
        work.set(taskId, fresh);
      }
    }

    let queued = [...work.values()].reduce((total, prs) => total + prs.length, 0);

    // Then whatever has fallen due, oldest first, until the budget runs out.
    for (const due of this.store.due(budget)) {
      if (queued >= budget) {
        break;
      }
      const pr = this.listTaskPRs(due.taskId).find(
        (candidate) =>
          candidate.repoSlug === due.repoSlug && candidate.prNumber === due.prNumber,
      );
      if (!pr || pr.prState !== 'merged') {
        // The pull request is gone from the card; stop tracking it.
        this.store.forget(due.taskId, due.repoSlug, due.prNumber);
        continue;
      }

      const bucket = work.get(due.taskId);
      if (bucket) {
        bucket.push(pr);
      } else {
        work.set(due.taskId, [pr]);
      }
      queued += 1;
    }

    for (const [taskId, prs] of work) {
      const statuses = await mapWithLimit(prs, MAX_CONCURRENT_LOOKUPS, (pr) =>
        this.resolver.resolve(pr),
      );
      for (const status of statuses) {
        this.store.save(taskId, status);
      }
      this.notifyIfReleased(taskId, this.store.loadTask(taskId));
    }
  }

  /**
   * Announces a card whose every pull request has shipped.
   *
   * Only announces; moving the card is left to a single owner so two services
   * can never fight over its track.
   */
  private notifyIfReleased(taskId: string, statuses: readonly PRReleaseStatus[]): void {
    if (!this.onTaskReleased || statuses.length === 0) {
      return;
    }

    const shipped = statuses.every(
      (status) => status.stage === 'ga' || status.stage === 'no-artifact',
    );
    if (shipped) {
      this.onTaskReleased(taskId);
    }
  }
}
