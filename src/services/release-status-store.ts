import type { Db } from '../db/index.js';
import type {
  ArtifactReleaseStatus,
  PRReleaseStatus,
  ReleaseConfidence,
  ReleaseEvidence,
  ReleaseStage,
  ReleaseUnknownReason,
} from '../types/index.js';
import { rollupConfidence, rollupStage } from './release-matching.js';

/**
 * Remembers where each merged pull request got to, and decides what is worth
 * asking about again.
 *
 * Most of what this feature learns is permanent — a change that reached
 * production stays there, and a pull request that touched nothing shippable
 * always did. Persisting those verdicts is what keeps a board of finished cards
 * from re-interrogating devex forever.
 */

/** A rollout is moving, so its state is worth watching closely. */
const ROLLING_OUT_INTERVAL_MS = 60_000;
/** Waiting on a build or a rollout that has not started. */
const PENDING_INTERVAL_MS = 120_000;
/** First retry after a failure, doubled on each repeat. */
const FAILURE_BASE_INTERVAL_MS = 120_000;
const FAILURE_MAX_INTERVAL_MS = 1_800_000;
/**
 * A merge with no release candidate after this long is not "any minute now" —
 * something was rebased, squashed away, or built somewhere unexpected.
 */
const STALE_MERGE_AFTER_MS = 21_600_000;
/**
 * Hard ceiling on how many verdicts one pass may refresh.
 *
 * Without it a board full of finished cards would spend an unbounded number of
 * calls per tick the first time it is polled.
 */
export const MAX_PAIRS_PER_POLL = 40;

/** Stage/artifact pairs that can never change, so they are never asked again. */
function isTerminal(stage: ReleaseStage): boolean {
  return stage === 'ga' || stage === 'no-artifact' || stage === 'not-merged';
}

interface StatusRow {
  task_id: string;
  repo_slug: string;
  pr_number: number;
  artifact_name: string;
  stage: string;
  confidence: string;
  evidence: string;
  reason: string | null;
  gates: number;
  containing_rc_version: string | null;
  containing_rc_commit: string | null;
  ga_version_at_check: string | null;
  rollout_to_version: string | null;
  consecutive_failures: number;
  checked_at: number;
  next_check_at: number;
}

interface DueRow {
  task_id: string;
  repo_slug: string;
  pr_number: number;
}

/** One pull request that has fallen due for another look. */
export interface DuePR {
  taskId: string;
  repoSlug: string;
  prNumber: number;
}

export class ReleaseStatusStore {
  private readonly db: Db;
  private readonly now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  /**
   * When to look at a verdict again.
   *
   * Returns null for a verdict that can never change, which is what removes it
   * from the polling set for good.
   */
  private nextCheckAt(
    stage: ReleaseStage,
    consecutiveFailures: number,
    checkedAt: number,
  ): number | null {
    if (isTerminal(stage)) {
      return null;
    }

    if (stage === 'unknown') {
      const backoff = Math.min(
        FAILURE_BASE_INTERVAL_MS * 2 ** Math.max(0, consecutiveFailures - 1),
        FAILURE_MAX_INTERVAL_MS,
      );
      return checkedAt + backoff;
    }

    if (stage === 'rolling-out') {
      return checkedAt + ROLLING_OUT_INTERVAL_MS;
    }

    return checkedAt + PENDING_INTERVAL_MS;
  }

