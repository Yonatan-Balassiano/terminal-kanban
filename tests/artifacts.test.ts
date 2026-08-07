import { describe, it, expect, vi } from 'vitest';
import {
  ArtifactsService,
  buildRolloutComment,
  shortArtifactName,
  versionDrift,
} from '../src/services/artifacts.js';
import { McpAuthRequiredError } from '../src/services/mcp/oauth.js';
import type { McpClient } from '../src/services/mcp/client.js';

/** Stands in for the MCP client, returning canned devex get_project payloads. */
function fakeClient(
  responder: (projectName: string) => unknown
): { client: McpClient; calls: string[] } {
  const calls: string[] = [];
  const client = {
    callTool: vi.fn(async (_tool: string, args: Record<string, unknown>) => {
      const name = args['projectName'] as string;
      calls.push(name);
      return responder(name);
    }),
  } as unknown as McpClient;
  return { client, calls };
}

const project = (over: Record<string, unknown> = {}) => ({
  project: {
    projectName: 'com.wixpress.web5.ecom-integrations',
    mode: 'LIVE',
    isArchived: false,
    gaVersion: '1.1258.0',
    latestRcVersion: '1.1259.0',
    ...over,
  },
});

describe('versionDrift', () => {
  it('counts how far the newest RC is ahead of GA', () => {
    expect(versionDrift('1.465.0', '1.470.0')).toBe(5);
    expect(versionDrift('1.1258.0', '1.1259.0')).toBe(1);
  });

  it('is zero when prod already runs the newest RC', () => {
    expect(versionDrift('1.3309.0', '1.3309.0')).toBe(0);
  });

  it('reports null rather than a misleading zero when a version is missing', () => {
    // Libraries and proto packages have no GA at all.
    expect(versionDrift(undefined, '1.2.0')).toBeNull();
    expect(versionDrift('1.2.0', undefined)).toBeNull();
  });

  it('reports null for versions it cannot parse', () => {
    expect(versionDrift('1.2.0', 'nightly')).toBeNull();
  });

  it('handles differing segment counts', () => {
    expect(versionDrift('1.0', '1.0.0')).toBe(0);
    expect(versionDrift('1.0', '1.3')).toBe(3);
  });
});

describe('shortArtifactName', () => {
  it('drops the group prefix so a narrow rail can show it', () => {
    expect(shortArtifactName('com.wixpress.web5.ecom-integrations')).toBe('web5.ecom-integrations');
  });

  it('leaves an unprefixed name alone', () => {
    expect(shortArtifactName('some.other.thing')).toBe('some.other.thing');
  });
});

