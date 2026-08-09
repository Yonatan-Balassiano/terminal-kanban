import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { openDb, type Db } from '../src/db/index.js';
import { ReleaseStatusStore } from '../src/services/release-status-store.js';
import type { ArtifactReleaseStatus, PRReleaseStatus } from '../src/types/index.js';

const NOW = 1_000_000;
const SLUG = 'wix-private/wix-vmr-repo';

function artifact(over: Partial<ArtifactReleaseStatus> = {}): ArtifactReleaseStatus {
  return {
    artifactName: 'com.wixpress.web5.svc',
    shortName: 'web5.svc',
    stage: 'rc-built',
    confidence: 'confirmed',
    evidence: 'ancestry',
    gates: true,
    checkedAt: NOW,
    ...over,
  };
}

function status(over: Partial<PRReleaseStatus> = {}): PRReleaseStatus {
  return {
    repoSlug: SLUG,
    prNumber: 42,
    stage: 'rc-built',
    confidence: 'confirmed',
    artifacts: [artifact()],
    checkedAt: NOW,
    ...over,
  };
}

describe('ReleaseStatusStore', () => {
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

  function newStore(now: number = NOW) {
    const dir = mkdtempSync(join(tmpdir(), 'agentboard-release-'));
    dirs.push(dir);
    const db = openDb(join(dir, 'agentboard.db'));
    dbs.push(db);
    db.prepare(
      `INSERT INTO tasks (id, title, track_id, sort_key, created_at, updated_at)
       VALUES ('task-1', 'Feature', 'pr', 0, 1, 1)`,
    ).run();
    return { db, store: new ReleaseStatusStore(db, () => now) };
  }

  it('round-trips a verdict and its evidence', () => {
    // Arrange
    const { store } = newStore();

    // Act
    store.save(
      'task-1',
      status({
        artifacts: [
          artifact({ containingRcVersion: '1.278.0', gaVersion: '1.279.0', stage: 'ga' }),
        ],
        stage: 'ga',
      }),
    );
    const loaded = store.loadTask('task-1');

    // Assert
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.stage).toBe('ga');
    expect(loaded[0]?.artifacts[0]).toMatchObject({
      containingRcVersion: '1.278.0',
      gaVersion: '1.279.0',
      evidence: 'ancestry',
    });
  });

  it('remembers a pull request that had nothing to ship', () => {
    // Arrange — with no artifact rows there is nothing to roll up, so the
    // verdict has to survive on its own or the PR looks unexamined forever.
    const { store } = newStore();

    // Act
    store.save('task-1', status({ stage: 'no-artifact', artifacts: [] }));

    // Assert
    expect(store.loadTask('task-1')[0]?.stage).toBe('no-artifact');
    expect(store.due()).toEqual([]);
  });

  it('never re-checks a verdict that reached production', () => {
    const { store } = newStore();

    store.save('task-1', status({ stage: 'ga', artifacts: [artifact({ stage: 'ga' })] }));

    expect(store.due()).toEqual([]);
  });

  it('re-checks a rollout sooner than a pending build', () => {
    // Arrange
    const { db: rollingDb, store: rolling } = newStore();
    const { db: pendingDb, store: pending } = newStore();
    const nextCheck = (db: Db) =>
      db
        .prepare<[], { next_check_at: number }>('SELECT next_check_at FROM pr_release_status')
        .get().next_check_at;

    // Act
    rolling.save(
      'task-1',
      status({ stage: 'rolling-out', artifacts: [artifact({ stage: 'rolling-out' })] }),
    );
    pending.save(
      'task-1',
      status({ stage: 'awaiting-build', artifacts: [artifact({ stage: 'awaiting-build' })] }),
    );

    // Assert — neither is due yet, but the rollout comes due first.
    expect(rolling.due()).toEqual([]);
    expect(nextCheck(rollingDb)).toBeLessThan(nextCheck(pendingDb));
  });

  it('backs off further on each repeated failure', () => {
    // Arrange
    const { db } = newStore();
    let clock = NOW;
    const store = new ReleaseStatusStore(db, () => clock);
    const unknown = status({
      stage: 'unknown',
      confidence: 'unknown',
      artifacts: [artifact({ stage: 'unknown', confidence: 'unknown', reason: 'mcp-error' })],
    });

    // Act
    store.save('task-1', unknown);
    const first = db
      .prepare<[], { next_check_at: number }>('SELECT next_check_at FROM pr_release_status')
      .get().next_check_at;

    clock = NOW + 1;
    store.save('task-1', { ...unknown, checkedAt: clock });
    const second = db
      .prepare<[], { next_check_at: number; consecutive_failures: number }>(
        'SELECT next_check_at, consecutive_failures FROM pr_release_status',
      )
      .get();

    // Assert
    expect(second.consecutive_failures).toBe(2);
    expect(second.next_check_at - clock).toBeGreaterThan(first - NOW);
  });

  it('clears the failure count once a verdict is reached', () => {
    const { db } = newStore();
    const store = new ReleaseStatusStore(db, () => NOW);

    store.save(
      'task-1',
      status({ stage: 'unknown', artifacts: [artifact({ stage: 'unknown' })] }),
    );
    store.save('task-1', status());

    const row = db
      .prepare<[], { consecutive_failures: number }>(
        'SELECT consecutive_failures FROM pr_release_status',
      )
      .get();
    expect(row.consecutive_failures).toBe(0);
  });

  it('returns due pull requests oldest first and honours the cap', () => {
    // Arrange — three pending pull requests, checked at different times.
    const { db } = newStore();
    let clock = NOW;
    const store = new ReleaseStatusStore(db, () => clock);

    for (const prNumber of [1, 2, 3]) {
      store.save(
        'task-1',
        status({
          prNumber,
          stage: 'awaiting-build',
          checkedAt: clock,
          artifacts: [artifact({ stage: 'awaiting-build', checkedAt: clock })],
        }),
      );
      clock += 1000;
    }

    // Act — long enough later that all three are due.
    clock += 1_000_000;
    const due = store.due(2);

    // Assert
    expect(due.map((entry) => entry.prNumber)).toEqual([1, 2]);
  });

  it('replaces a pull request’s rows rather than accumulating them', () => {
    const { db } = newStore();
    const store = new ReleaseStatusStore(db, () => NOW);

    store.save('task-1', status());
    store.save('task-1', status({ stage: 'ga', artifacts: [artifact({ stage: 'ga' })] }));

    const count = db
      .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM pr_release_status')
      .get();
    expect(count.count).toBe(1);
  });

  it('forgets a pull request that is unlinked from its card', () => {
    const { store } = newStore();
    store.save('task-1', status());

    store.forget('task-1', SLUG, 42);

    expect(store.loadTask('task-1')).toEqual([]);
  });

  it('stops believing a merge is still building after long enough', () => {
    const { store } = newStore();

    expect(store.isStaleMerge(NOW - 60_000)).toBe(false);
    expect(store.isStaleMerge(NOW - 21_600_001)).toBe(true);
  });

  it('drops its rows when the card is deleted', () => {
    // Arrange
    const { db, store } = newStore();
    store.save('task-1', status());

    // Act
    db.prepare("DELETE FROM tasks WHERE id = 'task-1'").run();

    // Assert
    expect(store.loadTask('task-1')).toEqual([]);
  });
});
