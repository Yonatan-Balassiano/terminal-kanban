import type {
  ArtifactRecord,
  ArtifactsSnapshot,
  RolloutArtifactParams,
  RolloutArtifactResult,
} from '../types/index.js';
import { McpAuthRequiredError } from './mcp/oauth.js';
import type { McpClient } from './mcp/client.js';
import type { CommitOwnership } from './commit-ownership.js';

/**
 * Rollout status for the artifacts rail: what is in production versus the
 * newest release candidate, for a configured list of artifacts.
 *
 * Data comes from devex over MCP — the rollout MCP is the write side and cannot
 * answer "what is GA". One `get_project` call per artifact returns both
 * `gaVersion` and `latestRcVersion`.
 */

const GET_PROJECT_TOOL = 'devex__get_project';
const ROLLOUT_VERSION_TOOL = 'rollout__rollout_version';
const AVAILABLE_RCS_TOOL = 'devex__available_rcs';
/** Pending windows are small in practice; this bounds a pathological one. */
const MAX_PENDING_RCS = 50;
/** Rube Goldberg rejects comments outside this range. */
const MIN_COMMENT_LENGTH = 10;
const DEFAULT_REFRESH_INTERVAL_MS = 300_000;
/** Per-artifact concurrency; the list is small and the server is shared. */
const MAX_CONCURRENT_LOOKUPS = 4;

interface DevexProject {
  projectName: string;
  mode?: string;
  isArchived?: boolean;
  gaVersion?: string;
  latestRcVersion?: string;
  repoUrl?: string;
  pathInRepo?: string;
}

interface GetProjectResponse {
  project?: DevexProject;
}

export interface ArtifactsServiceOptions {
  client: McpClient;
  artifactNames: readonly string[];
  refreshIntervalMs?: number;
  /** Absent when no GitHub login could be resolved; ownership is then unknown. */
  ownership?: CommitOwnership;
  now?: () => number;
}

interface PendingRelease {
  commitHash?: string;
  repoUrl?: string;
}

interface AvailableRcsResponse {
  releases?: PendingRelease[];
}

/**
 * Compares two dotted numeric versions.
 *
 * Returns the difference in the first component that differs, so `1.470.0` vs
 * `1.465.0` yields 5. Non-numeric or unparseable versions yield null rather
 * than a misleading zero.
 */
export function versionDrift(ga: string | undefined, rc: string | undefined): number | null {
  if (!ga || !rc) {
    return null;
  }
  const gaParts = ga.split('.').map((part) => Number.parseInt(part, 10));
  const rcParts = rc.split('.').map((part) => Number.parseInt(part, 10));
  if (gaParts.some(Number.isNaN) || rcParts.some(Number.isNaN)) {
    return null;
  }

  const length = Math.max(gaParts.length, rcParts.length);
  for (let index = 0; index < length; index += 1) {
    const gaPart = gaParts[index] ?? 0;
    const rcPart = rcParts[index] ?? 0;
    if (gaPart !== rcPart) {
      return rcPart - gaPart;
    }
  }
  return 0;
}

/** Trims the group prefix so a narrow rail can show something readable. */
export function shortArtifactName(projectName: string): string {
  return projectName.replace(/^com\.wixpress\./, '');
}

function toRecord(name: string, project: DevexProject | undefined): ArtifactRecord {
  if (!project) {
    return { name, shortName: shortArtifactName(name), status: 'unknown' };
  }

  const drift = versionDrift(project.gaVersion, project.latestRcVersion);
  return {
    name: project.projectName || name,
    shortName: shortArtifactName(project.projectName || name),
    mode: project.mode,
    isArchived: project.isArchived ?? false,
    gaVersion: project.gaVersion,
    latestRcVersion: project.latestRcVersion,
    drift: drift ?? undefined,
    // Libraries and proto packages publish RCs but never go GA; showing them as
    // "behind" would be meaningless.
    status: !project.gaVersion ? 'no-ga' : drift && drift > 0 ? 'drift' : 'in-sync',
    repoUrl: project.repoUrl,
    pathInRepo: project.pathInRepo,
  };
}

/** Runs tasks with a small concurrency cap, preserving input order. */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await task(items[index]!);
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * Audit-trail comment for a rollout.
 *
 * States plainly what is shipping and that a tool initiated it, so the audit
 * trail never implies a human typed it.
 */
export function buildRolloutComment(
  name: string,
  fromVersion: string | undefined,
  targetVersion: string
): string {
  const from = fromVersion ? `from ${fromVersion} ` : '';
  return (
    `GA rollout of ${name} ${from}to ${targetVersion}, ` +
    'triggered from the AgentBoard artifacts footer ' +
    '— initiated by AgentBoard via rollout-mcp'
  );
}

export class ArtifactsService {
  private readonly client: McpClient;
  private readonly artifactNames: readonly string[];
  private readonly refreshIntervalMs: number;
  private readonly ownership?: CommitOwnership;
  private readonly now: () => number;

  private snapshot: ArtifactsSnapshot;
  private refreshInFlight: Promise<ArtifactsSnapshot> | null = null;
  private timer?: ReturnType<typeof setInterval>;

