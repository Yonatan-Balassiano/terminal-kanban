import { describe, it, expect, vi } from 'vitest';
import { ReleaseStatusService, type PRRef } from '../src/services/release-status.js';
import {
  isFullyReleased,
  isShipped,
  matchArtifactsForPaths,
  pathMatchesArtifact,
  rollupConfidence,
  rollupStage,
  splitProjectName,
  stripMonorepoPrefix,
} from '../src/services/release-matching.js';
import { ArtifactsService } from '../src/services/artifacts.js';
import { GitHubServiceError } from '../src/services/github.js';
import { McpAuthRequiredError } from '../src/services/mcp/oauth.js';
import type { McpClient } from '../src/services/mcp/client.js';
import type { ArtifactRecord, ArtifactReleaseStatus } from '../src/types/index.js';

const PROMPT_MANAGER = 'com.wixpress.enterpise.web5.prompt-manager';
const VMR_URL = 'git@github.com:wix-private/wix-vmr-repo.git';
const VMR_SLUG = 'wix-private/wix-vmr-repo';
const MERGE_SHA = '3fe6abcb71f0a860948b7c9078f3d77fc7b7d811';
const RC_SHA = 'dc319bc290bc86b718a7f07d06f22ae437e205e1';
const MERGED_AT = '2026-07-29T10:02:52Z';

function artifact(over: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    name: PROMPT_MANAGER,
    shortName: 'enterpise.web5.prompt-manager',
    status: 'drift',
    gaVersion: '1.279.0',
    latestRcVersion: '1.292.0',
    repoUrl: VMR_URL,
    pathInRepo: 'b2b/web-5/engine/prompt-manager',
    ...over,
  };
}

function releaseStatus(over: Partial<ArtifactReleaseStatus> = {}): ArtifactReleaseStatus {
  return {
    artifactName: PROMPT_MANAGER,
    shortName: 'prompt-manager',
    stage: 'ga',
    confidence: 'confirmed',
    evidence: 'ancestry',
    gates: true,
    checkedAt: 0,
    ...over,
  };
}

/**
 * Stands in for the MCP gateway, dispatching on tool name and recording every
 * call so tests can assert both how often a tool ran and what it was sent.
 */
function fakeClient(responders: Record<string, (args: Record<string, unknown>) => unknown>): {
  client: McpClient;
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const client = {
    callTool: vi.fn(async (tool: string, args: Record<string, unknown>) => {
      calls.push({ tool, args });
      const responder = responders[tool];
      if (!responder) {
        throw new Error(`unexpected tool: ${tool}`);
      }
      return responder(args);
    }),
  } as unknown as McpClient;
  return { client, calls };
}

/** An ArtifactsService pre-loaded with one catalog row, without any network. */
function fakeArtifacts(records: ArtifactRecord[]): ArtifactsService {
  const service = new ArtifactsService({
    client: {} as unknown as McpClient,
    artifactNames: records.map((record) => record.name),
  });
  (service as unknown as { snapshot: unknown }).snapshot = {
    artifacts: records,
    refreshedAt: 1,
    stale: false,
  };
  return service;
}

function fakeGithub(
  over: {
    compare?: (base: string, head: string) => unknown;
    merge?: () => unknown;
  } = {},
) {
  return {
    getMergeInfo: vi.fn(async () =>
      over.merge
        ? (over.merge() as never)
        : ({ number: 1, merged: true, mergeCommitSha: MERGE_SHA, mergedAt: MERGED_AT, files: [] } as never),
    ),
    compareCommits: vi.fn(async (_path: string, _repo: string, base: string, head: string) =>
      over.compare ? (over.compare(base, head) as never) : ({ status: 'ahead', aheadBy: 4 } as never),
    ),
  };
}

