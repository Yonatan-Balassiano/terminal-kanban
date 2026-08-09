import type {
  ArtifactReleaseStatus,
  ArtifactRecord,
  PRReleaseStatus,
  ReleaseConfidence,
  ReleaseUnknownReason,
} from '../types/index.js';
import type { ArtifactsService } from './artifacts.js';
import { repoSlug } from './commit-ownership.js';
import { MAX_CONCURRENT_LOOKUPS, mapWithLimit } from './concurrency.js';
import type { CommitComparison, GitHubService, PRMergeInfo } from './github.js';
import { GitHubServiceError } from './github.js';
import { McpAuthRequiredError } from './mcp/oauth.js';
import type { McpClient } from './mcp/client.js';
import {
  isShipped,
  matchArtifactsForPaths,
  rollupConfidence,
  rollupStage,
} from './release-matching.js';

/**
 * Answers "has the pull request I merged actually shipped?".
 *
 * The artifacts rail reports what is in production right now. This reports
 * where one specific commit got to, which is a different question and needs a
 * different chain: merge commit -> the artifacts whose paths it touched -> the
 * release candidate that carries it -> whether that candidate is at or below
 * the production version.
 *
 * The chain is built to never claim more than it knows. A verdict of `ga`
 * releases the card's worktrees, so a false positive throws away work for a
 * change that is not live — every fallback below therefore degrades to
 * `awaiting-build` or `unknown` rather than guessing.
 */

const WHERE_IS_MY_COMMIT_TOOL = 'devex__where_is_my_commit';
const SEARCH_RELEASES_TOOL = 'devex__search_releases';

/**
 * How many release candidates to walk before giving up.
 *
 * A build queued before your merge landed produces a candidate that is newer in
 * time but older in history, so the first candidate after the merge is not
 * always the one that carries it.
 */
const MAX_RC_PROBES = 3;

interface DevexRelease {
  version?: string;
  commitHash?: string;
  repoUrl?: string;
  createdDate?: string;
}

interface WhereIsMyCommitResponse {
  release?: DevexRelease;
}

interface SearchReleasesResponse {
  releases?: DevexRelease[];
}

// --------------- resolver ------------------------------------

/** One pull request to resolve, as supplied by the caller. */
export interface PRRef {
  repoSlug: string;
  prNumber: number;
  /** Local checkout used as the working directory for `gh`. */
  repoPath: string;
  prState: string;
  mergeCommitSha?: string;
  mergedAt?: string;
  /** Changed paths, when the caller already has them. Fetched if absent. */
  changedFiles?: string[];
}

export interface ReleaseStatusServiceOptions {
  client: McpClient;
  artifacts: ArtifactsService;
  github: Pick<GitHubService, 'getMergeInfo' | 'compareCommits'>;
  now?: () => number;
}

/** Marks a per-artifact verdict that could not be reached. */
function unknownArtifact(
  record: ArtifactRecord,
  reason: ReleaseUnknownReason,
  checkedAt: number,
): ArtifactReleaseStatus {
  return {
    artifactName: record.name,
    shortName: record.shortName,
    stage: 'unknown',
    confidence: 'unknown',
    evidence: 'none',
    reason,
    gates: true,
    checkedAt,
  };
}

export class ReleaseStatusService {
  private readonly client: McpClient;
  private readonly artifacts: ArtifactsService;
  private readonly github: Pick<GitHubService, 'getMergeInfo' | 'compareCommits'>;
  private readonly now: () => number;

  /**
   * Pull requests whose exact merge commit produced no release candidate.
   *
   * The lookup matches on commit equality, so a miss can never become a hit and
   * asking again is pure cost.
   */
  private readonly whereIsMyCommitMissed = new Set<string>();
  /** Commit ancestry never changes, so a comparison is answered once. */
  private readonly comparisons = new Map<string, CommitComparison | null>();
  /** Merge facts are immutable once merged. */
  private readonly mergeInfo = new Map<string, PRMergeInfo>();

  constructor(options: ReleaseStatusServiceOptions) {
    this.client = options.client;
    this.artifacts = options.artifacts;
    this.github = options.github;
    this.now = options.now ?? Date.now;
  }

