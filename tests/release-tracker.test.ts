import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { openDb, type Db } from '../src/db/index.js';
import { ReleaseTracker } from '../src/services/release-tracker.js';
import type { PRRef, ReleaseStatusService } from '../src/services/release-status.js';
import type { PRReleaseStatus, ReleaseStage } from '../src/types/index.js';

const SLUG = 'wix-private/web5';

function mergedPR(prNumber: number, mergedAtMs?: number): PRRef {
  return {
    repoSlug: SLUG,
    prNumber,
    repoPath: '/repo',
    prState: 'merged',
    ...(mergedAtMs !== undefined ? { mergedAtMs } : {}),
  };
}

function status(prNumber: number, stage: ReleaseStage): PRReleaseStatus {
  return {
    repoSlug: SLUG,
    prNumber,
    stage,
    confidence: stage === 'unknown' ? 'unknown' : 'confirmed',
    artifacts: [
      {
        artifactName: 'com.wixpress.web5.svc',
        shortName: 'web5.svc',
        stage,
        confidence: stage === 'unknown' ? 'unknown' : 'confirmed',
        evidence: 'ancestry',
        gates: stage !== 'no-artifact',
        checkedAt: 1,
      },
    ],
    checkedAt: 1,
  };
}

describe('ReleaseTracker', () => {
  const dirs: string[] = [];
  const dbs: Db[] = [];

  afterEach(() => {
    for (const db of dbs.splice(0)) {
      db.close();
    }
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function newTracker(opts: {
    prs: PRRef[];
    resolve: (pr: PRRef) => PRReleaseStatus;
    onTaskReleased?: (taskId: string) => void;
    now?: () => number;
  }) {
    const dir = mkdtempSync(join(tmpdir(), 'agentboard-tracker-'));
    dirs.push(dir);
    const db = openDb(join(dir, 'agentboard.db'));
    dbs.push(db);
    db.prepare(
      `INSERT INTO tasks (id, title, track_id, sort_key, created_at, updated_at)
       VALUES ('task-1', 'Feature', 'shipping', 0, 1, 1)`,
    ).run();

    const resolver = {
      resolve: vi.fn(async (pr: PRRef) => opts.resolve(pr)),
    } as unknown as ReleaseStatusService;

    const tracker = new ReleaseTracker({
      db,
      resolver,
      listTaskPRs: () => opts.prs,
      listTrackedTaskIds: () => ['task-1'],
      ...(opts.onTaskReleased ? { onTaskReleased: opts.onTaskReleased } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    });

    return { tracker, resolver, db };
  }

  it('is released once every merged pull request shipped', async () => {
    // Arrange
    const { tracker } = newTracker({
      prs: [mergedPR(1), mergedPR(2)],
      resolve: (pr) => status(pr.prNumber, 'ga'),
    });

    // Act
    await tracker.poll();

    // Assert
    expect(tracker.isFullyReleased('task-1')).toBe(true);
  });

  it('holds a card back while one pull request is still only built', async () => {
    const { tracker } = newTracker({
      prs: [mergedPR(1), mergedPR(2)],
      resolve: (pr) => status(pr.prNumber, pr.prNumber === 1 ? 'ga' : 'rc-built'),
    });

    await tracker.poll();

    expect(tracker.isFullyReleased('task-1')).toBe(false);
  });

  it('holds a card back on a fresh unknown verdict, not just a resolved one', async () => {
    // Arrange — the very first check after a merge is routinely `unknown` for
    // a few minutes while a build starts. Reading that as "fully released"
    // moves the card straight to done — a terminal state that never
    // re-evaluates — before a later, correct verdict has any chance to land.
    const NOW = 1_000_000;
    const { tracker } = newTracker({
      prs: [mergedPR(1, NOW - 60_000)],
      resolve: (pr) => status(pr.prNumber, 'unknown'),
      now: () => NOW,
    });

    // Act
    await tracker.poll();

    // Assert
    expect(tracker.isFullyReleased('task-1')).toBe(false);
  });

  it('does not strand a card once an unknown verdict has aged past being credible', async () => {
    // Arrange — an expired login or an untracked repository must not park a
    // card in shipping forever. Once the merge is old enough that "not built
    // yet" stops being credible (ReleaseStatusStore.isStaleMerge), unreadable
    // is treated the same as unshippable.
    const NOW = 1_000_000;
    const { tracker } = newTracker({
      prs: [mergedPR(1, NOW - 21_600_001)],
      resolve: (pr) => status(pr.prNumber, 'unknown'),
      now: () => NOW,
    });

    // Act
    await tracker.poll();

    // Assert
    expect(tracker.isFullyReleased('task-1')).toBe(true);
  });

  it('holds a card back until its pull requests have been looked at', async () => {
    // Arrange — nothing polled yet. This resolves itself on the next pass, so
    // waiting is right; treating it as shipped would close the card blind.
    const { tracker } = newTracker({
      prs: [mergedPR(1)],
      resolve: (pr) => status(pr.prNumber, 'ga'),
    });

    // Assert
    expect(tracker.isFullyReleased('task-1')).toBe(false);
  });

  it('treats a card with nothing merged as released', async () => {
    const { tracker } = newTracker({
      prs: [{ ...mergedPR(1), prState: 'closed' }],
      resolve: (pr) => status(pr.prNumber, 'ga'),
    });

    expect(tracker.isFullyReleased('task-1')).toBe(true);
  });

  it('reports a card whose change touched nothing shippable as released', async () => {
    const { tracker } = newTracker({
      prs: [mergedPR(1)],
      resolve: (pr) => status(pr.prNumber, 'no-artifact'),
    });

    await tracker.poll();

    expect(tracker.isFullyReleased('task-1')).toBe(true);
  });

  it('never re-resolves a pull request that already shipped', async () => {
    // Arrange — production is permanent, so asking again is pure cost.
    const { tracker, resolver } = newTracker({
      prs: [mergedPR(1)],
      resolve: (pr) => status(pr.prNumber, 'ga'),
    });

    // Act
    await tracker.poll();
    await tracker.poll();

    // Assert
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
  });

  it('keeps looking at a pull request that has not shipped yet', async () => {
    // Arrange — the counterpart to the terminal case above: a verdict that can
    // still change has to be revisited, or a card would never notice it shipped.
    const { tracker, resolver } = newTracker({
      prs: [mergedPR(1)],
      resolve: (pr) => status(pr.prNumber, 'rc-built'),
    });

    // Act — the stored verdict is due again by the second pass.
    await tracker.poll();
    await tracker.poll();

    // Assert
    expect(resolver.resolve).toHaveBeenCalledTimes(2);
    expect(tracker.getStatuses('task-1')[0]?.stage).toBe('rc-built');
  });

  it('leaves a shipped pull request alone while re-checking an unshipped one', async () => {
    // Arrange — a card mid-rollout must not re-interrogate the half that is done.
    const { tracker, resolver } = newTracker({
      prs: [mergedPR(1), mergedPR(2)],
      resolve: (pr) => status(pr.prNumber, pr.prNumber === 1 ? 'ga' : 'rc-built'),
    });

    // Act
    await tracker.poll();
    await tracker.poll();

    // Assert — two on the first pass, then only the unshipped one again.
    const askedFor = (resolver.resolve as unknown as { mock: { calls: PRRef[][] } }).mock.calls.map(
      (call) => call[0]!.prNumber,
    );
    expect(askedFor).toEqual([1, 2, 2]);
  });

  it('announces a card whose every pull request shipped', async () => {
    const onTaskReleased = vi.fn();
    const { tracker } = newTracker({
      prs: [mergedPR(1)],
      resolve: (pr) => status(pr.prNumber, 'ga'),
      onTaskReleased,
    });

    await tracker.poll();

    expect(onTaskReleased).toHaveBeenCalledWith('task-1');
  });

  it('summarises the card by its least progressed pull request', async () => {
    // Arrange — a feature is only as shipped as its slowest part.
    const { tracker } = newTracker({
      prs: [mergedPR(1), mergedPR(2)],
      resolve: (pr) => status(pr.prNumber, pr.prNumber === 1 ? 'ga' : 'rc-built'),
    });

    // Act
    await tracker.poll();
    const summary = tracker.getSummary('task-1');

    // Assert
    expect(summary?.stage).toBe('rc-built');
    expect(summary?.gaCount).toBe(1);
    expect(summary?.gatingCount).toBe(2);
  });

  it('forgets a pull request that is no longer on the card', async () => {
    // Arrange
    let prs = [mergedPR(1)];
    const dir = mkdtempSync(join(tmpdir(), 'agentboard-tracker-'));
    dirs.push(dir);
    const db = openDb(join(dir, 'agentboard.db'));
    dbs.push(db);
    db.prepare(
      `INSERT INTO tasks (id, title, track_id, sort_key, created_at, updated_at)
       VALUES ('task-1', 'Feature', 'shipping', 0, 1, 1)`,
    ).run();

    const tracker = new ReleaseTracker({
      db,
      resolver: {
        resolve: vi.fn(async (pr: PRRef) => status(pr.prNumber, 'rc-built')),
      } as unknown as ReleaseStatusService,
      listTaskPRs: () => prs,
      listTrackedTaskIds: () => ['task-1'],
      now: () => Date.now() + 10_000_000,
    });

    await tracker.poll();
    expect(tracker.getStatuses('task-1')).toHaveLength(1);

    // Act — the branch was unlinked from the card.
    prs = [];
    await tracker.poll();

    // Assert
    expect(tracker.getStatuses('task-1')).toEqual([]);
  });
});