const mergedPR = (over: Partial<PRRef> = {}): PRRef => ({
  repoSlug: VMR_SLUG,
  prNumber: 26575,
  repoPath: '/repo',
  prState: 'merged',
  mergeCommitSha: MERGE_SHA,
  mergedAt: MERGED_AT,
  changedFiles: ['b2b/web-5/engine/prompt-manager/src/Main.scala'],
  ...over,
});

describe('pathMatchesArtifact', () => {
  it('matches a file inside the artifact directory', () => {
    // Arrange / Act / Assert
    expect(
      pathMatchesArtifact('b2b/web-5/engine/prompt-manager/src/Main.scala', 'b2b/web-5/engine/prompt-manager'),
    ).toBe(true);
  });

  it('matches the artifact root file itself', () => {
    expect(pathMatchesArtifact('a/b', 'a/b')).toBe(true);
  });

  it('does not match a sibling directory sharing the same prefix', () => {
    // A plain startsWith would gate the card on an artifact it never touched.
    expect(
      pathMatchesArtifact('b2b/web-5/engine/prompt-manager-v2/x.ts', 'b2b/web-5/engine/prompt-manager'),
    ).toBe(false);
  });
});

describe('stripMonorepoPrefix', () => {
  it('removes the mirror segment some builds prepend', () => {
    expect(stripMonorepoPrefix('comp/wix_vmr_repo/b2b/web-5/engine/prompt-manager')).toBe(
      'b2b/web-5/engine/prompt-manager',
    );
  });

  it('leaves an ordinary path alone', () => {
    expect(stripMonorepoPrefix('b2b/web-5/engine/prompt-manager')).toBe(
      'b2b/web-5/engine/prompt-manager',
    );
  });
});

describe('matchArtifactsForPaths', () => {
  it('matches a mirrored pathInRepo against the source repo layout', () => {
    const records = [artifact({ pathInRepo: 'comp/wix_vmr_repo/b2b/web-5/engine/prompt-manager' })];

    const matched = matchArtifactsForPaths(
      ['b2b/web-5/engine/prompt-manager/src/Main.scala'],
      records,
    );

    expect(matched.map((record) => record.name)).toEqual([PROMPT_MANAGER]);
  });

  it('attributes a file to the deepest artifact when they nest', () => {
    const umbrella = artifact({ name: 'com.wixpress.web5', shortName: 'web5', pathInRepo: 'b2b/web-5' });
    const child = artifact();

    const matched = matchArtifactsForPaths(
      ['b2b/web-5/engine/prompt-manager/src/Main.scala'],
      [umbrella, child],
    );

    expect(matched.map((record) => record.name)).toEqual([PROMPT_MANAGER]);
  });

  it('returns both artifacts when a change spans disjoint paths', () => {
    const other = artifact({
      name: 'com.wixpress.web5.ecom-integrations',
      shortName: 'ecom',
      pathInRepo: 'b2b/web-5/ecom-integrations',
    });

    const matched = matchArtifactsForPaths(
      ['b2b/web-5/engine/prompt-manager/a.scala', 'b2b/web-5/ecom-integrations/b.scala'],
      [artifact(), other],
    );

    expect(matched).toHaveLength(2);
  });

  it('ignores an artifact whose path matches but which is built elsewhere', () => {
    // Candidate filtering by repo happens upstream, so a path-only match here
    // would be a cross-repo false positive.
    const matched = matchArtifactsForPaths(['docs/readme.md'], [artifact()]);
    expect(matched).toEqual([]);
  });
});

describe('isShipped', () => {
  it('reports shipped when the RC is below GA', () => {
    expect(isShipped('1.278.0', '1.279.0')).toBe(true);
  });

  it('reports shipped when the RC equals GA', () => {
    expect(isShipped('1.279.0', '1.279.0')).toBe(true);
  });

  it('reports not shipped when the RC is above GA', () => {
    expect(isShipped('1.292.0', '1.279.0')).toBe(false);
  });

  it('compares components numerically, not lexicographically', () => {
    // '1.1259.0' < '1.300.0' as strings, but 1259 > 300 as versions.
    expect(isShipped('1.1259.0', '1.300.0')).toBe(false);
    expect(isShipped('2.0.0', '1.999.0')).toBe(false);
  });

  it('returns null for an unparseable version rather than guessing', () => {
    expect(isShipped('nightly', '1.279.0')).toBeNull();
    expect(isShipped('1.279.0', undefined)).toBeNull();
  });
});