  /**
   * Where a pull request stands.
   *
   * Never throws: a failure anywhere in the chain becomes an `unknown` verdict
   * carrying its reason, because the caller uses this to decide whether to
   * close a card and no error path may read as "shipped".
   */
  async resolve(pr: PRRef): Promise<PRReleaseStatus> {
    const checkedAt = this.now();
    const base = { repoSlug: pr.repoSlug, prNumber: pr.prNumber, checkedAt };

    if (pr.prState !== 'merged') {
      return { ...base, stage: 'not-merged', confidence: 'confirmed', artifacts: [] };
    }

    let merged: PRMergeInfo | null;
    try {
      merged = await this.loadMergeInfo(pr);
    } catch {
      return {
        ...base,
        stage: 'unknown',
        confidence: 'unknown',
        reason: 'gh-error',
        artifacts: [],
      };
    }

    const mergeCommitSha = pr.mergeCommitSha ?? merged?.mergeCommitSha;
    const mergedAt = pr.mergedAt ?? merged?.mergedAt;
    if (!mergeCommitSha || !mergedAt) {
      return {
        ...base,
        stage: 'unknown',
        confidence: 'unknown',
        reason: 'no-merge-commit',
        artifacts: [],
      };
    }

    const snapshot = this.artifacts.getSnapshot();
    const candidates = this.artifacts.artifactsForRepo(pr.repoSlug);
    if (candidates.length === 0) {
      // A repo with no tracked artifacts is not the same as a change with
      // nothing to ship, and must never read as complete.
      const reason: ReleaseUnknownReason = snapshot.stale
        ? 'catalog-unavailable'
        : 'repo-not-tracked';
      return { ...base, stage: 'unknown', confidence: 'unknown', reason, artifacts: [] };
    }

    const files = pr.changedFiles ?? merged?.files ?? [];
    const affected = matchArtifactsForPaths(files, candidates);
    if (affected.length === 0) {
      return { ...base, stage: 'no-artifact', confidence: 'confirmed', artifacts: [] };
    }

    const statuses = await mapWithLimit(affected, MAX_CONCURRENT_LOOKUPS, (record) =>
      this.resolveArtifact(record, pr, mergeCommitSha, mergedAt, checkedAt),
    );

    const reason = statuses.find((status) => status.reason !== undefined)?.reason;

    return {
      ...base,
      stage: rollupStage(statuses),
      confidence: rollupConfidence(statuses),
      ...(reason ? { reason } : {}),
      artifacts: statuses,
    };
  }

  /** Resolves several pull requests and reports whether all of them shipped. */
  async resolveAll(prs: readonly PRRef[]): Promise<PRReleaseStatus[]> {
    return mapWithLimit(prs, MAX_CONCURRENT_LOOKUPS, (pr) => this.resolve(pr));
  }

  private mergeKey(pr: PRRef): string {
    return `${pr.repoSlug}#${pr.prNumber}`;
  }

  private async loadMergeInfo(pr: PRRef): Promise<PRMergeInfo | null> {
    if (pr.mergeCommitSha && pr.mergedAt && pr.changedFiles) {
      return null;
    }

    const key = this.mergeKey(pr);
    const cached = this.mergeInfo.get(key);
    if (cached) {
      return cached;
    }

    const info = await this.github.getMergeInfo(pr.repoPath, pr.prNumber, pr.repoSlug);
    if (info?.merged) {
      this.mergeInfo.set(key, info);
    }
    return info;
  }

  private async resolveArtifact(
    record: ArtifactRecord,
    pr: PRRef,
    mergeCommitSha: string,
    mergedAt: string,
    checkedAt: number,
  ): Promise<ArtifactReleaseStatus> {
    let containing: DevexRelease | null;
    let confidence: ReleaseConfidence;
    let evidence: ArtifactReleaseStatus['evidence'];

    try {
      const found = await this.findContainingRelease(record, pr, mergeCommitSha, mergedAt);
      if (found === 'awaiting-build') {
        return {
          artifactName: record.name,
          shortName: record.shortName,
          stage: 'awaiting-build',
          confidence: 'confirmed',
          evidence: 'time-order',
          gates: true,
          checkedAt,
        };
      }
      containing = found.release;
      confidence = found.confidence;
      evidence = found.evidence;
    } catch (error: unknown) {
      const reason: ReleaseUnknownReason =
        error instanceof McpAuthRequiredError
          ? 'mcp-auth'
          : error instanceof GitHubServiceError
            ? 'gh-error'
            : 'mcp-error';
      return unknownArtifact(record, reason, checkedAt);
    }

    const rcVersion = containing.version;
    const shipped = isShipped(rcVersion, record.gaVersion);

    // Libraries and proto packages publish release candidates but never go GA,
    // so gating a card on one would hold it open forever.
    const gates = record.status !== 'no-ga' && record.gaVersion !== undefined;

    if (!gates) {
      return {
        artifactName: record.name,
        shortName: record.shortName,
        stage: 'rc-built',
        confidence,
        evidence,
        ...(rcVersion ? { containingRcVersion: rcVersion } : {}),
        ...(containing.commitHash ? { containingRcCommit: containing.commitHash } : {}),
        gates: false,
        checkedAt,
      };
    }

    if (shipped === null) {
      return unknownArtifact(record, 'unparseable-version', checkedAt);
    }

    const common = {
      artifactName: record.name,
      shortName: record.shortName,
      confidence,
      ...(rcVersion ? { containingRcVersion: rcVersion } : {}),
      ...(containing.commitHash ? { containingRcCommit: containing.commitHash } : {}),
      ...(record.gaVersion ? { gaVersion: record.gaVersion } : {}),
      gates: true,
      checkedAt,
    };

    if (shipped) {
      return { ...common, stage: 'ga', evidence };
    }

    const rollout = record.rolloutInFlight;
    const rolloutCovers =
      rollout !== undefined && isShipped(rcVersion, rollout.toVersion) === true;

    if (rolloutCovers) {
      return {
        ...common,
        stage: 'rolling-out',
        evidence,
        ...(rollout.toVersion ? { rolloutToVersion: rollout.toVersion } : {}),
      };
    }

    return { ...common, stage: 'rc-built', evidence };
  }