  constructor(options: ArtifactsServiceOptions) {
    this.client = options.client;
    this.artifactNames = options.artifactNames;
    this.refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.ownership = options.ownership;
    this.now = options.now ?? Date.now;
    this.snapshot = { artifacts: [], refreshedAt: 0, stale: true };
  }

  /**
   * Last known artifacts. Never blocks and never throws, so the rail always has
   * something to draw — staleness is reported in the snapshot instead.
   */
  getSnapshot(): ArtifactsSnapshot {
    return this.snapshot;
  }

  /** Refreshes on an interval; concurrent callers share one in-flight refresh. */
  start(): void {
    if (this.artifactNames.length === 0) {
      return;
    }
    void this.refresh().catch(() => {
      // Errors are recorded on the snapshot; nothing to do here.
    });
    this.timer ??= setInterval(() => {
      void this.refresh().catch(() => {});
    }, this.refreshIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Start a production rollout of one artifact.
   *
   * This changes production. It is only ever reached from an explicit typed
   * confirmation in the TUI, and the target version is the one the caller saw —
   * never re-resolved here, so a newly landed RC can never be shipped by
   * surprise.
   *
   * The artifact must be one of the configured ones: the rail is the only entry
   * point, and an unconfigured id would mean the caller is somewhere it should
   * not be.
   */
  async rollout(params: RolloutArtifactParams): Promise<RolloutArtifactResult> {
    const { name, targetVersion, graduality = 'gradual_safer' } = params;

    if (!this.artifactNames.includes(name)) {
      return { ok: false, message: `${name} is not a configured artifact` };
    }
    if (!targetVersion.trim()) {
      return { ok: false, message: 'No target version supplied' };
    }

    const known = this.snapshot.artifacts.find((artifact) => artifact.name === name);
    const comment = buildRolloutComment(name, known?.gaVersion, targetVersion);
    if (comment.length < MIN_COMMENT_LENGTH) {
      return { ok: false, message: 'Generated audit comment was too short' };
    }

    try {
      const response = await this.client.callTool<{
        transactionId?: string;
        transaction_id?: string;
        status?: string;
      }>(ROLLOUT_VERSION_TOOL, {
        application_id: name,
        desired_ga_version: targetVersion,
        graduality,
        comment,
      });

      const transactionId = response?.transactionId ?? response?.transaction_id;
      // The new GA only lands after the gradual rollout completes, so refresh
      // rather than optimistically rewriting the row.
      void this.refresh().catch(() => {});

      return {
        ok: true,
        transactionId,
        status: response?.status,
        message: `Rolling out ${targetVersion}${transactionId ? ` (${transactionId})` : ''}`,
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Annotate a drifting artifact with how many pending RCs are yours.
   *
   * Best-effort throughout: a failure leaves the counts undefined so the footer
   * shows "unknown ownership" rather than a confident zero that would read as
   * "nothing of mine is waiting".
   */
  private async withOwnership(record: ArtifactRecord): Promise<ArtifactRecord> {
    if (!this.ownership || !record.gaVersion || !record.latestRcVersion) {
      return record;
    }

    try {
      const response = await this.client.callTool<AvailableRcsResponse>(AVAILABLE_RCS_TOOL, {
        project_name: record.name,
        from_version: record.gaVersion,
        to_version: record.latestRcVersion,
        paging: { limit: MAX_PENDING_RCS },
      });

      const releases = response?.releases ?? [];
      const myPendingCount = await this.ownership.countMine(releases);
      return {
        ...record,
        pendingRcCount: releases.length,
        ...(myPendingCount === null ? {} : { myPendingCount }),
      };
    } catch {
      return record;
    }
  }

  async refresh(): Promise<ArtifactsSnapshot> {
    this.refreshInFlight ??= this.refreshInner().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async refreshInner(): Promise<ArtifactsSnapshot> {
    if (this.artifactNames.length === 0) {
      this.snapshot = { artifacts: [], refreshedAt: this.now(), stale: false };
      return this.snapshot;
    }

    try {
      const artifacts = await mapWithLimit(
        this.artifactNames,
        MAX_CONCURRENT_LOOKUPS,
        async (name) => {
          try {
            const response = await this.client.callTool<GetProjectResponse>(GET_PROJECT_TOOL, {
              projectName: name,
            });
            const record = toRecord(name, response?.project);
            return record.status === 'drift' ? await this.withOwnership(record) : record;
          } catch (error) {
            // One bad artifact must not blank the whole rail.
            if (error instanceof McpAuthRequiredError) {
              throw error;
            }
            return toRecord(name, undefined);
          }
        }
      );

      this.snapshot = { artifacts, refreshedAt: this.now(), stale: false };
      return this.snapshot;
    } catch (error) {
      const needsAuth = error instanceof McpAuthRequiredError;
      // Keep the previous rows visible; only mark them stale.
      this.snapshot = {
        ...this.snapshot,
        stale: true,
        needsAuth,
        error: error instanceof Error ? error.message : String(error),
      };
      return this.snapshot;
    }
  }
}