describe('rollupStage', () => {
  it('takes the least progressed gating artifact', () => {
    expect(rollupStage([releaseStatus(), releaseStatus({ stage: 'rc-built' })])).toBe('rc-built');
  });

  it('ignores non-gating artifacts', () => {
    expect(rollupStage([releaseStatus(), releaseStatus({ stage: 'rc-built', gates: false })])).toBe('ga');
  });

  it('lets unknown outrank everything', () => {
    expect(rollupStage([releaseStatus(), releaseStatus({ stage: 'unknown' })])).toBe('unknown');
  });

  it('is ga when every gating artifact shipped', () => {
    expect(rollupStage([releaseStatus(), releaseStatus()])).toBe('ga');
  });
});

describe('rollupConfidence', () => {
  it('degrades to the weakest gating confidence', () => {
    expect(rollupConfidence([releaseStatus(), releaseStatus({ confidence: 'inferred' })])).toBe('inferred');
    expect(rollupConfidence([releaseStatus(), releaseStatus({ confidence: 'unknown' })])).toBe('unknown');
  });
});

describe('isFullyReleased', () => {
  it('is true when every PR shipped or had nothing to ship', () => {
    expect(
      isFullyReleased([
        { repoSlug: 'a/b', prNumber: 1, stage: 'ga', confidence: 'confirmed', artifacts: [], checkedAt: 0 },
        { repoSlug: 'a/c', prNumber: 2, stage: 'no-artifact', confidence: 'confirmed', artifacts: [], checkedAt: 0 },
      ]),
    ).toBe(true);
  });

  it('is false while any PR is still unknown', () => {
    expect(
      isFullyReleased([
        { repoSlug: 'a/b', prNumber: 1, stage: 'ga', confidence: 'confirmed', artifacts: [], checkedAt: 0 },
        { repoSlug: 'a/c', prNumber: 2, stage: 'unknown', confidence: 'unknown', artifacts: [], checkedAt: 0 },
      ]),
    ).toBe(false);
  });
});

describe('splitProjectName', () => {
  it('splits at the last dot, as devex expects', () => {
    expect(splitProjectName(PROMPT_MANAGER)).toEqual({
      groupId: 'com.wixpress.enterpise.web5',
      artifactId: 'prompt-manager',
    });
  });

  it('rejects a name with no group', () => {
    expect(splitProjectName('prompt-manager')).toBeNull();
  });
});