  /**
   * The release candidate that carries a merge commit.
   *
   * Tries exact commit equality first, then walks candidates built after the
   * merge, confirming each by commit ancestry where the repositories line up.
   */
  private async findContainingRelease(
    record: ArtifactRecord,
    pr: PRRef,
    mergeCommitSha: string,
    mergedAt: string,
  ): Promise<
    | 'awaiting-build'
    | {
        release: DevexRelease;
        confidence: ReleaseConfidence;
        evidence: ArtifactReleaseStatus['evidence'];
      }
  > {
    const missKey = `${record.name}#${mergeCommitSha}`;

    if (!this.whereIsMyCommitMissed.has(missKey)) {
      const exact = await this.client.callTool<WhereIsMyCommitResponse>(
        WHERE_IS_MY_COMMIT_TOOL,
        {
          project_name: record.name,
          commit_hash: mergeCommitSha,
          repo_url: record.repoUrl ?? `git@github.com:${pr.repoSlug}.git`,
        },
      );

      if (exact?.release?.version) {
        return {
          release: exact.release,
          confidence: 'confirmed',
          evidence: 'where-is-my-commit',
        };
      }

      // Matching is on commit equality, so this can never start succeeding.
      this.whereIsMyCommitMissed.add(missKey);
    }

    const search = await this.client.callTool<SearchReleasesResponse>(SEARCH_RELEASES_TOOL, {
      search: {
        filter: {
          projectName: record.name,
          releaseType: 'RC',
          // mergedAt is passed through exactly as GitHub reported it;
          // reformatting it through a Date shifts the boundary.
          createdDate: { $gt: mergedAt },
        },
        sort: [{ fieldName: 'createdDate', order: 'ASC' }],
        cursorPaging: { limit: MAX_RC_PROBES },
      },
    });

    const releases = search?.releases ?? [];
    if (releases.length === 0) {
      return 'awaiting-build';
    }

    for (const release of releases) {
      if (!release.version) {
        continue;
      }

      const releaseSlug = repoSlug(release.repoUrl);
      if (releaseSlug !== pr.repoSlug || !release.commitHash) {
        // Built through the monorepo mirror, so its commit means nothing in the
        // pull request's repository and only build order supports the match.
        return { release, confidence: 'inferred', evidence: 'time-order' };
      }

      const comparison = await this.compare(pr, mergeCommitSha, release.commitHash);
      if (comparison === null) {
        return { release, confidence: 'inferred', evidence: 'time-order' };
      }

      if (comparison.status === 'ahead' || comparison.status === 'identical') {
        return { release, confidence: 'confirmed', evidence: 'ancestry' };
      }
      // 'behind' or 'diverged': this candidate was cut from history that
      // predates the merge, so keep walking rather than claiming it.
    }

    return 'awaiting-build';
  }

  private async compare(
    pr: PRRef,
    base: string,
    head: string,
  ): Promise<CommitComparison | null> {
    const key = `${pr.repoSlug}#${base}..${head}`;
    const cached = this.comparisons.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const result = await this.github.compareCommits(pr.repoPath, pr.repoSlug, base, head);
    this.comparisons.set(key, result);
    return result;
  }
}
