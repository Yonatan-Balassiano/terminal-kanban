import type {
  ArtifactReleaseStatus,
  ArtifactRecord,
  PRReleaseStatus,
  ReleaseConfidence,
  ReleaseStage,
  TaskReleaseSummary,
} from '../types/index.js';
import { versionDrift } from './artifacts.js';

/**
 * The judgement calls behind "has my pull request shipped?", with no I/O.
 *
 * Deciding which artifacts a change belongs to and whether a release candidate
 * is at or below production is where this feature is most likely to be subtly
 * wrong, and a wrong `ga` verdict deletes a card's worktrees. Keeping the rules
 * pure means they can be pinned by tests that name the failure they prevent.
 */

/**
 * Drops the mirror segment some monorepo builds prepend to a project path.
 *
 * A release built through the mirror reports `comp/wix_vmr_repo/b2b/web-5/x`
 * for a project whose files live at `b2b/web-5/x` in the repository the pull
 * request was opened against.
 */
export function stripMonorepoPrefix(pathInRepo: string): string {
  return pathInRepo.replace(/^comp\/[A-Za-z0-9_.-]+\//, '');
}

/**
 * Whether a changed file belongs to an artifact rooted at `pathInRepo`.
 *
 * Matching stops at a path separator: a plain prefix test would attribute
 * `engine/prompt-manager-v2/x.ts` to `engine/prompt-manager` and gate the card
 * on an artifact it never touched.
 */
export function pathMatchesArtifact(filePath: string, pathInRepo: string): boolean {
  const root = pathInRepo.replace(/\/+$/, '');
  if (root.length === 0) {
    return true;
  }

  return filePath === root || filePath.startsWith(`${root}/`);
}

/** Every form of an artifact's root path that a changed file might match. */
function artifactRoots(record: ArtifactRecord): string[] {
  const raw = record.pathInRepo?.trim();
  if (!raw) {
    return [];
  }

  const stripped = stripMonorepoPrefix(raw);
  // Both forms, never only the stripped one: a project genuinely rooted under
  // `comp/` would otherwise stop matching its own files.
  return stripped === raw ? [raw] : [raw, stripped];
}

/**
 * The artifacts a set of changed files belongs to.
 *
 * When artifacts nest, each file is attributed to the deepest one that claims
 * it. An umbrella project would otherwise be dragged in by every change to a
 * child and hold the card open until the umbrella happened to ship.
 */
export function matchArtifactsForPaths(
  files: readonly string[],
  candidates: readonly ArtifactRecord[],
): ArtifactRecord[] {
  const matched = new Map<string, ArtifactRecord>();

  for (const file of files) {
    let best: ArtifactRecord | undefined;
    let bestLength = -1;

    for (const candidate of candidates) {
      for (const root of artifactRoots(candidate)) {
        if (pathMatchesArtifact(file, root) && root.length > bestLength) {
          best = candidate;
          bestLength = root.length;
        }
      }
    }

    if (best) {
      matched.set(best.name, best);
    }
  }

  return [...matched.values()];
}

/**
 * Whether a release candidate is at or below the production version.
 *
 * Returns null when either version cannot be parsed, so an unrecognised scheme
 * reads as "could not tell" rather than as shipped.
 */
export function isShipped(rc: string | undefined, ga: string | undefined): boolean | null {
  // versionDrift(ga, rc) is rc - ga in the first differing component.
  const delta = versionDrift(ga, rc);
  return delta === null ? null : delta <= 0;
}

/** Ranks stages so the least-progressed one decides a pull request's verdict. */
const STAGE_ORDER: Record<ReleaseStage, number> = {
  unknown: 0,
  'not-merged': 1,
  'awaiting-build': 2,
  'rc-built': 3,
  'rolling-out': 4,
  ga: 5,
  // Nothing to ship, so it never holds a rollup back.
  'no-artifact': 6,
};

/**
 * Collapses per-artifact stages into one verdict for a pull request.
 *
 * The least-progressed gating artifact wins, and `unknown` outranks everything
 * — a pull request whose state is partly unreadable is not shipped.
 */
export function rollupStage(artifacts: readonly ArtifactReleaseStatus[]): ReleaseStage {
  const gating = artifacts.filter((artifact) => artifact.gates);
  if (gating.length === 0) {
    return artifacts.length === 0 ? 'unknown' : 'no-artifact';
  }

  return gating.reduce<ReleaseStage>(
    (worst, artifact) => (STAGE_ORDER[artifact.stage] < STAGE_ORDER[worst] ? artifact.stage : worst),
    'no-artifact',
  );
}

/** The weakest confidence across the artifacts that decided the verdict. */
export function rollupConfidence(artifacts: readonly ArtifactReleaseStatus[]): ReleaseConfidence {
  const gating = artifacts.filter((artifact) => artifact.gates);
  if (gating.length === 0) {
    return artifacts.length === 0 ? 'unknown' : 'confirmed';
  }
  if (gating.some((artifact) => artifact.confidence === 'unknown')) {
    return 'unknown';
  }
  if (gating.some((artifact) => artifact.confidence === 'inferred')) {
    return 'inferred';
  }
  return 'confirmed';
}

/**
 * True only when every artifact that can ship has shipped.
 *
 * `unknown` is never satisfied: an outage that made every card look complete
 * would close them and delete their worktrees.
 */
export function isFullyReleased(statuses: readonly PRReleaseStatus[]): boolean {
  if (statuses.length === 0) {
    return true;
  }

  return statuses.every((status) => status.stage === 'ga' || status.stage === 'no-artifact');
}

/**
 * Condenses a card's pull requests into the one line a card can show.
 *
 * Returns null when nothing has been resolved yet, so a card that has never
 * been checked shows no badge rather than an empty one.
 */
export function summarizeRelease(
  statuses: readonly PRReleaseStatus[],
): TaskReleaseSummary | null {
  if (statuses.length === 0) {
    return null;
  }

  const gating = statuses.filter((status) => status.stage !== 'not-merged');
  if (gating.length === 0) {
    return null;
  }

  // A feature is only as shipped as its slowest part.
  const worst = gating.reduce((slowest, status) =>
    STAGE_ORDER[status.stage] < STAGE_ORDER[slowest.stage] ? status : slowest,
  );
  const blocker = worst.artifacts.find((artifact) => artifact.gates && artifact.stage !== 'ga');

  return {
    stage: worst.stage,
    confidence: worst.confidence,
    ...(worst.reason ? { reason: worst.reason } : {}),
    gaCount: gating.filter((status) => status.stage === 'ga' || status.stage === 'no-artifact')
      .length,
    gatingCount: gating.length,
    ...(blocker?.artifactName
      ? {
          blockingArtifact: blocker.shortName,
          // The full project id as well, because rolling the card's change out
          // needs to name the artifact to devex, and the short name cannot.
          blockingArtifactName: blocker.artifactName,
        }
      : {}),
    ...(blocker?.containingRcVersion ? { blockingRcVersion: blocker.containingRcVersion } : {}),
    ...(blocker?.gaVersion ? { blockingGaVersion: blocker.gaVersion } : {}),
    checkedAt: Math.max(...gating.map((status) => status.checkedAt)),
  };
}

/**
 * Splits a project id into the group and artifact halves devex expects.
 *
 * The split is at the last dot: `com.wixpress.enterpise.web5.prompt-manager` is
 * group `com.wixpress.enterpise.web5`, artifact `prompt-manager`.
 */
export function splitProjectName(name: string): { groupId: string; artifactId: string } | null {
  const index = name.lastIndexOf('.');
  if (index <= 0 || index === name.length - 1) {
    return null;
  }

  return { groupId: name.slice(0, index), artifactId: name.slice(index + 1) };
}