describe('ReleaseStatusService.resolve', () => {
  it('reports an open PR without making any remote call', async () => {
    const { client, calls } = fakeClient({});
    const github = fakeGithub();
    const service = new ReleaseStatusService({
      client,
      artifacts: fakeArtifacts([artifact()]),
      github,
    });

    const result = await service.resolve(mergedPR({ prState: 'open' }));

    expect(result.stage).toBe('not-merged');
    expect(calls).toEqual([]);
    expect(github.getMergeInfo).not.toHaveBeenCalled();
  });

  it('uses the exact-commit lookup when it hits, and probes nothing else', async () => {
    const { client, calls } = fakeClient({
      devex__where_is_my_commit: () => ({
        release: { version: '1.278.0', commitHash: MERGE_SHA, repoUrl: VMR_URL },
      }),
    });
    const github = fakeGithub();
    const service = new ReleaseStatusService({
      client,
      artifacts: fakeArtifacts([artifact()]),
      github,
    });

    const result = await service.resolve(mergedPR());

    expect(result.stage).toBe('ga');
    expect(result.confidence).toBe('confirmed');
    expect(calls.map((call) => call.tool)).toEqual(['devex__where_is_my_commit']);
    expect(github.compareCommits).not.toHaveBeenCalled();
  });

  it('falls back to build order and proves containment by ancestry', async () => {
    const { client, calls } = fakeClient({
      devex__where_is_my_commit: () => ({}),
      devex__search_releases: () => ({
        releases: [{ version: '1.278.0', commitHash: RC_SHA, repoUrl: VMR_URL }],
      }),
    });
    const github = fakeGithub();
    const service = new ReleaseStatusService({
      client,
      artifacts: fakeArtifacts([artifact()]),
      github,
    });

    const result = await service.resolve(mergedPR());

    expect(result.stage).toBe('ga');
    expect(result.artifacts[0]?.evidence).toBe('ancestry');
    expect(result.artifacts[0]?.containingRcVersion).toBe('1.278.0');
    expect(github.compareCommits).toHaveBeenCalledWith('/repo', VMR_SLUG, MERGE_SHA, RC_SHA);

    // The release query is the load-bearing one: `releaseType` is filterable
    // where `type` is not, and the merge timestamp must go through untouched.
    const search = calls.find((call) => call.tool === 'devex__search_releases');
    expect(search?.args).toEqual({
      search: {
        filter: {
          projectName: PROMPT_MANAGER,
          releaseType: 'RC',
          createdDate: { $gt: MERGED_AT },
        },
        sort: [{ fieldName: 'createdDate', order: 'ASC' }],
        cursorPaging: { limit: 3 },
      },
    });
  });

  it('walks past a release candidate cut before the merge landed', async () => {
    const github = fakeGithub({
      compare: (_base, head) =>
        head === 'older' ? { status: 'behind', aheadBy: 0 } : { status: 'ahead', aheadBy: 2 },
    });
    const { client } = fakeClient({
      devex__where_is_my_commit: () => ({}),
      devex__search_releases: () => ({
        releases: [
          { version: '1.277.0', commitHash: 'older', repoUrl: VMR_URL },
          { version: '1.278.0', commitHash: RC_SHA, repoUrl: VMR_URL },
        ],
      }),
    });
    const service = new ReleaseStatusService({
      client,
      artifacts: fakeArtifacts([artifact()]),
      github,
    });

    const result = await service.resolve(mergedPR());

    expect(result.artifacts[0]?.containingRcVersion).toBe('1.278.0');
    expect(github.compareCommits).toHaveBeenCalledTimes(2);
  });

  it('never claims ga when every candidate predates the merge', async () => {
    const github = fakeGithub({ compare: () => ({ status: 'behind', aheadBy: 0 }) });
    const { client } = fakeClient({
      devex__where_is_my_commit: () => ({}),
      devex__search_releases: () => ({
        releases: [
          { version: '1.276.0', commitHash: 'a', repoUrl: VMR_URL },
          { version: '1.277.0', commitHash: 'b', repoUrl: VMR_URL },
        ],
      }),
    });
    const service = new ReleaseStatusService({
      client,
      artifacts: fakeArtifacts([artifact()]),
      github,
    });

    const result = await service.resolve(mergedPR());

    expect(result.stage).toBe('awaiting-build');
    expect(github.compareCommits).toHaveBeenCalledTimes(2);
  });

  it('reports awaiting-build confidently when no candidate exists yet', async () => {
    const { client } = fakeClient({
      devex__where_is_my_commit: () => ({}),
      devex__search_releases: () => ({ releases: [] }),
    });
    const service = new ReleaseStatusService({
      client,
      artifacts: fakeArtifacts([artifact()]),
      github: fakeGithub(),
    });

    const result = await service.resolve(mergedPR());

    expect(result.stage).toBe('awaiting-build');
    expect(result.confidence).toBe('confirmed');
  });

  it('infers containment without comparing when the RC was built elsewhere', async () => {
    const github = fakeGithub();
    const { client } = fakeClient({
      devex__where_is_my_commit: () => ({}),
      devex__search_releases: () => ({
        releases: [
          {
            version: '1.278.0',
            commitHash: 'c6706cd',
            repoUrl: 'git@github.com:wix-private/monorepo.git',
          },
        ],
      }),
    });
    const service = new ReleaseStatusService({
      client,
      artifacts: fakeArtifacts([artifact()]),
      github,
    });

    const result = await service.resolve(mergedPR());

    expect(result.stage).toBe('ga');
    expect(result.confidence).toBe('inferred');
    expect(result.artifacts[0]?.evidence).toBe('time-order');
    expect(github.compareCommits).not.toHaveBeenCalled();
  });

  it('does not repeat the exact-commit lookup after it misses once', async () => {
    const { client, calls } = fakeClient({
      devex__where_is_my_commit: () => ({}),
      devex__search_releases: () => ({
        releases: [{ version: '1.278.0', commitHash: RC_SHA, repoUrl: VMR_URL }],
      }),
    });
    const service = new ReleaseStatusService({
      client,
      artifacts: fakeArtifacts([artifact()]),
      github: fakeGithub(),
    });

    await service.resolve(mergedPR());
    await service.resolve(mergedPR());

    const exactCalls = calls.filter((call) => call.tool === 'devex__where_is_my_commit');
    expect(exactCalls).toHaveLength(1);
  });

  it('reuses a cached ancestry comparison across polls', async () => {
    const github = fakeGithub();
    const { client } = fakeClient({
      devex__where_is_my_commit: () => ({}),
      devex__search_releases: () => ({
        releases: [{ version: '1.278.0', commitHash: RC_SHA, repoUrl: VMR_URL }],
      }),
    });
    const service = new ReleaseStatusService({
      client,
      artifacts: fakeArtifacts([artifact()]),
      github,
    });

    await service.resolve(mergedPR());
    await service.resolve(mergedPR());

    expect(github.compareCommits).toHaveBeenCalledTimes(1);
  });

  it('reports rc-built when the containing RC is still above GA', async () => {
    const { client } = fakeClient({
      devex__where_is_my_commit: () => ({
        release: { version: '1.292.0', commitHash: MERGE_SHA, repoUrl: VMR_URL },
      }),
    });
    const service = new ReleaseStatusService({
      client,
      artifacts: fakeArtifacts([artifact()]),
      github: fakeGithub(),
    });

    const result = await service.resolve(mergedPR());

    expect(result.stage).toBe('rc-built');
    expect(result.artifacts[0]?.gaVersion).toBe('1.279.0');
  });

  it('reports rolling-out when a rollout in flight covers the containing RC', async () => {
    const { client } = fakeClient({
      devex__where_is_my_commit: () => ({
        release: { version: '1.290.0', commitHash: MERGE_SHA, repoUrl: VMR_URL },
      }),
    });
    const service = new ReleaseStatusService({
      client,
      artifacts: fakeArtifacts([
        artifact({ rolloutInFlight: { status: 'IN_PROGRESS', toVersion: '1.292.0' } }),
      ]),
      github: fakeGithub(),
    });

    const result = await service.resolve(mergedPR());

    expect(result.stage).toBe('rolling-out');
    expect(result.artifacts[0]?.rolloutToVersion).toBe('1.292.0');
  });

  it('stays rc-built when the rollout targets a version below the containing RC', async () => {
    const { client } = fakeClient({
      devex__where_is_my_commit: () => ({
        release: { version: '1.292.0', commitHash: MERGE_SHA, repoUrl: VMR_URL },
      }),
    });
    const service = new ReleaseStatusService({
      client,
      artifacts: fakeArtifacts([
        artifact({ rolloutInFlight: { status: 'IN_PROGRESS', toVersion: '1.285.0' } }),
      ]),
      github: fakeGithub(),
    });

    expect((await service.resolve(mergedPR())).stage).toBe('rc-built');
  });

  it('does not gate on an artifact that never goes GA', async () => {
    const { client } = fakeClient({
      devex__where_is_my_commit: () => ({
        release: { version: '1.5.0', commitHash: MERGE_SHA, repoUrl: VMR_URL },
      }),
    });
    const service = new ReleaseStatusService({
      client,
      artifacts: fakeArtifacts([artifact({ status: 'no-ga', gaVersion: undefined })]),
      github: fakeGithub(),
    });

    const result = await service.resolve(mergedPR());

    expect(result.artifacts[0]?.gates).toBe(false);
    // A proto package would otherwise hold the card open forever.
    expect(result.stage).toBe('no-artifact');
    expect(isFullyReleased([result])).toBe(true);
  });

  it('separates "nothing to ship" from "repo not tracked"', async () => {
    const { client } = fakeClient({});
    const tracked = new ReleaseStatusService({
      client,
      artifacts: fakeArtifacts([artifact()]),
      github: fakeGithub(),
    });
    const untracked = new ReleaseStatusService({
      client,
      artifacts: fakeArtifacts([]),
      github: fakeGithub(),
    });

    const docsOnly = await tracked.resolve(mergedPR({ changedFiles: ['docs/readme.md'] }));
    const elsewhere = await untracked.resolve(mergedPR());

    expect(docsOnly.stage).toBe('no-artifact');
    expect(docsOnly.confidence).toBe('confirmed');
    expect(elsewhere.stage).toBe('unknown');
    expect(elsewhere.reason).toBe('repo-not-tracked');
  });

  it('reports unknown, not shipped, when the MCP login has expired', async () => {
    const { client } = fakeClient({
      devex__where_is_my_commit: () => {
        throw new McpAuthRequiredError('login required');
      },
    });
    const service = new ReleaseStatusService({
      client,
      artifacts: fakeArtifacts([artifact()]),
      github: fakeGithub(),
    });

    const result = await service.resolve(mergedPR());

    expect(result.stage).toBe('unknown');
    expect(result.reason).toBe('mcp-auth');
    expect(isFullyReleased([result])).toBe(false);
  });

  it('reports unknown when gh cannot answer', async () => {
    const { client } = fakeClient({
      devex__where_is_my_commit: () => ({}),
      devex__search_releases: () => ({
        releases: [{ version: '1.278.0', commitHash: RC_SHA, repoUrl: VMR_URL }],
      }),
    });
    const service = new ReleaseStatusService({
      client,
      artifacts: fakeArtifacts([artifact()]),
      github: fakeGithub({
        compare: () => {
          throw new GitHubServiceError('rate_limit', 'API rate limit exceeded');
        },
      }),
    });

    const result = await service.resolve(mergedPR());

    expect(result.stage).toBe('unknown');
    expect(result.reason).toBe('gh-error');
  });

  it('reports unknown when a merged PR has no merge commit', async () => {
    const { client } = fakeClient({});
    const service = new ReleaseStatusService({
      client,
      artifacts: fakeArtifacts([artifact()]),
      github: fakeGithub({ merge: () => ({ number: 1, merged: true, files: [] }) }),
    });

    const result = await service.resolve(
      mergedPR({ mergeCommitSha: undefined, mergedAt: undefined, changedFiles: undefined }),
    );

    expect(result.stage).toBe('unknown');
    expect(result.reason).toBe('no-merge-commit');
  });

  it('reports unknown for a version scheme it cannot compare', async () => {
    const { client } = fakeClient({
      devex__where_is_my_commit: () => ({
        release: { version: 'nightly', commitHash: MERGE_SHA, repoUrl: VMR_URL },
      }),
    });
    const service = new ReleaseStatusService({
      client,
      artifacts: fakeArtifacts([artifact()]),
      github: fakeGithub(),
    });

    const result = await service.resolve(mergedPR());

    expect(result.stage).toBe('unknown');
    expect(result.reason).toBe('unparseable-version');
  });
});