describe('ArtifactsService', () => {
  it('maps a drifting artifact', async () => {
    // Arrange
    const { client } = fakeClient(() => project());
    const service = new ArtifactsService({
      client,
      artifactNames: ['com.wixpress.web5.ecom-integrations'],
    });

    // Act
    const snapshot = await service.refresh();

    // Assert
    expect(snapshot.stale).toBe(false);
    expect(snapshot.artifacts[0]).toMatchObject({
      shortName: 'web5.ecom-integrations',
      mode: 'LIVE',
      gaVersion: '1.1258.0',
      latestRcVersion: '1.1259.0',
      drift: 1,
      status: 'drift',
    });
  });

  it('marks an artifact in sync when GA matches the newest RC', async () => {
    const { client } = fakeClient(() =>
      project({ gaVersion: '1.3309.0', latestRcVersion: '1.3309.0' })
    );
    const service = new ArtifactsService({ client, artifactNames: ['x'] });

    expect((await service.refresh()).artifacts[0]?.status).toBe('in-sync');
  });

  it('flags an artifact with no GA rather than showing an empty prod column', async () => {
    // Arrange — proto packages and npm libraries publish RCs but never go GA.
    const { client } = fakeClient(() => project({ gaVersion: undefined }));
    const service = new ArtifactsService({ client, artifactNames: ['x'] });

    // Act
    const record = (await service.refresh()).artifacts[0];

    // Assert
    expect(record?.status).toBe('no-ga');
    expect(record?.drift).toBeUndefined();
  });

  it('keeps the rest of the rail when one artifact fails to resolve', async () => {
    // Arrange
    const { client } = fakeClient((name) => {
      if (name === 'bad') throw new Error('not found');
      return project();
    });
    const service = new ArtifactsService({ client, artifactNames: ['bad', 'good'] });

    // Act
    const snapshot = await service.refresh();

    // Assert
    expect(snapshot.artifacts).toHaveLength(2);
    expect(snapshot.artifacts[0]?.status).toBe('unknown');
    expect(snapshot.artifacts[1]?.status).toBe('drift');
    expect(snapshot.stale).toBe(false);
  });

  it('preserves the previous rows and flags re-auth when the login expires', async () => {
    // Arrange — a blank rail would be worse than stale numbers plus a warning.
    let fail = false;
    const { client } = fakeClient(() => {
      if (fail) throw new McpAuthRequiredError('expired');
      return project();
    });
    const service = new ArtifactsService({ client, artifactNames: ['x'] });
    await service.refresh();

    // Act
    fail = true;
    const snapshot = await service.refresh();

    // Assert
    expect(snapshot.artifacts).toHaveLength(1);
    expect(snapshot.artifacts[0]?.gaVersion).toBe('1.1258.0');
    expect(snapshot.stale).toBe(true);
    expect(snapshot.needsAuth).toBe(true);
  });

  it('serves the last snapshot without blocking or throwing', async () => {
    // Arrange
    const { client } = fakeClient(() => project());
    const service = new ArtifactsService({ client, artifactNames: ['x'] });

    // Assert — before any refresh the rail still has something to draw.
    expect(service.getSnapshot()).toMatchObject({ artifacts: [], refreshedAt: 0, stale: true });

    await service.refresh();
    expect(service.getSnapshot().artifacts).toHaveLength(1);
  });

  it('shares one in-flight refresh between concurrent callers', async () => {
    // Arrange — the rail polls and the user can force a refresh at the same time.
    const { client, calls } = fakeClient(() => project());
    const service = new ArtifactsService({ client, artifactNames: ['x'] });

    // Act
    await Promise.all([service.refresh(), service.refresh(), service.refresh()]);

    // Assert
    expect(calls).toEqual(['x']);
  });

  it('does no work and reports fresh when nothing is configured', async () => {
    const { client, calls } = fakeClient(() => project());
    const service = new ArtifactsService({ client, artifactNames: [] });

    const snapshot = await service.refresh();
    expect(calls).toEqual([]);
    expect(snapshot).toMatchObject({ artifacts: [], stale: false });
  });

  it('preserves the configured order', async () => {
    // Arrange — the rail should read in the order the user listed them.
    const { client } = fakeClient((name) => project({ projectName: name }));
    const service = new ArtifactsService({ client, artifactNames: ['a', 'b', 'c', 'd', 'e'] });

    // Act
    const snapshot = await service.refresh();

    // Assert
    expect(snapshot.artifacts.map((a) => a.name)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('ArtifactsService.rollout', () => {
  const drifting = () =>
    project({ gaVersion: '1.258.0', latestRcVersion: '1.269.0', projectName: 'svc' });

  async function serviceWithSnapshot(responder: (name: string) => unknown) {
    const { client, calls } = fakeClient(responder);
    const service = new ArtifactsService({ client, artifactNames: ['svc'] });
    await service.refresh();
    calls.length = 0;
    return { service, client, calls };
  }

  it('sends the confirmed version, not a freshly re-read one', async () => {
    // Arrange — a newer RC landing between confirmation and dispatch must never
    // be shipped by surprise.
    const seen: Array<Record<string, unknown>> = [];
    const { client } = fakeClient(() => drifting());
    (client.callTool as ReturnType<typeof vi.fn>).mockImplementation(
      async (tool: string, args: Record<string, unknown>) => {
        seen.push({ tool, ...args });
        return tool === 'rollout__rollout_version'
          ? { transactionId: 'tx-1', status: 'PENDING' }
          : drifting();
      }
    );
    const service = new ArtifactsService({ client, artifactNames: ['svc'] });
    await service.refresh();

    // Act
    const result = await service.rollout({ name: 'svc', targetVersion: '1.269.0' });

    // Assert
    expect(result.ok).toBe(true);
    expect(result.transactionId).toBe('tx-1');
    const call = seen.find((c) => c['tool'] === 'rollout__rollout_version');
    expect(call).toMatchObject({
      application_id: 'svc',
      desired_ga_version: '1.269.0',
      graduality: 'gradual_safer',
    });
  });

  it('defaults to the safer gradual rollout', async () => {
    const { service, client } = await serviceWithSnapshot(() => drifting());
    await service.rollout({ name: 'svc', targetVersion: '1.269.0' });

    const call = (client.callTool as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'rollout__rollout_version'
    );
    expect(call?.[1]).toMatchObject({ graduality: 'gradual_safer' });
  });

  it('passes through an explicitly chosen graduality', async () => {
    const { service, client } = await serviceWithSnapshot(() => drifting());
    await service.rollout({ name: 'svc', targetVersion: '1.269.0', graduality: 'gradual_quicker' });

    const call = (client.callTool as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'rollout__rollout_version'
    );
    expect(call?.[1]).toMatchObject({ graduality: 'gradual_quicker' });
  });

  it('refuses an artifact that is not configured', async () => {
    // Arrange — the rail is the only entry point; anything else is a caller bug.
    const { service, calls } = await serviceWithSnapshot(() => drifting());

    // Act
    const result = await service.rollout({ name: 'not-mine', targetVersion: '1.0.0' });

    // Assert — nothing reached production.
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not a configured artifact/);
    expect(calls).toEqual([]);
  });

  it('refuses an empty target version', async () => {
    const { service } = await serviceWithSnapshot(() => drifting());
    const result = await service.rollout({ name: 'svc', targetVersion: '  ' });
    expect(result.ok).toBe(false);
  });

  it('reports a failed rollout without throwing', async () => {
    // Arrange — a deploy freeze or a Wix Standards block surfaces here.
    const { client } = fakeClient(() => drifting());
    (client.callTool as ReturnType<typeof vi.fn>).mockImplementation(
      async (tool: string) => {
        if (tool === 'rollout__rollout_version') throw new Error('deploy freeze active');
        return drifting();
      }
    );
    const service = new ArtifactsService({ client, artifactNames: ['svc'] });
    await service.refresh();

    // Act
    const result = await service.rollout({ name: 'svc', targetVersion: '1.269.0' });

    // Assert
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/deploy freeze/);
  });
});

describe('buildRolloutComment', () => {
  it('names the versions and admits the tool initiated it', () => {
    const comment = buildRolloutComment('com.wixpress.svc', '1.258.0', '1.269.0');
    expect(comment).toContain('com.wixpress.svc');
    expect(comment).toContain('1.258.0');
    expect(comment).toContain('1.269.0');
    // The audit trail must never imply a human wrote this.
    expect(comment).toContain('initiated by AgentBoard via rollout-mcp');
  });

  it('stays valid when the current GA is unknown', () => {
    const comment = buildRolloutComment('svc', undefined, '1.0.0');
    expect(comment.length).toBeGreaterThanOrEqual(10);
    expect(comment).toContain('1.0.0');
  });
});

describe('ArtifactsService ownership annotation', () => {
  function serviceWith(myPending: number | null, opts: { drift?: boolean } = {}) {
    const drifting = opts.drift === false;
    const client = {
      callTool: vi.fn(async (tool: string) => {
        if (tool === 'devex__get_project') {
          return project(
            drifting
              ? { gaVersion: '1.0.0', latestRcVersion: '1.0.0', projectName: 'svc' }
              : { gaVersion: '1.0.0', latestRcVersion: '1.5.0', projectName: 'svc' }
          );
        }
        return { releases: [{ commitHash: 'a', repoUrl: 'git@github.com:o/r.git' }] };
      }),
    } as unknown as McpClient;

    const ownership = { countMine: vi.fn(async () => myPending) } as never;
    return {
      client,
      service: new ArtifactsService({ client, artifactNames: ['svc'], ownership }),
    };
  }

  it('annotates a drifting artifact with the user’s pending count', async () => {
    const { service } = serviceWith(3);
    const record = (await service.refresh()).artifacts[0];

    expect(record?.pendingRcCount).toBe(1);
    expect(record?.myPendingCount).toBe(3);
  });

  it('records a confident zero when none of the pending RCs are the user’s', async () => {
    const { service } = serviceWith(0);
    expect((await service.refresh()).artifacts[0]?.myPendingCount).toBe(0);
  });

  it('leaves the count undefined when ownership cannot be determined', async () => {
    // Arrange — undefined must reach the footer as "unknown", never as zero.
    const { service } = serviceWith(null);

    // Act
    const record = (await service.refresh()).artifacts[0];

    // Assert
    expect(record?.myPendingCount).toBeUndefined();
  });

  it('does not spend calls on an artifact that is already in sync', async () => {
    // Arrange — nothing is pending, so there is nothing to attribute.
    const { service, client } = serviceWith(3, { drift: false });

    // Act
    const record = (await service.refresh()).artifacts[0];

    // Assert
    expect(record?.status).toBe('in-sync');
    expect(record?.myPendingCount).toBeUndefined();
    const tools = (client.callTool as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(tools).not.toContain('devex__available_rcs');
  });

  it('still returns the artifact when the pending-RC lookup fails', async () => {
    // Arrange
    const client = {
      callTool: vi.fn(async (tool: string) => {
        if (tool === 'devex__get_project') {
          return project({ gaVersion: '1.0.0', latestRcVersion: '1.5.0', projectName: 'svc' });
        }
        throw new Error('upstream down');
      }),
    } as unknown as McpClient;
    const service = new ArtifactsService({
      client,
      artifactNames: ['svc'],
      ownership: { countMine: vi.fn(async () => 1) } as never,
    });

    // Act
    const record = (await service.refresh()).artifacts[0];

    // Assert — versions still shown; only the ownership annotation is missing.
    expect(record?.status).toBe('drift');
    expect(record?.gaVersion).toBe('1.0.0');
    expect(record?.myPendingCount).toBeUndefined();
  });

  it('omits ownership entirely when no login was resolved', async () => {
    const client = {
      callTool: vi.fn(async () =>
        project({ gaVersion: '1.0.0', latestRcVersion: '1.5.0', projectName: 'svc' })
      ),
    } as unknown as McpClient;
    const service = new ArtifactsService({ client, artifactNames: ['svc'] });

    const record = (await service.refresh()).artifacts[0];
    expect(record?.myPendingCount).toBeUndefined();
    expect(record?.pendingRcCount).toBeUndefined();
  });
});