  /** Replaces everything known about one pull request. */
  save(taskId: string, status: PRReleaseStatus): void {
    const rows: ArtifactReleaseStatus[] =
      status.artifacts.length > 0
        ? status.artifacts
        : [
            // A verdict with no artifacts still has to be remembered, or the
            // pull request looks unexamined on every pass.
            {
              artifactName: '',
              shortName: '',
              stage: status.stage,
              confidence: status.confidence,
              evidence: 'none',
              ...(status.reason ? { reason: status.reason } : {}),
              gates: status.stage !== 'no-artifact',
              checkedAt: status.checkedAt,
            },
          ];

    const previous = this.readFailureCounts(taskId, status.repoSlug, status.prNumber);

    const apply = this.db.transaction(() => {
      this.db
        .prepare<[string, string, number], void>(
          `DELETE FROM pr_release_status
            WHERE task_id = ? AND repo_slug = ? AND pr_number = ?`,
        )
        .run(taskId, status.repoSlug, status.prNumber);

      const insert = this.db.prepare(
        `INSERT INTO pr_release_status (
           task_id, repo_slug, pr_number, artifact_name,
           stage, confidence, evidence, reason, gates,
           containing_rc_version, containing_rc_commit, ga_version_at_check,
           rollout_to_version, consecutive_failures, checked_at, next_check_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      for (const artifact of rows) {
        const failures =
          artifact.stage === 'unknown' ? (previous.get(artifact.artifactName) ?? 0) + 1 : 0;
        const nextCheck = this.nextCheckAt(artifact.stage, failures, artifact.checkedAt);

        insert.run(
          taskId,
          status.repoSlug,
          status.prNumber,
          artifact.artifactName,
          artifact.stage,
          artifact.confidence,
          artifact.evidence,
          artifact.reason ?? null,
          artifact.gates ? 1 : 0,
          artifact.containingRcVersion ?? null,
          artifact.containingRcCommit ?? null,
          artifact.gaVersion ?? null,
          artifact.rolloutToVersion ?? null,
          failures,
          artifact.checkedAt,
          // Terminal verdicts are parked beyond any real clock so the due query
          // stays a plain index scan.
          nextCheck ?? Number.MAX_SAFE_INTEGER,
        );
      }
    });

    apply();
  }

  private readFailureCounts(
    taskId: string,
    repoSlug: string,
    prNumber: number,
  ): Map<string, number> {
    const rows = this.db
      .prepare<[string, string, number], { artifact_name: string; consecutive_failures: number }>(
        `SELECT artifact_name, consecutive_failures
           FROM pr_release_status
          WHERE task_id = ? AND repo_slug = ? AND pr_number = ?`,
      )
      .all(taskId, repoSlug, prNumber);

    return new Map(rows.map((row) => [row.artifact_name, row.consecutive_failures]));
  }

  /** Everything known about one card's pull requests. */
  loadTask(taskId: string): PRReleaseStatus[] {
    const rows = this.db
      .prepare<[string], StatusRow>(
        `SELECT * FROM pr_release_status WHERE task_id = ? ORDER BY pr_number, artifact_name`,
      )
      .all(taskId);

    const byPR = new Map<string, StatusRow[]>();
    for (const row of rows) {
      const key = `${row.repo_slug}#${row.pr_number}`;
      const bucket = byPR.get(key);
      if (bucket) {
        bucket.push(row);
      } else {
        byPR.set(key, [row]);
      }
    }

    return [...byPR.values()].map((group) => this.toStatus(group));
  }

  private toStatus(group: StatusRow[]): PRReleaseStatus {
    const first = group[0]!;
    const artifacts = group
      .filter((row) => row.artifact_name.length > 0)
      .map((row) => this.toArtifact(row));

    // A pull request stored without artifacts kept its verdict on the sentinel
    // row, so read it back from there rather than rolling up nothing.
    const stage = (artifacts.length > 0 ? rollupStage(artifacts) : first.stage) as ReleaseStage;
    const confidence = (
      artifacts.length > 0 ? rollupConfidence(artifacts) : first.confidence
    ) as ReleaseConfidence;
    const reason = group.find((row) => row.reason !== null)?.reason ?? undefined;

    return {
      repoSlug: first.repo_slug,
      prNumber: first.pr_number,
      stage,
      confidence,
      ...(reason ? { reason: reason as ReleaseUnknownReason } : {}),
      artifacts,
      checkedAt: Math.max(...group.map((row) => row.checked_at)),
    };
  }

  private toArtifact(row: StatusRow): ArtifactReleaseStatus {
    return {
      artifactName: row.artifact_name,
      shortName: row.artifact_name.replace(/^com\.wixpress\./, ''),
      stage: row.stage as ReleaseStage,
      confidence: row.confidence as ReleaseConfidence,
      evidence: row.evidence as ReleaseEvidence,
      ...(row.reason ? { reason: row.reason as ReleaseUnknownReason } : {}),
      ...(row.containing_rc_version ? { containingRcVersion: row.containing_rc_version } : {}),
      ...(row.containing_rc_commit ? { containingRcCommit: row.containing_rc_commit } : {}),
      ...(row.ga_version_at_check ? { gaVersion: row.ga_version_at_check } : {}),
      ...(row.rollout_to_version ? { rolloutToVersion: row.rollout_to_version } : {}),
      gates: row.gates === 1,
      checkedAt: row.checked_at,
    };
  }

  /**
   * Pull requests worth another look, oldest first.
   *
   * Ordering by due time rather than by card means a backlog is worked through
   * fairly instead of the same few cards being refreshed every pass.
   */
  due(limit: number = MAX_PAIRS_PER_POLL): DuePR[] {
    const rows = this.db
      .prepare<[number, number], DueRow>(
        `SELECT task_id, repo_slug, pr_number
           FROM pr_release_status
          WHERE next_check_at <= ?
          GROUP BY task_id, repo_slug, pr_number
          ORDER BY MIN(next_check_at)
          LIMIT ?`,
      )
      .all(this.now(), limit);

    return rows.map((row) => ({
      taskId: row.task_id,
      repoSlug: row.repo_slug,
      prNumber: row.pr_number,
    }));
  }

  /** True once a merge has waited long enough that "not built yet" stops being credible. */
  isStaleMerge(mergedAt: number): boolean {
    return this.now() - mergedAt > STALE_MERGE_AFTER_MS;
  }

  /** Forgets a pull request, for when it is unlinked from its card. */
  forget(taskId: string, repoSlug: string, prNumber: number): void {
    this.db
      .prepare<[string, string, number], void>(
        `DELETE FROM pr_release_status
          WHERE task_id = ? AND repo_slug = ? AND pr_number = ?`,
      )
      .run(taskId, repoSlug, prNumber);
  }
}
